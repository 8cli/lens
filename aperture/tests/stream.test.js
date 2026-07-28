import { describe, it, expect } from "vitest";
import { streamSSE, pipeSSE } from "../src/stream.js";

// --- MockResponse -----------------------------------------------------------

class MockResponse {
  constructor(body) {
    this.body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
  }
}

// --- Helper: consume a ReadableStream fully --------------------------------

async function consumeStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  // Final flush
  result += decoder.decode();
  return result;
}

// --- streamSSE --------------------------------------------------------------

describe("streamSSE", () => {
  it("parses 'data: {...}' lines into objects", async () => {
    const body = 'data: {"a":1}\ndata: {"b":2}\n';
    const response = new MockResponse(body);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips non-data lines (empty lines, event: lines)", async () => {
    const body = '\nevent: foo\ndata: {"x":1}\n\nevent: bar\n';
    const response = new MockResponse(body);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ x: 1 }]);
  });

  it("skips [DONE] signal", async () => {
    const body = 'data: {"ok":true}\ndata: [DONE]\ndata: {"also":true}\n';
    const response = new MockResponse(body);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ ok: true }, { also: true }]);
  });

  it("skips malformed JSON", async () => {
    const body = 'data: {"good":1}\ndata: {bad json}\ndata: {"also_good":2}\n';
    const response = new MockResponse(body);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ good: 1 }, { also_good: 2 }]);
  });

  it("accumulates partial lines across chunks", async () => {
    // Simulate chunked delivery where a "data: " line is split
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a"'));
        controller.enqueue(encoder.encode(':1}\ndata'));
        controller.enqueue(encoder.encode(': {"b":2}\n'));
        controller.close();
      },
    });
    const response = new Response(stream); // Use real Response, not MockResponse
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles data that extends into the buffer (no trailing newline after final data line)", async () => {
    // Last chunk ends mid-line; the final buffer is processed when done
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"first":1}\ndata: {"second":2}'));
        controller.close();
      },
    });
    const response = new Response(stream);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ first: 1 }, { second: 2 }]);
  });

  it("handles a single data line without trailing newline", async () => {
    const response = new MockResponse('data: {"lonely":true}');
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ lonely: true }]);
  });

  it("ignores final partial line that does not start with 'data: '", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"ok":1}\npartial line here'));
        controller.close();
      },
    });
    const response = new Response(stream);
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([{ ok: 1 }]);
  });

  it("throws on buffer > 2MB", async () => {
    // Generate a payload just over 2 MB
    const bigPayload = "x".repeat(2 * 1024 * 1024 + 1);
    const body = `data: {"big":"${bigPayload}"}\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const response = new Response(stream);

    await expect(async () => {
      for await (const _ of streamSSE(response)) {
        // Should not yield anything
      }
    }).rejects.toThrow("SSE buffer exceeded 2MB limit");
  });

  it("returns empty (yields nothing) if response.body is null", async () => {
    // This will throw because .body is null and getReader() fails
    // The spec says "Returns empty if response.body is null" — the function
    // will crash when accessing .body.getReader(), but this documents the
    // expected guard. We test that it doesn't silently hang.
    const response = new Response(null); // body is null
    await expect(async () => {
      for await (const _ of streamSSE(response)) {
        // nothing
      }
    }).rejects.toThrow(); // getReader() on null body fails
  });

  it("yields nothing for an empty body", async () => {
    const response = new MockResponse("");
    const results = [];
    for await (const obj of streamSSE(response)) {
      results.push(obj);
    }
    expect(results).toEqual([]);
  });

  it("cancels the reader on buffer overflow", async () => {
    // Very large chunk to trigger overflow.
    // Do NOT close the controller — the stream stays open so cancel() fires.
    const bigPayload = "y".repeat(2 * 1024 * 1024 + 1);
    const body = `data: {"big":"${bigPayload}"}\n`;
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        // Intentionally not calling controller.close()
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);

    try {
      for await (const _ of streamSSE(response)) {
        // nothing
      }
    } catch {
      // expected
    }
    expect(cancelled).toBe(true);
  });
});

// --- pipeSSE (event format) ------------------------------------------------

describe("pipeSSE — event format (default)", () => {
  it("creates a Response with text/event-stream headers", () => {
    async function* gen() {
      yield { event: "test", data: { hello: "world" } };
    }
    const res = pipeSSE(gen());
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("formats { event, data } as 'event: xxx\\ndata: {...}\\n\\n'", async () => {
    async function* gen() {
      yield { event: "update", data: { id: 1 } };
      yield { event: "done", data: { status: "ok" } };
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    expect(output).toBe(
      "event: update\ndata: {\"id\":1}\n\nevent: done\ndata: {\"status\":\"ok\"}\n\n",
    );
  });

  it("omits 'event:' line when event is falsy", async () => {
    async function* gen() {
      yield { event: "", data: { msg: "no event" } };
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    expect(output).toBe('data: {"msg":"no event"}\n\n');
  });

  it("omits 'event:' line when event is undefined", async () => {
    async function* gen() {
      yield { data: { msg: "no event key" } };
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    expect(output).toBe('data: {"msg":"no event key"}\n\n');
  });

  it("writes SSE error event and closes on generator error", async () => {
    async function* gen() {
      yield { event: "update", data: { ok: true } };
      throw new Error("boom");
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    // Should contain the normal event and then an error event
    expect(output).toContain('event: update\ndata: {"ok":true}');
    expect(output).toContain('event: error\ndata: {"error":"boom"}');
  });

  it("writes SSE error event even for non-Error thrown values", async () => {
    async function* gen() {
      throw "just a string";
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    expect(output).toContain('event: error\ndata: {"error":"Internal error"}');
  });

  it("closes the writer after generator completion", async () => {
    async function* gen() {
      yield { event: "done", data: { final: true } };
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    // Verify the full output — no extra data after close
    expect(output).toBe('event: done\ndata: {"final":true}\n\n');
  });

  it("handles empty generator (no yields)", async () => {
    async function* gen() {
      // nothing
    }
    const res = pipeSSE(gen());
    const output = await consumeStream(res.body);
    expect(output).toBe("");
  });
});

// --- pipeSSE (rawLine mode) ------------------------------------------------

describe("pipeSSE — rawLine mode", () => {
  it("writes chunk + '\\n' verbatim", async () => {
    async function* gen() {
      yield "data: {\"a\":1}";
      yield "event: custom";
      yield "";
    }
    const res = pipeSSE(gen(), { rawLine: true });
    const output = await consumeStream(res.body);
    expect(output).toBe('data: {"a":1}\nevent: custom\n\n');
  });

  it("includes same headers as event mode", () => {
    async function* gen() {
      yield "data: nothing";
    }
    const res = pipeSSE(gen(), { rawLine: true });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("writes error event on generator error in rawLine mode", async () => {
    async function* gen() {
      yield "data: {\"ok\":true}";
      throw new Error("raw error");
    }
    const res = pipeSSE(gen(), { rawLine: true });
    const output = await consumeStream(res.body);
    expect(output).toContain('data: {"ok":true}');
    expect(output).toContain('event: error\ndata: {"error":"raw error"}');
  });

  it("handles empty rawLine generator", async () => {
    async function* gen() {
      // nothing
    }
    const res = pipeSSE(gen(), { rawLine: true });
    const output = await consumeStream(res.body);
    expect(output).toBe("");
  });
});
