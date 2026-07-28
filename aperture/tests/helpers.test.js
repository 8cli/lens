import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  uid,
  now,
  extractText,
  errorResponse,
  corsHeaders,
  fetchUpstream,
} from "../src/helpers.js";

describe("helpers", () => {
  describe("uid", () => {
    it("generates unique values across multiple calls", () => {
      const a = uid();
      const b = uid();
      expect(a).not.toBe(b);
    });

    it("respects a prefix argument", () => {
      const id = uid("sess_");
      expect(id.startsWith("sess_")).toBe(true);
      // prefix + 24 hex chars (12 bytes = 24 hex digits)
      expect(id.length).toBe("sess_".length + 24);
    });

    it("defaults to empty prefix", () => {
      const id = uid();
      expect(id.startsWith("sess_")).toBe(false);
      expect(id.length).toBe(24);
    });
  });

  describe("now", () => {
    it("returns a number", () => {
      expect(typeof now()).toBe("number");
    });

    it("returns a unix timestamp close to the current time", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = now();
      const after = Math.floor(Date.now() / 1000);
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  describe("extractText", () => {
    it("returns the string as-is for string input", () => {
      expect(extractText("hello world")).toBe("hello world");
    });

    it("joins text blocks from an array of content blocks", () => {
      const content = [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ];
      expect(extractText(content)).toBe("Hello world");
    });

    it("strips thinking blocks", () => {
      const content = [
        { type: "thinking", text: "i should respond helpfully" },
        { type: "text", text: "Here is my answer" },
      ];
      expect(extractText(content)).toBe("Here is my answer");
    });

    it("strips redacted_thinking blocks", () => {
      const content = [
        { type: "redacted_thinking", text: "REDACTED" },
        { type: "text", text: "Answer" },
      ];
      expect(extractText(content)).toBe("Answer");
    });

    it("handles mixed content with text, thinking, and redacted_thinking", () => {
      const content = [
        { type: "thinking", text: "thinking..." },
        { type: "text", text: "Part1" },
        { type: "redacted_thinking", text: "REDACTED" },
        { type: "text", text: "Part2" },
      ];
      expect(extractText(content)).toBe("Part1Part2");
    });

    it("returns empty string for empty array", () => {
      expect(extractText([])).toBe("");
    });

    it("returns empty string for null input", () => {
      expect(extractText(null)).toBe("");
    });

    it("returns empty string for undefined input", () => {
      expect(extractText(undefined)).toBe("");
    });

    it("handles blocks with missing text property", () => {
      const content = [
        { type: "text" },
        { type: "text", text: "ok" },
      ];
      expect(extractText(content)).toBe("ok");
    });
  });

  describe("corsHeaders", () => {
    it("returns the expected CORS headers", () => {
      const headers = corsHeaders();
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers["Access-Control-Allow-Methods"]).toBe(
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      expect(headers["Access-Control-Allow-Headers"]).toBe(
        "Content-Type, Authorization, x-api-key",
      );
    });

    it("merges extra headers over the defaults", () => {
      const headers = corsHeaders({ "X-Custom": "value" });
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers["X-Custom"]).toBe("value");
    });

    it("allows overriding default CORS headers", () => {
      const headers = corsHeaders({ "Access-Control-Allow-Origin": "https://example.com" });
      expect(headers["Access-Control-Allow-Origin"]).toBe("https://example.com");
    });
  });

  describe("errorResponse", () => {
    it("returns a Response instance", () => {
      const res = errorResponse("msg", "type", "CODE", 400);
      expect(res).toBeInstanceOf(Response);
    });

    it("contains error JSON in the body", async () => {
      const res = errorResponse("Something broke", "server_error", "INTERNAL", 500);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          message: "Something broke",
          type: "server_error",
          code: "INTERNAL",
        },
      });
    });

    it("uses the provided status code", () => {
      const res = errorResponse("Not found", "not_found", "NOT_FOUND", 404);
      expect(res.status).toBe(404);
    });

    it("sets Content-Type to application/json", () => {
      const res = errorResponse("x", "y", "z", 400);
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    it("includes CORS headers", () => {
      const res = errorResponse("x", "y", "z", 400);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("fetchUpstream", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      // Default mock: successful fetch
      globalThis.fetch = async () => new Response("ok", { status: 200 });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns the response on a successful fetch", async () => {
      const res = await fetchUpstream("https://example.com", {}, 5000);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("ok");
    });

    it("passes through options to fetch", async () => {
      let capturedInit;
      globalThis.fetch = async (_url, init) => {
        capturedInit = init;
        return new Response("ok");
      };

      const opts = { method: "POST", body: "hello" };
      await fetchUpstream("https://example.com", opts, 5000);
      expect(capturedInit.method).toBe("POST");
      expect(capturedInit.body).toBe("hello");
    });

    it("returns a 504 Response on AbortError (timeout)", async () => {
      globalThis.fetch = async (_url, _init) => {
        throw Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        });
      };

      const res = await fetchUpstream("https://example.com", {}, 100);
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.error).toEqual({
        message: "Upstream request timed out",
        type: "timeout_error",
        code: "TIMEOUT",
      });
    });

    it("re-throws non-timeout errors", async () => {
      globalThis.fetch = async (_url, _init) => {
        throw new Error("Network failure");
      };

      await expect(fetchUpstream("https://example.com", {}, 100)).rejects.toThrow(
        "Network failure",
      );
    });
  });
});
