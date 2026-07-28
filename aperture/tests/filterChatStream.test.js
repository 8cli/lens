import { describe, it, expect } from "vitest";
import { filterChatStream } from "../src/handlers/chat.js";

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

describe("filterChatStream", () => {
  it("passes through plain text lines unchanged", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {"choices":[{"delta":{"content":"Hello"}}]}');
    expect(lines).toContain("data: [DONE]");
  });

  it("strips reasoning_content from delta chunks", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"","reasoning_content":"thinking..."},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines.some((l) => l.includes("reasoning_content"))).toBe(false);
    expect(lines.some((l) => l.includes("Answer"))).toBe(true);
  });

  it("converts null content to empty string", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":null},"finish_reason":null}]}',
      "data: [DONE]",
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLine = lines.find((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].delta.content).toBe("");
  });

  it("passes through [DONE] unchanged", async () => {
    const resp = makeSseResponse(["data: [DONE]"]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toEqual(["data: [DONE]"]);
  });

  it("passes through malformed JSON unchanged", async () => {
    const resp = makeSseResponse([
      'data: {not valid json}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {not valid json}');
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

  it("skips chunks that only contain reasoning_content after stripping", async () => {
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

  it("handles multiple choices in one chunk", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"A","reasoning_content":"r1"}},{"delta":{"content":"B"}}]}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    const dataLine = lines.find((l) => l.startsWith("data: {") && !l.includes("[DONE]"));
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].delta.reasoning_content).toBeUndefined();
    expect(parsed.choices[0].delta.content).toBe("A");
    expect(parsed.choices[1].delta.content).toBe("B");
  });

  it("handles chunks without choices array", async () => {
    const resp = makeSseResponse([
      'data: {"usage":{"prompt_tokens":10}}',
    ]);
    const lines = await collectLines(filterChatStream(resp));
    expect(lines).toContain('data: {"usage":{"prompt_tokens":10}}');
  });
});
