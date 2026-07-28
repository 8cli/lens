import { describe, it, expect, vi } from "vitest";
import { translateToChat } from "../src/translators/responses.js";

describe("translateToChat", () => {
  it("translates string input to a single user message", () => {
    const result = translateToChat({ input: "Hello world" });
    expect(result.messages).toEqual([{ role: "user", content: "Hello world" }]);
    expect(result.stream).toBe(true);
    expect(result.model).toBeDefined();
  });

  it("translates array input with string items to user messages", () => {
    const result = translateToChat({ input: ["Hello", "How are you?"] });
    expect(result.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("translates message items with roles", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "user", content: "Hello" },
        { type: "message", role: "assistant", content: "Hi there" },
      ],
    });
    expect(result.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("converts developer messages to system instructions", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "developer", content: "Be helpful" },
        { type: "message", role: "user", content: "Hello" },
      ],
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("handles instructions as system message", () => {
    const result = translateToChat({
      instructions: "System prompt",
      input: "User query",
    });
    expect(result.messages[0]).toEqual({ role: "system", content: "System prompt" });
    expect(result.messages[1]).toEqual({ role: "user", content: "User query" });
  });

  it("combines instructions and developer messages into one system message", () => {
    const result = translateToChat({
      instructions: "First system",
      input: [
        { type: "message", role: "developer", content: "Second system" },
        { type: "message", role: "user", content: "Hello" },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "First system\n\nSecond system",
    });
  });

  it("translates function_call items to assistant tool_calls", () => {
    const result = translateToChat({
      input: [
        {
          type: "function_call",
          call_id: "call_123",
          name: "get_weather",
          arguments: { city: "NYC" },
        },
      ],
    });
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].type).toBe("function");
    expect(assistant.tool_calls[0].function.name).toBe("get_weather");
    expect(assistant.tool_calls[0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("translates function_call_output to tool message", () => {
    const result = translateToChat({
      input: [
        {
          type: "function_call_output",
          call_id: "call_123",
          output: "Sunny, 72F",
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "call_123", content: "Sunny, 72F" },
    ]);
  });

  it("translates custom_tool_call_output to tool message", () => {
    const result = translateToChat({
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call_456",
          output: "Result here",
        },
      ],
    });
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "call_456", content: "Result here" },
    ]);
  });

  it("translates local_shell_call to assistant tool_calls with shell name", () => {
    const result = translateToChat({
      input: [
        {
          type: "local_shell_call",
          call_id: "call_shell",
          action: { command: "ls -la" },
        },
      ],
    });
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toBe("shell");
    expect(assistant.tool_calls[0].function.arguments).toBe('{"command":"ls -la"}');
  });

  it("translates custom_tool_call to assistant tool_calls", () => {
    const result = translateToChat({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_custom",
          name: "my_tool",
          action: { foo: "bar" },
        },
      ],
    });
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toBe("my_tool");
    expect(assistant.tool_calls[0].function.arguments).toBe('{"foo":"bar"}');
  });

  it("translates tool_search_call to assistant tool_calls", () => {
    const result = translateToChat({
      input: [
        {
          type: "tool_search_call",
          call_id: "call_search",
          action: { query: "vitest" },
        },
      ],
    });
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toBe("tool_search_call");
  });

  it("translates reasoning item to assistant message with summary", () => {
    const result = translateToChat({
      input: [
        { type: "reasoning", summary: "I need to think about this" },
      ],
    });
    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: "[Previous reasoning: I need to think about this]",
      },
    ]);
  });

  it("warns on unknown input item types", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateToChat({
      input: [{ type: "unknown_type", data: "foo" }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown input item type "unknown_type"')
    );
    warnSpy.mockRestore();
  });

  it("copies tools to chat request", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("get_weather");
    expect(result.tool_choice).toBe("auto");
  });

  it("enforces max_tokens minimum of 1024", () => {
    const result = translateToChat({ input: "Hello", max_output_tokens: 100 });
    expect(result.max_tokens).toBe(1024);
  });

  it("uses provided max_tokens when above minimum", () => {
    const result = translateToChat({ input: "Hello", max_output_tokens: 2048 });
    expect(result.max_tokens).toBe(2048);
  });

  it("handles max_tokens alias", () => {
    const result = translateToChat({ input: "Hello", max_tokens: 512 });
    expect(result.max_tokens).toBe(1024);
  });

  it("copies temperature and top_p", () => {
    const result = translateToChat({
      input: "Hello",
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
  });

  it("sets stream false when body.stream is false", () => {
    const result = translateToChat({ input: "Hello", stream: false });
    expect(result.stream).toBe(false);
  });

  it("defaults stream to true", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.stream).toBe(true);
  });

  it("handles reasoning effort configuration", () => {
    const result = translateToChat({
      input: "Hello",
      reasoning: { effort: "high" },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      reasoning_effort: "high",
    });
  });

  it("does not enable thinking when reasoning effort is none", () => {
    const result = translateToChat({
      input: "Hello",
      reasoning: { effort: "none" },
    });
    expect(result.thinking).toBeUndefined();
  });

  it("handles mixed input array with multiple item types", () => {
    const result = translateToChat({
      input: [
        "User message 1",
        { type: "message", role: "assistant", content: "Assistant reply" },
        { type: "function_call", name: "tool1", arguments: {} },
        { type: "function_call_output", call_id: "call_1", output: "out" },
        "User message 2",
      ],
    });
    // function_call attaches to the preceding assistant message
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: "user", content: "User message 1" });
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("Assistant reply");
    expect(result.messages[1].tool_calls).toBeDefined();
    expect(result.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "out" });
    expect(result.messages[3]).toEqual({ role: "user", content: "User message 2" });
  });
});
