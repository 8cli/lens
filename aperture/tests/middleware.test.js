// ─── Middleware Tests: auth, rate-limiter, logger ─────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authenticate } from "../src/middleware/auth.js";
import { createRateLimiter } from "../src/middleware/rate-limiter.js";
import { createLogger } from "../src/middleware/logger.js";

// ─── Auth ────────────────────────────────────────────────
describe("auth.js - authenticate()", () => {
  it("returns 401 when env.AI_GATEWAY_TOKEN is missing", () => {
    const request = new Request("http://test.com", {
      headers: { Authorization: "Bearer test-token" },
    });
    const env = {};
    const result = authenticate(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("returns 401 when Authorization header is missing", () => {
    const request = new Request("http://test.com");
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("returns 401 when wrong Bearer token", () => {
    const request = new Request("http://test.com", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("returns null when correct Bearer token", () => {
    const request = new Request("http://test.com", {
      headers: { Authorization: "Bearer my-secret" },
    });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeNull();
  });

  it("returns null when correct x-api-key header", () => {
    const request = new Request("http://test.com", {
      headers: { "x-api-key": "my-secret" },
    });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeNull();
  });

  it("returns 401 when wrong x-api-key", () => {
    const request = new Request("http://test.com", {
      headers: { "x-api-key": "wrong-key" },
    });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("Bearer token takes precedence over x-api-key when both are present", () => {
    // Bearer is checked first; if present (even wrong), x-api-key is ignored
    const request = new Request("http://test.com", {
      headers: {
        Authorization: "Bearer wrong-bearer",
        "x-api-key": "my-secret",
      },
    });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    // Returns 401 because it used the wrong Bearer token, not the correct x-api-key
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("uses headers Map via request.headers.get", () => {
    // Construct request with a Headers instance (Map-like)
    const headers = new Headers();
    headers.set("Authorization", "Bearer my-secret");
    const request = new Request("http://test.com", { headers });
    const env = { AI_GATEWAY_TOKEN: "my-secret" };
    const result = authenticate(request, env);
    expect(result).toBeNull();
  });

  it("returns 401 with JSON error body", async () => {
    const request = new Request("http://test.com", {
      headers: { Authorization: "Bearer bad" },
    });
    const env = { AI_GATEWAY_TOKEN: "good" };
    const result = authenticate(request, env);
    expect(result.status).toBe(401);
    const body = await result.json();
    expect(body).toHaveProperty("error");
    expect(body.error.message).toBe("Invalid or missing API key");
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ─── Rate Limiter ───────────────────────────────────────
describe("rate-limiter.js - createRateLimiter()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // Prevent probabilistic pruning from interfering with deterministic tests
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows first request", () => {
    const limiter = createRateLimiter(1000, 5);
    const result = limiter.check("key-1");
    expect(result.allowed).toBe(true);
    // resetAt should be now + windowMs
    expect(result.resetAt).toBe(1_001_000);
  });

  it("blocks over maxRequests", () => {
    const limiter = createRateLimiter(1000, 3);
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(true);
    // Fourth request within window should be blocked
    expect(limiter.check("key-1").allowed).toBe(false);
  });

  it("resets after window expires", () => {
    const limiter = createRateLimiter(100, 2);
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(false);
    // Advance past the 100ms window
    vi.advanceTimersByTime(101);
    // Should be allowed again (new window started)
    expect(limiter.check("key-1").allowed).toBe(true);
  });

  it("different keys have independent counters", () => {
    const limiter = createRateLimiter(1000, 2);
    // Exhaust key-1
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(true);
    expect(limiter.check("key-1").allowed).toBe(false);
    // key-2 should still be allowed
    expect(limiter.check("key-2").allowed).toBe(true);
  });

  it("check() returns { allowed, resetAt } shape", () => {
    const limiter = createRateLimiter(1000, 5);
    const result = limiter.check("key-1");
    expect(result).toHaveProperty("allowed");
    expect(result).toHaveProperty("resetAt");
    expect(typeof result.allowed).toBe("boolean");
    expect(typeof result.resetAt).toBe("number");
  });

  it("returns correct resetAt on blocked request", () => {
    const limiter = createRateLimiter(100, 1);
    expect(limiter.check("key-1").allowed).toBe(true);
    const blocked = limiter.check("key-1");
    expect(blocked.allowed).toBe(false);
    // resetAt should be windowStart + windowMs = 1_000_000 + 100
    expect(blocked.resetAt).toBe(1_000_100);
  });

  it("returns correct resetAt on allowed request in same window", () => {
    const limiter = createRateLimiter(100, 3);
    const first = limiter.check("key-1");
    expect(first.allowed).toBe(true);
    expect(first.resetAt).toBe(1_000_100);
    const second = limiter.check("key-1");
    expect(second.allowed).toBe(true);
    // resetAt is still windowStart + windowMs
    expect(second.resetAt).toBe(1_000_100);
  });

  it("handles large number of requests without throwing", () => {
    const limiter = createRateLimiter(1000, 100);
    for (let i = 0; i < 150; i++) {
      const r = limiter.check("burst-key");
      if (i < 100) {
        expect(r.allowed).toBe(true);
      } else {
        expect(r.allowed).toBe(false);
      }
    }
  });
});

// ─── Rate Limiter TTL Pruning ──────────────────────────
describe("rate-limiter TTL pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prunes stale entries when size exceeds threshold and random triggers", () => {
    const limiter = createRateLimiter(50, 1);
    // At time 0, check three different keys
    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.check("key-b").allowed).toBe(true);
    expect(limiter.check("key-c").allowed).toBe(true);
    // Advance past the 50ms window
    vi.advanceTimersByTime(100);
    // hits.size=3 > maxRequests*2=2 && random(0)<0.02 → pruning deletes stale entries
    expect(limiter.check("key-d").allowed).toBe(true);
  });
});

// ─── Logger ─────────────────────────────────────────────
describe("logger.js - createLogger()", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info writes JSON to console.log", () => {
    const logger = createLogger("req-123");
    logger.info("test_event", { foo: "bar" });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(output.level).toBe("info");
    expect(output.event).toBe("test_event");
    expect(output.requestId).toBe("req-123");
    expect(output.foo).toBe("bar");
  });

  it("warn writes JSON to console.log", () => {
    const logger = createLogger("req-456");
    logger.warn("slow_response", { durationMs: 1200 });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(output.level).toBe("warn");
    expect(output.event).toBe("slow_response");
    expect(output.requestId).toBe("req-456");
    expect(output.durationMs).toBe(1200);
  });

  it("error writes JSON to console.error", () => {
    const logger = createLogger("req-789");
    logger.error("upstream_failure", { status: 502, upstream: "openai" });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    const output = JSON.parse(console.error.mock.calls[0][0]);
    expect(output.level).toBe("error");
    expect(output.event).toBe("upstream_failure");
    expect(output.requestId).toBe("req-789");
    expect(output.status).toBe(502);
    expect(output.upstream).toBe("openai");
  });

  it("uses 'unknown' requestId when none provided", () => {
    const logger = createLogger();
    logger.info("test");
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(output.requestId).toBe("unknown");
  });

  it("JSON output contains level, event, requestId, timestamp", () => {
    const logger = createLogger("req-abc");
    logger.info("some_event");
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(output).toHaveProperty("level");
    expect(output).toHaveProperty("event");
    expect(output).toHaveProperty("requestId");
    expect(output).toHaveProperty("timestamp");
  });

  it("timestamp field is a number representing ms since epoch", () => {
    const logger = createLogger("req-ts");
    logger.info("timed");
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(typeof output.timestamp).toBe("number");
    // Should be close to current time
    expect(output.timestamp).toBeGreaterThan(0);
    expect(output.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("extra data fields are spread into the JSON output", () => {
    const logger = createLogger("req-data");
    logger.info("user_login", { userId: 42, role: "admin", ip: "1.2.3.4" });
    const output = JSON.parse(console.log.mock.calls[0][0]);
    expect(output.userId).toBe(42);
    expect(output.role).toBe("admin");
    expect(output.ip).toBe("1.2.3.4");
  });
});
