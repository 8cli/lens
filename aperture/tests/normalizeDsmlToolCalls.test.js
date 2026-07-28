import { describe, it, expect } from "vitest";
import { normalizeDsmlToolCalls } from "../src/translators/dsml.js";

describe("normalizeDsmlToolCalls", () => {
  it("returns body unchanged when no DSML present", () => {
    const body = {
      choices: [{ message: { content: "Hello world", role: "assistant" }, finish_reason: "stop" }],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result).toEqual(body);
  });

  it("returns body unchanged when choices array is missing", () => {
    const body = { id: "test" };
    expect(normalizeDsmlToolCalls(body)).toEqual(body);
  });

  it("returns body unchanged when message is missing", () => {
    const body = { choices: [{ finish_reason: "stop" }] };
    expect(normalizeDsmlToolCalls(body)).toEqual(body);
  });

  it("returns body unchanged when content is too long (>10000 chars)", () => {
    const body = {
      choices: [
        {
          message: { content: "x".repeat(10001), role: "assistant" },
          finish_reason: "stop",
        },
      ],
    };
    expect(normalizeDsmlToolCalls(body)).toEqual(body);
  });

  it("detects DSML invoke and extracts tool call", () => {
    const body = {
      choices: [
        {
          message: {
            content: '<invoke name="get_weather"><parameter name="city">NYC</parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    const msg = result.choices[0].message;
    expect(msg.content).toBe("");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].type).toBe("function");
    expect(msg.tool_calls[0].function.name).toBe("get_weather");
    const args = JSON.parse(msg.tool_calls[0].function.arguments);
    expect(args).toEqual({ city: "NYC" });
  });

  it("handles empty parameter values", () => {
    const body = {
      choices: [
        {
          message: {
            content: '<invoke name="echo"><parameter name="msg"></parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    const args = JSON.parse(result.choices[0].message.tool_calls[0].function.arguments);
    expect(args).toEqual({ msg: "" });
  });

  it("rewrites finish_reason to tool_calls", () => {
    const body = {
      choices: [
        {
          message: {
            content: '<invoke name="search"><parameter name="q">x</parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("rewrites finish_reason length to tool_calls", () => {
    const body = {
      choices: [
        {
          message: {
            content: '<invoke name="calc"><parameter name="expr">1+1</parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "length",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("extracts multiple tool calls", () => {
    const body = {
      choices: [
        {
          message: {
            content:
              '<invoke name="toolA"><parameter name="a">1</parameter></invoke>' +
              '<invoke name="toolB"><parameter name="b">2</parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].message.tool_calls).toHaveLength(2);
    const names = result.choices[0].message.tool_calls.map(
      (tc) => tc.function.name
    );
    expect(names).toContain("toolA");
    expect(names).toContain("toolB");
  });

  it("does not rewrite finish_reason when no tool calls found", () => {
    const body = {
      choices: [
        {
          message: {
            content: 'invoke name="no_match" but wrong format',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].message.tool_calls).toBeUndefined();
  });

  it("returns body unchanged for non-DSML content", () => {
    const body = {
      choices: [
        {
          message: { content: "The invoke keyword is here but not DSML", role: "assistant" },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result).toEqual(body);
  });

  it("handles mixed text and DSML (still detects and clears content)", () => {
    const body = {
      choices: [
        {
          message: {
            content: 'Thinking... <invoke name="action"><parameter name="p">v</parameter></invoke>',
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };
    const result = normalizeDsmlToolCalls(body);
    // Non-DSML prose is preserved alongside extracted tool calls
    expect(result.choices[0].message.content).toBe("Thinking...");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
  });
});
