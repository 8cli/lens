// --- Anthropic Messages API -> OpenCode Chat Completions ---

import { uid, now, extractText } from "../helpers.js";
import { streamSSE } from "../stream.js";
import { resolveDefaultModel } from "../config.js";

/**
 * Translate an Anthropic Messages API request body to OpenCode Chat Completions format.
 *
 * Supports:
 * - messages[] with role: user/assistant
 * - system prompt (as top-level field or first system message)
 * - content blocks (text, image, tool_use, tool_result, thinking)
 * - tools[] definitions -> OpenAI function calling
 * - streaming via stream: true
 * - thinking config
 * - Anthropic-style image blocks -> OpenAI image URL format
 */
export function translateAnthropicToChat(body, env) {
  const messages = [];
  let systemContent = null;
  let lastAssistantIdx = null;

  // Extract system prompt (Anthropic puts it at top level)
  if (body.system) {
    systemContent = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b) => extractText(b)).join("\n")
        : "";
  }

  // Process messages
  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      systemContent = (systemContent || "") + "\n" + extractText(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // A user message can contain text, image, and tool_result blocks.
      // tool_result blocks are emitted as role: "tool" (native OpenAI format)
      // so the upstream can properly match them to preceding tool_calls.
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const userParts = [];
        let hasUserText = false;
        const toolMessages = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            userParts.push({ type: "text", text: block.text || "" });
            hasUserText = true;
          } else if (block.type === "image") {
            if (block.source?.data) {
              userParts.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
                },
              });
            }
          } else if (block.type === "tool_result") {
            const content = typeof block.content === "string"
              ? block.content
              : extractText(block.content);
            toolMessages.push({
              role: "tool",
              tool_call_id: block.tool_use_id || uid("call"),
              content: content || "",
            });
          }
        }
        // Emit tool messages first (they are responses to prior assistant tool_calls),
        // then user text (the new prompt for this turn).
        if (toolMessages.length > 0) {
          messages.push(...toolMessages);
        }
        if (hasUserText || userParts.some((p) => p.type === "image_url")) {
          messages.push({
            role: "user",
            content: userParts.length === 1 ? userParts[0].text : userParts,
          });
        } else if (toolMessages.length === 0) {
          messages.push({ role: "user", content: "" });
        }
      } else {
        messages.push({ role: "user", content: "" });
      }
      lastAssistantIdx = null;
      continue;
    }

    if (msg.role === "assistant") {
      const toolCalls = [];
      let text = "";
      // Handle plain string content directly (not wrapped in content blocks)
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            text += block.text || "";
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || uid("call"),
              type: "function",
              function: {
                name: block.name || "",
                arguments: JSON.stringify(block.input || {}),
              },
            });
          }
        }
      }
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool_result" || msg.role === "tool") {
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((b) => extractText(b)).join("\n")
          : "";
      messages.push({
        role: "tool",
        tool_call_id: msg.tool_use_id || uid("call"),
        content: content || "",
      });
    }
  }

  // Prepend system message
  if (systemContent) {
    messages.unshift({ role: "system", content: systemContent.trim() });
  }

  // Build chat request
  const chat = {
    model: translateModel(body.model, env),
    messages,
    stream: body.stream !== false,
  };

  // Copy parameters
  const paramMap = {
    temperature: "temperature",
    top_p: "top_p",
    stop_sequences: "stop",
    max_tokens: "max_tokens",
  };
  for (const [src, dst] of Object.entries(paramMap)) {
    if (body[src] !== undefined) chat[dst] = body[src];
  }
  if (body.max_tokens === undefined) chat.max_tokens = 8192;
  // Enforce a sensible minimum so reasoning models don't spend the whole budget
  // on chain-of-thought and leave the actual answer empty.
  chat.max_tokens = Math.max(chat.max_tokens, 1024);

  // Tools -> function calling
  if (body.tools && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type === "custom" || t.type === "function" || (!t.type && t.name)) {
        const fn = t.function || t;
        tools.push({
          type: "function",
          function: {
            name: fn.name || t.name,
            description: fn.description || t.description,
            input_schema: fn.input_schema || t.input_schema,
            parameters: fn.parameters || t.parameters || fn.input_schema || t.input_schema,
          },
        });
      }
    }
    if (tools.length > 0) {
      chat.tools = tools;
      chat.tool_choice = body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : "auto";
    }
  }

  // Thinking -> reasoning effort
  if (body.thinking && body.thinking.type === "enabled") {
    chat.thinking = {
      type: "enabled",
      budget_tokens: body.thinking.budget_tokens || 2048,
    };
  }

  // Metadata
  if (body.metadata) {
    chat.user_id = body.metadata.user_id;
  }

  return chat;
}

/**
 * Translate Anthropic SSE stream events to Server-Sent Events format.
 * Since upstream returns Chat Completions format, we emit SSE events
 * that an Anthropic client can consume.
 */
export async function* translateAnthropicStream(upstreamResponse, requestId, model = resolveDefaultModel()) {
  // Emit the start-of-stream event for Anthropic
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: requestId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  };

  let contentIndex = 0;
  let textBlockIndex = -1;        // -1 = no text block currently open

  const toolUseMap = {};
  let lastFinishReason = null;
  const streamUsage = { input_tokens: 0, output_tokens: 0 };

  for await (const chunk of streamSSE(upstreamResponse)) {
    // Track usage from chunks (some providers emit usage in the final chunk)
    if (chunk.usage) {
      streamUsage.input_tokens = chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0;
      streamUsage.output_tokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0;
    }
    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {};
      const content = delta.content;
      const reasoning = delta.reasoning_content;   // DeepSeek reasoning model output
      const toolCalls = delta.tool_calls;
      const finishReason = choice.finish_reason;
      if (finishReason) lastFinishReason = finishReason;

      // Reasoning content: silently ignore. Do NOT emit any SSE events --
      // emitting empty text deltas for each reasoning chunk causes Claude CLI
      // to hang (it receives 50-200 empty text deltas before any real content).
      // The model's actual text or tool_call output will create its own block.
      if (reasoning) {
        // skip -- reasoning is not a standard Anthropic content block type
      }

      // Text content: open the text block ONCE, accumulate deltas, close ONCE.
      // Bug fix: previously every delta was wrapped in its own start/delta/stop,
      // which made the Anthropic SDK render each token on its own line.
      if (content) {

        if (textBlockIndex === -1) {
          textBlockIndex = contentIndex;
          yield {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            },
          };
        }
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: content },
          },
        };
      }

      // Tool calls: close the open text block first, then open the tool_use block
      // with a fresh index and accumulate its argument deltas on that index.
      if (toolCalls) {
        if (textBlockIndex !== -1) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: textBlockIndex },
          };
          contentIndex++;
          textBlockIndex = -1;
        }

        for (const tc of toolCalls) {
          const fn = tc.function || {};
          const idx = tc.index;
          if (!toolUseMap[idx]) {
            toolUseMap[idx] = {
              blockIndex: contentIndex,
              id: tc.id || uid("toolu"),
              name: fn.name || `tool_${(tc.id || "").slice(0, 8) || "unknown"}`,
              input: "",
            };
            yield {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: toolUseMap[idx].blockIndex,
                content_block: {
                  type: "tool_use",
                  id: toolUseMap[idx].id,
                  name: toolUseMap[idx].name,
                  input: {},
                },
              },
            };
            contentIndex++;
          }
          if (fn.arguments) {
            toolUseMap[idx].input += fn.arguments;
            yield {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: toolUseMap[idx].blockIndex,
                delta: { type: "input_json_delta", partial_json: fn.arguments },
              },
            };
          }
        }
      }

      // Close any still-open tool_use blocks when the upstream signals finish.
      if (finishReason) {
        for (const key of Object.keys(toolUseMap)) {
          const tc = toolUseMap[key];
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: tc.blockIndex },
          };
        }
        Object.keys(toolUseMap).forEach((k) => delete toolUseMap[k]);
      }
    }
  }

  if (textBlockIndex !== -1) {
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: textBlockIndex },
    };
  }

  // Map finish reason from the tracked last finish reason
  const stopReason = lastFinishReason ? mapFinishReason(lastFinishReason) : "end_turn";

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: streamUsage.input_tokens, output_tokens: streamUsage.output_tokens },
    },
  };

  yield {
    event: "message_stop",
    data: { type: "message_stop" },
  };
}

/**
 * Translate a complete upstream Chat Completion response to Anthropic Messages JSON format.
 */
export async function translateAnthropicJson(upstreamResponse, requestId, model = resolveDefaultModel()) {
  const data = await upstreamResponse.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  // Text content
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  // Tool calls -> tool_use blocks
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map finish reason
  const finishReason = choice?.finish_reason;
  const stopReason = mapFinishReason(finishReason);

  return {
    id: requestId,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
        }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

// --- Internal helpers ------------------------------

function translateModel(model, env) {
  if (!model) return resolveDefaultModel(env);
  // Map common Anthropic model names to our model
  const def = resolveDefaultModel(env);
  const modelMap = {
    "claude-sonnet-4-20250514": def,
    "claude-sonnet-4": def,
    "claude-3-5-sonnet-latest": def,
    "claude-3-haiku": def,
    "claude-3-opus": def,
  };
  return modelMap[model] || def;
}

function mapFinishReason(fr) {
  switch (fr) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

function mapAnthropicToolChoice(choice) {
  if (!choice) return "auto";
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required"; // forced tool use — upstream supports "required"
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return "auto";
}
