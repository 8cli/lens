"""Tests for upstream client."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock
from aiohttp import web, ClientConnectionError
from aperture.index import create_app
from aperture.upstream import extract_usage, send_chat_request
from aperture.middleware.logger import Logger


class TestExtractUsage:
    def test_openai_format(self):
        data = {"usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
        result = extract_usage(data)
        assert result["input_tokens"] == 10
        assert result["output_tokens"] == 20
        assert result["total_tokens"] == 30

    def test_responses_format(self):
        data = {"usage": {"input_tokens": 10, "output_tokens": 20}}
        result = extract_usage(data)
        assert result["input_tokens"] == 10
        assert result["output_tokens"] == 20

    def test_none(self):
        assert extract_usage({}) is None
        assert extract_usage(None) is None


@pytest.mark.asyncio
async def test_send_chat_request_no_client():
    """When no client session exists, returns 502."""
    resp = await send_chat_request(_make_app_mock(None), {"model": "test"})
    assert resp.status == 502


def _make_app_mock(client_session, **overrides):
    """Create a mock app dict for send_chat_request tests."""
    base = {
        "upstream_base_url": "http://upstream.test/v1",
        "request_timeout": 30000,
        "api_key": "sk-test",
    }
    if client_session is not None:
        base["client"] = client_session
    app = MagicMock()
    def get_side(key, default=None):
        return {**base, **overrides}.get(key, default)
    app.get.side_effect = get_side
    return app


@pytest.mark.asyncio
async def test_send_chat_request_timeout():
    """Timeout returns 504."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=asyncio.TimeoutError())
    resp = await send_chat_request(_make_app_mock(session), {"model": "test"})
    assert resp.status == 504


@pytest.mark.asyncio
async def test_send_chat_request_connection_error():
    """Connection refused returns 502 with UPSTREAM_UNREACHABLE."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=ClientConnectionError("Connection refused"))
    resp = await send_chat_request(_make_app_mock(session), {"model": "test"})
    assert resp.status == 502


@pytest.mark.asyncio
async def test_send_chat_request_generic_client_error():
    """Other client errors return 502 with UPSTREAM_CLIENT_ERROR."""
    from aiohttp import ClientError
    session = MagicMock()
    session.post = AsyncMock(side_effect=ClientError("Unknown client error"))
    resp = await send_chat_request(_make_app_mock(session), {"model": "test"})
    assert resp.status == 502
