// --- Upstream API Client ---------------------------------
// Routes through Cloudflare AI Gateway for caching + analytics.
// Falls back to direct upstream on Gateway failure.

import { fetchUpstream } from "./helpers.js";

/**
 * Whether to route through Cloudflare AI Gateway.
 *
 * Explicit env var (USE_GATEWAY) is the single source of truth — no implicit
 * detection from AI_GATEWAY_URL presence, avoiding silent mode changes from
 * residual secrets.
 *
 * Falls back to BYPASS_GATEWAY (inverted) for backward compatibility.
 */
function useGateway(env) {
  if (env.USE_GATEWAY === "true" || env.USE_GATEWAY === "1") return true;
  if (env.USE_GATEWAY === "false" || env.USE_GATEWAY === "0") return false;
  // Backward compat: BYPASS_GATEWAY=true → direct
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  if (bypass) return false;
  // Backward compat: old implicit AI_GATEWAY_URL detection
  return !!(env.AI_GATEWAY_URL || "").trim();
}

function buildUpstreamUrl(env) {
  if (useGateway(env)) {
    const gwUrl = (env.AI_GATEWAY_URL || "").trim();
    if (gwUrl) {
      const base = gwUrl.replace(/\/+$/, "");
      const slug = env.CUSTOM_PROVIDER_SLUG || "";
      return slug ? `${base}/custom-${slug}/v1/chat/completions` : `${base}/chat/completions`;
    }
  }
  // Direct route
  const baseUrl = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
  return `${baseUrl}/chat/completions`;
}

function chooseApiKey(env) {
  // Gateway mode: Gateway token first (Gateway stores upstream API key)
  if (useGateway(env)) {
    const gwUrl = (env.AI_GATEWAY_URL || "").trim();
    if (gwUrl) {
      return env.AI_GATEWAY_TOKEN || env.OPENCODE_API_KEY;
    }
  }
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

function mergeSignals(clientSignal, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort();
  if (clientSignal) {
    clientSignal.addEventListener("abort", onAbort);
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      if (clientSignal) {
        clientSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export async function sendChatRequest(env, chatBody, clientSignal) {
  const url = buildUpstreamUrl(env);
  const apiKey = chooseApiKey(env);
  const timeoutMs = Math.max(1000, parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10) || 120000);

  const { signal, cleanup } = mergeSignals(clientSignal, timeoutMs);

  try {
    const response = await fetchUpstream(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(chatBody),
        signal,
      },
      timeoutMs,
    );

    // Pass through successful responses
    if (response.ok) return response;

    // Gateway error (5xx) -> fallback directly to upstream
    const usingGateway = useGateway(env) && (env.AI_GATEWAY_URL || "").trim();

    if (response.status >= 500 && usingGateway) {
      const fallbackUrl = (env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1") + "/chat/completions";
      const fallbackKey = env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;

      return fetchUpstream(
        fallbackUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fallbackKey}`,
          },
          body: JSON.stringify(chatBody),
        },
        timeoutMs,
      );
    }

    // Non-retryable error — return as-is to the caller
    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: { message: "Upstream network error", type: "network_error", code: "NETWORK_ERROR" },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    cleanup();
  }
}

export function extractUsage(data) {
  if (!data?.usage) return null;
  const u = data.usage;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}
