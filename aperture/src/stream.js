import { corsHeaders } from "./helpers.js";

// --- Constants -----------------------------------------------------------

const MAX_SSE_BUFFER = 2 * 1024 * 1024; // 2 MB

// --- SSE Stream Parser ---------------------------------------------------

/**
 * Parse SSE "data: {...}" lines from a Response body.
 *
 * - 2 MB buffer cap — calls `reader.cancel()` and throws on overflow
 * - Skips non-data lines, `[DONE]` signals, and malformed JSON
 * - Yields each successfully parsed JSON object
 *
 * @param {Response} response  The fetch Response whose body is an SSE stream
 * @yields {object}
 */
export async function* streamSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let normalCompletion = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        normalCompletion = true;
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_SSE_BUFFER) {
        await reader.cancel();
        throw new Error("SSE buffer exceeded 2MB limit");
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the last (possibly partial) line in the buffer for the next chunk
      buffer = lines.pop() || "";

      for (const line of lines) {
        // Only interested in "data: …" lines
        if (!line.startsWith("data: ")) continue;

        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          yield JSON.parse(payload);
        } catch {
          // Skip lines with malformed JSON
        }
      }
    }

    // Process any remaining data that never had a trailing newline
    if (buffer.startsWith("data: ")) {
      const payload = buffer.slice(6).trim();
      if (payload !== "[DONE]") {
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    if (!normalCompletion) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
    }
  }
}

// --- SSE Pipe (generator → Response) ------------------------------------

/**
 * Pipe an async generator into an SSE Response.
 *
 * When `rawLine` is true each yielded value is written as-is followed by
 * `"\n"` — useful for generators that already emit properly formatted SSE
 * lines (e.g. `filterChatStream`).
 *
 * Otherwise the generator is expected to yield `{ event, data }` objects;
 * these are formatted as:
 * ```
 * event: <event>\n
 * data: <JSON>\n\n
 * ```
 *
 * On error an SSE `error` event is written before the stream is closed.
 *
 * @param {AsyncGenerator | AsyncIterable} generator
 * @param {{ rawLine?: boolean }} [options={}]
 * @returns {Response}
 */
export function pipeSSE(generator, options = {}) {
  const { rawLine = false } = options;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Single async writer loop — runs detached; the Response is returned
  // immediately so the caller can hand it back to the fetch event.
  (async () => {
    try {
      for await (const chunk of generator) {
        if (rawLine) {
          await writer.write(encoder.encode(chunk + "\n"));
        } else {
          const { event, data } = chunk;
          let sse = "";
          if (event) {
            sse += `event: ${event}\n`;
          }
          sse += `data: ${JSON.stringify(data)}\n\n`;
          await writer.write(encoder.encode(sse));
        }
      }
    } catch (err) {
      // On error: write an SSE error event, then close
      try {
        await writer.write(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: err.message || "Internal error" })}\n\n`,
          ),
        );
      } catch {
        // Ignore write errors during error handling
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Ignore close errors
      }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}
