// --- Configuration Constants ----------------------------------------
// Bottom-layer module: must NOT import from helpers.js or any other local module.

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const MIN_MAX_TOKENS = 1024;
export const DEFAULT_MAX_TOKENS = 16384;
export const SSE_BUFFER_MAX = 2 * 1024 * 1024;
export const DSML_CONTENT_MAX = 10000;

/**
 * Resolve the effective default model from environment or fallback constant.
 * @param {{ DEFAULT_MODEL?: string } | undefined} env
 * @returns {string}
 */
export function resolveDefaultModel(env) {
  return env?.DEFAULT_MODEL || DEFAULT_MODEL;
}

/**
 * Map client-provided model names to actual upstream model names.
 *
 * Supports:
 * 1. Known provider names (go, go_proxy, default, auto) -> resolveDefaultModel(env)
 * 2. Explicit model mappings via MODEL_MAP env var (JSON object, case-insensitive keys)
 * 3. Everything else falls back to resolveDefaultModel(env)
 *
 * @param {string | undefined} model
 * @param {{ DEFAULT_MODEL?: string, MODEL_MAP?: string } | undefined} env
 * @returns {string}
 */
export function mapModelName(model, env = {}) {
  if (!model) return resolveDefaultModel(env);

  const trimmed = String(model).toLowerCase().trim();
  const knownProviders = ["go", "go_proxy", "default", "auto"];
  if (knownProviders.includes(trimmed)) {
    return resolveDefaultModel(env);
  }

  // Parse custom model map from environment (case-insensitive keys)
  if (env.MODEL_MAP) {
    try {
      const map = JSON.parse(env.MODEL_MAP);
      if (map[trimmed]) return map[trimmed];
    } catch {
      // ignore invalid JSON
    }
  }

  // Fallback to default model for any unrecognized name
  // (so clients can use any arbitrary model alias)
  return resolveDefaultModel(env);
}
