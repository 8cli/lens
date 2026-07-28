import { vi, describe, it, expect, beforeEach } from "vitest";
import { sendChatRequest, extractUsage } from "../src/upstream.js";

// Mock helpers.js — replace fetchUpstream with a controllable mock
vi.mock("../src/helpers.js", async () => {
  const actual = await vi.importActual("../src/helpers.js");
  return {
    ...actual,
    fetchUpstream: vi.fn(),
  };
});

import { fetchUpstream } from "../src/helpers.js";

// ---------------------------------------------------------------------------
// extractUsage
// ---------------------------------------------------------------------------
describe("extractUsage", () => {
  it("returns null when data is null", () => {
    expect(extractUsage(null)).toBeNull();
  });

  it("returns null when data is undefined", () => {
    expect(extractUsage(undefined)).toBeNull();
  });

  it("returns null when data.usage is missing", () => {
    expect(extractUsage({})).toBeNull();
  });

  it("returns null when data.usage is null", () => {
    expect(extractUsage({ usage: null })).toBeNull();
  });

  it("returns usage object with prompt_tokens / completion_tokens", () => {
    const result = extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(result).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
  });

  it("falls back to input_tokens / output_tokens when prompt/completion fields are absent", () => {
    const result = extractUsage({
      usage: { input_tokens: 5, output_tokens: 15, total_tokens: 20 },
    });
    expect(result).toEqual({
      input_tokens: 5,
      output_tokens: 15,
      total_tokens: 20,
    });
  });

  it("prefers prompt_tokens over input_tokens when both are present", () => {
    const result = extractUsage({
      usage: {
        prompt_tokens: 10,
        input_tokens: 5,
        completion_tokens: 20,
        output_tokens: 15,
        total_tokens: 30,
      },
    });
    expect(result).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
  });

  it("defaults to 0 when prompt_tokens, completion_tokens, and their fallbacks are all absent", () => {
    const result = extractUsage({
      usage: { total_tokens: 42 },
    });
    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 42,
    });
  });

  it("defaults to 0 when total_tokens is absent", () => {
    const result = extractUsage({
      usage: { prompt_tokens: 7, completion_tokens: 8 },
    });
    expect(result).toEqual({
      input_tokens: 7,
      output_tokens: 8,
      total_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// sendChatRequest
// ---------------------------------------------------------------------------
describe("sendChatRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Happy path -----------------------------------------------------------

  it("returns the response on a successful request", async () => {
    const okResponse = new Response(JSON.stringify({ choices: [] }), { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "test-key" };
    const result = await sendChatRequest(env, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toBe(okResponse);
    expect(result.status).toBe(200);
  });

  // --- Authorization header -------------------------------------------------

  it("sends the correct Authorization header (bypass mode)", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "sk-my-secret" };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-my-secret",
        }),
      }),
      expect.any(Number),
    );
  });

  it("sends the AI_GATEWAY_TOKEN when in gateway mode", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      AI_GATEWAY_TOKEN: "gw-token-abc",
      OPENCODE_API_KEY: "direct-key",
      // BYPASS_GATEWAY left unset -> falsy
    };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gw-token-abc",
        }),
      }),
      expect.any(Number),
    );
  });

  // --- Request timeout -----------------------------------------------------

  it("uses the timeout from env.REQUEST_TIMEOUT_MS", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "key",
      REQUEST_TIMEOUT_MS: "5000",
    };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      5000,
    );
  });

  it("defaults to 120000ms when REQUEST_TIMEOUT_MS is not set", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      120000,
    );
  });

  it("clamps timeout to minimum 1000ms", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "key",
      REQUEST_TIMEOUT_MS: "100", // below minimum
    };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      1000,
    );
  });

  // --- HTTP method and body ------------------------------------------------

  it("sends POST with the chat body serialised as JSON", async () => {
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const chatBody = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };
    await sendChatRequest(env, chatBody);

    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(chatBody),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
      expect.any(Number),
    );
  });

  // --- Gateway 5xx fallback ------------------------------------------------

  it("falls back to direct upstream when gateway returns 5xx", async () => {
    const gatewayError = new Response("Gateway Error", { status: 502 });
    const directSuccess = new Response(JSON.stringify({ ok: true }), { status: 200 });

    fetchUpstream
      .mockResolvedValueOnce(gatewayError)
      .mockResolvedValueOnce(directSuccess);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      AI_GATEWAY_TOKEN: "gw-token",
      OPENCODE_API_KEY: "direct-key",
    };
    const result = await sendChatRequest(env, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toBe(directSuccess);
    expect(result.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);

    // Second call should target the direct upstream URL with the direct key
    expect(fetchUpstream).toHaveBeenNthCalledWith(
      2,
      "https://opencode.ai/zen/go/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer direct-key",
        }),
      }),
      expect.any(Number),
    );
  });

  it("does NOT fall back when BYPASS_GATEWAY=true even if AI_GATEWAY_URL is set", async () => {
    const errorResp = new Response("Gateway Error", { status: 502 });
    fetchUpstream.mockResolvedValue(errorResp);

    const env = {
      BYPASS_GATEWAY: "true",
      AI_GATEWAY_URL: "https://gateway.example.com",
      OPENCODE_API_KEY: "key",
    };
    const result = await sendChatRequest(env, { messages: [] });

    // Only one call made, and the error response is returned as-is
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(result).toBe(errorResp);
  });

  it("does NOT fall back for 4xx errors from the gateway", async () => {
    const badRequest = new Response("Bad Request", { status: 400 });
    fetchUpstream.mockResolvedValue(badRequest);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      AI_GATEWAY_TOKEN: "gw-token",
    };
    const result = await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(result).toBe(badRequest);
  });

  it("uses UPSTREAM_BASE_URL in the fallback when set", async () => {
    const gatewayError = new Response("Error", { status: 503 });
    const directSuccess = new Response("ok", { status: 200 });
    fetchUpstream
      .mockResolvedValueOnce(gatewayError)
      .mockResolvedValueOnce(directSuccess);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      AI_GATEWAY_TOKEN: "gw-token",
      OPENCODE_API_KEY: "fallback-key",
      UPSTREAM_BASE_URL: "https://custom.upstream.com/v2",
    };
    await sendChatRequest(env, { messages: [] });

    expect(fetchUpstream).toHaveBeenNthCalledWith(
      2,
      "https://custom.upstream.com/v2/chat/completions",
      expect.any(Object),
      expect.any(Number),
    );
  });

  // --- Network error / exception -------------------------------------------

  it("returns a 502 JSON response on network error", async () => {
    fetchUpstream.mockRejectedValue(new Error("Connection refused"));

    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };
    const result = await sendChatRequest(env, { messages: [] });

    expect(result.status).toBe(502);
    const body = await result.json();
    expect(body).toEqual({
      error: {
        message: "Upstream network error",
        type: "network_error",
        code: "NETWORK_ERROR",
      },
    });
  });

  it("returns 502 when fetchUpstream throws a non-AbortError (helpers timeout returns 504)", async () => {
    // fetchUpstream returns a 504 Response on timeout (from helpers.js),
    // but if it throws a different error, sendChatRequest should return 502.
    fetchUpstream.mockRejectedValue(new TypeError("fetch failed"));

    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };
    const result = await sendChatRequest(env, { messages: [] });

    expect(result.status).toBe(502);
  });

  // --- Client signal (AbortController integration) -------------------------

  it("aborts when clientSignal is aborted before timeout", async () => {
    // Mock fetchUpstream to hang and reject with AbortError when the signal aborts
    fetchUpstream.mockImplementation((_url, options, _timeoutMs) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        if (options.signal instanceof AbortSignal) {
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    });

    const abortController = new AbortController();
    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };

    // Fire the abort on the next microtask
    setTimeout(() => abortController.abort(), 5);

    const result = await sendChatRequest(env, { messages: [] }, abortController.signal);

    expect(result.status).toBe(502);
    const body = await result.json();
    expect(body.error.code).toBe("NETWORK_ERROR");
  });

  it("cleans up the internal timeout when clientSignal aborts", async () => {
    // This test verifies the finally-block cleanup runs without throwing.
    // We use a short-lived mock that resolves, then abort after the fact.
    const okResponse = new Response("ok", { status: 200 });
    fetchUpstream.mockResolvedValue(okResponse);

    const abortController = new AbortController();
    const env = { BYPASS_GATEWAY: "true", OPENCODE_API_KEY: "key" };

    const result = await sendChatRequest(env, { messages: [] }, abortController.signal);
    // Abort after the request already completed — just making sure cleanup() is safe
    abortController.abort();

    expect(result.status).toBe(200);
  });

  // --- Pass-through of non-5xx, non-ok responses ---------------------------

  it("passes through a non-ok response that is not a gateway 5xx", async () => {
    const tooLarge = new Response("Payload Too Large", { status: 413 });
    fetchUpstream.mockResolvedValue(tooLarge);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      AI_GATEWAY_TOKEN: "gw-token",
    };
    const result = await sendChatRequest(env, { messages: [] });

    expect(result).toBe(tooLarge);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it("passes through a gateway 5xx response when no fallback key is available", async () => {
    const gatewayError = new Response("Gateway Error", { status: 502 });
    fetchUpstream.mockResolvedValue(gatewayError);

    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      // No AI_GATEWAY_TOKEN and no OPENCODE_API_KEY — fallback key will be undefined
    };
    const result = await sendChatRequest(env, { messages: [] });

    // The code still attempts the fallback call (with undefined key),
    // returning whatever it gets back.
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });
});
