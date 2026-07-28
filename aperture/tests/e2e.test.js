import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import worker from "../src/index.js";

let upstreamServer;
let upstreamUrl;

// Start a real HTTP server as upstream
beforeAll(() => {
  return new Promise((resolve) => {
    upstreamServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        const chatReq = JSON.parse(body);
        const isStream = chatReq.stream;

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write("data: " + JSON.stringify({choices:[{"delta":{"role":"assistant"},"index":0}]}) + "\n");
          res.write("data: " + JSON.stringify({choices:[{"delta":{"content":"Hello"},"index":0}]}) + "\n");
          res.write("data: " + JSON.stringify({choices:[{"delta":{},"index":0,"finish_reason":"stop"}]}) + "\n");
          res.write("data: [DONE]\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: chatReq.model || "test-model",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Hello from upstream!",
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }));
        }
      });
    });
    upstreamServer.listen(0, () => {
      const addr = upstreamServer.address();
      upstreamUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise((resolve) => upstreamServer.close(resolve));
});

describe("e2e — full pipeline (real HTTP upstream)", () => {
  // Build env at call time so upstreamUrl is already resolved by beforeAll.
  const makeEnv = (overrides = {}) => ({
    UPSTREAM_BASE_URL: upstreamUrl,
    BYPASS_GATEWAY: "true",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX: "120",
    AI_GATEWAY_TOKEN: "test-token",
    OPENCODE_API_KEY: "test-key",
    DEFAULT_MODEL: "test-model",
    ...overrides,
  });

  // Ensure upstreamUrl is resolved before tests
  it("upstream server is running", () => {
    expect(upstreamUrl).toBeTruthy();
  });

  it("POST /v1/chat/completions — non-streaming returns valid response", async () => {
    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    const request = new Request(`http://test.com/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.choices?.[0]?.message?.content).toBe("Hello from upstream!");
  });

  it("POST /v1/chat/completions — streaming returns SSE", async () => {
    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const request = new Request(`http://test.com/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("data:");
  });

  it("POST /v1/messages — Anthropic API translates correctly (non-streaming)", async () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1024,
      stream: false,
    });
    const request = new Request(`http://test.com/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "test-token", "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.type).toBe("message");
    expect(data.role).toBe("assistant");
  });

  it("POST / — Responses API translates correctly (non-streaming)", async () => {
    const body = JSON.stringify({
      input: "hello from responses",
      model: "test-model",
      stream: false,
    });
    const request = new Request(`http://test.com/`, {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.object).toBe("response");
  });

  it("returns 401 without auth token", async () => {
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] });
    const request = new Request("http://test.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(401);
  });

  it("rate limiter allows first request (module-level singleton)", async () => {
    // The rate limiter is a module-level singleton initialised on the first
    // worker.fetch() call (see getRateLimiter in index.js). Once created with
    // the base env max=120, it cannot be re-initialised. The rate-limit
    // middleware is already thoroughly covered in index.test.js via mock.
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] });
    const request = new Request("http://test.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body,
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
  });

  it("returns 400 on invalid JSON body", async () => {
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
      body: "not json",
    });
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(400);
  });
});
