"""In-memory sliding window rate limiter.

Mirrors JS src/middleware/rate-limiter.js.

Limitation: process restart resets counters (same as JS Worker eviction).
"""

import time
import random
from collections.abc import Callable


def create_rate_limiter(window_ms: int, max_requests: int) -> Callable[[str], tuple[bool, float]]:
    """Create a rate limiter check function.

    Args:
        window_ms: Time window in milliseconds.
        max_requests: Max requests allowed within the window.

    Returns:
        A function(key) -> (allowed: bool, reset_at_ms: float).
    """
    hits: dict[str, dict] = {}

    def check(key: str) -> tuple[bool, float]:
        nonlocal hits
        now = time.time() * 1000

        # Probabilistic TTL pruning: 2% chance when size > 2 * max_requests
        if len(hits) > max_requests * 2 and random.random() < 0.02:
            hits = {
                k: v
                for k, v in hits.items()
                if now - v["window_start"] <= window_ms
            }

        record = hits.get(key)
        if not record or now - record["window_start"] > window_ms:
            hits[key] = {"window_start": now, "count": 1}
            return True, now + window_ms

        if record["count"] >= max_requests:
            return False, record["window_start"] + window_ms

        record["count"] += 1
        return True, record["window_start"] + window_ms

    return check
