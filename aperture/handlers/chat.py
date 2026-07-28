"""Chat Completions handler — passthrough with model override and stream filtering."""

import json
from typing import AsyncIterator
from aiohttp import web

from ..config import map_model_name
from ..upstream import send_chat_request
from ..stream import pipe_sse_raw
from ..translators.dsml import normalize_dsml_tool_calls
from ..helpers import error_response, cors_headers
from ..middleware.logger import create_logger


async def filter_chat_stream(response) -> AsyncIterator[str]:
    """Filter SSE stream to strip non-standard fields (reasoning_content, null content)."""
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
    """Handle a Chat Completions request: override model, send upstream, filter/normalize."""
    app = request.app
    body["model"] = map_model_name(body.get("model"), app)

    log = create_logger("chat")

    upstream_response = await send_chat_request(app, body)

    if isinstance(upstream_response, web.Response):
        return upstream_response

    if not upstream_response.ok:
        log.error("upstream.failed", {"status": upstream_response.status})
        return error_response("Upstream request failed", "upstream_error", "UPSTREAM", upstream_response.status)

    if body.get("stream"):
        return await pipe_sse_raw(filter_chat_stream(upstream_response), request)

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
