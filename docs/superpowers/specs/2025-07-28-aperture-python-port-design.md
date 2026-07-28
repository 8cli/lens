# Aperture Python Port — Design Spec

> **Date:** 2025-07-28
> **Status:** Approved
> **Target:** General-purpose Python AI protocol translator, deployable on OpenWRT (x86/64) and any Linux environment

---

## 1. Overview

Port Aperture (an AI protocol translator) from JavaScript/Cloudflare Workers to pure Python 3.10+.

### Core Mission (unchanged)

```
Client (OpenAI Responses API / Anthropic Messages API / Chat Completions)
  → Aperture (protocol translation)
    → Upstream (OpenAI-compatible, e.g. opencode.ai)
```

- Translate **OpenAI Responses API** → Chat Completions
- Translate **Anthropic Messages API** → Chat Completions
- Chat Completions pass-through (with DSML tool call normalization)
- All model names → `DEFAULT_MODEL` (single model routing)
- SSE streaming for all protocols

### What's NOT in scope

- Search execution (handled by MCP client-side)
- Authentication management / multi-user support
- Persistence / database — stateless
- AI Gateway (Cloudflare-specific) — simplified to direct-only in Python version

---

## 2. Architecture

### Dependency strategy

Single dependency: **aiohttp** (for both HTTP server and HTTP client).

| Dependency | Purpose | Alternative considered |
|---|---|---|
| `aiohttp` | HTTP server + async client | FastAPI (too heavy), stdlib (too low-level) |

No other runtime dependencies. `python-dotenv` is optional (loaded only if `.env` file exists).

### Directory structure

```
aperture/
├── __init__.py            # Package marker, version string
├── __main__.py            # Entry: python -m aperture [--port 8080]
├── config.py              # Env var parsing, model mapping
├── helpers.py             # uid(), now(), extract_text(), error_response(), fetch_upstream()
├── stream.py              # stream_sse() async generator, pipe_sse()
├── upstream.py            # build_upstream_url(), send_chat_request()
├── index.py               # aiohttp app factory, route dispatch, CORS
├── middleware/
│   ├── __init__.py
│   ├── auth.py            # authenticate()
│   ├── rate_limiter.py    # create_rate_limiter() — in-memory dict
│   └── logger.py          # create_logger() — structured JSON
├── handlers/
│   ├── __init__.py
│   ├── chat.py            # handle_chat_completions(), filter_chat_stream()
│   ├── responses.py       # handle_responses_api()
│   └── anthropic.py       # handle_anthropic_messages()
└── translators/
    ├── __init__.py
    ├── responses.py       # translate_to_chat(), translate_stream_events(), translate_response_json()
    ├── anthropic.py       # translate_anthropic_to_chat(), translate_anthropic_stream(), translate_anthropic_json()
    └── dsml.py            # normalize_dsml_tool_calls()
```

Total: ~2000-2200 lines of Python.

### Module responsibilities (unchanged from JS)

| Module | Responsibility | Lines (est.) | JS equiv | Translator type |
|---|---|---|---|---|
| `config.py` | Constants, env parsing, model name mapping | 60 | config.js | Pure function |
| `helpers.py` | uid, now, extract_text, error_response, cors, fetch_upstream | 120 | helpers.js | Pure function + async util |
| `stream.py` | SSE line parser, SSE pipe to Response | 140 | stream.js | Async generator |
| `upstream.py` | Build URL, choose API key, send request | 130 | upstream.js | Async orchestration |
| `middleware/auth.py` | API key check | 35 | auth.js | Pure function |
| `middleware/rate_limiter.py` | In-memory sliding window | 40 | rate-limiter.js | Closure/class |
| `middleware/logger.py` | Structured JSON logger | 30 | logger.js | Class |
| `handlers/chat.py` | Chat route: filter stream, DSML normalization | 140 | chat.js | Async orchestration |
| `handlers/responses.py` | Responses route: translate→send→translate back | 65 | responses.js | Async orchestration |
| `handlers/anthropic.py` | Anthropic route: translate→send→translate back | 80 | anthropic.js | Async orchestration |
| `translators/responses.py` | OpenAI Responses ↔ Chat Completions | 460 | responses.js | Pure function |
| `translators/anthropic.py` | Anthropic ↔ Chat Completions | 470 | anthropic.js | Pure function |
| `translators/dsml.py` | DSML XML tool call normalization | 75 | dsml.js | Pure function |
| `index.py` | App factory, CORS, routing | 120 | index.js | App setup |
| `__main__.py` | CLI entry point | 30 | — | — |

---

## 3. Request Lifecycle

### 3.1 HTTP Pipeline

```
Client → aiohttp.web (TCP :8080 default)
  │
  ├── [aiohttp middleware stack]
  │   ├── cors_middleware     → adds CORS headers
  │   ├── rate_limiter_middleware → 429 if exceeded
  │   └── auth_middleware     → 401 if invalid/missing API key
  │
  ├── GET  /v1/models, /models → list_models()
  ├── POST /v1/chat/completions, /chat/completions → chat_handler
  ├── POST /v1/messages, /messages → anthropic_handler
  └── POST * (auto-detect from body):
      ├── body.messages present → chat_handler
      ├── body.input or body.instructions → responses_handler
      ├── body.anthropic_version → anthropic_handler
      └── default → responses_handler
```

### 3.2 Route Detection (direct translation of JS logic)

```python
def detect_route(path: str, body: dict) -> str:
    if path in ("/v1/chat/completions",) or path.endswith("/chat/completions"):
        return "chat"
    if path in ("/v1/messages",) or path.endswith("/messages"):
        return "anthropic"
    if "messages" in body:
        return "chat"
    if "input" in body or "instructions" in body:
        return "responses"
    if body.get("anthropic_version") or body.get("anthropic"):
        return "anthropic"
    return "responses"
```

### 3.3 Handler Structure (all handlers follow same pattern)

```python
async def handle_chat(body: dict, app: web.Application) -> web.StreamResponse:
    body["model"] = map_model_name(body.get("model"), app)
    client = app["client"]
    response = await client.post(upstream_url, json=body, headers=build_auth_headers(app))
    if not response.ok:
        return error_response(...)

    if body.get("stream"):
        return StreamingResponse(translate_response_stream(response, ...))
    else:
        result = await translate_response_json(response, ...)
        return json_response(result)
```

---

## 4. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APERTURE_BIND` | `0.0.0.0:8080` | Listen address |
| `APERTURE_UNIX_SOCKET` | — | Unix socket path (overrides TCP bind) |
| `UPSTREAM_BASE_URL` | `https://opencode.ai/zen/go/v1` | Upstream API base |
| `DEFAULT_MODEL` | `deepseek-v4-flash` | Default/fallback model |
| `API_KEY` | `None` | Required: client auth + upstream auth |
| `MODEL_MAP` | `{}` | JSON object: alias→target model mapping |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout in ms |
| `RATE_LIMIT_MAX` | `120` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Time window in ms |

Load order: env vars → `.env` file (optional, loaded if exists).

---

## 5. SSE Streaming

### 5.1 Inbound (parsing upstream SSE)

Uses aiohttp `Content` reader (which is already an async generator of bytes):

```python
async def stream_sse(response: aiohttp.ClientResponse) -> AsyncIterator[dict]:
    buf = b""
    total = 0
    MAX_BUF = 2 * 1024 * 1024

    async for chunk in response.content:
        total += len(chunk)
        if total > MAX_BUF:
            raise RuntimeError("SSE buffer exceeded 2MB limit")
        buf += chunk
        lines = buf.split(b"\n")
        buf = lines.pop()
        for line in lines:
            if not line.startswith(b"data: "):
                continue
            payload = line[6:].strip()
            if payload == b"[DONE]":
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                pass
```

### 5.2 Outbound (streaming SSE to client)

Uses aiohttp `StreamResponse`:

```python
async def pipe_sse(generator: AsyncIterator, request: web.Request) -> web.StreamResponse:
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            **cors_headers(),
        },
    )
    await resp.prepare(request)
    async for event in generator:
        sse_text = f"event: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"
        await resp.write(sse_text.encode())
    return resp
```

---

## 6. Chat Stream Filtering

Direct translation of `filterChatStream()`:

- Strips `reasoning_content` from DeepSeek streaming deltas (Trae IDE compat)
- Converts `content: null` → `""` (some clients choke on null)
- Skips chunks that are only reasoning (no actual text content)

Logic is a pure async generator, same as JS version.

---

## 7. Upstream Client

### 7.1 Connection Management

- Single `aiohttp.ClientSession` created at app startup
- 120s default timeout
- TCP connection reuse (keepalive)

### 7.2 Gateway Fallback (removed)

JS version had Cloudflare AI Gateway fallback logic. Python version **always sends directly** to `UPSTREAM_BASE_URL`. The gateway logic is removed to keep the codebase simple and portable.

### 7.3 Error Handling

- Network errors → 502
- Upstream 5xx (non-retryable) → propagated to client
- Timeout → 504
- All errors logged via logger middleware

---

## 8. Rate Limiter (in-memory dict)

Direct translation of JS version:

```python
import time
import random

def create_rate_limiter(window_ms: int, max_requests: int):
    hits: dict[str, dict] = {}

    def check(key: str) -> tuple[bool, float]:
        now = time.time() * 1000

        # Pruning: 2% chance when oversized (keeps hot path fast)
        if len(hits) > max_requests * 2 and random.random() < 0.02:
            hits = {k: v for k, v in hits.items()
                    if now - v["window_start"] <= window_ms}

        record = hits.get(key)
        if not record or now - record["window_start"] > window_ms:
            hits[key] = {"window_start": now, "count": 1}
            return True, now + window_ms

        if record["count"] >= max_requests:
            return False, record["window_start"] + window_ms

        record["count"] += 1
        return True, record["window_start"] + window_ms

    return check
```

**Known limitation:** Process restart resets counters (same as JS Worker eviction). Acceptable for stateless proxy.

---

## 9. Translator Modules (Pure Functions)

### 9.1 `translators/responses.py` (~460 lines)

Converts OpenAI Responses API requests to Chat Completions:

| Input (Responses API) | Output (Chat Completions) |
|---|---|
| `body.input` as string or array of messages | `messages` array |
| `body.instructions` | `system` message prepended |
| `body.tools` (function type) | `tools` array |
| `body.tool_choice` | `tool_choice` |
| `body.max_output_tokens` | `max_tokens` |
| `body.stream: true` | `stream: true` |
| streaming `tool_search_call` blocks | passthrough as function_call |
| Upstream chat streaming chunks | Responses API streaming events |
| Upstream chat JSON | Responses API JSON |

### 9.2 `translators/anthropic.py` (~470 lines)

Converts Anthropic Messages API requests to Chat Completions:

| Input (Anthropic) | Output (Chat Completions) |
|---|---|
| `body.system` string/array | `system` message prepended |
| `body.messages[].role: user` | `user` + inline images as `image_url` |
| `body.messages[].role: assistant` | `assistant` + `tool_calls` conversion |
| `body.messages[].tool_result` | `tool` role messages |
| `body.tools` (custom/function) | `tools` (function type) |
| `body.thinking` | `thinking` config pass-through |
| streaming chunks | Anthropic `message_start` / `content_block_start` / `delta` / `stop` events |

### 9.3 `translators/dsml.py` (~75 lines)

Console Go DSML XML → standard `tool_calls` conversion. Pure regex, no change from JS.

---

## 10. Testing

### 10.1 Framework: pytest

```bash
pip install pytest pytest-asyncio aiohttp
pytest tests/ -v
```

### 10.2 Test files

| Test file | Tests | Type |
|---|---|---|
| `test_translate_to_chat.py` | translate_to_chat() pure function | Unit |
| `test_translate_anthropic.py` | translate_anthropic_to_chat() pure function | Unit |
| `test_translate_stream.py` | translate_stream_events() async generator | Async |
| `test_filter_stream.py` | filter_chat_stream() async generator | Async |
| `test_dsml.py` | normalize_dsml_tool_calls() | Unit |
| `test_helpers.py` | uid(), now(), extract_text(), error_response() | Unit |
| `test_config.py` | map_model_name(), resolve_default_model() | Unit |
| `test_middleware.py` | auth, rate_limiter, logger | Unit |
| `test_upstream.py` | send_chat_request() with mock | Async + mock |
| `test_handlers.py` | All 3 handlers via aiohttp TestClient | Integration |
| `test_e2e.py` | Full HTTP round-trip (optional, requires live upstream) | E2E |

### 10.3 Test strategy

- **Translators (pure functions):** Direct input→output test cases, ~80% of test surface
- **Handlers:** aiohttp `TestClient` for request→response tests
- **Upstream:** Mock `ClientSession` for network error scenarios
- **E2E:** Manual/CI only, not in default suite

---

## 11. CLI Usage

```bash
# Default: TCP 0.0.0.0:8080
python -m aperture

# Custom port
python -m aperture --port 3000

# Unix socket (for nginx/uhttpd reverse proxy)
python -m aperture --socket /var/run/aperture.sock

# Help
python -m aperture --help
```

Built with `argparse` (stdlib, no extra dependency).

---

## 12. OpenWRT Deployment

```bash
# Install Python 3 + aiohttp
opkg update
opkg install python3
pip3 install aiohttp

# Copy aperture package
scp -r ./aperture/ root@openwrt:/usr/lib/python3.11/site-packages/

# Create init script /etc/init.d/aperture (procd-based)
cat > /etc/init.d/aperture << 'INIT'
#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1

start_service() {
    procd_open_instance
    procd_set_param command /usr/bin/python3 -m aperture
    procd_set_param env APERTURE_BIND=0.0.0.0:8080
    procd_set_param env API_KEY=sk-...
    procd_set_param respawn
    procd_close_instance
}
INIT
chmod +x /etc/init.d/aperture
service aperture enable
service aperture start
```

~2 MB disk (aiohttp + deps), ~15-25 MB RAM at runtime.

---

## 13. Deviations from JS Version

| Aspect | JS (CF Workers) | Python (aiohttp) | Reason |
|---|---|---|---|
| Gateway fallback | Yes (CF AI Gateway 5xx→direct) | No (always direct) | CF-specific logic, not portable |
| Config source | `env` binding (Wrangler) | `os.environ` + optional `.env` | Portable approach |
| Entry point | CF Worker `fetch()` handler | `__main__.py` argparse CLI | Need explicit server |
| Auth | `AI_GATEWAY_TOKEN` dual-use | `API_KEY` single env var | Simplified for standalone |
| Rate limiter state | Per-isolate Map | Process dict | Same behavior |
| Middleware | Inline in index.js | aiohttp middleware stack | Python web convention |

---

## 14. File-by-file Implementation Plan

Ordered by dependency (no file depends on a later file):

1. **`aperture/__init__.py`** — version string
2. **`aperture/config.py`** — env parsing, model mapping (60 lines)
3. **`aperture/helpers.py`** — uid, now, extract_text, error_response, cors_headers (120 lines)
4. **`aperture/stream.py`** — stream_sse, pipe_sse (140 lines)
5. **`aperture/middleware/logger.py`** — create_logger (30 lines)
6. **`aperture/middleware/rate_limiter.py`** — create_rate_limiter (40 lines)
7. **`aperture/middleware/auth.py`** — authenticate (35 lines)
8. **`aperture/translators/dsml.py`** — normalize_dsml_tool_calls (75 lines)
9. **`aperture/translators/responses.py`** — translate_to_chat, translate_stream_events, translate_response_json (460 lines)
10. **`aperture/translators/anthropic.py`** — translate_anthropic_to_chat, translate_anthropic_stream, translate_anthropic_json (470 lines)
11. **`aperture/upstream.py`** — build_upstream_url, send_chat_request (130 lines)
12. **`aperture/handlers/chat.py`** — handle_chat_completions, filter_chat_stream (140 lines)
13. **`aperture/handlers/responses.py`** — handle_responses_api (65 lines)
14. **`aperture/handlers/anthropic.py`** — handle_anthropic_messages (80 lines)
15. **`aperture/index.py`** — app factory, routes, middleware registration (120 lines)
16. **`aperture/__main__.py`** — CLI entry (30 lines)

Total: ~2000-2200 lines across 16 files.
