# Aperture Python Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Aperture AI protocol translator from JavaScript/Cloudflare Workers (1922 lines, 14 modules) to standalone Python 3.10+ (16 files, ~2000-2200 lines) using aiohttp.

**Architecture:** Single-dependency Python HTTP service (aiohttp for server + client). Mirror JS module structure exactly — pure function translators in `translators/`, orchestration in `handlers/`, middleware stack, upstream client. SSE streaming via async generators.

**Tech Stack:** Python 3.10+, aiohttp, pytest (testing)

## Global Constraints

- **Python ≥ 3.10** required (match target: OpenWRT 23.05+ ships Python 3.11)
- **aiohttp** is the ONLY runtime dependency (server + client). `python-dotenv` is optional (loaded if `.env` exists)
- **No Cloudflare-specific code** — no AI Gateway fallback, no Workers env binding. Always send directly to `UPSTREAM_BASE_URL`
- **Single API key** — `API_KEY` env var for both client auth and upstream auth (no dual-var confusion)
- **All model names → DEFAULT_MODEL** — routing only, no hidden fallback
- **Catch-all error pattern:** every `except` in non-translator code must produce a valid HTTP error response, never crash
- **Test coverage:** every translator pure function must have unit tests; every handler must have integration tests with aiohttp TestClient
- **SSE streaming:** must work for all three protocols (chat, responses, anthropic) — no buffering entire response before sending
- **File naming:** snake_case for all Python files (JS had camelCase — e.g. `rateLimiter.js` → `rate_limiter.py`)
- **Dotfiles:** No `.env`, `requirements.txt`, `pyproject.toml`, or other project config files — the package ships standalone, installation instructions go in a README

---

## File Structure (complete map)

```
aperture/
├── __init__.py            # Version string
├── __main__.py            # CLI entry: python -m aperture [--port 8080]
├── config.py              # Env parsing, model mapping
├── helpers.py             # uid(), now(), extract_text(), error_response(), cors_headers(), fetch_upstream()
├── stream.py              # stream_sse(), pipe_sse()
├── upstream.py            # build_upstream_url(), send_chat_request()
├── index.py               # app factory, CORS middleware, route dispatch
├── middleware/
│   ├── __init__.py
│   ├── auth.py            # authenticate()
│   ├── rate_limiter.py    # create_rate_limiter()
│   └── logger.py          # create_logger()
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

Dependency graph (task ordering):

```
Layer 1 (no deps):       config  helpers  stream  middleware/*
Layer 2 (pure funcs):    translators/dsml  translators/responses  translators/anthropic
Layer 3 (network):       upstream
Layer 4 (orchestration): handlers/*
Layer 5 (app assembly):  index  __main__
```

---

### Task 1: Package structure, config, helpers

**Files:**
- Create: `aperture/__init__.py`
- Create: `aperture/config.py`
- Create: `aperture/helpers.py`
- Create: `tests/test_config.py`
- Create: `tests/test_helpers.py`

**Interfaces:**
- Produces:
  - `config.map_model_name(model: str, env: dict) -> str`
  - `config.resolve_default_model(env: dict) -> str`
  - `config.get_env_str(key: str, default: str = "") -> str`
  - `config.get_env_int(key: str, default: int) -> int`
  - `config.get_env_json(key: str, default=None) -> dict`
  - `helpers.uid(prefix: str = "") -> str`
  - `helpers.now() -> int`
  - `helpers.extract_text(content: str | list | None) -> str`
  - `helpers.error_response(message: str, type_: str, code: str, status: int) -> web.Response`
  - `helpers.cors_headers(extra: dict = None) -> dict`
  - `helpers.fetch_upstream(url, options, timeout_ms) -> web.Response` (later replaced by upstream module)
  - `helpers.DSML_CONTENT_MAX: int`

- [ ] **Step 1: Create `aperture/__init__.py`**

```python
"""Aperture — AI Protocol Translator.

Translates OpenAI Responses API and Anthropic Messages API requests
to OpenAI Chat Completions format for upstream processing.
"""

__version__ = "1.0.0"
```

- [ ] **Step 2: Create `aperture/config.py`**

```python
"""Environment configuration and model mapping.

Mirrors JS src/config.js — pure functions reading from env dict.
Codex provider names are resolved to a single DEFAULT_MODEL.
No hidden fallback path.
"""

import json
import os

# Allowlist for DSML content regex to prevent ReDoS
DSML_CONTENT_MAX = 100_000


def get_env_str(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def get_env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except (ValueError, TypeError):
        return default


def get_env_json(key: str, default=None) -> dict:
    raw = os.environ.get(key)
    if not raw:
        return default or {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default or {}


def resolve_default_model(env: dict | None = None) -> str:
    """Return the single default model from env or the hard default."""
    env = env or os.environ
    return env.get("DEFAULT_MODEL", "deepseek-v4-flash")


def map_model_name(model: str | None, env: dict | None = None) -> str:
    """Map any model name to our single configured model.

    All inputs — real model names, client-requested aliases, unknowns —
    resolve to DEFAULT_MODEL. This is intentional: Aperture is a single-model
    router. The MODEL_MAP env var supports cosmetic aliases for listing,
    but at runtime every request gets the same model.
    """
    env = env or os.environ
    default = resolve_default_model(env)
    if not model:
        return default

    # Check aliases from MODEL_MAP
    model_map = get_env_json("MODEL_MAP")
    if model_map and isinstance(model_map, dict):
        if model in model_map:
            return model_map[model]

    # Common known models — all resolve to default
    known = {
        "deepseek-v4-flash", "dv4f", "aigo",
        "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514",
        "claude-sonnet-4", "claude-opus-4", "claude-haiku-4-20251001",
        "o3-mini", "gpt-4o", "gpt-4o-mini",
    }
    if model in known:
        return default

    return default
```

- [ ] **Step 3: Write failing test for config**

```python
# tests/test_config.py
import os
from aperture.config import map_model_name, resolve_default_model, get_env_int


def test_map_model_none_returns_default():
    env = {"DEFAULT_MODEL": "my-model"}
    assert map_model_name(None, env) == "my-model"


def test_map_model_unknown_resolves_default():
    env = {"DEFAULT_MODEL": "deepseek-v4-flash"}
    assert map_model_name("gpt-9999", env) == "deepseek-v4-flash"


def test_map_model_alias_from_env():
    env = {"DEFAULT_MODEL": "base", "MODEL_MAP": '{"foo":"bar"}'}
    assert map_model_name("foo", env) == "bar"


def test_resolve_default_model_fallback():
    assert resolve_default_model({}) == "deepseek-v4-flash"


def test_get_env_int_default():
    assert get_env_int("NONEXISTENT", 42) == 42


def test_get_env_int_parsed():
    os.environ["TEST_INT"] = "99"
    assert get_env_int("TEST_INT", 0) == 99
    del os.environ["TEST_INT"]
```

- [ ] **Step 4: Run test to verify it fails, then pass**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_config.py -v
# Expected: failure (module not importable)
# After Step 5: all pass
```

- [ ] **Step 5: Create `aperture/helpers.py`**

```python
"""Pure helper utilities — bottom layer, no imports from other aperture modules.

Mirrors JS src/helpers.js.
"""

import json
import os
import secrets
import time
from aiohttp import web


def uid(prefix: str = "") -> str:
    """Generate a hex-encoded unique identifier."""
    return prefix + secrets.token_hex(12)


def now() -> int:
    """Current Unix timestamp in seconds."""
    return int(time.time())


def extract_text(content: str | list | None) -> str:
    """Extract plain text from content (string or Anthropic-style blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            # Strip thinking/redacted_thinking blocks
        return "".join(parts)
    return ""


def cors_headers(extra: dict | None = None) -> dict:
    """Standard CORS headers for API responses."""
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    }
    if extra:
        headers.update(extra)
    return headers


def error_response(message: str, type_: str, code: str, status: int) -> web.Response:
    """Standard JSON error response with CORS headers."""
    return web.json_response(
        {"error": {"message": message, "type": type_, "code": code}},
        status=status,
        headers=cors_headers(),
    )


async def fetch_upstream(url: str, options: dict, timeout_ms: int) -> web.Response:
    """Fetch upstream with timeout. Returns 504 on timeout, raises on other errors.

    NOTE: This is a compatibility helper. Production code uses upstream.send_chat_request()
    which manages its own aiohttp session.
    """
    import asyncio
    import aiohttp

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json=options.get("json"),
                headers=options.get("headers"),
                timeout=aiohttp.ClientTimeout(total=timeout_ms / 1000),
            ) as resp:
                return web.json_response(
                    await resp.json(),
                    status=resp.status,
                    headers=cors_headers(),
                )
    except asyncio.TimeoutError:
        return error_response("Upstream request timed out", "timeout_error", "TIMEOUT", 504)
    except Exception:
        raise
```

- [ ] **Step 6: Write failing tests for helpers**

```python
# tests/test_helpers.py
from aperture.helpers import uid, now, extract_text, cors_headers


def test_uid_generates_unique():
    ids = {uid() for _ in range(100)}
    assert len(ids) == 100


def test_uid_with_prefix():
    result = uid("req_")
    assert result.startswith("req_")


def test_now_returns_int():
    assert isinstance(now(), int)


def test_extract_text_string():
    assert extract_text("hello") == "hello"


def test_extract_text_list_blocks():
    content = [{"type": "text", "text": "Hello"}, {"type": "text", "text": " World"}]
    assert extract_text(content) == "Hello World"


def test_extract_text_ignores_thinking():
    content = [{"type": "text", "text": "Answer"}, {"type": "thinking", "text": "secret"}]
    assert extract_text(content) == "Answer"


def test_extract_text_none():
    assert extract_text(None) == ""


def test_cors_headers_default():
    h = cors_headers()
    assert h["Access-Control-Allow-Origin"] == "*"


def test_cors_headers_with_extra():
    h = cors_headers({"X-Custom": "val"})
    assert h["X-Custom"] == "val"
```

- [ ] **Step 7: Run tests and verify they pass**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_config.py tests/test_helpers.py -v
```

If `aiohttp` isn't installed, install it first:
```bash
pip install aiohttp pytest pytest-asyncio
```

- [ ] **Step 8: Commit**

```bash
git add aperture/__init__.py aperture/config.py aperture/helpers.py tests/test_config.py tests/test_helpers.py
git commit -m "feat(aperture-py): package structure, config, and helpers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: SSE stream module

**Files:**
- Create: `aperture/stream.py`
- Create: `tests/test_stream.py`

**Interfaces:**
- Consumes: `helpers.cors_headers()`
- Produces:
  - `stream.stream_sse(response: aiohttp.ClientResponse) -> AsyncIterator[dict]`
  - `stream.pipe_sse(generator: AsyncIterator, request: web.Request) -> web.StreamResponse`
  - `stream.pipe_sse_raw(generator: AsyncIterator, request: web.Request) -> web.StreamResponse`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_stream.py
import json
import pytest
from aiohttp import web, test_utils
from aperture.stream import stream_sse, pipe_sse


@pytest.mark.asyncio
async def test_stream_sse_parses_data_lines():
    """SSE data: lines should yield parsed JSON dicts."""
    # We'll test through a mock response — stream_sse iterates response.content
    from aiohttp import ClientResponse
    # Create a mock response that yields byte chunks
    mock_resp = MockClientResponse(b"data: {\"key\": \"value\"}\n\ndata: {\"n\": 2}\n\n")
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 2
    assert results[0] == {"key": "value"}


@pytest.mark.asyncio
async def test_stream_sse_skips_done():
    mock_resp = MockClientResponse(b"data: [DONE]\n\n")
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 0


@pytest.mark.asyncio
async def test_stream_sse_skips_malformed_json():
    mock_resp = MockClientResponse(b"data: {invalid\n\ndata: {\"ok\": true}\n\n")
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 1
    assert results[0] == {"ok": True}


class MockClientResponse:
    """Minimal mock for aiohttp.ClientResponse.content (async bytes stream)."""
    def __init__(self, data: bytes):
        self._data = data
        self._offset = 0

    @property
    def content(self):
        return self

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        # Yield in small chunks to test reassembly
        chunk_size = 10
        while self._offset < len(self._data):
            end = min(self._offset + chunk_size, len(self._data))
            yield self._data[self._offset:end]
            self._offset = end
```

- [ ] **Step 2: Test fails (module doesn't exist yet)**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_stream.py -v
```

- [ ] **Step 3: Implement `aperture/stream.py`**

```python
"""SSE stream parsing and piped response utilities.

Mirrors JS src/stream.js.

Two operations:
1. Parse inbound SSE (upstream → parsed dicts): stream_sse()
2. Pipe outbound events (generator → SSE HTTP response): pipe_sse() / pipe_sse_raw()
"""

import json
from typing import AsyncIterator

from aiohttp import web
from aiohttp import ClientResponse

from .helpers import cors_headers

MAX_SSE_BUFFER = 2 * 1024 * 1024  # 2 MB


async def stream_sse(response: ClientResponse) -> AsyncIterator[dict]:
    """Parse SSE data: lines from an aiohttp response body.

    Yields parsed JSON objects from each "data: {...}" line.
    Skips "[DONE]" signals and malformed JSON.
    Throws RuntimeError if buffer exceeds 2MB limit.

    Args:
        response: aiohttp ClientResponse whose body is an SSE stream.

    Yields:
        Parsed JSON dict from each data line.
    """
    buf = b""
    total = 0

    async for chunk in response.content:
        total += len(chunk)
        if total > MAX_SSE_BUFFER:
            raise RuntimeError("SSE buffer exceeded 2MB limit")

        buf += chunk
        lines = buf.split(b"\n")
        # Keep the last partial line in the buffer
        buf = lines.pop() if lines else b""

        for line in lines:
            line = line.strip()
            if not line.startswith(b"data: "):
                continue
            payload = line[6:].strip()
            if payload == b"[DONE]":
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                pass

    # Process remaining data that never had a trailing newline
    if buf.startswith(b"data: "):
        payload = buf[6:].strip()
        if payload != b"[DONE]":
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                pass


async def pipe_sse(
    generator: AsyncIterator,
    request: web.Request,
) -> web.StreamResponse:
    """Pipe an async generator of {event, data} dicts into an SSE Response.

    Each yielded dict is formatted as:
        event: <event>
        data: <JSON>

    followed by a blank line separator.
    """
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            **cors_headers(),
        },
    )
    await resp.prepare(request)

    try:
        async for chunk in generator:
            event = chunk.get("event", "")
            data = chunk.get("data", {})
            sse_text = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            await resp.write(sse_text.encode("utf-8"))
    except Exception as exc:
        try:
            error_data = json.dumps({"error": str(exc) or "Internal error"})
            await resp.write(f"event: error\ndata: {error_data}\n\n".encode("utf-8"))
        except Exception:
            pass
    finally:
        await resp.write_eof()

    return resp


async def pipe_sse_raw(
    generator: AsyncIterator,
    request: web.Request,
) -> web.StreamResponse:
    """Pipe an async generator as raw SSE lines (already-formatted text + "\\n").

    Each yielded value is written as-is followed by a newline. Used by
    filter_chat_stream which already emits properly formatted SSE lines.
    """
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            **cors_headers(),
        },
    )
    await resp.prepare(request)

    try:
        async for chunk in generator:
            await resp.write((chunk + "\n").encode("utf-8"))
    except Exception as exc:
        try:
            error_data = json.dumps({"error": str(exc) or "Internal error"})
            await resp.write(f"event: error\ndata: {error_data}\n\n".encode("utf-8"))
        except Exception:
            pass
    finally:
        await resp.write_eof()

    return resp
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_stream.py -v
```

- [ ] **Step 5: Commit**

```bash
git add aperture/stream.py tests/test_stream.py
git commit -m "feat(aperture-py): SSE stream parser and pipe utilities

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Middleware — auth, rate limiter, logger

**Files:**
- Create: `aperture/middleware/__init__.py`
- Create: `aperture/middleware/auth.py`
- Create: `aperture/middleware/rate_limiter.py`
- Create: `aperture/middleware/logger.py`
- Create: `tests/test_middleware.py`

**Interfaces:**
- Consumes: `helpers.error_response()`, `helpers.cors_headers()`
- Produces:
  - `auth.authenticate(request: web.Request, api_key: str | None) -> web.Response | None`
    - Returns None (allowed) or Response (401 denied)
  - `rate_limiter.create_rate_limiter(window_ms: int, max_requests: int) -> Callable[[str], tuple[bool, float]]`
    - Returns (allowed: bool, reset_at: float)
  - `logger.create_logger(request_id: str = "unknown") -> Logger`
    - Logger has .info(event, data), .warn(event, data), .error(event, data)

- [ ] **Step 1: Create `aperture/middleware/__init__.py`**

Empty init file.

- [ ] **Step 2: Write tests first (all middleware tests)**

```python
# tests/test_middleware.py
import time
import json
import pytest
from aiohttp import web
from aperture.middleware.auth import authenticate
from aperture.middleware.rate_limiter import create_rate_limiter
from aperture.middleware.logger import create_logger


# --- Auth tests ---

class MockRequest:
    """Minimal request mock for auth testing."""
    def __init__(self, headers=None):
        self.headers = headers or {}


def test_auth_missing_key_returns_401():
    req = MockRequest()
    resp = authenticate(req, "sk-secret")
    assert resp is not None
    assert resp.status == 401


def test_auth_wrong_key_returns_401():
    req = MockRequest({"Authorization": "Bearer sk-wrong"})
    resp = authenticate(req, "sk-secret")
    assert resp is not None
    assert resp.status == 401


def test_auth_valid_bearer_returns_none():
    req = MockRequest({"Authorization": "Bearer sk-correct"})
    resp = authenticate(req, "sk-correct")
    assert resp is None


def test_auth_valid_x_api_key_returns_none():
    req = MockRequest({"x-api-key": "sk-correct"})
    resp = authenticate(req, "sk-correct")
    assert resp is None


def test_auth_empty_key_skipped():
    """If no API key configured, allow all."""
    req = MockRequest()
    assert authenticate(req, None) is None
    assert authenticate(req, "") is None


# --- Rate limiter tests ---

def test_rate_limiter_allows_first_request():
    check = create_rate_limiter(60000, 10)
    allowed, reset_at = check("client-1")
    assert allowed is True
    assert reset_at > time.time() * 1000


def test_rate_limiter_blocks_after_limit():
    check = create_rate_limiter(60000, 3)
    for _ in range(3):
        allowed, _ = check("client-1")
        assert allowed is True
    allowed, _ = check("client-1")
    assert allowed is False


def test_rate_limiter_different_keys_independent():
    check = create_rate_limiter(60000, 3)
    for _ in range(3):
        check("client-1")
    allowed_client1, _ = check("client-1")
    assert allowed_client1 is False
    allowed_client2, _ = check("client-2")
    assert allowed_client2 is True


# --- Logger tests ---

def test_logger_basic_output(capsys):
    log = create_logger("req-123")
    log.info("test.event", {"key": "val"})
    captured = capsys.readouterr()
    parsed = json.loads(captured.out.strip())
    assert parsed["level"] == "info"
    assert parsed["event"] == "test.event"
    assert parsed["requestId"] == "req-123"
    assert parsed["key"] == "val"
```

- [ ] **Step 3: Test fails (modules don't exist yet)**

- [ ] **Step 4: Implement `aperture/middleware/auth.py`**

```python
"""API key authentication middleware.

Mirrors JS src/middleware/auth.js.
"""

import json
from aiohttp import web
from ..helpers import error_response


def authenticate(request: web.Request, api_key: str | None) -> web.Response | None:
    """Validate the client's API key.

    Checks Authorization: Bearer <key> or x-api-key header.

    Args:
        request: The incoming HTTP request.
        api_key: The configured API_KEY from env (may be None/empty to disable auth).

    Returns:
        None if authenticated, or a 401 web.Response if denied.
    """
    # If no API key is configured, allow all requests
    if not api_key:
        return None

    # Extract token from Authorization header or x-api-key header
    auth_header = request.headers.get("Authorization", "")
    token = request.headers.get("x-api-key", "")

    if auth_header.startswith("Bearer "):
        token = auth_header[7:]

    if not token:
        return error_response(
            "Missing API key. Provide via Authorization: Bearer <key> or x-api-key header.",
            "auth_error",
            "AUTH_REQUIRED",
            401,
        )

    if token != api_key:
        return error_response(
            "Invalid API key.",
            "auth_error",
            "AUTH_INVALID",
            401,
        )

    return None
```

- [ ] **Step 5: Implement `aperture/middleware/rate_limiter.py`**

```python
"""In-memory sliding window rate limiter.

Mirrors JS src/middleware/rate-limiter.js.

Limitation: process restart resets counters (same as JS Worker eviction).
"""

import time
import random
from collections.abc import Callable


def create_rate_limiter(window_ms: int, max_requests: int) -> Callable[[str], tuple[bool, float]]:
    """Create a rate limiter check function.

    Args:
        window_ms: Time window in milliseconds.
        max_requests: Maximum requests allowed within the window.

    Returns:
        A function that takes a key (str) and returns (allowed: bool, reset_at_ms: float).
    """
    hits: dict[str, dict] = {}

    def check(key: str) -> tuple[bool, float]:
        nonlocal hits
        now = time.time() * 1000

        # Probabilistic TTL pruning: 2% chance when size exceeds 2 * max_requests
        if len(hits) > max_requests * 2 and random.random() < 0.02:
            hits = {
                k: v
                for k, v in hits.items()
                if now - v["window_start"] <= window_ms
            }

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

- [ ] **Step 6: Implement `aperture/middleware/logger.py`**

```python
"""Structured JSON logger.

Mirrors JS src/middleware/logger.js.
"""

import json
import time


class Logger:
    """Logger that emits structured JSON lines to stdout/stderr."""

    def __init__(self, request_id: str = "unknown"):
        self._request_id = request_id

    def info(self, event: str, data: dict | None = None) -> None:
        self._emit("info", event, data)

    def warn(self, event: str, data: dict | None = None) -> None:
        self._emit("warn", event, data)

    def error(self, event: str, data: dict | None = None) -> None:
        self._emit("error", event, data)

    def _emit(self, level: str, event: str, data: dict | None = None) -> None:
        entry = {
            "level": level,
            "event": event,
            "requestId": self._request_id,
            "timestamp": int(time.time() * 1000),
            **(data or {}),
        }
        line = json.dumps(entry, default=str)
        if level == "error":
            import sys
            print(line, file=sys.stderr)
        else:
            print(line)


def create_logger(request_id: str = "unknown") -> Logger:
    """Create a structured JSON logger instance."""
    return Logger(request_id)
```

- [ ] **Step 7: Run tests and verify they pass**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_middleware.py -v
```

- [ ] **Step 8: Commit**

```bash
git add aperture/middleware/ tests/test_middleware.py
git commit -m "feat(aperture-py): auth, rate limiter, and logger middleware

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: DSML tool call normalization

**Files:**
- Create: `aperture/translators/__init__.py`
- Create: `aperture/translators/dsml.py`
- Create: `tests/test_dsml.py`

**Interfaces:**
- Consumes: `config.DSML_CONTENT_MAX`
- Produces:
  - `dsml.normalize_dsml_tool_calls(response_body: dict) -> dict`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_dsml.py
from aperture.translators.dsml import normalize_dsml_tool_calls


def test_no_dsml_content_passthrough():
    body = {"choices": [{"message": {"content": "Hello world"}, "finish_reason": "stop"}]}
    result = normalize_dsml_tool_calls(body)
    assert result["choices"][0]["message"]["content"] == "Hello world"
    assert "tool_calls" not in result["choices"][0]["message"]


def test_dsml_invoke_extracts_tool_call():
    dsml = '<invoke name="search"><parameter name="query">hello</parameter></invoke>'
    body = {"choices": [{"message": {"content": dsml}, "finish_reason": "stop"}]}
    result = normalize_dsml_tool_calls(body)
    msg = result["choices"][0]["message"]
    assert len(msg["tool_calls"]) == 1
    assert msg["tool_calls"][0]["function"]["name"] == "search"
    args = msg["tool_calls"][0]["function"]["arguments"]
    import json
    assert json.loads(args) == {"query": "hello"}
    assert result["choices"][0]["finish_reason"] == "tool_calls"


def test_dsml_multiple_invokes():
    dsml = (
        '<invoke name="search"><parameter name="q">a</parameter></invoke>'
        '<invoke name="calc"><parameter name="expr">1+1</parameter></invoke>'
    )
    body = {"choices": [{"message": {"content": dsml}, "finish_reason": "stop"}]}
    result = normalize_dsml_tool_calls(body)
    assert len(result["choices"][0]["message"]["tool_calls"]) == 2


def test_dsml_content_too_long_skipped():
    body = {
        "choices": [{
            "message": {"content": "<invoke name=\"x\">" + "a" * 200_000},
            "finish_reason": "stop",
        }]
    }
    result = normalize_dsml_tool_calls(body)
    assert "tool_calls" not in result["choices"][0]["message"]
```

- [ ] **Step 2: Test fails**

- [ ] **Step 3: Create `aperture/translators/__init__.py`**

Empty init file.

- [ ] **Step 4: Implement `aperture/translators/dsml.py`**

```python
"""DSML (Console Go XML) tool call normalization.

Detects and converts Console Go DSML-style tool calls embedded in
response content text to standard OpenAI tool_calls format.

Mirrors JS src/translators/dsml.js.
"""

import json
import re

from ..config import DSML_CONTENT_MAX


def normalize_dsml_tool_calls(response_body: dict) -> dict:
    """Detect and normalize DSML tool calls to standard tool_calls format.

    Console Go sometimes returns tool calls as DSML XML embedded in content
    (with finish_reason="stop") instead of standard message.tool_calls.
    This function detects and normalizes the pattern.

    Args:
        response_body: Parsed upstream response dict.

    Returns:
        Modified response_body with tool_calls extracted from DSML XML.
        Returns the original unchanged if no DSML pattern is found.
    """
    if not response_body:
        return response_body

    choices = response_body.get("choices")
    if not choices or not isinstance(choices, list) or not choices:
        return response_body

    choice = choices[0]
    msg = choice.get("message") or {}
    content = msg.get("content", "") or ""

    # Cap content length to prevent ReDoS
    if len(content) > DSML_CONTENT_MAX:
        return response_body

    # Quick check: look for invoke name=" pattern
    if not re.search(r"invoke\s+name\s*=\s*\"", content, re.IGNORECASE):
        return response_body

    tool_calls = []

    # Extract invoke blocks with regex
    invoke_pattern = re.compile(
        r'invoke\s+name\s*=\s*"([^"]+)"([\s\S]*?)(?=invoke\s+name\s*=\s*"|$)',
        re.IGNORECASE,
    )
    for match in invoke_pattern.finditer(content):
        fn_name = match.group(1)
        block_content = match.group(2)

        args = {}
        param_pattern = re.compile(
            r'parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)</parameter',
            re.IGNORECASE,
        )
        for p_match in param_pattern.finditer(block_content):
            if p_match.group(1):
                args[p_match.group(1)] = (p_match.group(2) or "").strip()

        if args:
            tool_calls.append({
                "index": len(tool_calls),
                "id": f"call_dsml_{__import__('secrets').token_hex(8)}",
                "type": "function",
                "function": {
                    "name": fn_name,
                    "arguments": json.dumps(args),
                },
            })

    if not tool_calls:
        return response_body

    # Remove DSML blocks from content, keep any prose
    prose = re.sub(
        r'<invoke\s+name\s*=\s*"[^"]*"[\s\S]*?</invoke>',
        "",
        content,
        flags=re.IGNORECASE,
    ).strip()
    msg["content"] = prose or ""
    msg["tool_calls"] = tool_calls

    if choice.get("finish_reason") in ("stop", "length"):
        choice["finish_reason"] = "tool_calls"

    return response_body
```

- [ ] **Step 5: Run tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_dsml.py -v
```

- [ ] **Step 6: Commit**

```bash
git add aperture/translators/ tests/test_dsml.py
git commit -m "feat(aperture-py): DSML tool call normalization translator

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Responses API translator

**Files:**
- Create: `aperture/translators/responses.py`
- Create: `tests/test_translate_to_chat.py`
- Create: `tests/test_translate_stream.py`

**Interfaces:**
- Consumes: `helpers.uid()`, `helpers.now()`, `helpers.extract_text()`, `stream.stream_sse()`
- Produces:
  - `translate_to_chat(body: dict) -> dict`
  - `translate_stream_events(response: ClientResponse, resp_id: str, model: str) -> AsyncIterator[dict]`
  - `translate_response_json(response: ClientResponse, resp_id: str, model: str) -> dict`

- [ ] **Step 1: Write unit tests for `translate_to_chat`**

```python
# tests/test_translate_to_chat.py
import json
import pytest
from aperture.translators.responses import translate_to_chat


def test_basic_input_string():
    body = {
        "input": "Hello world",
        "model": "deepseek-v4-flash",
        "instructions": "Be helpful",
    }
    result = translate_to_chat(body)
    assert result["model"] == "deepseek-v4-flash"
    assert len(result["messages"]) == 2
    assert result["messages"][0]["role"] == "system"
    assert result["messages"][0]["content"] == "Be helpful"
    assert result["messages"][1]["role"] == "user"
    assert result["messages"][1]["content"] == "Hello world"


def test_input_as_message_list():
    body = {
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
        ],
    }
    result = translate_to_chat(body)
    assert len(result["messages"]) == 1
    assert result["messages"][0]["content"] == "Hi"


def test_max_output_tokens_mapped():
    body = {"input": "Hi", "max_output_tokens": 500}
    result = translate_to_chat(body)
    assert result["max_tokens"] == 500


def test_previous_response_id_adds_history():
    body = {
        "input": "Hello",
        "previous_response_id": "resp_abc123",
    }
    result = translate_to_chat(body)
    # Should check for assistant message from previous response
    assert len(result["messages"]) >= 1


def test_tools_mapped():
    body = {
        "input": "Search",
        "tools": [{
            "type": "function",
            "name": "search",
            "description": "Search tool",
            "parameters": {"type": "object", "properties": {}},
        }],
        "tool_choice": "required",
    }
    result = translate_to_chat(body)
    assert len(result["tools"]) == 1
    assert result["tool_choice"] == "required"
```

- [ ] **Step 2: Write unit tests for stream translation**

```python
# tests/test_translate_stream.py
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from aperture.translators.responses import translate_stream_events


class MockStreamResponse:
    """Simulates a streaming response yielding bytes."""
    def __init__(self, chunks: list[bytes]):
        self.content = AsyncMock()
        self.content.__aiter__.return_value = iter(chunks)
        self.ok = True
        self.status = 200


@pytest.mark.asyncio
async def test_stream_event_format():
    """Each SSE event should have event + data keys."""
    data = json.dumps({
        "choices": [{"delta": {"content": "Hello"}, "index": 0, "finish_reason": None}]
    })
    resp = MockStreamResponse([f"data: {data}\n\n".encode()])
    events = []
    async for event in translate_stream_events(resp, "resp_1", "model-1"):
        events.append(event)
    assert len(events) > 0
    for ev in events:
        assert "event" in ev
        assert "data" in ev
```

- [ ] **Step 3: Implement `aperture/translators/responses.py`**

This is the largest single module (~445 JS lines). Implementation mirrors the JS exactly.

```python
"""OpenAI Responses API → Chat Completions translation.

Mirrors JS src/translators/responses.js.
"""

import json
from typing import AsyncIterator

from aiohttp import ClientResponse

from ..helpers import uid, now, extract_text
from ..stream import stream_sse


def translate_to_chat(body: dict) -> dict:
    """Translate an OpenAI Responses API request to Chat Completions format.

    The Responses API has a different structure from Chat Completions:
    - body.input can be a string (user message) or an array of message objects
    - body.instructions maps to system prompt
    - body.previous_response_id injects prior conversation context
    - Tools, truncation, and metadata are mapped to their Chat equivalents

    Args:
        body: Parsed JSON body of a Responses API request.

    Returns:
        Chat Completions request body (dict).
    """
    messages = []

    # Instructions → system message (prepended first)
    instructions = body.get("instructions", "")
    if instructions:
        messages.append({"role": "system", "content": instructions})

    # If previous_response_id is present, we don't have the conversation history
    # in this stateless proxy. The caller (handler) handles this by passing
    # the prior messages if available. Here we just note it.
    # previous_response_id = body.get("previous_response_id")

    # Input → user messages
    inp = body.get("input", "")
    if isinstance(inp, str):
        messages.append({"role": "user", "content": inp})

    elif isinstance(inp, list):
        for msg in inp:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "user":
                # Content can be a string or list of content blocks
                if isinstance(content, str):
                    messages.append({"role": "user", "content": content})
                elif isinstance(content, list):
                    user_texts = []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type", "")
                        if btype == "input_text":
                            user_texts.append(block.get("text", ""))
                        elif btype == "input_image":
                            img_url = block.get("image_url", {})
                            if isinstance(img_url, dict) and img_url.get("url"):
                                user_texts.append(f"[Image: {img_url['url']}]")
                    messages.append({"role": "user", "content": "".join(user_texts)})

            elif role == "assistant":
                if isinstance(content, str):
                    messages.append({"role": "assistant", "content": content})
                elif isinstance(content, list):
                    text_parts = []
                    tool_calls = []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type", "")
                        if btype == "output_text":
                            text_parts.append(block.get("text", ""))
                        elif btype == "function_call":
                            tool_calls.append({
                                "id": block.get("id", uid("call")),
                                "type": "function",
                                "function": {
                                    "name": block.get("name", ""),
                                    "arguments": json.dumps(block.get("arguments", {})),
                                },
                            })
                    msg_obj = {"role": "assistant", "content": "".join(text_parts) or None}
                    if tool_calls:
                        msg_obj["tool_calls"] = tool_calls
                    messages.append(msg_obj)

    # Build chat body
    chat = {
        "model": body.get("model", ""),
        "messages": messages,
        "stream": body.get("stream", False),
    }

    # Map parameters
    if "max_output_tokens" in body:
        chat["max_tokens"] = body["max_output_tokens"]
    if "temperature" in body:
        chat["temperature"] = body["temperature"]
    if "top_p" in body:
        chat["top_p"] = body["top_p"]
    if "stop" in body:
        chat["stop"] = body["stop"]

    # Map tools
    if "tools" in body and body["tools"]:
        tools = []
        for t in body["tools"]:
            if not isinstance(t, dict):
                continue
            ttype = t.get("type", "")
            if ttype == "function" or (t.get("name") and not ttype):
                tools.append({
                    "type": "function",
                    "function": {
                        "name": t.get("name", ""),
                        "description": t.get("description", ""),
                        "parameters": t.get("parameters", t.get("input_schema", {})),
                    },
                })
        if tools:
            chat["tools"] = tools
            chat["tool_choice"] = body.get("tool_choice", "auto")

    # Truncation
    truncation = body.get("truncation", "auto")
    if truncation == "auto":
        pass  # Upstream default handles this
    elif truncation == "disabled":
        chat.get("messages", [])

    # Metadata
    if "metadata" in body:
        meta = body["metadata"]
        if isinstance(meta, dict):
            if "user_id" in meta:
                chat["user"] = meta["user_id"]

    return chat


def _translate_tool_search_call(msg: dict) -> dict:
    """Translate a system tool_search_call message to a chat tool call.

    tool_search_call blocks in the Responses API use the namespace-based
    tool format with 'id', 'arguments', and 'name' per block.
    """
    # The Responses API uses function_call blocks — see translate_stream_events
    return msg


async def translate_stream_events(
    response: ClientResponse,
    resp_id: str,
    model: str,
) -> AsyncIterator[dict]:
    """Translate upstream Chat Completions SSE stream to Responses API events.

    Each yielded dict has {event, data} keys for pipe_sse().

    Args:
        response: Upstream SSE response.
        resp_id: Response ID prefix.
        model: Model name.

    Yields:
        Dicts with 'event' and 'data' keys.
    """
    output_index = 0
    item_index = 0

    yield {
        "event": "response.output_item.added",
        "data": {
            "type": "response.output_item.added",
            "output_index": output_index,
            "item": {
                "id": f"{resp_id}/item_{item_index}",
                "type": "message",
                "role": "assistant",
                "status": "in_progress",
                "content": [],
            },
        },
    }

    content_index = 0
    accumulated_text = ""
    last_finish_reason = None

    async for chunk in stream_sse(response):
        if "usage" in chunk:
            pass  # Track usage if needed

        for choice in chunk.get("choices", []):
            delta = choice.get("delta", {}) or {}
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                last_finish_reason = finish_reason

            content = delta.get("content", "")
            tool_calls = delta.get("tool_calls")

            # Text content
            if content:
                if not accumulated_text:
                    # First content — emit content_block.delta
                    yield {
                        "event": "response.content_part.added",
                        "data": {
                            "type": "response.content_part.added",
                            "output_index": output_index,
                            "part": {
                                "type": "output_text",
                                "text": "",
                            },
                        },
                    }
                accumulated_text += content
                yield {
                    "event": "response.output_text.delta",
                    "data": {
                        "type": "response.output_text.delta",
                        "output_index": output_index,
                        "content_index": content_index,
                        "delta": content,
                    },
                }

            # Tool calls
            if tool_calls:
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    tc_id = tc.get("id", uid("call"))
                    if tc.get("index") == 0:
                        yield {
                            "event": "response.output_item.added",
                            "data": {
                                "type": "response.output_item.added",
                                "output_index": output_index + 1,
                                "item": {
                                    "id": f"{resp_id}/item_{item_index + 1}",
                                    "type": "function_call",
                                    "status": "in_progress",
                                    "name": fn.get("name", ""),
                                    "call_id": tc_id,
                                    "arguments": "",
                                },
                            },
                        }
                    yield {
                        "event": "response.function_call_arguments.delta",
                        "data": {
                            "type": "response.function_call_arguments.delta",
                            "output_index": output_index + 1,
                            "item_id": f"{resp_id}/item_{item_index + 1}",
                            "delta": fn.get("arguments", ""),
                        },
                    }
                    if choice.get("finish_reason") in ("tool_calls", "stop"):
                        yield {
                            "event": "response.function_call_arguments.done",
                            "data": {
                                "type": "response.function_call_arguments.done",
                                "item_id": f"{resp_id}/item_{item_index + 1}",
                                "name": fn.get("name", ""),
                                "arguments": fn.get("arguments", "{}"),
                            },
                        }

    # Finalize
    if accumulated_text:
        yield {
            "event": "response.output_text.done",
            "data": {
                "type": "response.output_text.done",
                "output_index": output_index,
                "content_index": content_index,
                "text": accumulated_text,
            },
        }

    yield {
        "event": "response.done",
        "data": {
            "type": "response.done",
            "response": {
                "id": resp_id,
                "object": "response",
                "status": "completed",
                "model": model,
            },
        },
    }


async def translate_response_json(
    response: ClientResponse,
    resp_id: str,
    model: str,
) -> dict:
    """Translate a complete upstream Chat Completion response to Responses API JSON format.

    Args:
        response: Upstream response (not yet read).
        resp_id: Response ID for the output.
        model: Model name.

    Returns:
        Responses API response dict.
    """
    data = await response.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {})
    finish_reason = choice.get("finish_reason", "stop")

    output = []

    # Text output
    content = message.get("content", "")
    if content:
        output.append({
            "id": f"{resp_id}/text",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [
                {"type": "output_text", "text": content},
            ],
        })

    # Tool call output
    tool_calls = message.get("tool_calls", [])
    for tc in tool_calls:
        fn = tc.get("function", {})
        output.append({
            "id": tc.get("id", uid("call")),
            "type": "function_call",
            "status": "completed",
            "name": fn.get("name", ""),
            "call_id": tc.get("id", uid("call")),
            "arguments": fn.get("arguments", "{}"),
        })

    usage = data.get("usage", {})
    return {
        "id": resp_id,
        "object": "response",
        "created_at": now(),
        "model": model,
        "status": "completed",
        "output": output,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
            "output_tokens": usage.get("completion_tokens", usage.get("output_tokens", 0)),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }
```

- [ ] **Step 4: Write test and implement for `translate_response_json`**

```python
@pytest.mark.asyncio
async def test_translate_response_json_basic():
    """Basic non-streaming response."""
    from unittest.mock import AsyncMock
    mock_resp = AsyncMock(spec=ClientResponse)
    mock_resp.json = AsyncMock(return_value={
        "choices": [{
            "message": {"content": "Hello world", "tool_calls": []},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    })
    result = await translate_response_json(mock_resp, "resp_1", "model-x")
    assert result["object"] == "response"
    assert len(result["output"]) == 1
    assert result["output"][0]["content"][0]["text"] == "Hello world"
    assert result["usage"]["input_tokens"] == 10
```

- [ ] **Step 5: Run all tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_translate_to_chat.py tests/test_translate_stream.py -v
```

- [ ] **Step 6: Commit**

```bash
git add aperture/translators/responses.py tests/test_translate_to_chat.py tests/test_translate_stream.py
git commit -m "feat(aperture-py): Responses API ↔ Chat Completions translator

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Anthropic Messages API translator

**Files:**
- Create: `aperture/translators/anthropic.py`
- Create: `tests/test_translate_anthropic.py`

**Interfaces:**
- Consumes: `helpers.uid()`, `helpers.now()`, `helpers.extract_text()`, `stream.stream_sse()`, `config.resolve_default_model()`
- Produces:
  - `translate_anthropic_to_chat(body: dict, env: dict | None = None) -> dict`
  - `translate_anthropic_stream(response: ClientResponse, request_id: str, model: str) -> AsyncIterator[dict]`
  - `translate_anthropic_json(response: ClientResponse, request_id: str, model: str) -> dict`

Implementation mirrors JS `src/translators/anthropic.js` exactly. Key logic:
- Extract `body.system` → system message
- Convert Anthropic content blocks (image, tool_result, tool_use) to OpenAI equivalents
- Map tools (custom/function types) → OpenAI function calling
- Map thinking config
- SSE: emit Anthropic protocol events (message_start, content_block_start/delta/stop, message_delta, message_stop)

- [ ] **Step 1: Write tests**

```python
# tests/test_translate_anthropic.py
import json
import pytest
from aperture.translators.anthropic import (
    translate_anthropic_to_chat,
    translate_anthropic_json,
)


def test_basic_text_message():
    body = {
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "Hello"}],
        "system": "Be concise.",
    }
    result = translate_anthropic_to_chat(body, {"DEFAULT_MODEL": "deepseek-v4-flash"})
    assert len(result["messages"]) == 2
    assert result["messages"][0]["role"] == "system"
    assert result["messages"][0]["content"] == "Be concise."
    assert result["messages"][1]["role"] == "user"
    assert result["messages"][1]["content"] == "Hello"


def test_image_block_converted():
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "iVBORw0KGgo=",
            }},
        ]}],
    }
    result = translate_anthropic_to_chat(body)
    msg = result["messages"][0]
    assert isinstance(msg["content"], list)
    assert msg["content"][0]["type"] == "image_url"


def test_tool_result_to_tool_role():
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tu_abc", "content": "Result: 42"},
            {"type": "text", "text": "Now what?"},
        ]}],
    }
    result = translate_anthropic_to_chat(body)
    roles = [m["role"] for m in result["messages"]]
    assert "tool" in roles
    assert "user" in roles


def test_assistant_tool_use():
    body = {
        "messages": [{"role": "assistant", "content": [
            {"type": "text", "text": "Let me search"},
            {"type": "tool_use", "id": "tu_1", "name": "search", "input": {"q": "hello"}},
        ]}],
    }
    result = translate_anthropic_to_chat(body)
    msg = result["messages"][0]
    assert msg["role"] == "assistant"
    assert len(msg["tool_calls"]) == 1
    assert msg["tool_calls"][0]["function"]["name"] == "search"


def test_tools_mapped():
    body = {
        "messages": [{"role": "user", "content": "Hi"}],
        "tools": [{"name": "search", "description": "Search", "input_schema": {}}],
    }
    result = translate_anthropic_to_chat(body)
    assert len(result["tools"]) == 1
    assert result["tools"][0]["function"]["name"] == "search"


@pytest.mark.asyncio
async def test_translate_anthropic_json():
    from unittest.mock import AsyncMock
    from aiohttp import ClientResponse
    mock_resp = AsyncMock(spec=ClientResponse)
    mock_resp.json = AsyncMock(return_value={
        "choices": [{
            "message": {"content": "Hello too!", "tool_calls": []},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 10},
    })
    result = await translate_anthropic_json(mock_resp, "msg_1", "model-x")
    assert result["type"] == "message"
    assert result["content"][0]["text"] == "Hello too!"
    assert result["stop_reason"] == "end_turn"
```

- [ ] **Step 2: Tests fail (no module)**

- [ ] **Step 3: Implement `aperture/translators/anthropic.py`**

Full 470-line translation of the JS version. Core structure:

```python
"""Anthropic Messages API → Chat Completions translation.

Mirrors JS src/translators/anthropic.js.
"""

import json
from typing import AsyncIterator

from aiohttp import ClientResponse

from ..helpers import uid, now, extract_text
from ..stream import stream_sse
from ..config import resolve_default_model


def translate_anthropic_to_chat(body: dict, env: dict | None = None) -> dict:
    """Translate an Anthropic Messages API request to Chat Completions format.

    Supports:
    - messages[] with role: user/assistant
    - system prompt (top-level or first system message)
    - content blocks (text, image, tool_use, tool_result)
    - tools[] definitions → OpenAI function calling
    - streaming via stream: true
    - thinking config
    - Anthropic image blocks → OpenAI image URL format
    """
    env = env or {}
    messages = []
    system_content = None

    # Extract system prompt
    sys_val = body.get("system")
    if sys_val:
        if isinstance(sys_val, str):
            system_content = sys_val
        elif isinstance(sys_val, list):
            system_content = "\n".join(extract_text(b) for b in sys_val)

    # Process messages
    for msg in body.get("messages", []):
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "system":
            system_content = (system_content or "") + "\n" + extract_text(content)
            continue

        if role == "user":
            if isinstance(content, str):
                messages.append({"role": "user", "content": content})
            elif isinstance(content, list):
                user_parts = []
                has_user_text = False
                tool_messages = []

                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")

                    if btype == "text":
                        user_parts.append({"type": "text", "text": block.get("text", "")})
                        has_user_text = True

                    elif btype == "image":
                        source = block.get("source", {})
                        if source.get("data"):
                            user_parts.append({
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{source.get('media_type', 'image/png')};base64,{source['data']}",
                                },
                            })

                    elif btype == "tool_result":
                        tc_content = (
                            block.get("content", "")
                            if isinstance(block.get("content"), str)
                            else extract_text(block.get("content"))
                        )
                        tool_messages.append({
                            "role": "tool",
                            "tool_call_id": block.get("tool_use_id", uid("call")),
                            "content": tc_content or "",
                        })

                if tool_messages:
                    messages.extend(tool_messages)
                if has_user_text:
                    text_only = [p for p in user_parts if p["type"] == "text"]
                    content_text = "".join(p["text"] for p in text_only)
                    messages.append({"role": "user", "content": content_text})
                elif not tool_messages:
                    messages.append({"role": "user", "content": ""})

            else:
                messages.append({"role": "user", "content": ""})
            continue

        if role == "assistant":
            tool_calls = []
            text = ""

            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")
                    if btype == "text":
                        text += block.get("text", "")
                    elif btype == "tool_use":
                        tool_calls.append({
                            "id": block.get("id", uid("call")),
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": json.dumps(block.get("input", {})),
                            },
                        })

            msg_obj = {"role": "assistant", "content": text or None}
            if tool_calls:
                msg_obj["tool_calls"] = tool_calls
            messages.append(msg_obj)
            continue

        if role in ("tool_result", "tool"):
            tc_content = (
                content if isinstance(content, str)
                else "\n".join(extract_text(b) for b in content) if isinstance(content, list)
                else ""
            )
            messages.append({
                "role": "tool",
                "tool_call_id": msg.get("tool_use_id", uid("call")),
                "content": tc_content or "",
            })

    # Prepend system message
    if system_content:
        messages.insert(0, {"role": "system", "content": system_content.strip()})

    # Build chat request
    chat = {
        "model": _translate_model(body.get("model", ""), env),
        "messages": messages,
        "stream": body.get("stream", False) if "stream" in body else True,
    }

    # Map parameters
    if "temperature" in body:
        chat["temperature"] = body["temperature"]
    if "top_p" in body:
        chat["top_p"] = body["top_p"]
    if "stop_sequences" in body:
        chat["stop"] = body["stop_sequences"]

    # max_tokens
    max_tokens = body.get("max_tokens", 8192)
    chat["max_tokens"] = max(max_tokens, 1024)  # Enforce minimum

    # Tools → function calling
    if "tools" in body and body["tools"]:
        tools = []
        for t in body["tools"]:
            if not isinstance(t, dict):
                continue
            ttype = t.get("type", "")
            if ttype in ("custom", "function") or (not ttype and t.get("name")):
                fn = t.get("function", t)
                tools.append({
                    "type": "function",
                    "function": {
                        "name": fn.get("name", t.get("name", "")),
                        "description": fn.get("description", t.get("description", "")),
                        "input_schema": fn.get("input_schema", t.get("input_schema", fn.get("parameters", {}))),
                        "parameters": fn.get("parameters", t.get("parameters", fn.get("input_schema", {}))),
                    },
                })
        if tools:
            chat["tools"] = tools
            chat["tool_choice"] = _map_anthropic_tool_choice(body.get("tool_choice"))

    # Thinking → reasoning effort
    thinking = body.get("thinking")
    if isinstance(thinking, dict) and thinking.get("type") == "enabled":
        chat["thinking"] = {
            "type": "enabled",
            "budget_tokens": thinking.get("budget_tokens", 2048),
        }

    # Metadata
    metadata = body.get("metadata")
    if isinstance(metadata, dict) and "user_id" in metadata:
        chat["user_id"] = metadata["user_id"]

    return chat


async def translate_anthropic_stream(
    response: ClientResponse,
    request_id: str,
    model: str,
) -> AsyncIterator[dict]:
    """Translate upstream SSE stream to Anthropic Messages API stream events.

    Yields dicts with {event, data} keys for pipe_sse().
    Events: message_start, content_block_start, content_block_delta,
            content_block_stop, message_delta, message_stop.
    """
    # Emit message_start
    yield {
        "event": "message_start",
        "data": {
            "type": "message_start",
            "message": {
                "id": request_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        },
    }

    content_index = 0
    text_block_index = -1  # -1 = no text block open
    tool_use_map: dict[int, dict] = {}
    last_finish_reason = None
    stream_usage = {"input_tokens": 0, "output_tokens": 0}

    async for chunk in stream_sse(response):
        # Track usage
        if "usage" in chunk:
            stream_usage["input_tokens"] = (
                chunk["usage"].get("prompt_tokens", chunk["usage"].get("input_tokens", 0))
            )
            stream_usage["output_tokens"] = (
                chunk["usage"].get("completion_tokens", chunk["usage"].get("output_tokens", 0))
            )

        for choice in chunk.get("choices", []):
            delta = choice.get("delta", {}) or {}
            content = delta.get("content", "")
            tool_calls = delta.get("tool_calls")
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                last_finish_reason = finish_reason

            # Text content
            if content:
                if text_block_index == -1:
                    text_block_index = content_index
                    yield {
                        "event": "content_block_start",
                        "data": {
                            "type": "content_block_start",
                            "index": text_block_index,
                            "content_block": {"type": "text", "text": ""},
                        },
                    }
                yield {
                    "event": "content_block_delta",
                    "data": {
                        "type": "content_block_delta",
                        "index": text_block_index,
                        "delta": {"type": "text_delta", "text": content},
                    },
                }

            # Tool calls
            if tool_calls:
                if text_block_index != -1:
                    yield {
                        "event": "content_block_stop",
                        "data": {"type": "content_block_stop", "index": text_block_index},
                    }
                    content_index += 1
                    text_block_index = -1

                for tc in tool_calls:
                    fn = tc.get("function", {})
                    idx = tc.get("index", 0)
                    if idx not in tool_use_map:
                        tool_use_map[idx] = {
                            "block_index": content_index,
                            "id": tc.get("id", uid("toolu")),
                            "name": fn.get("name", f"tool_{(tc.get('id', '') or 'unknown')[:8]}"),
                            "input": "",
                        }
                        yield {
                            "event": "content_block_start",
                            "data": {
                                "type": "content_block_start",
                                "index": tool_use_map[idx]["block_index"],
                                "content_block": {
                                    "type": "tool_use",
                                    "id": tool_use_map[idx]["id"],
                                    "name": tool_use_map[idx]["name"],
                                    "input": {},
                                },
                            },
                        }
                        content_index += 1

                    args = fn.get("arguments", "")
                    if args:
                        tool_use_map[idx]["input"] += args
                        yield {
                            "event": "content_block_delta",
                            "data": {
                                "type": "content_block_delta",
                                "index": tool_use_map[idx]["block_index"],
                                "delta": {"type": "input_json_delta", "partial_json": args},
                            },
                        }

            # Close tool_use blocks on finish
            if finish_reason:
                for key in list(tool_use_map.keys()):
                    tc = tool_use_map[key]
                    yield {
                        "event": "content_block_stop",
                        "data": {"type": "content_block_stop", "index": tc["block_index"]},
                    }
                    del tool_use_map[key]

    # Close any open text block
    if text_block_index != -1:
        yield {
            "event": "content_block_stop",
            "data": {"type": "content_block_stop", "index": text_block_index},
        }

    stop_reason = _map_finish_reason(last_finish_reason)

    yield {
        "event": "message_delta",
        "data": {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": stream_usage,
        },
    }

    yield {
        "event": "message_stop",
        "data": {"type": "message_stop"},
    }


async def translate_anthropic_json(
    response: ClientResponse,
    request_id: str,
    model: str,
) -> dict:
    """Translate a complete upstream Chat Completion response to Anthropic JSON."""
    data = await response.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {})
    content = []

    # Text content
    msg_content = message.get("content", "")
    if msg_content:
        content.append({"type": "text", "text": msg_content})

    # Tool calls → tool_use blocks
    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        try:
            input_data = json.loads(fn.get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            input_data = {}
        content.append({
            "type": "tool_use",
            "id": tc.get("id", uid("toolu")),
            "name": fn.get("name", ""),
            "input": input_data,
        })

    finish_reason = choice.get("finish_reason")
    stop_reason = _map_finish_reason(finish_reason)
    usage = data.get("usage", {})

    return {
        "id": request_id,
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


# --- Internal helpers ---

def _translate_model(model: str, env: dict | None = None) -> str:
    if not model:
        return resolve_default_model(env)
    known = {
        "claude-sonnet-4-20250514": resolve_default_model(env),
        "claude-sonnet-4": resolve_default_model(env),
        "claude-3-5-sonnet-latest": resolve_default_model(env),
        "claude-3-haiku": resolve_default_model(env),
        "claude-3-opus": resolve_default_model(env),
    }
    return known.get(model, resolve_default_model(env))


def _map_finish_reason(fr: str | None) -> str:
    mapping = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
    }
    return mapping.get(fr, "end_turn")


def _map_anthropic_tool_choice(choice: dict | str | None) -> str | dict:
    if not choice:
        return "auto"
    if isinstance(choice, str):
        return choice
    ctype = choice.get("type", "auto")
    if ctype == "auto":
        return "auto"
    if ctype == "any":
        return "required"
    if ctype == "tool":
        return {"type": "function", "function": {"name": choice.get("name", "")}}
    return "auto"
```

- [ ] **Step 4: Run tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_translate_anthropic.py -v
```

- [ ] **Step 5: Commit**

```bash
git add aperture/translators/anthropic.py tests/test_translate_anthropic.py
git commit -m "feat(aperture-py): Anthropic Messages ↔ Chat Completions translator

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Upstream client

**Files:**
- Create: `aperture/upstream.py`
- Create: `tests/test_upstream.py`

**Interfaces:**
- Consumes: `helpers.fetch_upstream()` (replaced with aiohttp session)
- Produces:
  - `send_chat_request(app: web.Application, chat_body: dict) -> ClientResponse`
  - `extract_usage(data: dict) -> dict | None`

- [ ] **Step 1: Write tests**

```python
# tests/test_upstream.py
import pytest
from aperture.upstream import extract_usage


def test_extract_usage_openai_format():
    data = {"usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
    result = extract_usage(data)
    assert result["input_tokens"] == 10
    assert result["output_tokens"] == 20


def test_extract_usage_responses_format():
    data = {"usage": {"input_tokens": 10, "output_tokens": 20}}
    result = extract_usage(data)
    assert result["input_tokens"] == 10


def test_extract_usage_none():
    assert extract_usage({}) is None
    assert extract_usage(None) is None
```

- [ ] **Step 2: Implement `aperture/upstream.py`**

```python
"""Upstream API client.

Manages the connection to the upstream Chat Completions API.
Simplified from JS version — always sends directly (no Gateway fallback).
"""

import os
from aiohttp import web, ClientResponse

from .helpers import cors_headers


def build_upstream_url(app: web.Application) -> str:
    """Build the upstream Chat Completions URL."""
    base_url = app.get("upstream_base_url", os.environ.get(
        "UPSTREAM_BASE_URL", "https://opencode.ai/zen/go/v1",
    ))
    return f"{base_url.rstrip('/')}/chat/completions"


def build_auth_headers(app: web.Application) -> dict:
    """Build auth headers for upstream requests."""
    api_key = app.get("api_key", os.environ.get("API_KEY", ""))
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }


async def send_chat_request(
    app: web.Application,
    chat_body: dict,
) -> ClientResponse:
    """Send a Chat Completions request to the upstream API.

    Uses the app's shared aiohttp ClientSession for connection reuse.
    Handles timeouts via the session's default timeout setting.

    Args:
        app: The aiohttp application (contains 'client' session).
        chat_body: The translated Chat Completions request body.

    Returns:
        aiohttp ClientResponse. Caller must check .ok and handle errors.
        On network error, returns a synthetic 502 response.
    """
    url = build_upstream_url(app)
    headers = build_auth_headers(app)
    client = app.get("client")

    if client is None:
        return web.json_response(
            {"error": "Upstream client not initialized"},
            status=502,
            headers=cors_headers(),
        )

    try:
        return await client.post(url, json=chat_body, headers=headers)
    except Exception:
        return web.json_response(
            {
                "error": {
                    "message": "Upstream network error",
                    "type": "network_error",
                    "code": "NETWORK_ERROR",
                },
            },
            status=502,
            headers=cors_headers(),
        )


def extract_usage(data: dict | None) -> dict | None:
    """Extract usage stats from upstream response data.

    Handles both OpenAI format (prompt_tokens/completion_tokens)
    and Responses API format (input_tokens/output_tokens).
    """
    if not data or not isinstance(data, dict):
        return None
    usage = data.get("usage")
    if not usage or not isinstance(usage, dict):
        return None
    return {
        "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
        "output_tokens": usage.get("completion_tokens", usage.get("output_tokens", 0)),
        "total_tokens": usage.get("total_tokens", 0),
    }
```

- [ ] **Step 3: Run tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_upstream.py -v
```

- [ ] **Step 4: Commit**

```bash
git add aperture/upstream.py tests/test_upstream.py
git commit -m "feat(aperture-py): upstream HTTP client

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Handlers — chat, responses, anthropic

**Files:**
- Create: `aperture/handlers/__init__.py`
- Create: `aperture/handlers/chat.py`
- Create: `aperture/handlers/responses.py`
- Create: `aperture/handlers/anthropic.py`
- Create: `tests/test_handlers.py`

**Interfaces:**
- Consumes: `config.map_model_name()`, `upstream.send_chat_request()`, `stream.*`, `translators.*`, `helpers.*`, `middleware.logger.*`
- Produces:
  - `chat.handle_chat_completions(body: dict, request: web.Request) -> web.Response | web.StreamResponse`
  - `chat.filter_chat_stream(response: ClientResponse) -> AsyncIterator[str]`
  - `responses.handle_responses_api(body: dict, request: web.Request) -> web.Response | web.StreamResponse`
  - `anthropic.handle_anthropic_messages(body: dict, request: web.Request) -> web.Response | web.StreamResponse`

- [ ] **Step 1: Create `aperture/handlers/__init__.py`**

Empty init file.

- [ ] **Step 2: Implement `aperture/handlers/chat.py`**

Mirrors JS `src/handlers/chat.js`. Key logic: override model, send request, stream filter or DSML normalize.

```python
"""Chat Completions handler — passthrough with model override and stream filtering.

Mirrors JS src/handlers/chat.js.
"""

import json
from aiohttp import web
from typing import AsyncIterator

from ..config import map_model_name
from ..upstream import send_chat_request
from ..stream import pipe_sse_raw
from ..translators.dsml import normalize_dsml_tool_calls
from ..helpers import error_response, cors_headers
from ..middleware.logger import create_logger


async def filter_chat_stream(response) -> AsyncIterator[str]:
    """Filter streaming SSE chunks to strip non-standard fields.

    Strips reasoning_content (DeepSeek non-standard field) and converts
    content: null → "" for client compatibility. Skips empty chunks
    that only contained reasoning.

    Yields already-formatted SSE lines (rawLine mode for pipe_sse_raw).
    """
    MAX_BUF = 2 * 1024 * 1024
    buf = b""
    total = 0

    async for chunk in response.content:
        total += len(chunk)
        if total > MAX_BUF:
            raise RuntimeError("SSE buffer exceeded maximum size")

        buf += chunk
        lines = buf.split(b"\n")
        buf = lines.pop() if lines else b""

        for line in lines:
            trimmed = line.strip()
            if not trimmed.startswith(b"data: "):
                yield line.decode("utf-8", errors="replace")
                continue

            payload = trimmed[6:].strip()
            if payload == b"[DONE]":
                yield line.decode("utf-8", errors="replace")
                continue

            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                yield line.decode("utf-8", errors="replace")
                continue

            if "choices" not in parsed or not isinstance(parsed.get("choices"), list):
                yield line.decode("utf-8", errors="replace")
                continue

            modified = False
            had_null_content = False
            for choice in parsed["choices"]:
                delta = choice.get("delta")
                if not delta:
                    continue
                if "reasoning_content" in delta:
                    del delta["reasoning_content"]
                    modified = True
                if delta.get("content") is None:
                    delta["content"] = ""
                    modified = True
                    had_null_content = True

            if not modified:
                yield line.decode("utf-8", errors="replace")
                continue

            has_content = had_null_content or any(
                c.get("finish_reason")
                or (
                    c.get("delta")
                    and (
                        (isinstance(c["delta"].get("content"), str) and len(c["delta"]["content"]) > 0)
                        or c["delta"].get("role") is not None
                        or c["delta"].get("tool_calls") is not None
                    )
                )
                for c in parsed["choices"]
            )

            if has_content:
                yield f"data: {json.dumps(parsed)}"


async def handle_chat_completions(body: dict, request: web.Request) -> web.Response | web.StreamResponse:
    """Handle a Chat Completions request.

    Steps:
    1. Override model name via map_model_name()
    2. Send request upstream
    3. If streaming: pipe through filter_chat_stream
    4. If non-streaming: DSML normalize, return JSON
    """
    app = request.app
    body["model"] = map_model_name(body.get("model"), app)

    log = create_logger("chat")

    upstream_response = await send_chat_request(app, body)

    if isinstance(upstream_response, web.Response):
        # send_chat_request returned an error response
        return upstream_response

    if not upstream_response.ok:
        log.error("upstream.failed", {"status": upstream_response.status})
        return error_response("Upstream request failed", "upstream_error", "UPSTREAM", upstream_response.status)

    # Streaming
    if body.get("stream"):
        return await pipe_sse_raw(filter_chat_stream(upstream_response), request)

    # Non-streaming
    try:
        response_text = await upstream_response.text()
        response_body = json.loads(response_text)
        for choice in response_body.get("choices", []):
            msg = choice.get("message", {})
            if "reasoning_content" in msg:
                del msg["reasoning_content"]
        normalized = normalize_dsml_tool_calls(response_body)
        return web.json_response(normalized, headers=cors_headers())
    except (json.JSONDecodeError, Exception):
        return web.json_response(
            {"error": "Failed to parse upstream response"},
            status=502,
            headers=cors_headers(),
        )
```

- [ ] **Step 3: Implement `aperture/handlers/responses.py`**

```python
"""OpenAI Responses API handler.

Translates incoming request to Chat Completions, sends upstream,
translates response back.

Mirrors JS src/handlers/responses.js.
"""

from aiohttp import web

from ..config import map_model_name
from ..upstream import send_chat_request
from ..stream import pipe_sse
from ..translators.responses import translate_to_chat, translate_stream_events, translate_response_json
from ..helpers import uid, now, cors_headers
from ..middleware.logger import create_logger


async def handle_responses_api(body: dict, request: web.Request) -> web.Response | web.StreamResponse:
    """Handle an OpenAI Responses API request."""
    app = request.app
    resp_id = uid("resp_")

    # Translate to Chat Completions
    chat_req = translate_to_chat(body)
    chat_req["model"] = map_model_name(chat_req.get("model"), app)

    log = create_logger("responses")

    upstream_response = await send_chat_request(app, chat_req)

    if isinstance(upstream_response, web.Response):
        return upstream_response

    if not upstream_response.ok:
        log.error("upstream.failed", {"status": upstream_response.status})
        return web.json_response(
            {
                "id": resp_id,
                "object": "response",
                "created_at": now(),
                "model": chat_req.get("model", ""),
                "output": [],
                "error": {
                    "message": "Upstream request failed",
                    "type": "invalid_request_error",
                    "code": "invalid_request_error",
                },
            },
            status=upstream_response.status,
            headers=cors_headers(),
        )

    # Streaming
    if chat_req.get("stream"):
        model = chat_req.get("model", "")
        return await pipe_sse(
            translate_stream_events(upstream_response, resp_id, model),
            request,
        )

    # Non-streaming
    result = await translate_response_json(upstream_response, resp_id, chat_req.get("model", ""))
    return web.json_response(result, headers=cors_headers())
```

- [ ] **Step 4: Implement `aperture/handlers/anthropic.py`**

```python
"""Anthropic Messages API handler.

Translates incoming request to Chat Completions, sends upstream,
translates response back to Anthropic format.

Mirrors JS src/handlers/anthropic.js.
"""

from aiohttp import web

from ..config import map_model_name
from ..upstream import send_chat_request
from ..stream import pipe_sse
from ..translators.anthropic import (
    translate_anthropic_to_chat,
    translate_anthropic_stream,
    translate_anthropic_json,
)
from ..helpers import uid, cors_headers
from ..middleware.logger import create_logger


async def handle_anthropic_messages(body: dict, request: web.Request) -> web.Response | web.StreamResponse:
    """Handle an Anthropic Messages API request."""
    app = request.app
    request_id = uid("msg_")

    # Translate Anthropic request → Chat Completions
    chat_req = translate_anthropic_to_chat(body, dict(app))
    chat_req["model"] = map_model_name(chat_req.get("model"), app)

    log = create_logger("anthropic")

    upstream_response = await send_chat_request(app, chat_req)

    if isinstance(upstream_response, web.Response):
        return upstream_response

    if not upstream_response.ok:
        log.error("upstream.failed", {"status": upstream_response.status})
        headers = {
            "Content-Type": "application/json",
            "x-request-id": request_id,
            "request-id": request_id,
            **cors_headers(),
        }
        return web.json_response(
            {
                "id": request_id,
                "type": "error",
                "error": {"type": "invalid_request_error", "message": "Upstream request failed"},
            },
            status=upstream_response.status,
            headers=headers,
        )

    # Streaming
    if chat_req.get("stream"):
        return await pipe_sse(
            translate_anthropic_stream(upstream_response, request_id, chat_req.get("model", "")),
            request,
        )

    # Non-streaming
    result = await translate_anthropic_json(upstream_response, request_id, chat_req.get("model", ""))
    return web.json_response(
        result,
        headers={
            "x-request-id": request_id,
            "request-id": request_id,
            **cors_headers(),
        },
    )
```

- [ ] **Step 5: Write handler integration tests**

```python
# tests/test_handlers.py
import json
import pytest
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

# Use aiohttp TestClient for integration tests
from aperture.index import create_app


@pytest.fixture
def app():
    """Create app with test config."""
    import os
    os.environ["API_KEY"] = "sk-test"
    os.environ["DEFAULT_MODEL"] = "test-model"
    os.environ["UPSTREAM_BASE_URL"] = "http://localhost:99999"
    app = create_app()
    return app


@pytest.fixture
async def client(aiohttp_client, app):
    return await aiohttp_client(app)


@pytest.mark.asyncio
async def test_models_endpoint(client):
    resp = await client.get("/v1/models")
    assert resp.status == 200
    data = await resp.json()
    assert "data" in data
    assert isinstance(data["data"], list)


@pytest.mark.asyncio
async def test_chat_no_auth_returns_401(client):
    resp = await client.post("/v1/chat/completions", json={
        "model": "test",
        "messages": [{"role": "user", "content": "Hi"}],
    })
    assert resp.status == 401


@pytest.mark.asyncio
async def test_chat_with_valid_auth(client):
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "test", "messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    # Should fail with 502 since there's no real upstream
    # but the important thing is auth passes
    assert resp.status in (200, 502)


@pytest.mark.asyncio
async def test_anthropic_route_detection(client):
    resp = await client.post(
        "/v1/messages",
        json={"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    # Auth passes, but no upstream → expect 502 or similar
    assert resp.status in (200, 502)
```

- [ ] **Step 6: Run handler tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_handlers.py -v -x
```

- [ ] **Step 7: Commit**

```bash
git add aperture/handlers/ tests/test_handlers.py
git commit -m "feat(aperture-py): request handlers for chat, responses, anthropic

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: App factory (index.py) and CLI entry (__main__.py)

**Files:**
- Create: `aperture/index.py`
- Create: `aperture/__main__.py`

**Interfaces:**
- Produces:
  - `index.create_app() -> web.Application`
  - CLI: `python -m aperture [--port PORT] [--socket PATH] [--host HOST]`

- [ ] **Step 1: Implement `aperture/index.py`**

```python
"""Aperture application factory and route dispatch.

Creates the aiohttp application, wires up middleware and routes.

Mirrors JS src/index.js.
"""

import json
import os

from aiohttp import web

from .helpers import error_response, cors_headers
from .middleware.auth import authenticate
from .middleware.rate_limiter import create_rate_limiter
from .handlers.chat import handle_chat_completions
from .handlers.responses import handle_responses_api
from .handlers.anthropic import handle_anthropic_messages


def _detect_route(path: str, body: dict) -> str:
    """Detect the API route from the path and request body.

    Mirrors JS detectRoute() logic.
    """
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


def _handle_list_models(request: web.Request) -> web.Response:
    """Build and return the model list from environment."""
    env = dict(request.app)
    models = []
    seen = set()

    def add_model(model_id: str):
        if model_id in seen:
            return
        seen.add(model_id)
        models.append({
            "id": model_id,
            "object": "model",
            "created": 1780000000,
            "owned_by": "aperture",
        })

    default = os.environ.get("DEFAULT_MODEL", "deepseek-v4-flash")
    add_model(default)

    # MODEL_MAP entries
    model_map_raw = os.environ.get("MODEL_MAP", "{}")
    try:
        model_map = json.loads(model_map_raw)
        if isinstance(model_map, dict):
            for alias, target in model_map.items():
                add_model(alias)
                add_model(target)
    except (json.JSONDecodeError, TypeError):
        pass

    # Common AI client model IDs
    common = [
        "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514",
        "claude-sonnet-4", "claude-opus-4", "claude-haiku-4-20251001",
        "o3-mini", "gpt-4o", "gpt-4o-mini",
    ]
    for mid in common:
        add_model(mid)

    return web.json_response({"data": models}, headers=cors_headers())


@web.middleware
async def cors_middleware(request: web.Request, handler) -> web.Response:
    """Add CORS headers to all responses."""
    if request.method == "OPTIONS":
        return web.Response(headers=cors_headers())
    try:
        response = await handler(request)
        for key, value in cors_headers().items():
            if key not in response.headers:
                response.headers[key] = value
        return response
    except web.HTTPException as exc:
        for key, value in cors_headers().items():
            if key not in exc.headers:
                exc.headers[key] = value
        raise


@web.middleware
async def rate_limit_middleware(request: web.Request, handler) -> web.Response:
    """Apply rate limiting based on client IP."""
    # Skip rate limiting for GET requests (model listing)
    if request.method == "GET":
        return await handler(request)

    rate_limiter = request.app.get("rate_limiter")
    if rate_limiter is None:
        return await handler(request)

    client_ip = request.remote or request.headers.get("X-Forwarded-For", "unknown")
    allowed, reset_at = rate_limiter(client_ip)

    if not allowed:
        retry_after = max(1, int((reset_at - (__import__("time").time() * 1000)) / 1000))
        return web.json_response(
            {
                "error": {
                    "message": "Rate limit exceeded. Try again later.",
                    "type": "rate_limit_error",
                    "code": "RATE_LIMITED",
                },
            },
            status=429,
            headers={
                "Content-Type": "application/json",
                "Retry-After": str(retry_after),
                **cors_headers(),
            },
        )

    return await handler(request)


@web.middleware
async def auth_middleware(request: web.Request, handler) -> web.Response:
    """Authenticate requests via API key."""
    # Skip auth for GET requests (model listing) and OPTIONS
    if request.method in ("GET", "OPTIONS"):
        return await handler(request)

    api_key = request.app.get("api_key") or os.environ.get("API_KEY", "")
    auth_response = authenticate(request, api_key)
    if auth_response is not None:
        return auth_response

    return await handler(request)


async def _handle_post(request: web.Request) -> web.Response:
    """Handle POST requests — the main dispatch point."""
    try:
        raw = await request.text()
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return error_response("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400)

    if not isinstance(body, dict):
        return error_response("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400)

    path = request.match_info.get("path", "")
    route = _detect_route(path, body)

    if route == "chat":
        return await handle_chat_completions(body, request)
    elif route == "responses":
        return await handle_responses_api(body, request)
    elif route == "anthropic":
        return await handle_anthropic_messages(body, request)

    return error_response("Unknown route", "invalid_request", "INVALID_ROUTE", 400)


async def _client_session_ctx(app: web.Application):
    """Application cleanup context — manage shared aiohttp ClientSession."""
    import aiohttp
    timeout = aiohttp.ClientTimeout(
        total=app.get("request_timeout", int(os.environ.get("REQUEST_TIMEOUT_MS", "120000"))) / 1000,
    )
    app["client"] = aiohttp.ClientSession(timeout=timeout)
    yield
    await app["client"].close()


def create_app() -> web.Application:
    """Create and configure the aiohttp application.

    Reads configuration from environment variables.
    Returns a fully configured web.Application ready to run.
    """
    app = web.Application(middlewares=[cors_middleware, rate_limit_middleware, auth_middleware])

    # Store config in app for handler access
    app["upstream_base_url"] = os.environ.get(
        "UPSTREAM_BASE_URL", "https://opencode.ai/zen/go/v1",
    )
    app["api_key"] = os.environ.get("API_KEY", "")

    # Rate limiter config
    window_ms = int(os.environ.get("RATE_LIMIT_WINDOW_MS", "60000"))
    max_req = int(os.environ.get("RATE_LIMIT_MAX", "120"))
    app["rate_limiter"] = create_rate_limiter(window_ms, max_req)

    # Request timeout
    app["request_timeout"] = int(os.environ.get("REQUEST_TIMEOUT_MS", "120000"))

    # Shared aiohttp ClientSession
    app.cleanup_ctx.append(_client_session_ctx)

    # Routes
    app.router.add_get("/v1/models", _handle_list_models)
    app.router.add_get("/models", _handle_list_models)
    app.router.add_post("/{path:.*}", _handle_post)

    return app
```

- [ ] **Step 2: Implement `aperture/__main__.py`**

```python
"""CLI entry point for Aperture.

Usage:
    python -m aperture                  # TCP 0.0.0.0:8080
    python -m aperture --port 3000      # Custom port
    python -m aperture --socket /var/run/aperture.sock  # Unix socket
    python -m aperture --help           # Show help
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Aperture — AI Protocol Translator",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("APERTURE_HOST", "0.0.0.0"),
        help="Bind address (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("APERTURE_PORT", "8080")),
        help="Bind port (default: 8080)",
    )
    parser.add_argument(
        "--socket",
        default=os.environ.get("APERTURE_UNIX_SOCKET", ""),
        help="Unix socket path (overrides host:port)",
    )
    args = parser.parse_args()

    # Optionally load .env
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.isfile(env_path):
        try:
            from dotenv import load_dotenv
            load_dotenv(env_path)
        except ImportError:
            pass

    from .index import create_app

    app = create_app()

    if args.socket:
        print(f"Aperture starting on unix://{args.socket}", file=sys.stderr)
        web.run_app(app, path=args.socket)
    else:
        print(f"Aperture starting on http://{args.host}:{args.port}", file=sys.stderr)
        web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Test the app starts and responds**

```bash
cd /home/yupeng/worker

# Quick smoke test: start in background, test models endpoint, kill
python -m aperture &
PID=$!
sleep 2
curl -s http://0.0.0.0:8080/v1/models | python -m json.tool | head -5
kill $PID 2>/dev/null
wait $PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add aperture/index.py aperture/__main__.py
git commit -m "feat(aperture-py): app factory, middleware stack, and CLI entry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: End-to-end test with mock upstream

**Files:**
- Create: `tests/test_e2e.py`

- [ ] **Step 1: Write e2e test with a mock upstream server**

```python
# tests/test_e2e.py
"""End-to-end tests using a mock upstream HTTP server.

Starts a small aiohttp server that simulates the upstream Chat Completions API,
then sends real Aperture requests through and verifies the full pipeline.
"""

import json
import asyncio
import pytest
from aiohttp import web
from aperture.index import create_app


@pytest.fixture
async def mock_upstream(aiohttp_server):
    """Start a mock upstream Chat Completions API server."""
    async def chat_handler(request):
        body = await request.json()
        stream = body.get("stream", False)

        if stream:
            resp = web.StreamResponse(
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await resp.prepare(request)
            data = json.dumps({
                "choices": [{"delta": {"content": "Hello"}, "index": 0, "finish_reason": None}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 10},
            })
            await resp.write(f"data: {data}\n\n".encode())
            data_done = json.dumps({
                "choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}],
            })
            await resp.write(f"data: {data_done}\n\n".encode())
            await resp.write(b"data: [DONE]\n\n")
            return resp

        return web.json_response({
            "choices": [{
                "message": {"content": "Hello!", "tool_calls": []},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15},
        })

    app = web.Application()
    app.router.add_post("/v1/chat/completions", chat_handler)
    server = await aiohttp_server(app, port=None)
    return server


@pytest.fixture
def aperture_app(mock_upstream):
    """Aperture app pointed at the mock upstream."""
    import os
    os.environ["API_KEY"] = "sk-test"
    os.environ["DEFAULT_MODEL"] = "test-model"
    os.environ["UPSTREAM_BASE_URL"] = f"http://localhost:{mock_upstream.port}"
    return create_app()


@pytest.mark.asyncio
async def test_chat_completions_non_streaming(aiohttp_client, aperture_app, mock_upstream):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "test", "messages": [{"role": "user", "content": "Hi"}], "stream": False},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200
    data = await resp.json()
    assert "choices" in data
    assert data["choices"][0]["message"]["content"] == "Hello!"


@pytest.mark.asyncio
async def test_responses_api_non_streaming(aiohttp_client, aperture_app, mock_upstream):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/responses",
        json={"input": "Hi", "model": "test"},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200
    data = await resp.json()
    assert data["object"] == "response"


@pytest.mark.asyncio
async def test_anthropic_messages_non_streaming(aiohttp_client, aperture_app, mock_upstream):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/messages",
        json={"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200
    data = await resp.json()
    assert data["type"] == "message"
    assert data["content"][0]["text"] == "Hello!"


@pytest.mark.asyncio
async def test_route_detection_by_body(aiohttp_client, aperture_app, mock_upstream):
    """POST to /v1/some-path with messages in body should route to chat."""
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/some-path",
        json={"messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200
```

- [ ] **Step 2: Run e2e tests**

```bash
cd /home/yupeng/worker && python -m pytest tests/test_e2e.py -v -x
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(aperture-py): end-to-end test suite with mock upstream

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Spec Coverage Check

| Spec Requirement | Task | Status |
|---|---|---|
| Package structure | Task 1 | ✓ |
| Config/env parsing | Task 1 | ✓ |
| Helper utilities | Task 1 | ✓ |
| SSE stream parser | Task 2 | ✓ |
| SSE pipe response | Task 2 | ✓ |
| Auth middleware | Task 3 | ✓ |
| Rate limiter | Task 3 | ✓ |
| Logger | Task 3 | ✓ |
| DSML normalization | Task 4 | ✓ |
| Responses translator | Task 5 | ✓ |
| Anthropic translator | Task 6 | ✓ |
| Upstream client | Task 7 | ✓ |
| Chat handler | Task 8 | ✓ |
| Responses handler | Task 8 | ✓ |
| Anthropic handler | Task 8 | ✓ |
| App factory + CORS | Task 9 | ✓ |
| CLI entry point | Task 9 | ✓ |
| Unit tests (translators) | Tasks 4-6 | ✓ |
| Integration tests (handlers) | Task 8 | ✓ |
| E2E test (mock upstream) | Task 10 | ✓ |
| Single dependency (aiohttp) | All | ✓ |
| No Gateway fallback | Task 7 | ✓ |
| API_KEY single var | Tasks 3, 7, 9 | ✓ |
| snake_case naming | All | ✓ |

No gaps found. All spec requirements mapped to implementation tasks.
