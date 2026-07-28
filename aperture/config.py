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
    """Map a model name to a known model or fall back to DEFAULT_MODEL.

    * None -> default model
    * Already known -> returned as-is
    * MODEL_MAP alias -> resolved to mapped target
    * Unknown -> default model
    """
    if model is None:
        return resolve_default_model(env)

    model_str = str(model)
    if model_str in _KNOWN_MODELS:
        return model_str

    # Check MODEL_MAP alias
    model_map_raw = env.get("MODEL_MAP", {})
    if isinstance(model_map_raw, str):
        try:
            model_map = json.loads(model_map_raw)
        except (json.JSONDecodeError, TypeError):
            model_map = {}
    elif isinstance(model_map_raw, dict):
        model_map = model_map_raw
    else:
        model_map = {}

    if model_str in model_map:
        return model_map[model_str]

    return resolve_default_model(env)


def resolve_default_model(env: dict) -> str:
    """Return the default model from env, falling back to deepseek-v4-flash."""
    return env.get("DEFAULT_MODEL", "deepseek-v4-flash")
