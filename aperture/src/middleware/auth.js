import { errorResponse } from "../helpers.js";

/**
 * Authenticate a request against the configured AI_GATEWAY_TOKEN.
 * Supports: Authorization: Bearer <token> (OpenAI style) and x-api-key (Anthropic style).
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Response | null} 401 Response on failure, null on pass
 */
export function authenticate(request, env) {
  const expected = env.AI_GATEWAY_TOKEN;
  if (!expected) {
    return errorResponse("Invalid or missing API key", "authentication_error", "UNAUTHORIZED", 401);
  }

  // Try Authorization: Bearer first, then x-api-key
  let token = null;
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  if (!token) {
    token = request.headers.get("x-api-key");
  }

  if (!token || token !== expected) {
    return errorResponse("Invalid or missing API key", "authentication_error", "UNAUTHORIZED", 401);
  }

  return null;
}
