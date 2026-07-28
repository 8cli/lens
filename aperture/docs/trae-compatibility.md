# Trae IDE Compatibility Guide

> How to use Aperture as a custom model provider in Trae IDE, and the special compatibility requirements.

## Overview

[Trae IDE](https://trae.ai) (by ByteDance) is an AI-native IDE that supports custom model providers. However, Trae has specific API requirements that differ from other AI coding tools like Claude Code or Codex CLI.

## Protocol Support

Trae's custom model feature supports **only two** API protocols:

| Protocol | Endpoint | Trae UI Setting |
|----------|----------|-----------------|
| **OpenAI Chat Completions** | `/v1/chat/completions` | Select "OpenAI Chat Completions 格式" |
| **Anthropic Messages** | `/v1/messages` | Select "Anthropic Messages 格式" |

> **Important:** Trae does **NOT** support the OpenAI Responses API (`POST /` or `/v1/responses`). If your proxy exposes a Responses API endpoint, Trae will not be able to use it.

## Configuration in Trae

### OpenAI Protocol (Recommended for DeepSeek models)

1. Open Settings → Models → Add Model
2. Select "自定义配置" (Custom Configuration)
3. API Format: **OpenAI Chat Completions 格式**
4. Request URL: `https://opencode-go-proxy.blogger.workers.dev/v1/chat/completions`
   - Enable "完整 URL" toggle and enter the full path
5. Model ID: `dv4f` (or any mapped alias)
6. API Key: Your `cfut_...` Gateway token

### Anthropic Protocol (for Claude Code compatibility)

1. Open Settings → Models → Add Model
2. Select "自定义配置" (Custom Configuration)
3. API Format: **Anthropic Messages 格式**
4. Request URL: `https://opencode-go-proxy.blogger.workers.dev/v1/messages`
   - Enable "完整 URL" toggle and enter the full path
5. Model ID: `dv4f` (or any mapped alias)
6. API Key: Your `cfut_...` Gateway token

## Architecture

```
Trae IDE  ──POST /v1/chat/completions──▶  Aperture Worker  ──▶  AI Gateway  ──▶  Console Go / OpenCode
(OpenAI Chat                                (handleChatCompletions)     (custom-opencode-go)   (deepseek-v4-flash)
Completions)
```

## Key Compatibility Issues

### 1. Tool Call Message Format

**Background:** opencode.ai uses DSML (Deep Seek Markup Language) XML-style tool calling, not standard OpenAI `tool_calls`. It natively accepts `role: "tool"` messages and `tool_calls` in assistant request messages. The Chat Completions passthrough now forwards these message formats as-is without transformation.

> **Note:** Earlier versions of this proxy included a `compatChatMessages()` function that converted `role: "tool"` to `role: "user"`. This was removed after confirming that opencode.ai properly handles the native format. If you encounter issues with tool calling, verify that your worker is running version `2c7a0e80` or later.

This is the **most likely reason** Trae users see `HTTP 400` while other tools work fine.

### 2. DeepSeek `reasoning_content` in Streaming

**Problem:** DeepSeek models (including DeepSeek V4 Flash) emit a non-standard `reasoning_content` field in streaming Chat Completions delta chunks. Standard Chat Completions clients (including Trae) may fail to parse these.

A typical DeepSeek streaming response produces ~30+ chunks containing **only** `reasoning_content` before emitting any `content`:

```json
// Non-standard chunk (DeepSeek-specific):
{"choices":[{"delta":{"reasoning_content":"Thinking step 1..."}}]}

// Standard chunk (OpenAI-compatible):
{"choices":[{"delta":{"content":"The answer is..."}}]}
```

**Fix:** `filterChatStream()` in `src/index.js` strips `reasoning_content` and converts `content: null` to `content: ""`.

### 3. AI Gateway base_url Configuration

**Problem:** The Cloudflare AI Gateway custom provider's `base_url` must **NOT** include a trailing `/v1`. The Gateway automatically appends the request path `/v1/chat/completions`, resulting in a doubled `/v1/v1/` URL:

```
❌ Before: base_url = "https://opencode.ai/zen/go/v1"
   Result:  https://opencode.ai/zen/go/v1/v1/chat/completions  (404/400)

✅ After:  base_url = "https://opencode.ai/zen/go/"
   Result:  https://opencode.ai/zen/go/v1/chat/completions      (200)
```

### 4. Gateway API Key Storage

**Problem:** When updating a custom provider via PATCH, the `api_key` field must be explicitly included. A PATCH without `api_key` will **clear** the stored key, causing all subsequent requests to fail with 400.

**Fix:** Always include `api_key` in PATCH payload:

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/{acct}/ai-gateway/custom-providers/{uuid}" \
  -H "Authorization: Bearer $CFAT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "OpenCodeGo",
    "slug": "opencode-go",
    "base_url": "https://opencode.ai/zen/go/",
    "api_key": "sk-...",
    "enable": true
  }'
```

## Verification

After configuration, verify the worker is working with Trae-compatible requests:

```bash
# Test 1: Simple chat (no tool calls)
curl -X POST "https://opencode-go-proxy.blogger.workers.dev/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GW_TOKEN" \
  -d '{"model":"dv4f","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Test 2: Tool call round-trip (simulates what Trae Builder sends)
curl -X POST "https://opencode-go-proxy.blogger.workers.dev/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GW_TOKEN" \
  -d '{
    "model":"dv4f",
    "messages":[
      {"role":"user","content":"What is the weather?"},
      {"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Beijing\"}"}}]},
      {"role":"tool","tool_call_id":"c1","content":"Sunny, 25°C"}
    ],
    "stream":false
  }'
```

## Troubleshooting

### Error: "HTTP 400 - Error from provider (Console Go)"

This usually means the upstream rejected the request. Likely causes:

1. **AI Gateway API key** — Re-PATCH the provider with the correct `api_key`
2. **AI Gateway base_url** — Verify it does NOT end with `/v1`

### Error: "HTTP 200 - empty or malformed response" in Claude Code

This usually affects the Anthropic protocol path. Ensure:

1. Content block start/stop framing follows the "open once, accumulate deltas, close once" pattern
2. `stop_reason` properly maps `tool_calls` → `tool_use`
3. `reasoning_content` → `thinking` block mapping is active

### Error: Trae chat silently fails (no visible error)

Likely caused by `reasoning_content` in streaming chunks. Verify the deployed worker version includes `filterChatStream`. Test with `stream: false` first to isolate the issue.

## Debugging Gateway Logs

Check Cloudflare AI Gateway logs to see actual error details:

```bash
# Replace with your cfat token and account ID
curl -s "https://api.cloudflare.com/client/v4/accounts/{acct}/ai-gateway/gateways/opencodego/logs?limit=10" \
  -H "Authorization: Bearer $CFAT" | jq '.result[] | {time: .created_at, status: .status_code, success: .success, tokens: "\(.tokens_in)/\(.tokens_out)"}'
```

## Related Files in This Project

| File | Purpose |
|------|---------|
| `src/index.js` | `filterChatStream()`, routing, passthrough |
| `src/upstream.js` | `buildUpstreamUrl()`, `chooseApiKey()` — Gateway routing logic |
| `src/anthropic.js` | Anthropic stream translation with `reasoning_content` → `thinking` |
| `wrangler.jsonc` | Worker configuration, model mapping, env vars |
| `docs/trae-compatibility.md` | This file |

## Git History

Relevant commits for Trae compatibility:

```
2c7a0e80 - fix: remove compatChatMessages (opencode.ai natively supports role:tool)
3cac3f2 - fix: add compatChatMessages for Chat Completions passthrough [REVERTED]
785ce57 - fix: improve upstream routing and error diagnostics
9ed948f - fix: filter reasoning_content for Trae compat + stop_reason mapping + null body guard
```
