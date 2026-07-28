/**
 * Create a structured JSON logger.
 *
 * @param {string} requestId - Unique request identifier for correlation
 * @returns {{ info: (event: string, data?: object) => void, warn: (event: string, data?: object) => void, error: (event: string, data?: object) => void }}
 */
export function createLogger(requestId = "unknown") {
  function emit(level, event, data = {}) {
    const entry = JSON.stringify({
      level,
      event,
      requestId,
      timestamp: Date.now(),
      ...data,
    });
    if (level === "error") {
      console.error(entry);
    } else {
      console.log(entry);
    }
  }

  return {
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data),
  };
}
