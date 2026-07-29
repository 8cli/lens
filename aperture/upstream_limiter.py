"""Token bucket rate limiter for upstream requests.

Ensures outbound requests stay within a configured RPM limit.
Requests that exceed the rate are queued and sent as tokens become available.
"""

import asyncio
import time


class UpstreamRateLimiter:
    """Token bucket limiter for outbound upstream requests.

    Args:
        rpm: Max requests per minute (0 = disabled).
        max_queue: Max number of requests waiting for a token.
        queue_timeout: Max seconds a request waits in queue before 429.
    """

    def __init__(self, rpm: int, max_queue: int = 100, queue_timeout: float = 30.0):
        self.rpm = rpm
        self.rate = rpm / 60.0  # tokens per second
        self.burst = rpm
        self.max_queue = max_queue
        self.queue_timeout = queue_timeout
        self.tokens = float(rpm)  # start full
        self.last_refill = time.monotonic()
        self._lock = asyncio.Lock()
        self._waiting = 0

    async def acquire(self) -> bool:
        """Acquire a token, waiting if necessary.

        Returns True when a token is acquired.
        Returns False on timeout or queue full.
        """
        if self.rpm <= 0:
            return True  # disabled

        async with self._lock:
            self._refill()
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            if self._waiting >= self.max_queue:
                return False  # queue full
            self._waiting += 1

        try:
            while True:
                async with self._lock:
                    self._refill()
                    if self.tokens >= 1:
                        self.tokens -= 1
                        self._waiting -= 1
                        return True
                    wait = (1.0 - self.tokens) / self.rate

                if wait > self.queue_timeout:
                    async with self._lock:
                        self._waiting -= 1
                    return False

                await asyncio.sleep(min(wait * 0.5 + 0.01, 0.5))
        except Exception:
            async with self._lock:
                self._waiting -= 1
            raise

    def _refill(self):
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
        self.last_refill = now