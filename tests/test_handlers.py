"""Integration tests for handlers using aiohttp TestClient."""

import pytest
from aperture.index import create_app


@pytest.fixture
def app():
    import os
    os.environ["API_KEY"] = "sk-test"
    os.environ["DEFAULT_MODEL"] = "test-model"
    os.environ["UPSTREAM_BASE_URL"] = "http://localhost:99999"
    return create_app()


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
    assert len(data["data"]) > 0


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
        json={"model": "test", "messages": [{"role": "user", "content": "Hi"}], "stream": False},
        headers={"Authorization": "Bearer sk-test"},
    )
    # Auth passes — no real upstream so should get 502
    assert resp.status in (200, 502)


@pytest.mark.asyncio
async def test_anthropic_route_detection(client):
    resp = await client.post(
        "/v1/messages",
        json={"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hi"}]},
        headers={"Authorization": "Bearer sk-test"},
    )
    assert resp.status in (200, 502)
