"""Anthropic Messages API handler — translate, send, translate back."""

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

    chat_req = translate_anthropic_to_chat(body, dict(app))
    chat_req["model"] = map_model_name(chat_req.get("model"), app)

    log = create_logger("anthropic")

    upstream_response = await send_chat_request(app, chat_req)

    if isinstance(upstream_response, web.Response):
        return upstream_response

    if not upstream_response.ok:
        log.error("upstream.failed", {"status": upstream_response.status})
        return web.json_response(
            {
                "id": request_id,
                "type": "error",
                "error": {"type": "invalid_request_error", "message": "Upstream request failed"},
            },
            status=upstream_response.status,
            headers={
                "x-request-id": request_id,
                "request-id": request_id,
                **cors_headers(),
            },
        )

    if chat_req.get("stream"):
        return await pipe_sse(
            translate_anthropic_stream(upstream_response, request_id, chat_req.get("model", "")),
            request,
        )

    result = await translate_anthropic_json(upstream_response, request_id, chat_req.get("model", ""))
    return web.json_response(
        result,
        headers={
            "x-request-id": request_id,
            "request-id": request_id,
            **cors_headers(),
        },
    )
