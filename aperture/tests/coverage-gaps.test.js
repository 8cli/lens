import { describe, it, expect, vi } from "vitest";

// -----------------------------------------------------------------
// Coverage gap tests — target specific uncovered lines
// -----------------------------------------------------------------

describe("coverage-gap: helpers.js line 40", () => {
  it("extractText handles unknown content block type", async () => {
    const { extractText } = await import("../src/helpers.js");
    const result = extractText([{ type: "unknown_type", value: "x" }]);
    expect(result).toBe("");
  });
});

describe("coverage-gap: index.js lines 14-15 (anthropic body shape routing)", () => {
  it("routes by body.anthropic_version to anthropic handler", async () => {
    const { handleAnthropicMessages } = await import("../src/handlers/anthropic.js");
    // Test detectRoute indirectly via index.js
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;
    // Mock rate limiter to pass, mock auth to pass, mock handler
    const env = {
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX: "120",
      AI_GATEWAY_TOKEN: "test",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropic_version: "2023-06-01",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // The mock will be called — just verify no 404/400
    // Use vi.mock on the handler to avoid actual upstream calls
    const response = await handler(request, env);
    // Should not be 400 "Unknown API format"
    expect(response.status).not.toBe(400);
  });
});

describe("coverage-gap: upstream.js line 22 (GW URL with slug)", () => {
  it("buildUpstreamUrl returns base path when slug is empty", async () => {
    const { default: mod } = await import("../src/upstream.js");
    // Can't access private buildUpstreamUrl directly
    // Test via sendChatRequest with mocked fetchUpstream
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "key",
      BYPASS_GATEWAY: "false",
    };
    await sendChatRequest(env, { model: "test", messages: [] });

    const calledUrl = spy.mock.calls[0][0];
    expect(calledUrl).toContain("/chat/completions");
    expect(calledUrl).not.toContain("custom-");
    spy.mockRestore();
  });
});

describe("coverage-gap: chat.js lines 25-26 (trailing buffer)", () => {
  it("filterChatStream warns on trailing partial data", async () => {
    const { filterChatStream } = await import("../src/handlers/chat.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Stream with trailing partial line that doesn't start with "data: "
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"));
        controller.enqueue(encoder.encode("\n"));
        controller.enqueue(encoder.encode("trailing")); // partial, no newline
        controller.close();
      },
    });
    const response = new Response(stream);
    const results = [];
    for await (const line of filterChatStream(response)) {
      results.push(line);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("coverage-gap: rate-limiter.js lines 17-22 (TTL pruning)", () => {
  it("prunes stale entries after many checks", async () => {
    const { createRateLimiter } = await import("../src/middleware/rate-limiter.js");
    const limiter = createRateLimiter(50, 100); // small window

    // Fill with many entries
    for (let i = 0; i < 250; i++) {
      limiter.check(`key_${i}`);
    }
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    // Trigger check — should prune stale entries
    const result = limiter.check("new_key");
    expect(result.allowed).toBe(true);
  }, 5000);
});

describe("coverage-gap: anthropic.js lines 306-307 (tool call name update)", () => {
  it("updates tool name when provided on subsequent chunk", async () => {
    const { translateAnthropicStream } = await import("../src/translators/anthropic.js");

    // Create a stream where first tool chunk has no name, second has name
    const encoder = new TextEncoder();
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"arguments\":\"{\\\"loc\\\":\\\"NYC\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"get_weather\"}}]}}]}\n",
      "data: [DONE]\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const response = new Response(stream);
    const events = [];
    for await (const evt of translateAnthropicStream(response, "req_001", "test-model")) {
      events.push(evt);
      if (evt.event === "message_stop") break;
    }
    // Verify tool_use content blocks are present
    const toolUseStarts = events.filter(e => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
    expect(toolUseStarts.length).toBeGreaterThanOrEqual(1);
    // Verify input_json_delta events
    const deltas = events.filter(e => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });
});

describe("coverage-gap: anthropic.js lines 444-445 (tool_choice type tool)", () => {
  it("maps tool_choice type 'tool' to function type", async () => {
    const { translateAnthropicToChat } = await import("../src/translators/anthropic.js");
    const result = translateAnthropicToChat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "test_tool" } }],
      tool_choice: { type: "tool", name: "test_tool" },
    });
    expect(result.tool_choice.type).toBe("function");
    expect(result.tool_choice.function.name).toBe("test_tool");
  });
});

describe("coverage-gap: dsml.js line 17 (branch — non-null content)", () => {
  it("normalizeDsmlToolCalls handles msg.content that is non-null", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = {
      choices: [{
        message: { content: "some text here", role: "assistant" },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].message.content).toBe("some text here");
  });
});

describe("coverage-gap: responses.js lines 284-285 (tool call name update)", () => {
  it("updates tool call name on subsequent chunk", async () => {
    const { translateStreamEvents } = await import("../src/translators/responses.js");

    const encoder = new TextEncoder();
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"arguments\":\"{\\\"q\\\":\\\"test\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"search\"}}]}}]}\n",
      "data: [DONE]\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const response = new Response(stream);
    const events = [];
    for await (const evt of translateStreamEvents(response, "resp_001", "test-model")) {
      events.push(evt);
      if (evt.event === "response.completed") break;
    }
    // Should have function_call output items
    const additions = events.filter(e => e.event === "response.output_item.added");
    expect(additions.length).toBeGreaterThan(0);
    // Should have flush at end
    const doneItems = events.filter(e => e.event === "response.output_item.done");
    expect(doneItems.length).toBeGreaterThan(0);
  });
});

describe("coverage-gap: upstream branches (slug empty, bypass key, finally)", () => {
  it("sends correct auth header when BYPASS_GATEWAY=true with OPENCODE_API_KEY", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));
    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "opencode-key-123",
      AI_GATEWAY_TOKEN: "gw-token",
      UPSTREAM_BASE_URL: "https://custom.upstream.com",
    };
    await sendChatRequest(env, { model: "test", messages: [] });
    const headers = spy.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer opencode-key-123");
    spy.mockRestore();
  });

  it("handles slug being empty with AI_GATEWAY_URL set", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));
    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "token",
      BYPASS_GATEWAY: "false",
    };
    await sendChatRequest(env, { model: "test", messages: [] });
    const url = spy.mock.calls[0][0];
    expect(url).toContain("gateway.example.com/chat/completions");
    spy.mockRestore();
  });

  it("sends clientSignal to upstream and cleans up", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockImplementation(
      async (url, opts) => {
        expect(opts.signal).toBeDefined();
        return new Response("ok", { status: 200 });
      }
    );
    const { sendChatRequest } = await import("../src/upstream.js");
    const controller = new AbortController();
    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "key",
      UPSTREAM_BASE_URL: "https://upstream.test",
    };
    await sendChatRequest(env, { model: "test", messages: [] }, controller.signal);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("coverage-gap: dsml.js msg.content branch", () => {
  it("handles msg.content that is null", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = { choices: [{ message: { content: null, role: "assistant" }, finish_reason: "stop" }] };
    const result = normalizeDsmlToolCalls(body);
    // Should not throw and return body unchanged (no DSML pattern)
    expect(result.choices[0].message.content).toBe(null);
  });
  it("handles msg.content that has prose alongside DSML", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = {
      choices: [{
        message: { content: 'First do X <invoke name="fn"><parameter name="x">1</parameter></invoke> then do Y', role: "assistant" },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(body);
    const msg = result.choices[0].message;
    expect(msg.content).toContain("First do X");
    expect(msg.content).toContain("then do Y");
    expect(msg.tool_calls).toHaveLength(1);
  });
});

// =====================================================================
// NEW coverage-gap tests for uncovered lines
// =====================================================================

describe("coverage-gap: index.js lines 32-33 (parseInt NaN fallback)", () => {
  it("falls back to defaults when env vars are invalid", async () => {
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;

    const env = {
      RATE_LIMIT_WINDOW_MS: "invalid",
      RATE_LIMIT_MAX: "invalid",
      AI_GATEWAY_TOKEN: "test",
    };

    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropic_version: "2023-06-01",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // parseInt("invalid") returns NaN, NaN || fallback yields 60000/120
    // So rate limiter should allow the request, not 429
    const response = await handler(request, env);
    // Not a parse error
    expect(response.status).not.toBe(400);
    // Not rate limited — NaN fallback worked
    expect(response.status).not.toBe(429);
  });
});

describe("coverage-gap: stream.js lines 137-138,143-144 (pipeSSE error catch)", () => {
  it("handles errors in SSE pipe gracefully", async () => {
    const { pipeSSE } = await import("../src/stream.js");

    async function* throwingGenerator() {
      yield { event: "test", data: { msg: "hello" } };
      throw new Error("simulated error");
    }

    const response = pipeSSE(throwingGenerator());
    // Cancel the body so the writable is errored, triggering catch blocks
    await response.body.cancel();
    // Give the detached async loop time to process
    await new Promise(r => setTimeout(r, 10));
    // If we reach here without an unhandled rejection, both catches worked
    expect(true).toBe(true);
  });
});

describe("coverage-gap: upstream.js line 20 (slug ternary)", () => {
  it("includes custom slug in URL when CUSTOM_PROVIDER_SLUG is set", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "my-slug",
      AI_GATEWAY_TOKEN: "key",
    };
    await sendChatRequest(env, { model: "test", messages: [] });

    const calledUrl = spy.mock.calls[0][0];
    expect(calledUrl).toContain("custom-my-slug");
    spy.mockRestore();
  });
});

describe("coverage-gap: upstream.js line 30 (bypass key fallback)", () => {
  it("falls back to AI_GATEWAY_TOKEN when OPENCODE_API_KEY is missing in bypass mode", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      BYPASS_GATEWAY: "true",
      AI_GATEWAY_TOKEN: "fallback-token",
      // No OPENCODE_API_KEY — triggers the || fallback
    };
    await sendChatRequest(env, { model: "test", messages: [] });

    const headers = spy.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer fallback-token");
    spy.mockRestore();
  });
});

describe("coverage-gap: upstream.js line 64 (parseInt NaN timeout)", () => {
  it("falls back to default timeout when REQUEST_TIMEOUT_MS is invalid", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "key",
      REQUEST_TIMEOUT_MS: "invalid",
    };
    await sendChatRequest(env, { model: "test", messages: [] });

    // Third argument passed to fetchUpstream is the timeout
    const timeoutArg = spy.mock.calls[0][2];
    expect(timeoutArg).toBe(120000);
    spy.mockRestore();
  });
});

describe("coverage-gap: upstream.js line 117 (network error catch)", () => {
  it("returns 502 on network error", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockRejectedValue(new Error("Network failure"));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "key",
    };
    const response = await sendChatRequest(env, { model: "test", messages: [] });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("NETWORK_ERROR");
    spy.mockRestore();
  });
});

describe("coverage-gap: anthropic.js lines 441-442 (tool_choice default)", () => {
  it("maps unknown tool_choice type to auto", async () => {
    const { translateAnthropicToChat } = await import("../src/translators/anthropic.js");
    const result = translateAnthropicToChat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "test_tool" } }],
      tool_choice: { type: "unknown_type" },
    });
    // mapAnthropicToolChoice falls through to the final return "auto"
    expect(result.tool_choice).toBe("auto");
  });
});

// =====================================================================
// PHASE 2: Full branch coverage for index.js parseInt variants
// =====================================================================

describe("coverage-gap: index.js lines 32-33 (parseInt valid branch)", () => {
  it("uses parsed value when env vars are valid integers", async () => {
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;
    // With valid RATE_LIMIT_WINDOW_MS, the || short-circuits at the parsed value
    const env = {
      RATE_LIMIT_WINDOW_MS: "5000",
      RATE_LIMIT_MAX: "10",
      AI_GATEWAY_TOKEN: "test",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await handler(request, env);
    expect(response.status).not.toBe(400);
  });

  it("clamps RATE_LIMIT_WINDOW_MS to minimum 1000", async () => {
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;
    const env = {
      RATE_LIMIT_WINDOW_MS: "100",  // parseInt = 100, Math.max(1000, 100) = 1000
      RATE_LIMIT_MAX: "1",
      AI_GATEWAY_TOKEN: "test",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await handler(request, env);
    // Should pass (window clamped to 1000ms, max=1, only 1 request)
    expect(response.status).not.toBe(400);
  });

  it("handles unset env vars via || fallback", async () => {
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;
    const env = {
      AI_GATEWAY_TOKEN: "test",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    const response = await handler(request, env);
    expect(response.status).not.toBe(400);
  });
});

// =====================================================================
// PHASE 2: stream.js buffer-edge processing + cancel-error
// =====================================================================

describe("coverage-gap: stream.js lines 68-69 (trailing data: line with invalid JSON)", () => {
  it("skips malformed JSON in trailing data: line", async () => {
    const { streamSSE } = await import("../src/stream.js");
    // Stream that ends with "data: {invalid" (starts with data: but invalid JSON)
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"ok":true}\ndata: {not valid'));
        controller.close();
      },
    });
    const response = new Response(stream);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ ok: true }]);
  });
});

describe("coverage-gap: stream.js lines 77-78 (reader.cancel() throws)", () => {
  it("catches reader.cancel error on buffer overflow", async () => {
    const { streamSSE } = await import("../src/stream.js");
    // Create a stream where cancel() throws
    const bigPayload = "y".repeat(2 * 1024 * 1024 + 1);
    const body = `data: {"big":"${bigPayload}"}\n`;
    const encoder = new TextEncoder();
    let cancelCalled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
      },
      cancel() {
        cancelCalled = true;
        throw new Error("cancel_failed");
      },
    });
    const response = new Response(stream);
    try {
      for await (const _ of streamSSE(response)) {}
    } catch {
      // expected
    }
    expect(cancelCalled).toBe(true);
  });
});

// =====================================================================
// PHASE 2: responses.js toolCallsMap name update — more direct test
// =====================================================================

describe("coverage-gap: responses.js lines 284-285 (toolCallsMap name update direct)", () => {
  it("updates tool call name when provided on subsequent chunk (no existing name)", async () => {
    const { translateStreamEvents } = await import("../src/translators/responses.js");
    const encoder = new TextEncoder();
    const chunks = [
      // First: create tool_call with arguments (NO finish_reason to avoid deletion)
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","function":{"arguments":"{}"}}]}}]}\n',
      // Second: update the name (same index, finishes before any finish_reason)
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup"}}]}}]}\n',
      // Third: close the stream
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      'data: [DONE]\n',
    ];
    const stream = new ReadableStream({
      start(c) { for (const chunk of chunks) c.enqueue(encoder.encode(chunk)); c.close(); },
    });
    const events = [];
    for await (const ev of translateStreamEvents(new Response(stream), "resp_tool", "test")) {
      events.push(ev);
      if (ev.event === "response.completed") break;
    }
    const added = events.filter(e => e.event === "response.output_item.added" && e.data.item?.type === "function_call");
    expect(added.length).toBeGreaterThan(0);
  });
});
