"""Tests for aperture/config.py."""

import os

from aperture.config import (
    get_env_int,
    get_env_str,
    map_model_name,
    BACKEND_MODEL,
)


class TestMapModelName:
    def test_map_model_none_returns_backend(self):
        assert map_model_name(None) == BACKEND_MODEL

    def test_map_model_unknown_resolves_backend(self):
        assert map_model_name("completely-unknown-model") == BACKEND_MODEL

    def test_map_model_always_backend(self):
        assert map_model_name("claude-sonnet-4-20250514") == BACKEND_MODEL
        assert map_model_name("gpt-4o") == BACKEND_MODEL
        assert map_model_name("o3-mini") == BACKEND_MODEL
        assert map_model_name("") == BACKEND_MODEL


class TestGetEnvInt:
    def test_get_env_int_default(self):
        # Key does not exist — should return default
        result = get_env_int("NONEXISTENT_KEY_FOR_TEST", 42)
        assert result == 42

    def test_get_env_int_parsed(self, monkeypatch):
        monkeypatch.setenv("TEST_INT_KEY", "99")
        result = get_env_int("TEST_INT_KEY", 0)
        assert result == 99
