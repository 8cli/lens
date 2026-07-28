import { describe, it, expect } from "vitest";
import { translateAnthropicToChat } from "../src/translators/anthropic.js";

describe("translateAnthropicToChat", () => {
  it("translates a simple text user message", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("translates assistant text message", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("translates system prompt from top-level field", () => {
    const result = translateAnthropicToChat({
      system: "Be concise",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "Be concise" });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("translates system prompt from system message role", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "Be helpful" });
  });

  it("combines top-level system and system message", () => {
    const result = translateAnthropicToChat({
      system: "First",
      messages: [
        { role: "system", content: "Second" },
        { role: "user", content: "Hello" },
      ],
    });
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("First");
    expect(result.messages[0].content).toContain("Second");
  });

  it("translates image blocks to OpenAI image_url format", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
          ],
        },
      ],
    });
    const userMsg = result.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "Describe this" });
    expect(userMsg.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  it("translates tool_use blocks to assistant tool_calls", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll check" },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "get_weather",
              input: { city: "NYC" },
            },
          ],
        },
      ],
    });
    const assistant = result.messages[0];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("I'll check");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe("toolu_123");
    expect(assistant.tool_calls[0].type).toBe("function");
    expect(assistant.tool_calls[0].function.name).toBe("get_weather");
    expect(assistant.tool_calls[0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("translates tool_result blocks to tool messages", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Sunny, 72F",
            },
          ],
        },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_123",
      content: "Sunny, 72F",
    });
  });

  it("maps Anthropic model names to default model", () => {
    const result = translateAnthropicToChat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("copies temperature, top_p, and max_tokens", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 2048,
    });
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.95);
    expect(result.max_tokens).toBe(2048);
  });

  it("enforces max_tokens minimum of 1024", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    });
    expect(result.max_tokens).toBe(1024);
  });

  it("defaults max_tokens to 8192 when not provided", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.max_tokens).toBe(8192);
  });

  it("maps stop_sequences to stop", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      stop_sequences: ["STOP", "END"],
    });
    expect(result.stop).toEqual(["STOP", "END"]);
  });

  it("translates tools to function calling format", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather info",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].type).toBe("function");
    expect(result.tools[0].function.name).toBe("get_weather");
    expect(result.tools[0].function.parameters).toEqual({ type: "object" });
    expect(result.tool_choice).toBe("auto");
  });

  it("translates thinking configuration", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });

  it("streams by default", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.stream).toBe(true);
  });

  it("respects stream: false", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });
    expect(result.stream).toBe(false);
  });

  it("handles assistant content as string", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "assistant", content: "Simple text" }],
    });
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "Simple text",
    });
  });

  it("handles user content as string", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Simple text" }],
    });
    expect(result.messages[0]).toEqual({
      role: "user",
      content: "Simple text",
    });
  });

  it("handles tool_result with array content", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: [{ type: "text", text: "Result part 1" }],
            },
          ],
        },
      ],
    });
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("toolu_123");
    expect(result.messages[0].content).toBe("Result part 1");
  });

  it("handles role: tool as tool_result", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "tool", content: "Tool output", tool_use_id: "toolu_456" },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_456",
      content: "Tool output",
    });
  });
});
