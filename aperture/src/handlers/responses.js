import { mapModelName } from "../config.js";
import { sendChatRequest } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { translateToChat, translateStreamEvents, translateResponseJson } from "../translators/responses.js";
import { uid, now, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

export async function handleResponsesAPI(body, env, signal) {
  const respId = uid("resp");

  // Translate to Chat Completions format
  const chatReq = translateToChat(body);
  // Map Codex provider names to actual model names
  chatReq.model = mapModelName(chatReq.model, env);

  // Send upstream
  let upstreamResponse;
  try {
    upstreamResponse = await sendChatRequest(env, chatReq, signal);
  } catch (err) {
    const log = createLogger("responses");
    log.error("upstream.network_error", { message: err.message, stack: err.stack });
    return new Response(
      JSON.stringify({
        id: respId, object: "response", created_at: now(), model: chatReq.model, output: [],
        error: { message: "Upstream request failed", type: "invalid_request_error", code: "upstream_error" },
      }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders() } }
    );
  }
  if (!upstreamResponse.ok) {
    const log = createLogger("responses");
    log.error("upstream.failed", { status: upstreamResponse.status });
    return new Response(
      JSON.stringify({
        id: respId,
        object: "response",
        created_at: now(),
        model: chatReq.model,
        output: [],
        error: { message: "Upstream request failed", type: "invalid_request_error", code: "invalid_request_error" },
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      }
    );
  }

  // Streaming
  if (chatReq.stream) {
    return pipeSSE(translateStreamEvents(upstreamResponse, respId, chatReq.model));
  }

  // Non-streaming
  const result = await translateResponseJson(upstreamResponse, respId, chatReq.model);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
