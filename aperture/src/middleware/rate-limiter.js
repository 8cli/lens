/**
 * Create an in-memory sliding-window rate limiter.
 *
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} maxRequests - Maximum requests allowed within the window
 * @returns {{ check: (key: string) => { allowed: boolean, resetAt: number } }}
 */
export function createRateLimiter(windowMs, maxRequests) {
  const hits = new Map();

  return {
    check(key) {
      const now = Date.now();

      // Probabilistic TTL pruning: 2% chance when size exceeds 2 * maxRequests
      if (hits.size > maxRequests * 2 && Math.random() < 0.02) {
        for (const [k, v] of hits) {
          if (now - v.windowStart > windowMs) {
            hits.delete(k);
          }
        }
      }

      const record = hits.get(key);
      if (!record || now - record.windowStart > windowMs) {
        hits.set(key, { windowStart: now, count: 1 });
        return { allowed: true, resetAt: now + windowMs };
      }

      if (record.count >= maxRequests) {
        return { allowed: false, resetAt: record.windowStart + windowMs };
      }

      record.count++;
      return { allowed: true, resetAt: record.windowStart + windowMs };
    },
  };
}
