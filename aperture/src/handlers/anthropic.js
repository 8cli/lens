import { mapModelName } from "../config.js";
import { sendChatRequest } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { translateAnthropicToChat, translateAnthropicStream, translateAnthropicJson } from "../translators/anthropic.js";
import { uid, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

/**
 * Build standard response headers with request tracing IDs.
 * @param {Record<string, string>} [extra={}]
 * @returns {Record<string, string>}
 */
function anthropicHeaders(extra = {}) {
  const reqId = uid("req");
  return {
    "Content-Type": "application/json",
    "x-request-id": reqId,
    "request-id": reqId,
    ...extra,
    ...corsHeaders(),
  };
}

export async function handleAnthropicMessages(body, env, signal) {
  const requestId = uid("msg");

  // Translate Anthropic request -> Chat Completions
  const chatReq = translateAnthropicToChat(body, env);
  chatReq.model = mapModelName(chatReq.model, env);

  // Send upstream
  let upstreamResponse;
  try {
    upstreamResponse = await sendChatRequest(env, chatReq, signal);
  } catch (err) {
    const log = createLogger("anthropic");
    log.error("upstream.network_error", { message: err.message, stack: err.stack });
    return new Response(
      JSON.stringify({
        id: requestId, type: "error",
        error: { type: "upstream_error", message: "Upstream request failed" },
      }),
      { status: 502, headers: anthropicHeaders() }
    );
  }
  if (!upstreamResponse.ok) {
    const log = createLogger("anthropic");
    log.error("upstream.failed", { status: upstreamResponse.status });
    return new Response(
      JSON.stringify({
        id: requestId,
        type: "error",
        error: { type: "invalid_request_error", message: "Upstream request failed" },
      }),
      {
        status: upstreamResponse.status,
        headers: anthropicHeaders(),
      }
    );
  }

  // Streaming
  if (chatReq.stream) {
    return pipeSSE(translateAnthropicStream(upstreamResponse, requestId, chatReq.model));
  }

  // Non-streaming
  const result = await translateAnthropicJson(upstreamResponse, requestId, chatReq.model);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
      ...corsHeaders(),
    },
  });
}
