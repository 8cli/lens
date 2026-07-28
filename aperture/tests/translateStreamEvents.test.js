import { describe, it, expect } from "vitest";
import { translateStreamEvents } from "../src/translators/responses.js";

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

async function collectEvents(generator) {
  const events = [];
  for await (const ev of generator) {
    events.push(ev);
  }
  return events;
}

describe("translateStreamEvents", () => {
  it("emits response.created at start", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));
    expect(events[0].event).toBe("response.created");
    expect(events[0].data.response.id).toBe("resp_123");
    expect(events[0].data.response.model).toBe("test-model");
    expect(events[0].data.response.output).toEqual([]);
  });

  it("emits text deltas and completion lifecycle", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));

    const types = events.map((e) => e.event);
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.output_item.done");
    expect(types).toContain("response.completed");

    const deltas = events.filter((e) => e.event === "response.output_text.delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0].data.delta).toBe("Hello");
    expect(deltas[1].data.delta).toBe(" world");

    const textDone = events.find((e) => e.event === "response.output_text.done");
    expect(textDone.data.text).toBe("Hello world");
  });

  it("emits tool call lifecycle with arguments deltas", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\": "}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));

    const types = events.map((e) => e.event);
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.output_item.done");

    const argDeltas = events.filter(
      (e) => e.event === "response.function_call_arguments.delta"
    );
    expect(argDeltas.length).toBeGreaterThanOrEqual(2);

    const argDone = events.find(
      (e) => e.event === "response.function_call_arguments.done"
    );
    expect(argDone.data.arguments).toContain("NYC");
    expect(argDone.data.id).toBe("call_1");

    const toolDone = events.find(
      (e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call"
    );
    expect(toolDone.data.item.name).toBe("get_weather");
    expect(toolDone.data.item.status).toBe("completed");
  });

  it("handles mixed text and tool calls", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Let me check"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\": \"x\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));

    const textDeltas = events.filter((e) => e.event === "response.output_text.delta");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].data.delta).toBe("Let me check");

    const toolAdded = events.find(
      (e) => e.event === "response.output_item.added" && e.data.item?.type === "function_call"
    );
    expect(toolAdded).toBeDefined();
  });

  it("emits response.completed with usage when available", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeDefined();
    expect(completed.data.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 0,
    });
  });

  it("handles finish_reason without prior content", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));
    const types = events.map((e) => e.event);
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
    expect(types).not.toContain("response.output_text.delta");
  });

  it("handles empty content deltas gracefully", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Real text"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateStreamEvents(resp, "resp_123", "test-model"));
    const textDeltas = events.filter((e) => e.event === "response.output_text.delta");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].data.delta).toBe("Real text");
  });
});
