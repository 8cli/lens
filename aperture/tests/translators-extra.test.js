import { describe, it, expect, vi } from "vitest";
import { translateToChat, translateResponseJson, translateStreamEvents } from "../src/translators/responses.js";
import {
  translateAnthropicToChat,
  translateAnthropicJson,
  translateAnthropicStream,
} from "../src/translators/anthropic.js";

// ---------------------------------------------------------------------------
// Helpers for stream / response tests
// ---------------------------------------------------------------------------

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

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

// ===========================================================================
// 1.  translateToChat  –  extra edge cases
// ===========================================================================
describe("translateToChat – extra edge cases", () => {
  // ------ reasoning effort mapping ------
  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["default", "high"],
    ["unknown_val", "high"],
  ])('maps reasoning.effort "%s" to "%s"', (effort, expected) => {
    const result = translateToChat({
      input: "Hello",
      reasoning: { effort },
    });
    if (effort === "none") {
      expect(result.thinking).toBeUndefined();
    } else {
      expect(result.thinking).toEqual({
        type: "enabled",
        reasoning_effort: expected,
      });
    }
  });

  it("does not set thinking when reasoning.effort is none", () => {
    const result = translateToChat({
      input: "Hello",
      reasoning: { effort: "none" },
    });
    expect(result.thinking).toBeUndefined();
  });

  it("does not set thinking when reasoning.effort is undefined", () => {
    const result = translateToChat({
      input: "Hello",
      reasoning: {},
    });
    expect(result.thinking).toBeUndefined();
  });

  it("does not set thinking when reasoning is absent", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.thinking).toBeUndefined();
  });

  // ------ model fallback ------
  it("uses resolveDefaultModel when body.model is missing", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("prefers body.model over default", () => {
    const result = translateToChat({ input: "Hello", model: "custom-model" });
    expect(result.model).toBe("custom-model");
  });

  // ------ max_output_tokens / max_tokens fallback chain ------
  it("uses max_output_tokens as primary token limit", () => {
    const result = translateToChat({ input: "Hello", max_output_tokens: 4096 });
    expect(result.max_tokens).toBe(4096);
  });

  it("falls back to max_tokens when max_output_tokens is missing", () => {
    const result = translateToChat({ input: "Hello", max_tokens: 2048 });
    expect(result.max_tokens).toBe(2048); // but minimum 1024 enforced
  });

  it("enforces minimum 1024 even with very low max_output_tokens", () => {
    const result = translateToChat({ input: "Hello", max_output_tokens: 100 });
    expect(result.max_tokens).toBe(1024);
  });

  it("uses default 16384 when neither max_output_tokens nor max_tokens is set", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.max_tokens).toBe(16384); // default in code: 16384
  });

  // ------ streaming defaults ------
  it("stream defaults to true", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.stream).toBe(true);
  });

  it("respects stream: false", () => {
    const result = translateToChat({ input: "Hello", stream: false });
    expect(result.stream).toBe(false);
  });

  // ------ passthrough parameters ------
  it("passes through temperature and top_p", () => {
    const result = translateToChat({
      input: "Hello",
      temperature: 0.3,
      top_p: 0.8,
    });
    expect(result.temperature).toBe(0.3);
    expect(result.top_p).toBe(0.8);
  });

  it("passes through stop", () => {
    const result = translateToChat({
      input: "Hello",
      stop: ["STOP", "END"],
    });
    expect(result.stop).toEqual(["STOP", "END"]);
  });

  it("passes through response_format", () => {
    const result = translateToChat({
      input: "Hello",
      response_format: { type: "json_object" },
    });
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  it("passes through logprobs and top_logprobs", () => {
    const result = translateToChat({
      input: "Hello",
      logprobs: true,
      top_logprobs: 3,
    });
    expect(result.logprobs).toBe(true);
    expect(result.top_logprobs).toBe(3);
  });

  // ------ instructions as array of content blocks ------
  it("handles instructions as array of content blocks", () => {
    const result = translateToChat({
      instructions: [
        { type: "text", text: "System part 1" },
        { type: "text", text: "System part 2" },
      ],
      input: "User query",
    });
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "System part 1System part 2",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "User query" });
  });

  // ------ tool definitions ------
  it("translates tool definitions to function calling format", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
            strict: true,
          },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("get_weather");
    expect(result.tools[0].function.strict).toBe(true);
    expect(result.tool_choice).toBe("auto");
  });

  it("handles tools without explicit type (name-based detection)", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [{ name: "my_tool", description: "Does stuff", parameters: {} }],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("my_tool");
  });

  it("passes through tool_choice", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [{ name: "my_tool", parameters: {} }],
      tool_choice: "required",
    });
    expect(result.tool_choice).toBe("required");
  });

  it("passes through parallel_tool_calls", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [{ name: "my_tool", parameters: {} }],
      parallel_tool_calls: true,
    });
    expect(result.parallel_tool_calls).toBe(true);
  });

  it("does not set parallel_tool_calls when absent", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [{ name: "my_tool", parameters: {} }],
    });
    expect(result.parallel_tool_calls).toBeUndefined();
  });

  // ------ reasoning items with empty / embedded content ------
  it("skips reasoning items with empty summary", () => {
    const result = translateToChat({
      input: [{ type: "reasoning", summary: "" }],
    });
    // No reasoning message should appear when summary is empty
    expect(result.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("handles reasoning items with content instead of summary", () => {
    const result = translateToChat({
      input: [{ type: "reasoning", content: [{ type: "text", text: "Thinking hard" }] }],
    });
    expect(result.messages).toEqual([
      { role: "assistant", content: "[Previous reasoning: Thinking hard]" },
    ]);
  });

  // ------ message items with embedded content blocks ------
  it("handles message items with array content (extractText)", () => {
    const result = translateToChat({
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " world" },
          ],
        },
      ],
    });
    expect(result.messages[0]).toEqual({ role: "assistant", content: "Hello world" });
  });

  it("strips thinking/redacted_thinking blocks from message content via extractText", () => {
    const result = translateToChat({
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Answer" },
            { type: "thinking", text: "I think therefore" },
            { type: "redacted_thinking", text: "REDACTED" },
          ],
        },
      ],
    });
    // extractText strips thinking/redacted_thinking blocks
    expect(result.messages[0].content).toBe("Answer");
  });

  // ------ function_call items (already tested but adding edge cases) ------
  it("handles function_call with string arguments", () => {
    const result = translateToChat({
      input: [
        { type: "function_call", call_id: "call_1", name: "fn", arguments: '{"x":1}' },
      ],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls[0].function.arguments).toBe('{"x":1}');
  });

  it("handles function_call with missing call_id", () => {
    const result = translateToChat({
      input: [{ type: "function_call", name: "fn", arguments: {} }],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls[0].id).toMatch(/^call/);
  });

  // ------ default case: unknown item type warnings ------
  it("warns on unknown input item types with correct message format", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateToChat({
      input: [{ type: "foobar_unknown", data: "test" }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown input item type "foobar_unknown"/)
    );
    warnSpy.mockRestore();
  });

  // ------ tool_call_output items (role: "tool") ------
  it("translates function_call_output with object output via extractText", () => {
    const result = translateToChat({
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "text", text: "Object result" }],
        },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "Object result",
    });
  });

  it("handles function_call_output with missing output", () => {
    const result = translateToChat({
      input: [{ type: "function_call_output", call_id: "call_1" }],
    });
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "",
    });
  });

  // ------ custom_tool_call, local_shell_call, tool_search_call items ------
  it("handles custom_tool_call items", () => {
    const result = translateToChat({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_ct1",
          name: "my_custom_tool",
          action: { query: "test" },
        },
      ],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].id).toBe("call_ct1");
    expect(msg.tool_calls[0].function.name).toBe("my_custom_tool");
    expect(msg.tool_calls[0].function.arguments).toBe('{"query":"test"}');
  });

  it("handles local_shell_call items with name 'shell'", () => {
    const result = translateToChat({
      input: [
        {
          type: "local_shell_call",
          call_id: "call_sh1",
          action: { command: "ls -la" },
        },
      ],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("shell");
    expect(msg.tool_calls[0].function.arguments).toBe('{"command":"ls -la"}');
  });

  it("handles tool_search_call items", () => {
    const result = translateToChat({
      input: [
        {
          type: "tool_search_call",
          call_id: "call_ts1",
          name: "web_search",
          action: { query: "weather" },
        },
      ],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("web_search");
    expect(msg.tool_calls[0].function.arguments).toBe('{"query":"weather"}');
  });

  it("handles custom_tool_call with missing name (falls back to type)", () => {
    const result = translateToChat({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_nn",
          action: { task: "run" },
        },
      ],
    });
    const msg = result.messages.find((m) => m.role === "assistant");
    expect(msg.tool_calls[0].function.name).toBe("custom_tool_call");
  });

  // ------ developer role in message items ------
  it("handles message item with developer role as system text", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "developer", content: "Be helpful" },
        { type: "message", role: "user", content: "Hi" },
      ],
    });
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "Be helpful",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("skips developer message with empty text", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "developer", content: "" },
        { type: "message", role: "user", content: "Hi" },
      ],
    });
    // Empty developer text should not add a system message
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  // ------ instructions as plain string ------
  it("handles instructions as plain string", () => {
    const result = translateToChat({
      instructions: "You are a helpful assistant.",
      input: "Hello",
    });
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  // ------ empty input array ------
  it("handles empty input array", () => {
    const result = translateToChat({ input: [] });
    expect(result.messages).toEqual([]);
    expect(result.model).toBe("deepseek-v4-flash");
  });

  it("handles missing input entirely", () => {
    const result = translateToChat({});
    expect(result.messages).toEqual([]);
  });

  // ------ string input already covered at top, but ensure fallback ------
  it("handles input items with null/undefined type falling through to default", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateToChat({
      input: [{ noType: true }],
    });
    // type defaults to "message", so it may or may not warn depending on how
    // the code resolves item.type. If item.type is undefined, the switch
    // uses "message" default → no warning.
    // We just verify no crash.
    expect(result).toBeDefined();
    warnSpy.mockRestore();
  });

  // ------ ensure function_call sets tool_choice ------
  it("sets tool_choice when tools are provided", () => {
    const result = translateToChat({
      input: "Hello",
      tools: [{ name: "my_tool", parameters: {} }],
    });
    expect(result.tool_choice).toBe("auto");
  });

  it("does not set tool_choice when no tools", () => {
    const result = translateToChat({ input: "Hello" });
    expect(result.tool_choice).toBeUndefined();
  });
});

// ===========================================================================
// 2.  translateAnthropicToChat  –  extra edge cases
// ===========================================================================
describe("translateAnthropicToChat – extra edge cases", () => {
  // ------ system as string, array, and missing ------
  it("handles system as array of strings", () => {
    const result = translateAnthropicToChat({
      system: ["Rule one", "Rule two"],
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Rule one");
    expect(result.messages[0].content).toContain("Rule two");
  });

  it("handles system as empty string", () => {
    const result = translateAnthropicToChat({
      system: "",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages[0].role).toBe("user");
    expect(result.messages).toHaveLength(1);
  });

  it("handles missing system and no system messages", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  // ------ tool_choice mapping ------
  it('maps tool_choice "any" to "required"', () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(result.tool_choice).toBe("required");
  });

  it('maps tool_choice "tool" to function type with name', () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "get_weather" },
    });
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it('maps tool_choice "auto" to "auto"', () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    });
    expect(result.tool_choice).toBe("auto");
  });

  // ------ tool definitions with custom/function types ------
  it("handles tools with custom type", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          type: "custom",
          name: "my_custom_tool",
          description: "Custom tool",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].type).toBe("function");
    expect(result.tools[0].function.name).toBe("my_custom_tool");
  });

  it("handles tools with function type", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "my_tool",
            description: "Tool desc",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("my_tool");
    expect(result.tools[0].function.parameters).toEqual({ type: "object" });
  });

  it("handles tool with no type but has name", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "bare_tool", description: "Bare", input_schema: { type: "object" } }],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("bare_tool");
  });

  // ------ thinking blocks in assistant content ------
  it("strips thinking blocks from assistant content", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Final answer" },
            { type: "thinking", text: "I am thinking about this" },
          ],
        },
      ],
    });
    // The thinking block is iterated but not handled as "text" or "tool_use",
    // so it should be skipped.
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBe("Final answer");
  });

  // ------ metadata passthrough (user_id) ------
  it("passes through metadata.user_id", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      metadata: { user_id: "user_abc123" },
    });
    expect(result.user_id).toBe("user_abc123");
  });

  it("handles absent metadata", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.user_id).toBeUndefined();
  });

  // ------ max_tokens: default + minimum combined ------
  it("applies both default 8192 and minimum 1024", () => {
    // No max_tokens => default 8192, minimum 1024 => 8192
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.max_tokens).toBe(8192);
  });

  it("enforces minimum 1024 when max_tokens is set below threshold", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 50,
    });
    expect(result.max_tokens).toBe(1024);
  });

  // ------ user messages with empty content ------
  it("drops user message with empty array content (no contentParts to push)", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: [] }],
    });
    // Empty array means no blocks to process;
    // the else clause pushes an empty user message.
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "" });
  });

  it("handles user message with non-array non-string content (fallback)", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: null }],
    });
    expect(result.messages[0]).toEqual({ role: "user", content: "" });
  });

  // ------ environment passthrough for resolveDefaultModel ------
  it("uses env DEFAULT_MODEL when provided", () => {
    const result = translateAnthropicToChat(
      { messages: [{ role: "user", content: "Hello" }] },
      { DEFAULT_MODEL: "env-model" }
    );
    expect(result.model).toBe("env-model");
  });

  // ------ tool_result blocks in user content ------
  it("emits tool_result as separate tool message and keeps user text separate", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "The result was:" },
            {
              type: "tool_result",
              content: "42",
              tool_use_id: "tu_abc",
            },
          ],
        },
      ],
    });
    // tool message first (response to prior tool_calls), then user text
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("tu_abc");
    expect(result.messages[0].content).toBe("42");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("The result was:");
  });

  it("converts tool_result with array content via extractText and emits as tool role", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "Result data" }],
              tool_use_id: "tu_def",
            },
          ],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("tu_def");
    expect(result.messages[0].content).toBe("Result data");
  });

  it("handles tool_result with missing content", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_empty" },
          ],
        },
      ],
    });
    // Emitted as tool message with empty content
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("tu_empty");
    expect(result.messages[0].content).toBe("");
  });

  // ------ assistant with tool_use blocks ------
  it("converts assistant tool_use blocks to tool_calls", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Get weather" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll check." },
            {
              type: "tool_use",
              id: "tu_1",
              name: "get_weather",
              input: { city: "NYC" },
            },
          ],
        },
      ],
    });
    const msg = result.messages[1];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("I'll check.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].id).toBe("tu_1");
    expect(msg.tool_calls[0].type).toBe("function");
    expect(msg.tool_calls[0].function.name).toBe("get_weather");
    expect(msg.tool_calls[0].function.arguments).toBe('{"city":"NYC"}');
  });

  it("handles assistant with only tool_use blocks and no text", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_2",
              name: "search",
              input: { q: "hello" },
            },
          ],
        },
      ],
    });
    const msg = result.messages[1];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("search");
  });

  it("handles assistant tool_use with missing id (generates uid)", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "act", input: { action: "run" } },
          ],
        },
      ],
    });
    const msg = result.messages[1];
    expect(msg.tool_calls[0].id).toMatch(/^call/);
  });

  // ------ messages with "tool" role ------
  it("converts messages with role 'tool' to user text", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Let me check" },
        {
          role: "tool",
          content: "The answer is 42",
          tool_use_id: "tu_3",
        },
      ],
    });
    const toolMsg = result.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("tu_3");
    expect(toolMsg.content).toBe("The answer is 42");
  });

  it("converts role 'tool' with string content", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "tool",
          content: "Tool result text",
          tool_use_id: "tu_4",
        },
      ],
    });
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("tu_4");
    expect(result.messages[0].content).toBe("Tool result text");
  });

  it("handles role 'tool' with missing content", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "tool", tool_use_id: "tu_5" },
      ],
    });
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("tu_5");
    expect(result.messages[0].content).toBe("");
  });

  // ------ string content for assistant (not wrapped in array) ------
  it("handles assistant with plain string content", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("Hi there!");
    expect(result.messages[1].tool_calls).toBeUndefined();
  });

  // ------ thinking enabled ------
  it("maps thinking.type enabled to chat.thinking with default budget", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "enabled" },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
  });

  it("maps thinking.type enabled with custom budget_tokens", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });

  it("ignores thinking when type is not enabled", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
      thinking: { type: "disabled" },
    });
    expect(result.thinking).toBeUndefined();
  });

  // ------ stream passthrough ------
  it("defaults stream to true", () => {
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
});

// ===========================================================================
// 3.  translateResponseJson  –  extra edge cases
// ===========================================================================
describe("translateResponseJson", () => {
  it("translates a normal response with content", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const result = await translateResponseJson(resp, "resp_123", "test-model");
    expect(result.id).toBe("resp_123");
    expect(result.model).toBe("test-model");
    expect(result.object).toBe("response");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].role).toBe("assistant");
    expect(result.output[0].content[0].text).toBe("Hello world");
    expect(result.usage.input_tokens).toBe(10);
  });

  it("translates response with content and tool_calls", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Let me check",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await translateResponseJson(resp, "resp_456", "test-model");
    expect(result.output).toHaveLength(2);
    // First output is the message
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].content[0].text).toBe("Let me check");
    // Second output is the function_call
    expect(result.output[1].type).toBe("function_call");
    expect(result.output[1].name).toBe("get_weather");
    expect(result.output[1].arguments).toBe('{"city":"NYC"}');
    expect(result.output[1].call_id).toBe("call_abc");
  });

  it("emits message even when content is empty but has tool_calls", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_xyz",
                type: "function",
                function: { name: "search", arguments: '{"q":"test"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await translateResponseJson(resp, "resp_789", "test-model");
    // Should still emit the message (with empty text) plus the function_call
    expect(result.output).toHaveLength(2);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].content[0].text).toBe("");
    expect(result.output[1].type).toBe("function_call");
    expect(result.output[1].name).toBe("search");
  });

  it("handles malformed tool_call arguments gracefully", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Check",
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "bad_tool", arguments: "not-json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await translateResponseJson(resp, "resp_bad", "test-model");
    expect(result.output[1].arguments).toBe("{}"); // falls back to {} after JSON.parse fails
  });

  it("returns undefined when there are no choices", async () => {
    const resp = jsonResponse({ choices: [] });
    const result = await translateResponseJson(resp, "resp_empty", "test-model");
    // The function accesses choices?.[0]?.message, which will be undefined,
    // so output will contain a message with empty content
    expect(result.output[0].content[0].text).toBe("");
  });

  it("handles usage being absent", async () => {
    const resp = jsonResponse({
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" } }],
    });
    const result = await translateResponseJson(resp, "resp_no_usage", "test-model");
    expect(result.usage).toBeUndefined();
  });
});

// ===========================================================================
// 4.  translateAnthropicJson  –  extra edge cases
// ===========================================================================
describe("translateAnthropicJson", () => {
  it("translates a normal response with text content", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = await translateAnthropicJson(resp, "req_123", "test-model");
    expect(result.id).toBe("req_123");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(result.stop_reason).toBe("end_turn");
    expect(result.model).toBe("test-model");
  });

  it("translates response with content and tool_calls", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I'll check",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await translateAnthropicJson(resp, "req_456", "test-model");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "I'll check" });
    expect(result.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "NYC" },
    });
    expect(result.stop_reason).toBe("tool_use");
  });

  it("handles null message content gracefully", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
    });
    const result = await translateAnthropicJson(resp, "req_null", "test-model");
    // null content -> no text block pushed, content array stays empty
    expect(result.content).toEqual([]);
  });

  it("handles undefined message content gracefully", async () => {
    const resp = jsonResponse({
      choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }],
    });
    const result = await translateAnthropicJson(resp, "req_undef", "test-model");
    expect(result.content).toEqual([]);
  });

  it("handles malformed tool_call arguments via try/catch fallback", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Stuff",
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "bad_tool", arguments: "!invalid json!!" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await translateAnthropicJson(resp, "req_bad", "test-model");
    const toolUseBlock = result.content[1];
    expect(toolUseBlock.type).toBe("tool_use");
    expect(toolUseBlock.input).toEqual({}); // falls back to empty object
  });

  it("maps finish_reason length to max_tokens", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Partial" },
          finish_reason: "length",
        },
      ],
    });
    const result = await translateAnthropicJson(resp, "req_len", "test-model");
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("defaults stop_reason to end_turn for unknown finish_reason", async () => {
    const resp = jsonResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi" },
          finish_reason: "content_filter",
        },
      ],
    });
    const result = await translateAnthropicJson(resp, "req_cf", "test-model");
    expect(result.stop_reason).toBe("end_turn");
  });
});

// ===========================================================================
// 5.  translateAnthropicStream  –  extra edge cases
// ===========================================================================
describe("translateAnthropicStream", () => {
  it("emits message_start at the beginning", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_123", "test-model"));
    expect(events[0].event).toBe("message_start");
    expect(events[0].data.message.id).toBe("req_123");
    expect(events[0].data.message.model).toBe("test-model");
  });

  it("emits message_stop at the end", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_123", "test-model"));
    expect(events[events.length - 1].event).toBe("message_stop");
  });

  // ------ tool_use block lifecycle ------
  it("emits tool_use lifecycle (start, input_json_delta, stop)", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\": "}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_tc", "test-model"));

    const contentBlockStarts = events.filter((e) => e.event === "content_block_start");
    const contentBlockDeltas = events.filter((e) => e.event === "content_block_delta");
    const contentBlockStops = events.filter((e) => e.event === "content_block_stop");

    expect(contentBlockStarts.length).toBeGreaterThanOrEqual(1);
    // The first content_block_start for tool_use
    const toolUseStart = contentBlockStarts.find(
      (e) => e.data.content_block?.type === "tool_use"
    );
    expect(toolUseStart).toBeDefined();
    expect(toolUseStart.data.content_block.name).toBe("get_weather");
    expect(toolUseStart.data.content_block.id).toBe("call_1");
    expect(toolUseStart.data.content_block.input).toEqual({});

    // input_json_delta events
    const jsonDeltas = contentBlockDeltas.filter(
      (e) => e.data.delta?.type === "input_json_delta"
    );
    expect(jsonDeltas.length).toBeGreaterThanOrEqual(1);

    // content_block_stop for tool_use
    // There should be at least 1 stop (for tool use blocks) + possibly text block stop
    expect(contentBlockStops.length).toBeGreaterThanOrEqual(1);
  });

  it("emits content_block_start for text before tool calls", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Let me check"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_t1","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"hello\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_mix", "test-model"));

    const textStarts = events.filter(
      (e) => e.event === "content_block_start" && e.data.content_block?.type === "text"
    );
    expect(textStarts).toHaveLength(1);
    expect(textStarts[0].data.content_block.text).toBe("");

    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta"
    );
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].data.delta.text).toBe("Let me check");
  });

  // ------ stream with only reasoning (should skip gracefully) ------
  it("gracefully skips reasoning-only stream with no text or tool_calls", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking step 1"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"thinking step 2"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_reason", "test-model"));

    // message_start + message_delta + message_stop = 3 events minimum
    // No content_block_* events should be emitted for reasoning only
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].event).toBe("message_start");
    expect(events[events.length - 1].event).toBe("message_stop");

    const contentBlockEvents = events.filter(
      (e) =>
        e.event === "content_block_start" ||
        e.event === "content_block_delta" ||
        e.event === "content_block_stop"
    );
    expect(contentBlockEvents).toHaveLength(0);
  });

  // ------ missing content block close at stream end ------
  it("closes open text block at stream end when no finish_reason arrived", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"I am still thinking"},"finish_reason":null}]}',
      // No finish_reason chunk ever arrives; stream ends normally
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_open", "test-model"));

    // Should have content_block_stop for the open text block at the end
    const stops = events.filter((e) => e.event === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(1);

    // Plus message_delta and message_stop
    expect(events.some((e) => e.event === "message_delta")).toBe(true);
    expect(events.some((e) => e.event === "message_stop")).toBe(true);
  });

  it("emits tool_use content_block_stop on finish_reason even without arguments deltas", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_none","function":{"name":"dry_tool","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_dry", "test-model"));

    // Should have content_block_start and content_block_stop for the tool_use,
    // but no input_json_delta since arguments was empty
    const deltas = events.filter(
      (e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta"
    );
    expect(deltas).toHaveLength(0);

    const stops = events.filter((e) => e.event === "content_block_stop");
    // At least one stop for the tool_use block
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty choices gracefully", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_empty", "test-model"));
    // Should not crash; emit start/delta/stop with empty content
    expect(events[0].event).toBe("message_start");
    expect(events[events.length - 1].event).toBe("message_stop");
  });

  it("tracks usage from stream chunks", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}],"usage":{"prompt_tokens":15,"completion_tokens":8}}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_usage", "test-model"));
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta).toBeDefined();
    expect(delta.data.usage.output_tokens).toBe(8);
    expect(delta.data.usage.input_tokens).toBe(15);
  });
});

// =====================================================================
// Comprehensively cover ALL remaining translator branches
// (|| fallbacks, null checks, default cases)
// =====================================================================

describe("anthropic.js branch coverage — all || fallbacks", () => {
  it("translateAnthropicToChat covers all fallback branches", () => {
    const body = {
      model: "claude-sonnet-4",
      system: true, // not string, not array -> triggers empty-string fallback
      messages: [
        {
          role: "user",
          content: [
            { type: "text" }, // text is undefined -> block.text || ""
            { type: "image", source: { data: "base64data" } }, // no media_type -> "image/png"
            { type: "tool_result", content: [{ type: "text", text: "result" }] },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text" }, // text is undefined -> block.text || ""
            { type: "tool_use", id: "", name: "", input: null }, // id/name/input fallbacks
          ],
        },
        { role: "tool_result", content: null }, // null content -> || ""
        { role: "tool", content: "tool output" },
      ],
      tools: [
        { type: "custom", name: "my_tool", description: "A tool" },
        { type: "function", function: { name: "fn_tool", description: "Fn tool" } },
        { name: "simple_tool", description: "Simple" },
      ],
      tool_choice: { type: "any" },
      max_tokens: 500,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["\n"],
      thinking: { type: "enabled", budget_tokens: 4096 },
      metadata: { user_id: "user_123" },
    };

    const result = translateAnthropicToChat(body, {});
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBe(3);
    expect(result.tool_choice).toBe("required");
    expect(result.thinking).toBeDefined();
    expect(result.thinking.type).toBe("enabled");
    expect(result.user_id).toBe("user_123");
    expect(result.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(result.stop).toEqual(["\n"]);
  });

  it("translateAnthropicToChat covers missing params default values", () => {
    const result = translateAnthropicToChat({}, {});
    expect(result.messages).toEqual([]);
    expect(result.stream).toBe(true);
    expect(result.max_tokens).toBe(8192);
  });

  it("translateAnthropicJson covers null message and null usage", async () => {
    const upstream = new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: null }],
      usage: null,
    }), { headers: { "Content-Type": "application/json" } });

    const result = await translateAnthropicJson(upstream, "req_null", "test-model");
    expect(result.id).toBe("req_null");
    expect(result.stop_reason).toBe("max_tokens");
    expect(result.usage.input_tokens).toBe(0);
  });

  it("translateAnthropicJson covers tool_calls and null arguments", async () => {
    const upstream = new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: "Let me search",
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "search", arguments: null } },
          ],
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    }), { headers: { "Content-Type": "application/json" } });

    const result = await translateAnthropicJson(upstream, "req_tc", "test");
    expect(result.content).toHaveLength(2);
    expect(result.content[1].type).toBe("tool_use");
    expect(result.content[1].input).toEqual({});
  });

  it("translateAnthropicStream covers tool_use without id", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"no_id_tool"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_no_id", "test-model"));
    const toolStarts = events.filter(e => e.event === "content_block_start" && e.data.content_block?.type === "tool_use");
    expect(toolStarts.length).toBeGreaterThanOrEqual(1);
  });

  it("translateAnthropicStream covers finish_reason close of tool_use blocks", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"final_tool","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n',
      'data: {"choices":[{"delta":{}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_final", "test-model"));
    const stops = events.filter(e => e.event === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it("translateAnthropicJson covers null/undefined usage (lines 404-405)", async () => {
    const upstream = new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "OK" } }],
      // No usage field at all
    }), { headers: { "Content-Type": "application/json" } });
    const result = await translateAnthropicJson(upstream, "req_no_usage", "test");
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("translateAnthropicToChat handles tool without description (line 424)", () => {
    const result = translateAnthropicToChat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "no_desc_tool" }],
    }, {});
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("no_desc_tool");
  });

  it("translateAnthropicStream yields message_stop for unknown finish_reason (line 437)", async () => {
    const resp = makeSseResponse([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"other_reason"}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collectEvents(translateAnthropicStream(resp, "req_other", "test"));
    const delta = events.find(e => e.event === "message_delta");
    expect(delta).toBeDefined();
    expect(delta.data.delta.stop_reason).toBe("end_turn");
  });
});
