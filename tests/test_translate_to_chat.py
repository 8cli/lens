"""Tests for Responses API -> Chat Completions translation."""

import json
import pytest
from unittest.mock import AsyncMock
from aiohttp import ClientResponse
from aperture.translators.responses import (
    translate_to_chat,
    translate_response_json,
)


class TestTranslateToChat:
    def test_basic_input_string(self):
        body = {
            "input": "Hello world",
            "model": "deepseek-v4-flash",
            "instructions": "Be helpful",
        }
        result = translate_to_chat(body)
        assert result["model"] == "deepseek-v4-flash"
        assert len(result["messages"]) == 2
        assert result["messages"][0]["role"] == "system"
        assert result["messages"][0]["content"] == "Be helpful"
        assert result["messages"][1]["role"] == "user"
        assert result["messages"][1]["content"] == "Hello world"

    def test_input_as_message_list(self):
        body = {
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
            ],
        }
        result = translate_to_chat(body)
        assert len(result["messages"]) == 1
        assert result["messages"][0]["content"] == "Hi"

    def test_max_output_tokens_mapped(self):
        body = {"input": "Hi", "max_output_tokens": 500}
        result = translate_to_chat(body)
        assert result["max_tokens"] == 500

    def test_tools_mapped(self):
        body = {
            "input": "Search",
            "tools": [{
                "name": "search",
                "description": "Search tool",
                "parameters": {"type": "object", "properties": {}},
            }],
            "tool_choice": "required",
        }
        result = translate_to_chat(body)
        assert len(result["tools"]) == 1
        assert result["tool_choice"] == "required"

    def test_instructions_empty_skipped(self):
        body = {"input": "Hi"}
        result = translate_to_chat(body)
        assert len(result["messages"]) == 1
        assert result["messages"][0]["role"] == "user"

    def test_string_input_no_instructions(self):
        body = {"input": "Hello"}
        result = translate_to_chat(body)
        assert result["messages"][0]["content"] == "Hello"

    def test_stream_default_false(self):
        body = {"input": "Hi"}
        result = translate_to_chat(body)
        assert result["stream"] is False


@pytest.mark.asyncio
async def test_translate_response_json_basic():
    """Non-streaming response translation."""
    mock_resp = AsyncMock(spec=ClientResponse)
    mock_resp.json = AsyncMock(return_value={
        "choices": [{
            "message": {"content": "Hello world", "tool_calls": []},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    })
    result = await translate_response_json(mock_resp, "resp_1", "model-x")
    assert result["object"] == "response"
    assert len(result["output"]) == 1
    assert result["output"][0]["content"][0]["text"] == "Hello world"
    assert result["usage"]["input_tokens"] == 10
    assert result["usage"]["output_tokens"] == 20
