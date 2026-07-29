"""Tests for upstream fallback logic."""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock
from aiohttp import web, ClientConnectionError
from aperture.upstream import send_with_fallback, send_chat_request


def _make_app(backup_url="", backup_key="", **overrides):
    """Create a minimal app dict for testing."""
    base = {
        "upstream_base_url": "http://primary.test/v1",
        "api_key": "sk-primary",
        "request_timeout": 30000,
        "backup_upstream_base_url": backup_url,
        "backup_api_key": backup_key,
        "cb_threshold": 3,
        "cb_cooldown_sec": 300,
        "_cb_failures": 0,
        "_cb_open_until": 0.0,
    }
    if overrides:
        base.update(overrides)
    app = MagicMock()
    app.__getitem__ = lambda s, key: base[key]
    app.__setitem__ = lambda s, key, val: base.update({key: val})
    def get_side(key, default=None):
        return base.get(key, default)
    app.get.side_effect = get_side
    return app


@pytest.mark.asyncio
async def test_fallback_primary_success():
    """Primary 2xx → no fallback called."""
    session = MagicMock()
    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.ok = True
    session.post = AsyncMock(return_value=mock_resp)

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 200
    assert session.post.call_count == 1
    # Verify it called primary URL
    call_url = session.post.call_args[0][0]
    assert "primary" in call_url


@pytest.mark.asyncio
async def test_fallback_primary_4xx_no_retry():
    """Primary 4xx → NOT retried on backup."""
    session = MagicMock()
    mock_resp = MagicMock()
    mock_resp.status = 400
    mock_resp.ok = False
    session.post = AsyncMock(return_value=mock_resp)

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    # Should return the 400 without retrying
    assert resp.status == 400
    assert session.post.call_count == 1


@pytest.mark.asyncio
async def test_fallback_primary_timeout():
    """Primary timeout → retry on backup."""
    session = MagicMock()
    # First call: timeout
    session.post = AsyncMock(side_effect=[
        asyncio.TimeoutError(),
        # fallback call
        MagicMock(status=200, ok=True),
    ])

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 200
    assert session.post.call_count == 2
    # Verify second call went to backup
    call_urls = [call[0][0] for call in session.post.call_args_list]
    assert any("backup" in url for url in call_urls)


@pytest.mark.asyncio
async def test_fallback_primary_5xx():
    """Primary 5xx → retry on backup."""
    session = MagicMock()
    primary_resp = MagicMock()
    primary_resp.status = 502
    primary_resp.ok = False
    backup_resp = MagicMock()
    backup_resp.status = 200
    backup_resp.ok = True

    session.post = AsyncMock(side_effect=[primary_resp, backup_resp])

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 200
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_fallback_no_backup_configured():
    """Primary timeout, no backup → returns error, no crash."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=asyncio.TimeoutError())

    app = _make_app(backup_url="", backup_key="", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 504
    assert session.post.call_count == 1


@pytest.mark.asyncio
async def test_fallback_both_fail():
    """Primary fails, backup also fails → return final error."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=[
        asyncio.TimeoutError(),
        ClientConnectionError("Backup refused"),
    ])

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 502
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_fallback_primary_connection_error():
    """Primary connection error → retry on backup."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=[
        ClientConnectionError("Connection refused"),
        MagicMock(status=200, ok=True),
    ])

    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})

    assert resp.status == 200
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_circuit_breaker_trips_after_3_failures():
    """3 consecutive failures → breaker opens, subsequent requests skip primary."""
    fail_resp = MagicMock(status=502, ok=False)
    backup_resp = MagicMock(status=200, ok=True)

    app = _make_app("http://backup.test/v1", "sk-backup", cb_threshold=3, cb_cooldown_sec=300)

    for i in range(3):
        session = MagicMock()
        session.post = AsyncMock(side_effect=[fail_resp, backup_resp])
        app["client"] = session
        resp = await send_with_fallback(app, {"model": "test"})
        assert resp.status == 200
        assert session.post.call_count == 2, f"Request {i+1} should try both"

    # 4th request: breaker should be open, skip primary, go straight to backup
    session = MagicMock()
    session.post = AsyncMock(side_effect=[backup_resp])
    app["client"] = session
    resp = await send_with_fallback(app, {"model": "test"})
    assert resp.status == 200
    assert session.post.call_count == 1, "Breaker open: should skip primary, only call backup"


@pytest.mark.asyncio
async def test_circuit_breaker_resets_on_success():
    """Successful request resets the breaker counter."""
    fail_resp = MagicMock(status=502, ok=False)
    backup_resp = MagicMock(status=200, ok=True)
    success_resp = MagicMock(status=200, ok=True)

    app = _make_app("http://backup.test/v1", "sk-backup", cb_threshold=3, cb_cooldown_sec=300)

    # 2 failures to pre-heat counter
    session = MagicMock()
    session.post = AsyncMock(side_effect=[fail_resp, backup_resp])
    app["client"] = session
    await send_with_fallback(app, {"model": "test"})

    session = MagicMock()
    session.post = AsyncMock(side_effect=[fail_resp, backup_resp])
    app["client"] = session
    await send_with_fallback(app, {"model": "test"})
    assert app["_cb_failures"] == 2, "Should have 2 recorded failures"

    # Now primary succeeds — resets counter
    session = MagicMock()
    session.post = AsyncMock(side_effect=[success_resp])
    app["client"] = session
    resp = await send_with_fallback(app, {"model": "test"})
    assert resp.status == 200
    assert app["_cb_failures"] == 0, "Success should reset failure counter"
    assert app["_cb_open_until"] == 0.0, "Success should close breaker"


@pytest.mark.asyncio
async def test_circuit_breaker_no_backup_ignored():
    """Without backup, breaker never opens — just returns error."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=asyncio.TimeoutError())

    app = _make_app(backup_url="", backup_key="", client=session)
    for _ in range(5):
        resp = await send_with_fallback(app, {"model": "test"})
        assert resp.status == 504
    assert app["_cb_failures"] == 0, "No backup configured — counter should remain 0"