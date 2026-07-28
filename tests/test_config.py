"""Tests for aperture/config.py."""

import os

from aperture.config import (
    get_env_int,
    get_env_json,
    get_env_str,
    map_model_name,
    resolve_default_model,
)


class TestMapModelName:
    def test_map_model_none_returns_default(self):
        env = {"DEFAULT_MODEL": "claude-sonnet-4"}
        result = map_model_name(None, env)
        assert result == "claude-sonnet-4"

    def test_map_model_unknown_resolves_default(self):
        env = {"DEFAULT_MODEL": "claude-opus-4"}
        result = map_model_name("completely-unknown-model", env)
        assert result == "claude-opus-4"

    def test_map_model_alias_from_env(self):
        env = {
            "MODEL_MAP": '{"my-alias": "claude-haiku-4-20250514"}',
            "DEFAULT_MODEL": "deepseek-v4-flash",
        }
        result = map_model_name("my-alias", env)
        assert result == "claude-haiku-4-20250514"


class TestResolveDefaultModel:
    def test_resolve_default_model_fallback(self):
        result = resolve_default_model({})
        assert result == "deepseek-v4-flash"


class TestGetEnvInt:
    def test_get_env_int_default(self):
        # Key does not exist — should return default
        result = get_env_int("NONEXISTENT_KEY_FOR_TEST", 42)
        assert result == 42

    def test_get_env_int_parsed(self, monkeypatch):
        monkeypatch.setenv("TEST_INT_KEY", "99")
        result = get_env_int("TEST_INT_KEY", 0)
        assert result == 99
