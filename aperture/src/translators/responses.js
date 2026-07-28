// --- OpenAI Responses API -> OpenCode Chat Completions -----

import { uid, now, extractText } from "../helpers.js";
import { streamSSE } from "../stream.js";
import { resolveDefaultModel } from "../config.js";
import { extractUsage } from "../upstream.js";

/**
 * Translate an OpenAI Responses API request body to OpenCode Chat Completions format.
 * @param {object} body - The Responses API request body
 */
export function translateToChat(body) {
  const messages = [];
  const systemParts = [];

  // instructions -> system message
  if (body.instructions) {
    systemParts.push(
      typeof body.instructions === "string" ? body.instructions : extractText(body.instructions)
    );
  }

  let lastAssistantIdx = null;

  function ensureAssistant() {
    if (lastAssistantIdx !== null && messages[lastAssistantIdx]?.role === "assistant") {
      return lastAssistantIdx;
    }
    // Use placeholder content for tool_calls - DeepSeek needs non-empty assistant content
    messages.push({ role: "assistant", content: "I'll process your request." });
    lastAssistantIdx = messages.length - 1;
    return lastAssistantIdx;
  }

  // Process input items
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else {
    for (const item of body.input || []) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        lastAssistantIdx = null;
        continue;
      }

      switch (item.type || "message") {
        case "message": {
          const role = item.role || "user";
          const text = extractText(item.content);
          if (role === "developer") {
            if (text) systemParts.push(text);
            break;
          }
          messages.push({ role, content: text });
          lastAssistantIdx = role === "assistant" ? messages.length - 1 : null;
          break;
        }

        case "function_call": {
          const idx = ensureAssistant();
          if (!messages[idx].tool_calls) messages[idx].tool_calls = [];
          messages[idx].tool_calls.push({
            id: item.call_id || uid("call"),
            type: "function",
            function: {
              name: item.name || "",
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments || {}),
            },
          });
          break;
        }

        case "function_call_output":
        case "custom_tool_call_output": {
          const output = typeof item.output === "string" ? item.output : extractText(item.output);
          const callId = item.call_id || "";
          messages.push({ role: "tool", tool_call_id: callId, content: output || "" });
          lastAssistantIdx = null;
          break;
        }

        case "local_shell_call":
        case "custom_tool_call":
        case "tool_search_call": {
          const idx = ensureAssistant();
          const name = item.type === "local_shell_call" ? "shell" : item.name || item.type;
          if (!messages[idx].tool_calls) messages[idx].tool_calls = [];
          messages[idx].tool_calls.push({
            id: item.call_id || uid("call"),
            type: "function",
            function: { name, arguments: JSON.stringify(item.action || {}) },
          });
          break;
        }

        case "reasoning": {
          const summary = extractText(item.summary || item.content || "");
          if (summary) {
            messages.push({
              role: "assistant",
              content: `[Previous reasoning: ${summary.slice(0, 500)}]`,
            });
          }
          lastAssistantIdx = null;
          break;
        }

        default: {
          console.warn(`Unknown input item type "${item.type}" in translateToChat`);
          break;
        }
      }
    }
  }

  // Prepend system messages
  if (systemParts.length > 0) {
    messages.unshift({ role: "system", content: systemParts.join("\n\n") });
  }

  // Build the chat request
  const chat = {
    model: body.model || resolveDefaultModel(),
    messages,
    stream: body.stream !== false,
  };

  // Copy over supported parameters
  const params = ["temperature", "top_p", "stop", "response_format", "logprobs", "top_logprobs"];
  for (const key of params) {
    if (body[key] !== undefined) chat[key] = body[key];
  }

  // Token limits
  const maxTokens = body.max_output_tokens ?? body.max_tokens ?? 16384;
  // Enforce a sensible minimum so reasoning models don't spend the whole budget
  // on chain-of-thought and leave the actual answer empty.
  chat.max_tokens = Math.max(maxTokens, 1024);

  // Tool/function definitions
  if (body.tools && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type === "function" || (!t.type && t.name)) {
        const fn = t.function || t;
        tools.push({
          type: "function",
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
            strict: fn.strict,
          },
        });
      }
    }
    if (tools.length > 0) {
      chat.tools = tools;
      chat.tool_choice = body.tool_choice || "auto";
      if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
    }
  }

  // Reasoning/thinking
  if (body.reasoning?.effort && body.reasoning.effort !== "none") {
    const effortMap = { low: "low", medium: "medium", high: "high", default: "high" };
    chat.thinking = {
      type: "enabled",
      reasoning_effort: effortMap[body.reasoning.effort] || "high",
    };
  }

  return chat;
}

/**
 * Translate upstream Chat Completion response chunk to Responses API SSE event.
 */
export async function* translateStreamEvents(upstreamResponse, respId, model = resolveDefaultModel()) {
  let outputIndex = 0;
  let textStarted = false;
  let fullText = "";
  let currentTextItemId = null;
  let usage = {};
  const toolCallsMap = {};
  const toolOrder = [];

  // Emit response.created
  yield {
    event: "response.created",
    data: {
      type: "response.created",
      response: {
        id: respId,
        object: "response",
        created_at: now(),
        model,
        output: [],
      },
    },
  };

  for await (const chunk of streamSSE(upstreamResponse)) {
    if (chunk.usage) usage = chunk.usage;

    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {};
      const finishReason = choice.finish_reason;
      const content = delta.content;

      // Text content delta
      if (content !== undefined && content !== null && content !== "") {
        if (!textStarted) {
          textStarted = true;
          currentTextItemId = uid("msg");
          yield {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                id: currentTextItemId,
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
              },
            },
          };
        }
        fullText += content;
        yield {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            output_index: outputIndex,
            content_index: 0,
            delta: content,
          },
        };
      }

      // Tool calls
      if (delta.tool_calls) {
        // Close previous text item if any
        if (textStarted) {
          yield { event: "response.output_item.done", data: makeTextItemDone(outputIndex, fullText) };
          outputIndex++;
          textStarted = false;
          fullText = "";
        }

        for (const tc of delta.tool_calls) {
          const fn = tc.function || {};
          const idx = tc.index;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = {
              call_id: tc.id || uid("call"),
              name: fn.name || "",
              arguments: "",
            };
            toolOrder.push(idx);
            yield {
              event: "response.output_item.added",
              data: {
                type: "response.output_item.added",
                output_index: outputIndex,
                item: {
                  id: toolCallsMap[idx].call_id,
                  type: "function_call",
                  call_id: toolCallsMap[idx].call_id,
                  name: toolCallsMap[idx].name,
                  arguments: "",
                  status: "in_progress",
                },
              },
            };
          }
          // Update name if missing
          if (fn.name && !toolCallsMap[idx].name) {
            toolCallsMap[idx].name = fn.name;
          }
          if (fn.arguments) {
            toolCallsMap[idx].arguments += fn.arguments;
            yield {
              event: "response.function_call_arguments.delta",
              data: {
                type: "response.function_call_arguments.delta",
                delta: fn.arguments,
                id: toolCallsMap[idx].call_id,
              },
            };
          }
        }
      }

      // Finish reason
      if (finishReason) {
        if (textStarted) {
          yield { event: "response.output_text.done", data: makeTextDone(outputIndex, fullText) };
          yield { event: "response.output_item.done", data: makeTextItemDone(outputIndex, fullText) };
          outputIndex++;
          textStarted = false;
          fullText = "";
        }
        // Emit completed tool calls
        for (const idx of toolOrder) {
          const tc = toolCallsMap[idx];
          yield {
            event: "response.function_call_arguments.done",
            data: {
              type: "response.function_call_arguments.done",
              arguments: tc.arguments,
              id: tc.call_id,
            },
          };
          yield { event: "response.output_item.done", data: makeToolCallDone(outputIndex, tc) };
          outputIndex++;
        }
        Object.keys(toolCallsMap).forEach(k => delete toolCallsMap[k]);
        toolOrder.length = 0;
      }
    }
  }

  // Flush remaining
  if (textStarted) {
    yield { event: "response.output_text.done", data: makeTextDone(outputIndex, fullText) };
    yield { event: "response.output_item.done", data: makeTextItemDone(outputIndex, fullText, currentTextItemId) };
    outputIndex++;
  }
  for (const idx of toolOrder) {
    const tc = toolCallsMap[idx];
    yield { event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", arguments: tc.arguments, id: tc.call_id } };
    yield { event: "response.output_item.done", data: makeToolCallDone(outputIndex, tc) };
    outputIndex++;
  }

  // response.completed
  const respUsage = usage.prompt_tokens !== undefined ? extractUsage({ usage }) : null;
  yield {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        created_at: now(),
        model,
        output: [],
        usage: respUsage,
      },
    },
  };
}

/**
 * Translate upstream Chat Completion response to Responses API JSON format (non-streaming).
 */
export async function translateResponseJson(upstreamResponse, respId, model = resolveDefaultModel()) {
  const data = await upstreamResponse.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const output = [];

  output.push({
    id: uid("msg"),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: message.content || "", annotations: [] }],
  });

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      output.push({
        id: uid("fc"),
        type: "function_call",
        name: tc.function.name,
        arguments: JSON.stringify(args),
        call_id: tc.id,
        status: "completed",
      });
    }
  }

  return {
    id: respId,
    object: "response",
    created_at: now(),
    model,
    output,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
          total_tokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

// --- Internal helpers ------------------------------

function makeTextDone(idx, text) {
  return { type: "response.output_text.done", output_index: idx, content_index: 0, text };
}

function makeTextItemDone(idx, text, itemId) {
  return {
    type: "response.output_item.done",
    output_index: idx,
    item: {
      id: itemId || uid("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: text ? [{ type: "output_text", text, annotations: [] }] : [],
    },
  };
}

function makeToolCallDone(idx, tc) {
  return {
    type: "response.output_item.done",
    output_index: idx,
    item: {
      id: tc.call_id,
      type: "function_call",
      call_id: tc.call_id,
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    },
  };
}
