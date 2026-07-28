"""Tests for Responses API stream event translation."""

import json
import pytest
from unittest.mock import AsyncMock
from aperture.translators.responses import translate_stream_events


class MockStreamContent:
    """Simulates response.content as an async byte iterator."""

    def __init__(self, chunks: list[bytes]):
        self._chunks = iter(chunks)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._chunks)
        except StopIteration:
            raise StopAsyncIteration


class MockStreamResponse:
    """Simulates a streaming response with content attribute."""

    def __init__(self, data: bytes):
        chunk_size = 15
        chunks = []
        for i in range(0, len(data), chunk_size):
            chunks.append(data[i:i + chunk_size])
        self.content = MockStreamContent(chunks)


@pytest.mark.asyncio
async def test_stream_event_format():
    """Each SSE event should have event + data keys."""
    data = json.dumps({
        "choices": [{"delta": {"content": "Hello"}, "index": 0, "finish_reason": None}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    })
    response = MockStreamResponse(f"data: {data}\n\n".encode())
    events = []
    async for event in translate_stream_events(response, "resp_1", "model-1"):
        events.append(event)
    assert len(events) > 0
    for ev in events:
        assert "event" in ev
        assert "data" in ev


@pytest.mark.asyncio
async def test_stream_with_text():
    """Stream with text content should emit content_part.added and delta."""
    text_chunk = json.dumps({
        "choices": [{"delta": {"content": "Hi"}, "index": 0, "finish_reason": None}],
    })
    done_chunk = json.dumps({
        "choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}],
    })
    data = f"data: {text_chunk}\n\ndata: {done_chunk}\n\n"
    response = MockStreamResponse(data.encode())
    events = []
    async for event in translate_stream_events(response, "resp_1", "model-1"):
        events.append(event)

    events_by_type = {e["event"]: e["data"] for e in events}
    assert "response.content_part.added" in events_by_type
    assert "response.output_text.delta" in events_by_type
    assert events_by_type["response.output_text.delta"]["delta"] == "Hi"
