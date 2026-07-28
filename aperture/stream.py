"""SSE stream parsing and piped response utilities.

Mirrors JS src/stream.js.

Two operations:
1. Parse inbound SSE (upstream via ClientResponse -> parsed dicts): stream_sse()
2. Pipe outbound events (generator -> SSE HTTP response): pipe_sse() / pipe_sse_raw()
"""

import json
from typing import AsyncIterator

from aiohttp import web, ClientResponse

from .helpers import cors_headers

MAX_SSE_BUFFER = 2 * 1024 * 1024  # 2 MB


async def stream_sse(response: ClientResponse) -> AsyncIterator[dict]:
    """Parse SSE "data: {...}" lines from a response body.

    Yields parsed JSON objects from each "data: {...}" line.
    Skips "[DONE]" signals and malformed JSON.
    Raises RuntimeError if buffer exceeds 2MB limit.

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
        # Keep the last partial line in the buffer for next chunk
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

    Each yielded value is written as-is followed by a newline.
    Used by filter_chat_stream which already emits properly formatted SSE lines.
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
