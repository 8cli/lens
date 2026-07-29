"""Tests for upstream rate limiter."""
import asyncio
import time
import pytest
from aperture.upstream_limiter import UpstreamRateLimiter


@pytest.mark.asyncio
async def test_disabled_when_rpm_zero():
    """rpm=0 → acquire() always returns True immediately."""
    limiter = UpstreamRateLimiter(0)
    for _ in range(100):
        assert await limiter.acquire() is True


@pytest.mark.asyncio
async def test_allows_burst():
    """Burst of RPM requests all succeed immediately."""
    limiter = UpstreamRateLimiter(rpm=40)
    start = time.monotonic()
    results = await asyncio.gather(*[limiter.acquire() for _ in range(40)])
    elapsed = time.monotonic() - start
    assert all(results)
    assert elapsed < 1.0, f"Burst took {elapsed:.2f}s, should be instant"


@pytest.mark.asyncio
async def test_queues_extra_request():
    """41st request waits for a token."""
    limiter = UpstreamRateLimiter(rpm=40)
    for _ in range(40):
        assert await limiter.acquire() is True

    # 41st: should wait briefly
    start = time.monotonic()
    result = await limiter.acquire()
    elapsed = time.monotonic() - start
    assert result is True
    assert elapsed >= 0.5, f"41st request should wait, got {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_queue_timeout():
    """Request that waits too long returns False."""
    limiter = UpstreamRateLimiter(rpm=40, max_queue=100, queue_timeout=0.5)
    for _ in range(40):
        assert await limiter.acquire() is True

    result = await limiter.acquire()
    assert result is False, "Should time out on empty bucket with short timeout"


@pytest.mark.asyncio
async def test_queue_full():
    """max_queue exceeded → returns False immediately."""
    limiter = UpstreamRateLimiter(rpm=40, max_queue=1, queue_timeout=30)
    for _ in range(40):
        assert await limiter.acquire() is True

    # First extra fills queue slot (max_queue=1)
    async def wait_and_acquire():
        return await limiter.acquire()

    acquire1 = asyncio.create_task(wait_and_acquire())
    await asyncio.sleep(0.01)
    # Second extra should hit max_queue
    assert await limiter.acquire() is False, "Should be rejected: queue full"
    acquire1.cancel()


@pytest.mark.asyncio
async def test_refills_over_time():
    """Tokens refill as time passes."""
    limiter = UpstreamRateLimiter(rpm=60)  # 1 token per second
    for _ in range(60):
        assert await limiter.acquire() is True

    # Wait 1 second for 1 token
    await asyncio.sleep(1.1)
    assert await limiter.acquire() is True, "Should have 1 token after 1s"


@pytest.mark.asyncio
async def test_burst_capped_at_rpm():
    """Burst never exceeds configured RPM (burst = rpm)."""
    limiter = UpstreamRateLimiter(rpm=40)
    for _ in range(40):
        assert await limiter.acquire() is True

    # Instant: should get 0 tokens immediately
    await asyncio.sleep(0.01)
    task = asyncio.create_task(limiter.acquire())
    done, _ = await asyncio.wait([task], timeout=0.1)
    assert task not in done, "Should not get a token instantly"
    task.cancel()


@pytest.mark.asyncio
async def test_steady_state_40_rpm():
    """Sustained 40 RPM over 2 minutes stays within rate."""
    limiter = UpstreamRateLimiter(rpm=40)
    total = 80
    interval = 60.0 / 40.0  # 1.5s between requests

    start = time.monotonic()
    for i in range(total):
        t0 = time.monotonic()
        assert await limiter.acquire() is True
        elapsed = time.monotonic() - t0
        # Each request should not take > 2x interval
        assert elapsed < interval * 2, f"Request {i} took {elapsed:.2f}s"
        # Sleep to simulate real-world pacing
        await asyncio.sleep(interval * 0.8)
    elapsed = time.monotonic() - start
    # 80 requests at 40 RPM should take at least ~60s
    assert elapsed >= 50, f"80 requests at 40 RPM took {elapsed:.2f}s, expected ~60s"