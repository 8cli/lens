"""Configuration helpers — pure functions reading from environment."""

import json
import os


# Allowlist for DSML content regex to prevent ReDoS
DSML_CONTENT_MAX: int = 100_000

_KNOWN_MODELS = frozenset({
    "deepseek-v4-flash",
    "dv4f",
    "aigo",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-haiku-4-20250514",
    "claude-sonnet-4",
    "claude-opus-4",
    "claude-haiku-4-20251001",
    "o3-mini",
    "gpt-4o",
    "gpt-4o-mini",
})


def get_env_str(key: str, default: str = "") -> str:
    """Read a string from the environment."""
    return os.environ.get(key, default)


def get_env_int(key: str, default: int) -> int:
    """Read an integer from the environment."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (ValueError, TypeError):
        return default


def get_env_json(key: str, default=None) -> dict:
    """Read a JSON value from the environment."""
    raw = os.environ.get(key)
    if raw is None:
        return default if default is not None else {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default if default is not None else {}


def map_model_name(model: str, env: dict) -> str:
    """Always return DEFAULT_MODEL — every incoming model is fixed to the user's configured default.

    Regardless of what model name the client sends, it is replaced with the
    value of the DEFAULT_MODEL environment variable. This ensures all upstream
    requests use a single, user-specified model.

    * None -> default model
    * Known model name (even if in _KNOWN_MODELS) -> default model
    * MODEL_MAP alias -> default model
    * Unknown -> default model
    """
    return resolve_default_model(env)


def resolve_default_model(env: dict) -> str:
    """Return the default model from env, falling back to deepseek-v4-flash."""
    return env.get("DEFAULT_MODEL", "deepseek-v4-flash")
