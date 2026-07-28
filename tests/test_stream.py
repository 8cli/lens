"""Tests for the SSE stream module."""

import json
import pytest
from aperture.stream import stream_sse


class MockClientResponse:
    """Minimal mock for aiohttp.ClientResponse.content (async bytes stream)."""

    def __init__(self, data: bytes):
        self._data = data
        self._offset = 0

    @property
    def content(self):
        return self

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        chunk_size = 10
        while self._offset < len(self._data):
            end = min(self._offset + chunk_size, len(self._data))
            yield self._data[self._offset:end]
            self._offset = end


@pytest.mark.asyncio
async def test_stream_sse_parses_data_lines():
    """SSE data: lines should yield parsed JSON dicts."""
    data = b"data: {\"key\": \"value\"}\n\ndata: {\"n\": 2}\n\n"
    mock_resp = MockClientResponse(data)
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 2
    assert results[0] == {"key": "value"}
    assert results[1] == {"n": 2}


@pytest.mark.asyncio
async def test_stream_sse_skips_done():
    """[DONE] signal should be skipped."""
    data = b"data: [DONE]\n\n"
    mock_resp = MockClientResponse(data)
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 0


@pytest.mark.asyncio
async def test_stream_sse_skips_malformed_json():
    """Malformed JSON lines should be skipped, valid ones still yielded."""
    data = b"data: {invalid\n\ndata: {\"ok\": true}\n\n"
    mock_resp = MockClientResponse(data)
    results = []
    async for chunk in stream_sse(mock_resp):
        results.append(chunk)
    assert len(results) == 1
    assert results[0] == {"ok": True}
