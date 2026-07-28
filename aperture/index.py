"""Aperture application factory and route dispatch.

Creates the aiohttp application, wires up middleware and routes.
Mirrors JS src/index.js.
"""

import json
import os
import time

from aiohttp import web

from .helpers import error_response, cors_headers
from .middleware.auth import authenticate
from .middleware.rate_limiter import create_rate_limiter
from .handlers.chat import handle_chat_completions
from .handlers.responses import handle_responses_api
from .handlers.anthropic import handle_anthropic_messages


def _detect_route(path: str, body: dict) -> str:
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

    model_map_raw = os.environ.get("MODEL_MAP", "{}")
    try:
        model_map = json.loads(model_map_raw)
        if isinstance(model_map, dict):
            for alias, target in model_map.items():
                add_model(alias)
                add_model(target)
    except (json.JSONDecodeError, TypeError):
        pass

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
    if request.method == "GET":
        return await handler(request)

    rate_limiter = request.app.get("rate_limiter")
    if rate_limiter is None:
        return await handler(request)

    client_ip = request.remote or request.headers.get("X-Forwarded-For", "unknown")
    allowed, reset_at = rate_limiter(client_ip)

    if not allowed:
        retry_after = max(1, int((reset_at - (time.time() * 1000)) / 1000))
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
    if request.method in ("GET", "OPTIONS"):
        return await handler(request)

    api_key = request.app.get("api_key") or os.environ.get("API_KEY", "")
    auth_response = authenticate(request, api_key)
    if auth_response is not None:
        return auth_response

    return await handler(request)


async def _handle_post(request: web.Request) -> web.Response:
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
    import aiohttp
    timeout_sec = app.get("request_timeout", int(os.environ.get("REQUEST_TIMEOUT_MS", "120000"))) / 1000.0
    app["client"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_sec))
    yield
    await app["client"].close()


def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware, rate_limit_middleware, auth_middleware])

    app["upstream_base_url"] = os.environ.get("UPSTREAM_BASE_URL", "https://opencode.ai/zen/go/v1")
    app["api_key"] = os.environ.get("API_KEY", "")

    window_ms = int(os.environ.get("RATE_LIMIT_WINDOW_MS", "60000"))
    max_req = int(os.environ.get("RATE_LIMIT_MAX", "120"))
    app["rate_limiter"] = create_rate_limiter(window_ms, max_req)

    app["request_timeout"] = int(os.environ.get("REQUEST_TIMEOUT_MS", "120000"))

    app.cleanup_ctx.append(_client_session_ctx)

    app.router.add_get("/v1/models", _handle_list_models)
    app.router.add_get("/models", _handle_list_models)
    app.router.add_post("/{path:.*}", _handle_post)

    return app
