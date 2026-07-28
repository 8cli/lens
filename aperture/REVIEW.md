---
status: issues_found
files_reviewed: 5
critical: 15
warning: 10
info: 5
total: 30
---

# Code Review: Aperture 🔭

> **⚠️ 注意：此审查基于旧架构（5 个源文件）。项目已重构为 14 个模块（见 `docs/superpowers/specs/`）。**
> **所有 Critical/Medium 问题已在 commit `2252d54`、`62301c3`、`f8822d5` 中修复。**
> **当前状态：356 测试，99% 覆盖率，100% 函数覆盖。**

## Summary

Aperture is a Cloudflare Worker that translates OpenAI Responses API and Anthropic Messages API requests into OpenAI Chat Completions for upstream consumption. The codebase is lean and purpose-built, but contains several correctness, security, and protocol compliance defects that affect production reliability. Critical issues include a broken Responses API string-input handler, upstream error message leakage to clients, an unbounded in-memory rate limiter, hardcoded model names across all translated responses, dropped Anthropic assistant tool-use blocks, and ReDoS-vulnerable regex in the DSML parser. Streaming error paths are universally silent (no telemetry), and several protocol translation edge cases will cause client SDKs to misbehave or hang.

---

## Critical Findings

### CR-001: Responses API string `input` iterated character-by-character

**File:** `src/responses.js:36`
**Severity:** Critical
**Category:** bug / compliance
**Description:** The Responses API spec allows `input` to be a plain string. `translateToChat` does `for (const item of body.input || [])` without first checking if `body.input` is a string. When it is a string, JavaScript iterates over individual characters. Each character satisfies `typeof item === "string"` and is pushed as a separate `role: "user"` message.
**Impact:** A single user prompt like `"Hello"` becomes five sequential user messages (`H`, `e`, `l`, `l`, `o`), completely breaking the Responses API path.
**Fix:**
```javascript
if (typeof body.input === "string") {
  messages.push({ role: "user", content: body.input });
} else {
  for (const item of body.input || []) { /* existing loop */ }
}
```

---

### CR-002: Raw upstream error bodies leaked to clients without sanitization

**File:** `src/index.js:277-280`, `src/index.js:462-468`
**Severity:** Critical
**Category:** security
**Description:** `handleChatCompletions` embeds `safeReadUpstreamBody(upstreamResponse)` directly into the client-facing error message. `handleResponsesAPI` and `handleAnthropicMessages` use `readUpstreamErrorSafe`, which extracts `body.error?.message || body.message` from upstream JSON errors. Upstream gateways or providers may return diagnostic messages containing internal URLs, partial API keys, stack traces, or model endpoint details.
**Impact:** Sensitive infrastructure details or credentials may be exposed to any authenticated (or unauthenticated) client.
**Fix:** Return a generic opaque error to the client, and log the detailed upstream error server-side:
```javascript
// Client-facing
return errorResponse("Upstream request failed", "upstream_error", "UPSTREAM", upstreamResponse.status);
// Server-side (add structured logging)
log.error("upstream.error", { status: upstreamResponse.status, detail: errBody });
```

---

### CR-003: Rate limiter ignores environment configuration and grows unbounded

**File:** `src/index.js:19`, `src/utils.js:271-288`
**Severity:** Critical
**Category:** bug / performance
**Description:** The rate limiter is instantiated at module scope with hardcoded `createRateLimiter(60000, 120)`, ignoring `wrangler.jsonc` variables `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`. Furthermore, `hits` is a `Map` that never evicts stale entries. Under sustained load from many unique IPs (botnets, IPv6 rotation, etc.), the Map consumes worker memory indefinitely until the isolate is evicted.
**Impact:** Configuration changes to rate limits have no effect. Memory exhaustion can crash or slow the worker isolate.
**Fix:** Instantiate the limiter inside `fetch` where `env` is available, and add TTL eviction:
```javascript
// In fetch()
const rateLimiter = createRateLimiter(
  Math.max(1000, parseInt(env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000),
  Math.max(1, parseInt(env.RATE_LIMIT_MAX || "120", 10) || 120)
);
```
```javascript
// In createRateLimiter, prune on every Nth check or use a Weak-ish TTL scheme
```

---

### CR-004: Hardcoded `model: "deepseek-v4-flash"` in all translated responses

**File:** `src/responses.js:187`, `src/responses.js:338`, `src/anthropic.js:171`, `src/anthropic.js:341`, `src/anthropic.js:380`
**Severity:** Critical
**Category:** compliance
**Description:** Both streaming and non-streaming translations for Responses API and Anthropic API embed the literal string `"deepseek-v4-flash"` in every output event and JSON envelope. The actual upstream model (from `chatReq.model` or the upstream response) is never propagated.
**Impact:** Clients relying on the `model` field for billing, logging, or routing receive false information. Multi-model deployments are effectively impossible.
**Fix:** Pass the resolved model name through the translation pipeline and use it consistently:
```javascript
// In handleResponsesAPI / handleAnthropicMessages:
const resolvedModel = chatReq.model;
return pipeEventStream(translateStreamEvents(upstreamResponse, respId, resolvedModel), ...);
```

---

### CR-005: Responses API streaming emits mismatched message IDs between `added` and `done`

**File:** `src/responses.js:205-217`, `src/responses.js:406-418`
**Severity:** Critical
**Category:** compliance
**Description:** When a text output item starts, `response.output_item.added` yields `id: uid("msg")`. When the same item completes, `makeTextItemDone` calls `uid("msg")` again, generating a completely different ID. The Responses API requires the same item ID across its lifecycle.
**Impact:** Clients tracking output items by ID will see orphaned items and mismatched completion events.
**Fix:** Track the text item ID when created and reuse it:
```javascript
let currentTextItemId = null;
// on start:
currentTextItemId = uid("msg");
// on done:
item: { id: currentTextItemId, ... }
```

---

### CR-006: `toolCallsMap` plain-object `.length = 0` is a no-op leaving stale state

**File:** `src/responses.js:309-310`
**Severity:** Critical
**Category:** bug
**Description:** `toolCallsMap` is initialized as `{}` (a plain object, not an Array). The code sets `toolCallsMap.length = 0` after emitting `finishReason`, expecting to clear all entries. On plain objects this has no effect—existing keys remain enumerable. While `toolOrder` (an Array) is correctly cleared, the stale map entries persist for the remainder of the generator lifespan.
**Impact:** If the upstream emits any unexpected trailing chunks after `finish_reason`, old tool call state may be duplicated or resurrected.
**Fix:**
```javascript
Object.keys(toolCallsMap).forEach(k => delete toolCallsMap[k]);
toolOrder.length = 0;
```

---

### CR-007: `filterChatStream` buffer grows unbounded on newline-free upstream data

**File:** `src/index.js:202-269`
**Severity:** Critical
**Category:** performance / DoS
**Description:** The stream reader accumulates data in `buffer` and only flushes when `\n` is seen. If the upstream sends a massive amount of data without newlines (maliciously or due to a proxy bug), `buffer += value` grows without bound until the worker hits its memory limit (~128 MB) and is terminated.
**Impact:** A single malicious or broken upstream stream can crash the worker isolate.
**Fix:** Cap the buffer size and throw/abort when exceeded:
```javascript
const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB
buffer += value;
if (buffer.length > MAX_BUFFER) {
  throw new Error("SSE buffer exceeded maximum size");
}
```

---

### CR-008: `REQUEST_TIMEOUT_MS` non-numeric value causes immediate request abort

**File:** `src/upstream.js:44`, `src/utils.js:257-266`
**Severity:** Critical
**Category:** bug
**Description:** `parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10)` returns `NaN` when the env var is a non-numeric string. `fetchUpstream` passes this `NaN` to `setTimeout(..., timeoutMs)`. Per HTML spec, `setTimeout(fn, NaN)` clamps to `0`, aborting the request instantly.
**Impact:** A single misconfigured deployment variable breaks 100% of upstream requests.
**Fix:** Validate after parsing:
```javascript
const timeout = Math.max(1000, parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10) || 120000);
```

---

### CR-009: Anthropic assistant `tool_use` blocks are silently dropped

**File:** `src/anthropic.js:82-86`, `src/anthropic.js:445-446`
**Severity:** Critical
**Category:** compliance
**Description:** For assistant messages, `translateAnthropicToChat` calls `translateAnthropicContent`, which explicitly ignores `block.type === "tool_use"` with a comment "Already handled at message level." However, `tool_use` blocks are **not** handled at the message level for assistant messages—they are only handled for user messages (`tool_result`). This means Anthropic assistant tool calls are lost in translation to Chat Completions.
**Impact:** Conversations containing tool-call round-trips break; the upstream receives an assistant message with no `tool_calls`, causing validation errors or hallucinated behavior.
**Fix:** Detect `tool_use` blocks in assistant messages and convert them to OpenAI `tool_calls`:
```javascript
if (msg.role === "assistant") {
  const toolCalls = [];
  let text = "";
  for (const block of (Array.isArray(msg.content) ? msg.content : [msg.content])) {
    if (block.type === "text") text += block.text || "";
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || uid("call"),
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
  continue;
}
```

---

### CR-010: Anthropic user message images emitted as non-standard `images` field

**File:** `src/anthropic.js:69-74`
**Severity:** Critical
**Category:** compliance
**Description:** When translating Anthropic user messages containing image blocks, the code constructs:
```javascript
messages.push({ role: "user", content: text, ...(images.length > 0 ? { images } : {}) });
```
OpenAI Chat Completions does not recognize a top-level `images` field on messages. The correct format uses a `content` array with `type: "image_url"` objects.
**Impact:** Image uploads from Anthropic clients are either ignored by the upstream or cause schema validation errors.
**Fix:** Build a standard OpenAI multimodal `content` array:
```javascript
const contentParts = [];
if (text) contentParts.push({ type: "text", text });
if (images.length) contentParts.push(...images);
if (contentParts.length) messages.push({ role: "user", content: contentParts });
```

---

### CR-011: Non-streaming Chat Completions path does not strip `reasoning_content`

**File:** `src/index.js:289-303`
**Severity:** Critical
**Category:** compliance
**Description:** The streaming path has `filterChatStream` which strips `reasoning_content` from delta chunks for Trae compatibility. The non-streaming path calls `normalizeDsmlToolCalls(responseBody)` but does **not** strip `reasoning_content` from `choices[].message` or `choices[].delta`. Trae and other strict clients receiving non-streaming DeepSeek responses will encounter the non-standard field.
**Impact:** Non-streaming requests from Trae IDE fail or render incorrectly when the upstream returns reasoning content.
**Fix:** Apply the same normalization to non-streaming bodies:
```javascript
for (const choice of responseBody.choices || []) {
  if (choice.message?.reasoning_content !== undefined) {
    delete choice.message.reasoning_content;
  }
}
```

---

### CR-012: ReDoS vulnerability in DSML regex parser

**File:** `src/index.js:426`, `src/index.js:433`
**Severity:** Critical
**Category:** security
**Description:** `normalizeDsmlToolCalls` uses two unanchored regexes with `gi` flags and greedy/lazy quantifier combinations inside lookaheads:
- `invokeRegex`: `/invoke\s+name\s*=\s*"([^"]+)"([\s\S]*?)(?=invoke\s+name\s*=\s*"|$)/gi`
- `paramRegex`: `/parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/parameter/gi`

On specially crafted content with many partial match candidates (e.g., repeated `invoke` without closing quotes, or many `>` without `</parameter>`), the regex engine can exhibit catastrophic backtracking. Because this runs on upstream response content, a compromised or malicious upstream provider can trigger CPU exhaustion.
**Impact:** Denial of service via CPU exhaustion in the Cloudflare Worker isolate.
**Fix:** Replace regex parsing with a robust XML-ish state machine or use `String.prototype.indexOf`/`substring` extraction. At minimum, cap input length before regex application:
```javascript
if (content.length > 10000) return responseBody; // skip DSML for oversized content
```

---

### CR-013: `fetchUpstream` abort errors propagate as unhandled 500s

**File:** `src/utils.js:257-266`, `src/upstream.js:41-57`
**Severity:** Critical
**Category:** bug
**Description:** When `fetchUpstream` times out, `controller.abort()` causes `fetch` to throw an `AbortError` (or `DOMException`). Neither `fetchUpstream` nor `sendChatRequest` catches this. The error bubbles to the Worker global handler, which returns a generic HTTP 500 or Cloudflare error page. The client cannot distinguish a timeout from a server crash.
**Impact:** Clients receive unhelpful 500 errors instead of 504 Gateway Timeout, making retries and debugging impossible.
**Fix:** Catch and remap in `fetchUpstream`:
```javascript
try {
  const response = await fetch(url, { ...options, signal: controller.signal });
  return response;
} catch (err) {
  if (err.name === "AbortError") {
    return new Response(JSON.stringify({ error: { message: "Request timed out", type: "timeout_error" } }), { status: 504 });
  }
  throw err;
}
```

---

### CR-014: All streaming error paths are swallowed without server-side logging

**File:** `src/index.js:136-151`, `src/index.js:172-181`
**Severity:** Critical
**Category:** observability
**Description:** `pipeEventStream` and `pipeChatStream` contain `catch (err) { /* ignore */ }` blocks. When a stream fails (upstream disconnect, parse error, buffer overflow, translation bug), the error is silently discarded. No structured log entry is emitted. The client may see an truncated SSE stream with no indication of what failed.
**Impact:** Production incidents are invisible. Debugging requires reproducing the issue locally, which may be impossible with transient upstream behavior.
**Fix:** Log every caught error before writing the stream termination:
```javascript
} catch (err) {
  log.error("stream.error", { message: err.message, stack: err.stack });
  await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Internal stream error" })}\n\n`));
}
```

---

### CR-015: No rate limiting on failed authentication attempts

**File:** `src/index.js:63-67`, `src/utils.js:92-110`
**Severity:** Critical
**Category:** security
**Description:** `authenticate` runs before `rateLimiter.check`. An attacker can submit unlimited authentication attempts with different tokens or headers without ever hitting the rate limiter. Because the token is checked with simple string equality, a brute-force or dictionary attack against `AI_GATEWAY_TOKEN` is unthrottled.
**Impact:** Weak or moderately strong tokens can be brute-forced over time without detection or throttling.
**Fix:** Move rate limiting before authentication, or add a separate, stricter rate limiter for auth failures keyed by IP.

---

### CR-016: `anthropicHeaders` generates two different request IDs

**File:** `src/index.js:350-358`
**Severity:** Critical
**Category:** compliance
**Description:** `anthropicHeaders` calls `uid("req")` twice:
```javascript
"x-request-id": uid("req"),
"request-id": uid("req"),
```
These two headers should contain the same request identifier for correlation. Instead they receive independent random values.
**Impact:** Request tracing across logs and upstream systems is broken because `x-request-id` and `request-id` don't match.
**Fix:**
```javascript
const reqId = uid("req");
return {
  "x-request-id": reqId,
  "request-id": reqId,
  ...extra,
  ...corsHeaders(),
};
```

---

### CR-017: `top_k` parameter forwarded to upstream API that does not support it

**File:** `src/anthropic.js:112-121`
**Severity:** Critical
**Category:** compliance
**Description:** `translateAnthropicToChat` maps `body.top_k` → `chat.top_k`. The OpenAI Chat Completions specification does not define `top_k`; some strict upstream implementations will reject requests containing unknown parameters with HTTP 400.
**Impact:** Anthropic clients that include `top_k` see 100% request failure against strict upstream endpoints.
**Fix:** Either omit `top_k` from the translation or gate it behind an env flag:
```javascript
// Remove top_k from the paramMap
const paramMap = {
  temperature: "temperature",
  top_p: "top_p",
  stop_sequences: "stop",
  max_tokens: "max_tokens",
};
```

---

## Warning Findings

### WR-001: `mapModelName` contradicts its own comment—all unrecognized models are discarded

**File:** `src/index.js:28-50`
**Severity:** Warning
**Category:** quality
**Description:** The JSDoc says "Everything else passes through (real model names like deepseek-v4-flash)", but the fallback on line 49 unconditionally returns the default model. Real model names do **not** pass through.
**Fix:** Align code with comment, or update the comment to reflect the actual behavior.

---

### WR-002: Gateway fallback only triggers on exact HTTP 400

**File:** `src/upstream.js:59-63`
**Severity:** Warning
**Category:** quality
**Description:** `sendChatRequest` returns immediately for any status other than 400. Gateway outages typically manifest as 502/503/504. These bypass the direct-upstream fallback entirely, meaning Gateway failures are not recovered even when direct upstream is healthy.
**Fix:** Consider falling back on 5xx gateway errors as well, gated by an env flag.

---

### WR-003: Unrecognized Responses API input item types are silently dropped

**File:** `src/responses.js:43-106`
**Severity:** Warning
**Category:** compliance
**Description:** The `switch` statement lacks a `default` case. Valid Responses API item types such as `file`, `image`, `web_search_call`, `computer_call`, and `computer_call_output` are silently ignored. The client receives no indication that part of the input was discarded.
**Fix:** Add a `default` case that logs a warning and either preserves the item or returns an error for unsupported types.

---

### WR-004: `extractText` silently discards image blocks

**File:** `src/utils.js:35-58`
**Severity:** Warning
**Category:** quality
**Description:** `extractText` handles `text`, `thinking`, and `redacted_thinking` types, but skips `image` blocks without warning. When used on multimodal content arrays, images vanish without a trace.
**Fix:** Add a comment or warning log when image blocks are encountered in text-extraction contexts.

---

### WR-005: `filterChatStream` discards the final buffered line if stream ends without trailing newline

**File:** `src/index.js:202-269`
**Severity:** Warning
**Category:** bug
**Description:** After the `while (true)` loop exits on `done`, any remaining text in `buffer` is discarded. Well-formed SSE should end with `\n\n`, but abrupt upstream disconnects can leave a partial final event in the buffer.
**Fix:** After the loop, if `buffer.trim()` is non-empty, yield it or log a warning about the truncated event.

---

### WR-006: `pipeEventStream` and `pipeChatStream` in `utils.js` are dead code with broken SSE framing

**File:** `src/utils.js:186-223`
**Severity:** Warning
**Category:** quality
**Description:** `utils.js` exports `pipeEventStream` and `pipeChatStream` created via `createPipeStream`, but nothing imports them. The event serializer omits the required second newline (`\n\n`), producing invalid SSE.
**Fix:** Either delete the dead code, or fix the format and migrate `index.js` to use these shared utilities to eliminate duplication.

---

### WR-007: Inconsistent upstream error reading between handlers

**File:** `src/index.js:271-304`, `src/index.js:308-346`, `src/index.js:360-402`
**Severity:** Warning
**Category:** quality
**Description:** `handleChatCompletions` reads errors as plain text (`safeReadUpstreamBody`). `handleResponsesAPI` and `handleAnthropicMessages` read errors as JSON (`readUpstreamErrorSafe`). If the upstream returns HTML (e.g., a load balancer error page) to the Responses/Anthropic handlers, the JSON parse fails and the diagnostic detail is lost.
**Fix:** Unify on a single robust error reader that attempts JSON first, then falls back to text, always returning both to the caller.

---

### WR-008: `normalizeDsmlToolCalls` mutates the response body in-place

**File:** `src/index.js:413-459`
**Severity:** Warning
**Category:** quality
**Description:** The function modifies `msg.content`, `msg.tool_calls`, and `choice.finish_reason` on the object returned by `upstreamResponse.json()`. While currently safe because the object is not reused, this creates a hidden coupling: future callers that attempt to cache or re-read the body will see mutated state.
**Fix:** Return a deep copy or explicitly clone the choice before mutation.

---

### WR-009: `authenticate` reveals configuration state on missing token

**File:** `src/utils.js:92-96`
**Severity:** Warning
**Category:** security
**Description:** When `env.AI_GATEWAY_TOKEN` is missing, the worker returns HTTP 500 with "Server configuration error". This confirms to an unauthenticated requester that the server lacks credentials, distinguishing it from a valid-but-wrong token (401).
**Fix:** Return 401 for both missing server token and invalid client token to avoid information leakage. Log the 500-level condition server-side.

---

### WR-010: `translateAnthropicStream` `message_delta` omits `input_tokens`

**File:** `src/anthropic.js:323-330`
**Severity:** Warning
**Category:** compliance
**Description:** The final `message_delta` event only includes `output_tokens`. Anthropic's streaming specification typically includes both `input_tokens` and `output_tokens` in the usage block of `message_delta`.
**Fix:** Include `input_tokens: streamUsage.input_tokens` in the `message_delta` usage object.

---

## Info Findings

### IF-001: `createLogger` does not redact sensitive fields

**File:** `src/utils.js:129-150`
**Severity:** Info
**Category:** security
**Description:** The structured logger JSON-stringifies whatever data object is passed. If a developer accidentally logs request headers, bodies, or upstream responses, tokens and PII will appear in Cloudflare logs unredacted.
**Recommendation:** Add a shallow redaction pass that scrubs known sensitive keys (`Authorization`, `x-api-key`, `api_key`, `token`, `password`) before stringification.

---

### IF-002: `streamSSE` silently skips malformed JSON chunks

**File:** `src/utils.js:247-249`
**Severity:** Info
**Category:** observability
**Description:** Malformed `data:` lines are caught and ignored with an empty catch block. In a streaming translation context, silently dropping chunks can cause the client to wait indefinitely for completion events that will never arrive.
**Recommendation:** At minimum, increment a counter of dropped chunks and log it at stream end. Consider yielding an error event if the drop rate exceeds a threshold.

---

### IF-003: `BYPASS_GATEWAY: "true"` set as default in `wrangler.jsonc`

**File:** `wrangler.jsonc:26`
**Severity:** Info
**Category:** quality
**Description:** The default deployed configuration bypasses the Cloudflare AI Gateway entirely, contradicting the project's primary value proposition (Gateway caching, analytics, and rate limiting).
**Recommendation:** Set default to `"false"` or omit the variable so the Gateway path is used unless explicitly overridden.

---

### IF-004: `translateAnthropicToChat` includes `thinking` config unsupported by most Chat Completions endpoints

**File:** `src/anthropic.js:151-156`
**Severity:** Info
**Category:** compliance
**Description:** The `thinking` object with `budget_tokens` is a DeepSeek/OpenCode-specific extension, not part of the standard OpenAI Chat Completions schema. Strict upstreams may reject it.
**Recommendation:** Document this non-standard parameter or gate it behind an environment flag.

---

### IF-005: `package.json` references 88 unit tests but no test files are present in the source tree

**File:** `package.json:8-9`
**Severity:** Info
**Category:** quality
**Description:** The README and package scripts reference a test suite, but the project root contains no `tests/` or `__tests__/` directory. This suggests the tests either live outside the repo or have not been committed.
**Recommendation:** Ensure tests are committed and that `npm test` passes in CI.

---

## Fix Plan

**Phase 1 (Immediate — correctness & security):**
1. Fix Responses API string-input handling (CR-001).
2. Sanitize upstream error bodies before returning to clients (CR-002).
3. Fix hardcoded model names by threading the resolved model through translations (CR-004).
4. Fix mismatched message IDs in Responses streaming (CR-005).
5. Fix `toolCallsMap` clearing bug (CR-006).
6. Fix dropped Anthropic assistant `tool_use` blocks (CR-009).
7. Fix non-standard `images` field in Anthropic user messages (CR-010).
8. Strip `reasoning_content` in non-streaming Chat Completions (CR-011).
9. Fix timeout NaN bug (CR-008).
10. Handle `fetchUpstream` abort errors gracefully (CR-013).

**Phase 2 (Stability & robustness):**
11. Cap `filterChatStream` buffer size (CR-007).
12. Replace DSML regex with safe parser or add input-length guard (CR-012).
13. Add structured logging to all streaming catch blocks (CR-014).
14. Apply rate limiting to authentication attempts (CR-015).
15. Fix rate limiter to use `env` variables and add TTL eviction (CR-003).
16. Fix `anthropicHeaders` duplicate request IDs (CR-016).
17. Remove or gate `top_k` translation (CR-017).

**Phase 3 (Cleanup & compliance):**
18. Unify upstream error reading across handlers (WR-007).
19. Delete or fix dead code in `utils.js` (WR-006).
20. Update misleading `mapModelName` comment (WR-001).
21. Add default case for unknown Responses input types (WR-003).
22. Add test files to repository (IF-005).
