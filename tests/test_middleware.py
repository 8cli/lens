"""Tests for middleware modules — auth, rate limiter, logger."""

import json
import time
import pytest
from aiohttp import web
from aperture.middleware.auth import authenticate
from aperture.middleware.rate_limiter import create_rate_limiter
from aperture.middleware.logger import create_logger


# --- Auth tests ---

class MockRequest:
    """Minimal request mock with headers dict."""
    def __init__(self, headers=None):
        self.headers = headers or {}


class TestAuth:
    def test_missing_key_returns_401(self):
        req = MockRequest()
        resp = authenticate(req, "sk-secret")
        assert resp is not None
        assert resp.status == 401

    def test_wrong_key_returns_401(self):
        req = MockRequest({"Authorization": "Bearer sk-wrong"})
        resp = authenticate(req, "sk-secret")
        assert resp is not None
        assert resp.status == 401

    def test_valid_bearer_returns_none(self):
        req = MockRequest({"Authorization": "Bearer sk-correct"})
        resp = authenticate(req, "sk-correct")
        assert resp is None

    def test_valid_x_api_key_returns_none(self):
        req = MockRequest({"x-api-key": "sk-correct"})
        resp = authenticate(req, "sk-correct")
        assert resp is None

    def test_empty_key_skipped(self):
        req = MockRequest()
        assert authenticate(req, None) is None
        assert authenticate(req, "") is None


# --- Rate limiter tests ---

class TestRateLimiter:
    def test_allows_first_request(self):
        check = create_rate_limiter(60000, 10)
        allowed, reset_at = check("client-1")
        assert allowed is True
        assert reset_at > time.time() * 1000

    def test_blocks_after_limit(self):
        check = create_rate_limiter(60000, 3)
        for _ in range(3):
            allowed, _ = check("client-1")
            assert allowed is True
        allowed, _ = check("client-1")
        assert allowed is False

    def test_different_keys_independent(self):
        check = create_rate_limiter(60000, 3)
        for _ in range(3):
            check("client-1")
        allowed_client1, _ = check("client-1")
        assert allowed_client1 is False
        allowed_client2, _ = check("client-2")
        assert allowed_client2 is True


# --- Logger tests ---

class TestLogger:
    def test_basic_output(self, capsys):
        log = create_logger("req-123")
        log.info("test.event", {"key": "val"})
        captured = capsys.readouterr()
        parsed = json.loads(captured.out.strip())
        assert parsed["level"] == "info"
        assert parsed["event"] == "test.event"
        assert parsed["requestId"] == "req-123"
        assert parsed["key"] == "val"

    def test_error_goes_to_stderr(self, capsys):
        log = create_logger("req-err")
        log.error("fail.event", {"reason": "timeout"})
        captured = capsys.readouterr()
        # error goes to stderr
        parsed = json.loads(captured.err.strip())
        assert parsed["level"] == "error"
        assert parsed["event"] == "fail.event"
