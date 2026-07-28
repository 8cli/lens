// --- Pure Helper Utilities ------------------------------------------
// Bottom-layer module: must NOT import from config.js or any other local module.

/**
 * Generate a hex-encoded unique identifier using cryptographically random bytes.
 * @param {string} [prefix=""]
 * @returns {string}
 */
export function uid(prefix = "") {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}

/**
 * Current Unix timestamp in seconds.
 * @returns {number}
 */
export function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Extract plain text from a content value that may be a string or
 * an array of content blocks (Anthropic-style). Strips thinking and
 * redacted_thinking blocks.
 *
 * @param {string | Array<{ type: string; text?: string }> | undefined} content
 * @returns {string}
 */
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === "text") return block.text || "";
        // Strip thinking/redacted_thinking blocks
        if (block.type === "thinking" || block.type === "redacted_thinking") return "";
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * CORS headers suitable for API responses.
 * @param {Record<string, string>} [extra={}]
 * @returns {Record<string, string>}
 */
export function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    ...extra,
  };
}

/**
 * Create a JSON error Response with standard error envelope shape.
 * @param {string} message
 * @param {string} type
 * @param {string} code
 * @param {number} status
 * @returns {Response}
 */
export function errorResponse(message, type, code, status) {
  return new Response(
    JSON.stringify({ error: { message, type, code } }),
    {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    },
  );
}

/**
 * Fetch an upstream URL with a timeout. On timeout returns a 504 Response.
 * Non-timeout errors are re-thrown.
 *
 * @param {string | URL} url
 * @param {RequestInit} [options]
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchUpstream(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return new Response(
        JSON.stringify({
          error: { message: "Upstream request timed out", type: "timeout_error", code: "TIMEOUT" },
        }),
        { status: 504, headers: { "Content-Type": "application/json", ...corsHeaders() } },
      );
    }
    throw err;
  }
}
