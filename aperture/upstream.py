"""Upstream API client.

Manages connection to upstream Chat Completions API via app's shared session.
No Gateway fallback (Cloudflare-specific logic removed).
"""

import asyncio
import os
from aiohttp import web, ClientResponse, ClientError, ClientConnectionError

from .helpers import cors_headers
from .middleware.logger import Logger


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
    log: Logger | None = None,
    url_override: str | None = None,
    headers_override: dict | None = None,
) -> ClientResponse | web.Response:
    """Send a Chat Completions request to the upstream API.

    Uses the app's shared aiohttp ClientSession.
    On network error, returns a 502 web.Response with a structured error body.

    Categorizes upstream errors:
    - Timeout → 504
    - Connection refused/DNS failure → 502 with UPSTREAM_UNREACHABLE
    - Other client errors → 502 with UPSTREAM_ERROR
    - Unexpected → 502 with INTERNAL_ERROR
    """
    url = url_override or build_upstream_url(app)
    headers = headers_override or build_auth_headers(app)
    client = app.get("client")
    model = chat_body.get("model", "")

    if log:
        log.info("upstream.request", {
            "url": url,
            "model": model,
        })

    if client is None:
        msg = "Upstream client not initialized"
        if log:
            log.error("upstream.no_client", {"url": url})
        return web.json_response(
            {"error": {"message": msg, "type": "upstream_error", "code": "NO_CLIENT"}},
            status=502,
            headers=cors_headers(),
        )

    timeout_ms = app.get("request_timeout", 120000)

    try:
        resp = await client.post(url, json=chat_body, headers=headers)
        if log:
            log.info("upstream.response", {
                "url": url,
                "status": resp.status,
                "model": model,
            })
        return resp

    except asyncio.TimeoutError:
        if log:
            log.error("upstream.timeout", {
                "url": url,
                "timeout_ms": timeout_ms,
                "model": model,
            })
        return web.json_response(
            {
                "error": {
                    "message": f"Upstream request timed out after {timeout_ms}ms",
                    "type": "timeout_error",
                    "code": "UPSTREAM_TIMEOUT",
                },
            },
            status=504,
            headers=cors_headers(),
        )

    except ClientConnectionError as exc:
        if log:
            log.error("upstream.unreachable", {
                "url": url,
                "error": str(exc),
                "model": model,
            })
        return web.json_response(
            {
                "error": {
                    "message": f"Upstream unreachable: {exc}",
                    "type": "connection_error",
                    "code": "UPSTREAM_UNREACHABLE",
                },
            },
            status=502,
            headers=cors_headers(),
        )

    except ClientError as exc:
        if log:
            log.error("upstream.client_error", {
                "url": url,
                "error": str(exc),
                "model": model,
            })
        return web.json_response(
            {
                "error": {
                    "message": f"Upstream error: {exc}",
                    "type": "upstream_error",
                    "code": "UPSTREAM_CLIENT_ERROR",
                },
            },
            status=502,
            headers=cors_headers(),
        )

    except Exception as exc:
        if log:
            log.error("upstream.unexpected", {
                "url": url,
                "error": str(exc),
                "type": type(exc).__name__,
                "model": model,
            })
        return web.json_response(
            {
                "error": {
                    "message": "Internal upstream error",
                    "type": "internal_error",
                    "code": "INTERNAL_ERROR",
                },
            },
            status=502,
            headers=cors_headers(),
        )


async def send_with_fallback(
    app: web.Application,
    chat_body: dict,
    log: Logger | None = None,
) -> ClientResponse | web.Response:
    """Send request with primary/backup fallback.

    Tries primary upstream first. If the failure is retryable
    (timeout, connection error, 5xx) and a backup is configured,
    retries once on the backup upstream.
    """
    # Step 1: Try primary
    resp = await send_chat_request(app, chat_body, log)
    if _is_success(resp):
        return resp

    if _is_retryable(resp) and _has_backup(app):
        log and log.warn("upstream.fallback", {
            "reason": _error_code(resp),
            "from": app.get("upstream_base_url", ""),
            "to": app.get("backup_upstream_base_url", ""),
        })
        backup_url = _build_backup_url(app)
        backup_headers = _build_backup_headers(app)
        resp = await send_chat_request(app, chat_body, log, url_override=backup_url, headers_override=backup_headers)

    return resp


def _is_success(resp: ClientResponse | web.Response) -> bool:
    """< 400 from upstream is success; web.Response means send_chat_request already errored."""
    if isinstance(resp, web.Response):
        return False
    return resp.status < 400


def _is_retryable(resp: ClientResponse | web.Response) -> bool:
    """Timeout (504), connection error (502), or upstream 5xx."""
    if isinstance(resp, web.Response):
        return resp.status in (502, 504)
    return resp.status >= 500


def _error_code(resp: ClientResponse | web.Response) -> str:
    if isinstance(resp, web.Response):
        body = resp.body
        if isinstance(body, bytes):
            try:
                import json
                payload = json.loads(body)
                return payload.get("error", {}).get("code", f"HTTP_{resp.status}")
            except Exception:
                pass
        return f"HTTP_{resp.status}"
    return f"HTTP_{resp.status}"


def _has_backup(app: web.Application) -> bool:
    enabled = app.get("backup_enabled", True)
    return enabled and bool(app.get("backup_upstream_base_url", ""))


def _build_backup_url(app: web.Application) -> str:
    base_url = app.get("backup_upstream_base_url", "")
    return f"{base_url.rstrip('/')}/chat/completions"


def _build_backup_headers(app: web.Application) -> dict:
    api_key = app.get("backup_api_key", "")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }


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
