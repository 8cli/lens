"""Token bucket rate limiter for upstream requests.

Ensures outbound requests stay within a configured RPM limit.
Requests that exceed the rate are queued and sent as tokens become available.
"""

import asyncio
import time


class UpstreamRateLimiter:
    """Token bucket limiter for outbound upstream requests.

    Ensures outbound requests stay within a configured RPM limit.
    Requests that exceed the rate are queued and sent as tokens become available.
    Never rejects or drops requests — always queues until a token is available.
    The client-side HTTP timeout (REQUEST_TIMEOUT_MS) is the upper bound.

    Args:
        rpm: Max requests per minute (0 = disabled).
    """

    def __init__(self, rpm: int):
        self.rpm = rpm
        self.rate = rpm / 60.0  # tokens per second
        self.burst = rpm
        self.tokens = float(rpm)  # start full
        self.last_refill = time.monotonic()
        self._lock = asyncio.Lock()
        self._waiting = 0

    async def acquire(self) -> None:
        """Acquire a token, waiting as long as necessary.

        Never returns False — always waits until a token is available.
        """
        if self.rpm <= 0:
            return

        async with self._lock:
            self._refill()
            if self.tokens >= 1:
                self.tokens -= 1
                return
            self._waiting += 1

        try:
            while True:
                async with self._lock:
                    self._refill()
                    if self.tokens >= 1:
                        self.tokens -= 1
                        self._waiting -= 1
                        return
                    wait = (1.0 - self.tokens) / self.rate

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