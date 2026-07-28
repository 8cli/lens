// ─── Workers Runtime Mock for Vitest ─────────────────────
// Provides minimal polyfills for Cloudflare Workers APIs
// so translation logic can be tested without the actual runtime.

if (typeof globalThis.crypto === "undefined") {
  const { webcrypto } = require("crypto");
  globalThis.crypto = webcrypto;
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = require("util").TextEncoder;
}

if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = require("util").TextDecoder;
}

if (typeof globalThis.TransformStream === "undefined") {
  // Minimal TransformStream mock for stream pipe tests
  globalThis.TransformStream = class TransformStream {
    constructor() {
      const { ReadableStream, WritableStream } = require("stream/web");
      this.readable = new ReadableStream();
      this.writable = new WritableStream();
    }
  };
}

if (typeof globalThis.ReadableStream === "undefined") {
  globalThis.ReadableStream = require("stream/web").ReadableStream;
}

if (typeof globalThis.WritableStream === "undefined") {
  globalThis.WritableStream = require("stream/web").WritableStream;
}

// AbortController is available in Node 15+; polyfill for older versions
if (typeof globalThis.AbortController === "undefined") {
  globalThis.AbortController = require("abort-controller");
}

// Response / Headers / Request are available in Node 18+ via undici
// If missing, try to import from undici or node-fetch
if (typeof globalThis.Response === "undefined") {
  try {
    const undici = require("undici");
    globalThis.Response = undici.Response;
    globalThis.Headers = undici.Headers;
    globalThis.Request = undici.Request;
  } catch {
    // If undici is not available, tests that need Response must be skipped
  }
}
