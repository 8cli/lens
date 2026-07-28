"""OpenAI Responses API handler — translate, send, translate back."""

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

    if chat_req.get("stream"):
        return await pipe_sse(
            translate_stream_events(upstream_response, resp_id, chat_req.get("model", "")),
            request,
        )

    result = await translate_response_json(upstream_response, resp_id, chat_req.get("model", ""))
    return web.json_response(result, headers=cors_headers())
