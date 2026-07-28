// ─── Handler Tests: chat.js, responses.js, anthropic.js ──
import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE importing the modules under test
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  mapModelName: vi.fn(() => "mapped-model"),
  resolveDefaultModel: vi.fn(() => "deepseek-v4-flash"),
  DEFAULT_MODEL: "deepseek-v4-flash",
  MIN_MAX_TOKENS: 1024,
  DEFAULT_MAX_TOKENS: 16384,
  SSE_BUFFER_MAX: 2097152,
  DSML_CONTENT_MAX: 10000,
}));

vi.mock("../src/upstream.js", () => ({
  sendChatRequest: vi.fn(),
  extractUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })),
}));

vi.mock("../src/stream.js", () => ({
  pipeSSE: vi.fn((_generator, _options = {}) => {
    return new Response("mocked stream", {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
  streamSSE: vi.fn(),
}));

vi.mock("../src/translators/dsml.js", () => ({
  normalizeDsmlToolCalls: vi.fn((body) => ({
    ...body,
    _dsmlNormalized: true,
  })),
}));

vi.mock("../src/translators/responses.js", () => ({
  translateToChat: vi.fn((body) => ({
    model: body.model || "test-model",
    messages: [{ role: "user", content: "from translateToChat" }],
    stream: body.stream !== false,
  })),
  translateStreamEvents: vi.fn(async function* () {
    yield { event: "response.created", data: { type: "response.created" } };
  }),
  translateResponseJson: vi.fn(async (_upstreamResponse, respId, model) => ({
    id: respId,
    object: "response",
    created_at: 1234567890,
    model,
    output: [{ type: "message", role: "assistant", content: "translated response" }],
  })),
}));

vi.mock("../src/translators/anthropic.js", () => ({
  translateAnthropicToChat: vi.fn((body, _env) => ({
    model: body.model || "test-model",
    messages: [{ role: "user", content: "from translateAnthropicToChat" }],
    stream: body.stream !== false,
  })),
  translateAnthropicStream: vi.fn(async function* () {
    // yield at least one event so pipeSSE receives a valid generator
    yield { event: "message_start", data: { type: "message_start" } };
  }),
  translateAnthropicJson: vi.fn(async (_upstreamResponse, requestId, model) => ({
    id: requestId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "translated anthropic" }],
    model,
    stop_reason: "end_turn",
  })),
}));

vi.mock("../src/helpers.js", () => ({
  uid: vi.fn((prefix = "") => `${prefix}test123`),
  now: vi.fn(() => 1234567890),
  corsHeaders: vi.fn((extra = {}) => ({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    ...extra,
  })),
  errorResponse: vi.fn((message, type, code, status) => {
    return new Response(JSON.stringify({ error: { message, type, code } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }),
  extractText: vi.fn((content) => (typeof content === "string" ? content : "")),
  fetchUpstream: vi.fn(),
}));

vi.mock("../src/middleware/logger.js", () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports — module under test
// ---------------------------------------------------------------------------

import { handleChatCompletions, filterChatStream } from "../src/handlers/chat.js";
import { handleResponsesAPI } from "../src/handlers/responses.js";
import { handleAnthropicMessages } from "../src/handlers/anthropic.js";
import { mapModelName } from "../src/config.js";
import { sendChatRequest } from "../src/upstream.js";
import { pipeSSE } from "../src/stream.js";
import { normalizeDsmlToolCalls } from "../src/translators/dsml.js";
import { translateToChat, translateResponseJson } from "../src/translators/responses.js";
import { translateAnthropicToChat, translateAnthropicJson } from "../src/translators/anthropic.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponseBody(data) {
  return new Response(JSON.stringify(data));
}

function mockStreamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  }));
}

function makeSseResponse(lines) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(readable);
}

async function collectLines(generator) {
  const lines = [];
  for await (const line of generator) {
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── handleChatCompletions ─────────────────────────────────────────────────
describe("handleChatCompletions", () => {
  const baseBody = {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  };

  it("streaming path returns pipeSSE response", async () => {
    const body = { ...baseBody, stream: true };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(mockStreamResponse(["data: test\n\n"]));

    const result = await handleChatCompletions(body, env, signal);

    expect(mapModelName).toHaveBeenCalledWith("test-model", env);
    expect(sendChatRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ model: "mapped-model", stream: true }),
      signal,
    );
    expect(pipeSSE).toHaveBeenCalledTimes(1);
    // pipeSSE called with filterChatStream generator and { rawLine: true }
    expect(pipeSSE).toHaveBeenCalledWith(expect.any(Object), { rawLine: true });
    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("non-streaming path parses JSON and returns response", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleChatCompletions(body, env, signal);

    expect(sendChatRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ model: "mapped-model", stream: false }),
      signal,
    );
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(200);
    const data = await result.json();
    // Should contain the upstream content plus DSML normalization marker
    expect(data.choices[0].message.content).toBe("Hello world");
    expect(data._dsmlNormalized).toBe(true);
    expect(normalizeDsmlToolCalls).toHaveBeenCalledTimes(1);
  });

  it("non-streaming path strips reasoning_content from response", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [{
        message: { content: "Answer", reasoning_content: "deepseek thinking" },
        finish_reason: "stop",
      }],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(200);
    const data = await result.json();
    // reasoning_content should be stripped before DSML normalization
    expect(data.choices[0].message.reasoning_content).toBeUndefined();
    expect(data.choices[0].message.content).toBe("Answer");
  });

  it("non-streaming path strips reasoning_content with multiple choices", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [
        { message: { content: "Answer1", reasoning_content: "deepseek thinking" }, finish_reason: "stop" },
        { message: { content: "Answer2" }, finish_reason: "stop" },
      ],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.choices[0].message.reasoning_content).toBeUndefined();
    expect(data.choices[0].message.content).toBe("Answer1");
    expect(data.choices[1].message.reasoning_content).toBeUndefined();
    expect(data.choices[1].message.content).toBe("Answer2");
  });

  it("non-streaming with DSML tool calls normalizes via normalizeDsmlToolCalls", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [{
        message: {
          content: 'invoke name="get_weather"<parameter name="city">Paris</parameter></invoke>',
        },
        finish_reason: "stop",
      }],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(200);
    const data = await result.json();
    // normalizeDsmlToolCalls should have transformed the body
    expect(data._dsmlNormalized).toBe(true);
    // The DSML content should be stripped by normalizeDsmlToolCalls
    expect(normalizeDsmlToolCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({
            message: expect.not.objectContaining({ reasoning_content: expect.anything() }),
          }),
        ]),
      }),
    );
  });

  it("returns raw text when JSON parse fails in non-streaming path", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const rawText = "not valid json here";
    sendChatRequest.mockResolvedValue(new Response(rawText, { status: 200 }));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toBe(rawText);
  });

  it("upstream network error returns 502 error response", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockRejectedValue(new Error("Connection timed out"));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(502);
    const data = await result.json();
    expect(data.error.message).toBe("Upstream request failed");
    expect(data.error.type).toBe("upstream_error");
    expect(data.error.code).toBe("UPSTREAM");
  });

  it("upstream non-ok response returns error response with upstream status", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(new Response("Bad Request", { status: 400 }));

    const result = await handleChatCompletions(body, env, signal);
    expect(result.status).toBe(400);
    const data = await result.json();
    expect(data.error.message).toBe("Upstream request failed");
    expect(data.error.code).toBe("UPSTREAM");
  });

  it("model is mapped via mapModelName", async () => {
    const body = { ...baseBody, stream: false };
    const env = { DEFAULT_MODEL: "custom-model" };
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(mockResponseBody({ choices: [{ message: { content: "x" } }] }));

    await handleChatCompletions(body, env, signal);

    expect(mapModelName).toHaveBeenCalledWith("test-model", env);
  });

  it("passes request signal to sendChatRequest", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const abortController = new AbortController();
    const signal = abortController.signal;

    sendChatRequest.mockResolvedValue(mockResponseBody({ choices: [{ message: { content: "" } }] }));

    await handleChatCompletions(body, env, signal);

    expect(sendChatRequest).toHaveBeenCalledWith(env, expect.any(Object), signal);
  });
});

// ─── handleResponsesAPI ────────────────────────────────────────────────────
describe("handleResponsesAPI", () => {
  const baseBody = {
    model: "test-model",
    input: "hello from responses",
  };

  it("streaming path returns pipeSSE response", async () => {
    const body = { ...baseBody, stream: true };
    const env = {};
    const signal = new AbortController().signal;

    const mockUpstream = mockStreamResponse(["data: test\n\n"]);
    sendChatRequest.mockResolvedValue(mockUpstream);

    const result = await handleResponsesAPI(body, env, signal);

    expect(translateToChat).toHaveBeenCalledWith(body);
    // translateToChat returns model "test-model", then mapModelName is called on chatReq.model
    expect(mapModelName).toHaveBeenCalledWith("test-model", env);
    expect(sendChatRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ model: "mapped-model", stream: true }),
      signal,
    );
    expect(pipeSSE).toHaveBeenCalledTimes(1);
    expect(pipeSSE).toHaveBeenCalledWith(expect.any(Object));
    expect(result).toBeInstanceOf(Response);
  });

  it("non-streaming path returns translated JSON response", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [{ message: { content: "Hello from responses" }, finish_reason: "stop" }],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleResponsesAPI(body, env, signal);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.object).toBe("response");
    expect(data.id).toBe("resptest123");
    expect(data.model).toBe("mapped-model");
    expect(data.output[0].content).toBe("translated response");
    expect(translateResponseJson).toHaveBeenCalledTimes(1);
  });

  it("upstream network error returns structured error with respId", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockRejectedValue(new Error("Network failure"));

    const result = await handleResponsesAPI(body, env, signal);
    expect(result.status).toBe(502);
    const data = await result.json();
    expect(data.id).toBe("resptest123");
    expect(data.object).toBe("response");
    expect(data.error.message).toBe("Upstream request failed");
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.code).toBe("upstream_error");
  });

  it("upstream non-ok response returns structured error with respId", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(new Response("Forbidden", { status: 403 }));

    const result = await handleResponsesAPI(body, env, signal);
    expect(result.status).toBe(403);
    const data = await result.json();
    expect(data.id).toBe("resptest123");
    expect(data.object).toBe("response");
    expect(data.error.message).toBe("Upstream request failed");
    expect(data.error.code).toBe("invalid_request_error");
  });

  it("model is mapped via mapModelName", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(mockResponseBody({ choices: [{ message: { content: "" } }] }));

    await handleResponsesAPI(body, env, signal);
    // translateToChat returns model "test-model", mapModelName is called on chatReq.model
    expect(mapModelName).toHaveBeenCalled();
  });
});

// ─── handleAnthropicMessages ───────────────────────────────────────────────
describe("handleAnthropicMessages", () => {
  const baseBody = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
  };

  it("streaming path returns pipeSSE response", async () => {
    const body = { ...baseBody, stream: true };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(mockStreamResponse(["data: test\n\n"]));

    const result = await handleAnthropicMessages(body, env, signal);

    expect(translateAnthropicToChat).toHaveBeenCalledWith(body, env);
    expect(mapModelName).toHaveBeenCalled();
    expect(sendChatRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ stream: true }),
      signal,
    );
    expect(pipeSSE).toHaveBeenCalledTimes(1);
    expect(pipeSSE).toHaveBeenCalledWith(expect.any(Object));
    expect(result).toBeInstanceOf(Response);
  });

  it("non-streaming path returns translated JSON response", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    const upstreamData = {
      choices: [{ message: { content: "Hello from claude" }, finish_reason: "stop" }],
    };
    sendChatRequest.mockResolvedValue(mockResponseBody(upstreamData));

    const result = await handleAnthropicMessages(body, env, signal);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.id).toBe("msgtest123");
    expect(data.type).toBe("message");
    expect(data.role).toBe("assistant");
    expect(data.model).toBe("mapped-model");
    expect(translateAnthropicJson).toHaveBeenCalledTimes(1);
  });

  it("upstream network error returns structured error with requestId", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockRejectedValue(new Error("Connection refused"));

    const result = await handleAnthropicMessages(body, env, signal);
    expect(result.status).toBe(502);
    const data = await result.json();
    expect(data.id).toBe("msgtest123");
    expect(data.type).toBe("error");
    expect(data.error.type).toBe("upstream_error");
    expect(data.error.message).toBe("Upstream request failed");
  });

  it("upstream non-ok response returns structured error with requestId", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(new Response("Too Many Requests", { status: 429 }));

    const result = await handleAnthropicMessages(body, env, signal);
    expect(result.status).toBe(429);
    const data = await result.json();
    expect(data.id).toBe("msgtest123");
    expect(data.type).toBe("error");
    expect(data.error.type).toBe("invalid_request_error");
  });

  it("model is mapped via mapModelName", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(mockResponseBody({ choices: [{ message: { content: "" } }] }));

    await handleAnthropicMessages(body, env, signal);
    expect(mapModelName).toHaveBeenCalled();
  });

  it("response includes x-request-id header on success", async () => {
    const body = { ...baseBody, stream: false };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockResolvedValue(
      mockResponseBody({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );

    const result = await handleAnthropicMessages(body, env, signal);
    expect(result.headers.get("x-request-id")).toBe("msgtest123");
    expect(result.headers.get("request-id")).toBe("msgtest123");
  });

  it("response includes x-request-id header on network error", async () => {
    const body = { ...baseBody };
    const env = {};
    const signal = new AbortController().signal;

    sendChatRequest.mockRejectedValue(new Error("fail"));

    const result = await handleAnthropicMessages(body, env, signal);
    expect(result.headers.get("x-request-id")).toBeTruthy();
    expect(result.headers.get("request-id")).toBeTruthy();
  });
});

// ─── filterChatStream ──────────────────────────────────────────────────────
describe("filterChatStream", () => {
  it("strips reasoning_content from deltas", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"thinking..."},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines.some((l) => l.includes("reasoning_content"))).toBe(false);
    expect(lines.some((l) => l.includes("Answer"))).toBe(true);
  });

  it("converts content:null to empty string", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":null},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLine = lines.find((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].delta.content).toBe("");
  });

  it("passes through non-data lines", async () => {
    const resp = makeSseResponse([
      "",
      "event: message",
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain("");
    expect(lines).toContain("event: message");
  });

  it("passes through [DONE] signal unchanged", async () => {
    const resp = makeSseResponse(["data: [DONE]"]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toEqual(["data: [DONE]"]);
  });

  it("passes through malformed JSON unchanged", async () => {
    const resp = makeSseResponse(['data: {not valid json}']);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {not valid json}');
  });

  it("skips empty deltas that only had reasoning", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"only reasoning"},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLines = lines.filter((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    expect(dataLines).toHaveLength(0);
  });

  it("keeps chunks with finish_reason even after stripping reasoning", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"thinking"},"finish_reason":"stop"}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLine = lines.find((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });

  it("enforces 2MB buffer cap", async () => {
    const encoder = new TextEncoder();
    // Send a chunk that pushes the buffer over 2MB (has no newline, so it accumulates)
    const bigChunk = "X".repeat(2 * 1024 * 1024 + 500);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(bigChunk));
        controller.close();
      },
    });
    const resp = new Response(readable);
    await expect(collectLines(filterChatStream(resp))).rejects.toThrow(
      "SSE buffer exceeded maximum size",
    );
  });

  it("handles multiple choices in one chunk", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"A","reasoning_content":"r1"}},{"delta":{"content":"B"}}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLine = lines.find((l) => l.startsWith("data: {"));
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].delta.reasoning_content).toBeUndefined();
    expect(parsed.choices[0].delta.content).toBe("A");
    expect(parsed.choices[1].delta.content).toBe("B");
  });

  it("handles chunks without choices array", async () => {
    const resp = makeSseResponse(['data: {"usage":{"prompt_tokens":10}}']);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {"usage":{"prompt_tokens":10}}');
  });

  it("handles chunk with choices missing delta", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"index":0,"finish_reason":"stop"}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {"choices":[{"index":0,"finish_reason":"stop"}]}');
  });

  it("handles choice without delta in hasContent", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"r"}},{"index":1}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLines = lines.filter((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    expect(dataLines).toHaveLength(0);
  });
});
