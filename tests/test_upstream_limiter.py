"""Tests for upstream rate limiter."""
import asyncio
import time
import pytest
from aperture.upstream_limiter import UpstreamRateLimiter


@pytest.mark.asyncio
async def test_disabled_when_rpm_zero():
    """rpm=0 → acquire() returns immediately."""
    limiter = UpstreamRateLimiter(0)
    for _ in range(100):
        await limiter.acquire()  # should not block


@pytest.mark.asyncio
async def test_allows_burst():
    """Burst of RPM requests all succeed immediately."""
    limiter = UpstreamRateLimiter(rpm=39)
    start = time.monotonic()
    await asyncio.gather(*[limiter.acquire() for _ in range(39)])
    elapsed = time.monotonic() - start
    assert elapsed < 1.0, f"Burst took {elapsed:.2f}s, should be instant"


@pytest.mark.asyncio
async def test_queues_extra_request():
    """40th request waits for a token."""
    limiter = UpstreamRateLimiter(rpm=39)
    for _ in range(39):
        await limiter.acquire()

    # 40th: should wait briefly
    start = time.monotonic()
    await limiter.acquire()
    elapsed = time.monotonic() - start
    assert elapsed >= 1.0, f"Extra request should wait, got {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_refills_over_time():
    """Tokens refill as time passes."""
    limiter = UpstreamRateLimiter(rpm=60)  # 1 token per second
    for _ in range(60):
        await limiter.acquire()

    # Wait 1 second for 1 token
    await asyncio.sleep(1.1)
    await limiter.acquire()  # Should have 1 token after 1s


@pytest.mark.asyncio
async def test_burst_capped_at_rpm():
    """After draining all tokens, next acquire blocks."""
    limiter = UpstreamRateLimiter(rpm=39)
    for _ in range(39):
        await limiter.acquire()

    # Next acquire should block (no tokens)
    await asyncio.sleep(0.01)
    task = asyncio.create_task(limiter.acquire())
    done, _ = await asyncio.wait([task], timeout=0.1)
    assert task not in done, "Should not get a token instantly"
    task.cancel()


@pytest.mark.asyncio
async def test_queues_indefinitely_not_429():
    """After burst, extra request queues until token available (never rejects)."""
    limiter = UpstreamRateLimiter(rpm=39)
    for _ in range(39):
        await limiter.acquire()

    # Should wait patiently, not return False
    task = asyncio.create_task(limiter.acquire())
    await asyncio.sleep(0.05)
    assert not task.done(), "Should still be waiting, not returning"
    task.cancel()