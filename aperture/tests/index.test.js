// ─── Integration tests: full request pipeline ────────────
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../src/index.js";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest before imports)
// ---------------------------------------------------------------------------

vi.mock("../src/handlers/chat.js", () => ({ handleChatCompletions: vi.fn() }));
vi.mock("../src/handlers/responses.js", () => ({ handleResponsesAPI: vi.fn() }));
vi.mock("../src/handlers/anthropic.js", () => ({ handleAnthropicMessages: vi.fn() }));

// Mock rate limiter: default to all allowed; individual tests can override
vi.mock("../src/middleware/rate-limiter.js", () => ({
  createRateLimiter: vi.fn(() => ({
    check: vi.fn(() => ({ allowed: true, resetAt: Date.now() + 60000 })),
  })),
}));

import { handleChatCompletions } from "../src/handlers/chat.js";
import { handleResponsesAPI } from "../src/handlers/responses.js";
import { handleAnthropicMessages } from "../src/handlers/anthropic.js";
import { createRateLimiter } from "../src/middleware/rate-limiter.js";

// ---------------------------------------------------------------------------
// Test-wide constants
// ---------------------------------------------------------------------------

const BASE_ENV = {
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX: "120",
  AI_GATEWAY_TOKEN: "test-token",
};

const AUTH_HEADERS = {
  Authorization: "Bearer test-token",
};

// Common CORS headers that should appear on all responses
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, x-api-key",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("index.js — full request pipeline", () => {
  beforeEach(() => {
    vi.mocked(handleChatCompletions).mockReset();
    vi.mocked(handleResponsesAPI).mockReset();
    vi.mocked(handleAnthropicMessages).mockReset();

    // Default: each handler returns a 200 success response
    vi.mocked(handleChatCompletions).mockReturnValue(
      new Response("chat ok", { status: 200 }),
    );
    vi.mocked(handleResponsesAPI).mockReturnValue(
      new Response("responses ok", { status: 200 }),
    );
    vi.mocked(handleAnthropicMessages).mockReturnValue(
      new Response("anthropic ok", { status: 200 }),
    );

    // Reset rate limiter mock to allow-all
    vi.mocked(createRateLimiter).mockReset();
    vi.mocked(createRateLimiter).mockReturnValue({
      check: () => ({ allowed: true, resetAt: Date.now() + 60000 }),
    });
  });

  // ── 1. OPTIONS → 200 with CORS headers ──────────────────
  it("returns 200 with CORS headers on OPTIONS preflight", async () => {
    const request = new Request("http://test.com/", { method: "OPTIONS" });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }

    // No handler should be reached
    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 2. GET → 405 ────────────────────────────────────────
  it("returns 405 for non-POST methods", async () => {
    const request = new Request("http://test.com/", { method: "GET" });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(405);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Method not allowed",
        type: "invalid_request",
        code: "METHOD_NOT_ALLOWED",
      },
    });

    // CORS headers present
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 3. POST with invalid JSON → 400 ─────────────────────
  it("returns 400 for invalid JSON body", async () => {
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: "this is not json",
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request",
        code: "PARSE_ERROR",
      },
    });

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 4. POST with null body → 400 ────────────────────────
  it("returns 400 for null body (JSON `null`)", async () => {
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: "null",
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request",
        code: "PARSE_ERROR",
      },
    });

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 5. POST with array body → 400 ───────────────────────
  it("returns 400 for array body", async () => {
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: "[]",
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request",
        code: "PARSE_ERROR",
      },
    });

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 6. POST /v1/chat/completions → chat handler ─────────
  it("dispatches /v1/chat/completions to chat handler", async () => {
    const requestBody = { model: "deepseek", messages: [{ role: "user", content: "hi" }] };
    const request = new Request("http://test.com/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chat ok");

    expect(handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(handleChatCompletions).toHaveBeenCalledWith(
      requestBody,
      BASE_ENV,
      expect.anything(), // request.signal
    );
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 7. POST /v1/messages → anthropic handler ────────────
  it("dispatches /v1/messages to anthropic handler", async () => {
    const requestBody = { model: "claude", messages: [{ role: "user", content: "hello" }] };
    const request = new Request("http://test.com/v1/messages", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("anthropic ok");

    expect(handleAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(handleAnthropicMessages).toHaveBeenCalledWith(
      requestBody,
      BASE_ENV,
      expect.anything(),
    );
    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
  });

  // ── 8. POST / with `input` → responses handler ──────────
  it("dispatches POST / with input field to responses handler", async () => {
    const requestBody = {
      input: "Write a poem",
      instructions: "Be creative",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("responses ok");

    expect(handleResponsesAPI).toHaveBeenCalledTimes(1);
    expect(handleResponsesAPI).toHaveBeenCalledWith(
      requestBody,
      BASE_ENV,
      expect.anything(),
    );
    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 9. POST / with `messages` → chat handler ────────────
  it("dispatches POST / with messages field to chat handler", async () => {
    const requestBody = { messages: [{ role: "user", content: "hello" }] };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chat ok");

    expect(handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(handleChatCompletions).toHaveBeenCalledWith(
      requestBody,
      BASE_ENV,
      expect.anything(),
    );
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 10. Rate limit exceeded → 429 ───────────────────────
  it("returns 429 when rate limit is exceeded", async () => {
    // Override the rate limiter to block this request
    vi.mocked(createRateLimiter).mockReturnValueOnce({
      check: () => ({ allowed: false, resetAt: Date.now() + 1000 }),
    });

    const request = new Request("http://test.com/", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: "{}",
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(429);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Rate limit exceeded. Try again later.",
        type: "rate_limit_error",
        code: "RATE_LIMITED",
      },
    });

    // Retry-After should be a positive integer string
    const retryAfter = response.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // CORS headers present
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }

    // No handler reached
    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  // ── 11. Authentication fails → 401 ──────────────────────
  it("returns 401 when authentication fails", async () => {
    // No Authorization header → auth fails
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: {},
      body: "{}",
    });
    const response = await worker.fetch(request, BASE_ENV);

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        message: "Invalid or missing API key",
        type: "authentication_error",
        code: "UNAUTHORIZED",
      },
    });

    // CORS headers still on error responses
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }

    // No handler reached
    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(handleResponsesAPI).not.toHaveBeenCalled();
    expect(handleAnthropicMessages).not.toHaveBeenCalled();
  });

  it("dispatches POST / with empty body to responses (default route)", async () => {
    const env = { ...BASE_ENV, RATE_LIMIT_WINDOW_MS: "60000" };
    const body = JSON.stringify({});
    const request = new Request("http://test.com/", { method: "POST", headers: { ...AUTH_HEADERS, "Content-Type": "application/json" }, body });
    await worker.fetch(request, env);
    expect(handleResponsesAPI).toHaveBeenCalled();
  });

  it("dispatches POST / with anthropic_version to anthropic route", async () => {
    const env = { ...BASE_ENV, RATE_LIMIT_WINDOW_MS: "60000" };
    const body = JSON.stringify({ anthropic_version: "2023-06-01", model: "claude" });
    const request = new Request("http://test.com/", { method: "POST", headers: { ...AUTH_HEADERS, "Content-Type": "application/json" }, body });
    await worker.fetch(request, env);
    expect(handleAnthropicMessages).toHaveBeenCalled();
  });
});
