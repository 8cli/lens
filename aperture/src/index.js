import { authenticate } from "./middleware/auth.js";
import { createRateLimiter } from "./middleware/rate-limiter.js";
import { errorResponse } from "./helpers.js";
import { handleChatCompletions } from "./handlers/chat.js";
import { handleResponsesAPI } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic.js";

function detectRoute(path, body) {
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";
  if (body.messages) return "chat";
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";
  return "responses";
}

/**
 * Build the model list from environment configuration.
 * Exposes aliases (MODEL_MAP keys) and the actual upstream models, plus
 * Claude-compatible IDs so tools like Claude Code can find a usable model.
 */
function handleListModels(env, cors) {
  const models = [];
  const seen = new Set();

  const addModel = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    models.push({ id, object: "model", created: 1780000000, owned_by: "aperture" });
  };

  // Default model
  const defaultModel = env.DEFAULT_MODEL || "deepseek-v4-flash";
  addModel(defaultModel);

  // MODEL_MAP entries (both aliases and targets)
  if (env.MODEL_MAP) {
    try {
      const map = JSON.parse(env.MODEL_MAP);
      for (const [alias, target] of Object.entries(map)) {
        addModel(alias);
        addModel(target);
      }
    } catch { /* ignore invalid JSON */ }
  }

  // Common AI client model IDs — all fall back to DEFAULT_MODEL at runtime
  const common = [
    "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514",
    "claude-sonnet-4", "claude-opus-4", "claude-haiku-4-20251001",
    "o3-mini", "gpt-4o", "gpt-4o-mini",
  ];
  for (const id of common) addModel(id);

  return new Response(JSON.stringify({ data: models }), {
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Model discovery endpoint — used by Claude Code, Cursor, etc.
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (path === "/v1/models" || path === "/models") return handleListModels(env, cors);
      return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);
    }

    if (request.method !== "POST") return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);

    // Rate limiter is per-request (best-effort within Workers isolate model).
    // CF edge provides DDoS protection — this is an additional soft throttle.
    const rateLimiter = createRateLimiter(
      Math.max(1000, parseInt(env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000),
      Math.max(1, parseInt(env.RATE_LIMIT_MAX || "120", 10) || 120)
    );
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateCheck = rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: "RATE_LIMITED" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil((rateCheck.resetAt - Date.now()) / 1000)), ...cors } }
      );
    }

    const authResponse = authenticate(request, env);
    if (authResponse) return authResponse;

    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }

    switch (detectRoute(path, body)) {
      case "chat":      return handleChatCompletions(body, env, request.signal);
      case "responses": return handleResponsesAPI(body, env, request.signal);
      case "anthropic": return handleAnthropicMessages(body, env, request.signal);
    }
  },
};
