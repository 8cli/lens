import { mapModelName } from "../config.js";
import { sendChatRequest } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { normalizeDsmlToolCalls } from "../translators/dsml.js";
import { errorResponse, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

/**
 * Filter streaming SSE chunks to strip non-standard fields that some clients
 * (e.g. Trae IDE) cannot handle.
 *
 * DeepSeek models emit `reasoning_content` in streaming delta chunks.
 * Standard OpenAI Chat Completions clients may choke on this field.
 * This filter removes `reasoning_content` and skips chunks that only
 * contain reasoning (no actual content delta).
 */
export async function* filterChatStream(upstreamResponse) {
  const reader = upstreamResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB cap to prevent memory exhaustion
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) {
        console.warn("filterChatStream: discarding partial trailing SSE data", buffer.length);
      }
      break;
    }
    buffer += value;
    if (buffer.length > MAX_BUFFER) {
      throw new Error("SSE buffer exceeded maximum size");
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      // Pass through non-data lines (e.g. empty line separators, event: lines)
      if (!trimmed.startsWith("data: ")) {
        yield line;
        continue;
      }
      const payload = trimmed.slice(6).trim();
      // Pass through [DONE] signal unchanged
      if (payload === "[DONE]") {
        yield line;
        continue;
      }
      // Try to parse and filter reasoning_content
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        yield line; // malformed JSON -- pass through
        continue;
      }
      if (!parsed.choices || !Array.isArray(parsed.choices)) {
        yield line; // no choices -- pass through
        continue;
      }
      let modified = false;
      let hadNullContent = false;
      for (const choice of parsed.choices) {
        if (!choice.delta) continue;
        // Strip reasoning_content (DeepSeek non-standard field)
        if (choice.delta.reasoning_content !== undefined) {
          delete choice.delta.reasoning_content;
          modified = true;
        }
        // Convert content: null -> "" (some clients expect string content)
        if (choice.delta.content === null) {
          choice.delta.content = "";
          modified = true;
          hadNullContent = true;
        }
      }
      if (!modified) {
        yield line; // nothing changed -- pass through
        continue;
      }
      // Keep meaningful chunks only -- skip empty deltas that only had reasoning.
      const hasContent = hadNullContent || parsed.choices.some(c => {
        if (c.finish_reason) return true;
        if (!c.delta) return false;
        const d = c.delta;
        return (typeof d.content === 'string' && d.content.length > 0)
            || d.role !== undefined
            || d.tool_calls !== undefined;
      });
      if (hasContent) {
        yield `data: ${JSON.stringify(parsed)}`;
      }
      // If delta is empty after stripping reasoning_content, skip it
    }
  }
}

export async function handleChatCompletions(body, env, signal) {
  // Override model and passthrough
  body.model = mapModelName(body.model, env);

  let upstreamResponse;
  try {
    upstreamResponse = await sendChatRequest(env, body, signal);
  } catch (err) {
    const log = createLogger("chat");
    log.error("upstream.network_error", { message: err.message, stack: err.stack });
    return errorResponse("Upstream request failed", "upstream_error", "UPSTREAM", 502);
  }
  if (!upstreamResponse.ok) {
    const log = createLogger("chat");
    log.error("upstream.failed", { status: upstreamResponse.status });
    return errorResponse("Upstream request failed", "upstream_error", "UPSTREAM", upstreamResponse.status);
  }

  // Stream passthrough (filtering reasoning_content for Trae compat)
  if (body.stream) {
    return pipeSSE(filterChatStream(upstreamResponse), { rawLine: true });
  }

  // Non-streaming: try DSML normalization, fallback to raw pass-through
  // IMPORTANT: upstreamResponse.body can only be consumed once.
  // Read as text first so we can retry if JSON.parse fails.
  let responseText;
  try {
    responseText = await upstreamResponse.text();
    const responseBody = JSON.parse(responseText);
    // Strip non-standard reasoning_content for Trae compatibility
    for (const choice of responseBody.choices || []) {
      if (choice.message?.reasoning_content !== undefined) {
        delete choice.message.reasoning_content;
      }
    }
    const normalizedBody = normalizeDsmlToolCalls(responseBody);
    return new Response(JSON.stringify(normalizedBody), {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch {
    // If JSON parsing fails, return the raw text we already read
    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}
