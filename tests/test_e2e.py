"""End-to-end tests with a mock upstream HTTP server."""

import json
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
                headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
            )
            await resp.prepare(request)
            data = json.dumps({
                "choices": [{"delta": {"content": "Hello"}, "index": 0, "finish_reason": None}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 10},
            })
            await resp.write(f"data: {data}\n\n".encode())
            done = json.dumps({
                "choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}],
            })
            await resp.write(f"data: {done}\n\n".encode())
            await resp.write(b"data: [DONE]\n\n")
            return resp

        return web.json_response({
            "choices": [{
                "message": {"content": "Hello!", "tool_calls": []},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15},
        })

    up_app = web.Application()
    up_app.router.add_post("/chat/completions", chat_handler)
    return await aiohttp_server(up_app, port=None)


@pytest.fixture
def aperture_app(mock_upstream):
    """Aperture app pointed at the mock upstream."""
    import os
    os.environ["API_KEY"] = "sk-test"
    os.environ["DEFAULT_MODEL"] = "test-model"
    os.environ["UPSTREAM_BASE_URL"] = f"http://localhost:{mock_upstream.port}"
    return create_app()


@pytest.mark.asyncio
async def test_chat_completions_non_streaming(aiohttp_client, aperture_app):
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
async def test_responses_api_non_streaming(aiohttp_client, aperture_app):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/chat/completions",
        json={"input": "Hi", "model": "test"},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200


@pytest.mark.asyncio
async def test_anthropic_messages_non_streaming(aiohttp_client, aperture_app):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/messages",
        json={"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hi"}], "stream": False},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200
    data = await resp.json()
    assert data["type"] == "message"
    assert data["content"][0]["text"] == "Hello!"


@pytest.mark.asyncio
async def test_route_detection_by_body(aiohttp_client, aperture_app):
    """POST without chat completions path but with messages field should route to chat."""
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/some-path",
        json={"messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status == 200


@pytest.mark.asyncio
async def test_unauthorized_request_returns_401(aiohttp_client, aperture_app):
    client = await aiohttp_client(aperture_app)
    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "Hi"}]},
        headers={},  # No auth
    )
    assert resp.status == 401
