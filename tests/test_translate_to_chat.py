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

    def test_tool_empty_parameters_normalized(self):
        """Empty parameters {} must be normalized to a valid JSON Schema —
        Console Go upstreams reject {} on tool parameters (400)."""
        body = {
            "input": [
                {"role": "user", "content": "Hi"},
            ],
            "tools": [{
                "name": "collab",
                "description": "Tools for sub-agents",
                "parameters": {},
            }],
        }
        result = translate_to_chat(body)
        assert result["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {}}

    def test_tool_parameters_without_type_normalized(self):
        """parameters missing the required 'type' key is also invalid."""
        body = {
            "input": [{"role": "user", "content": "Hi"}],
            "tools": [{
                "name": "weird",
                "description": "d",
                "parameters": {"properties": {"x": {"type": "string"}}},
            }],
        }
        result = translate_to_chat(body)
        assert result["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {}}

    def test_additional_tools_empty_parameters_normalized(self):
        body = {
            "input": [
                {
                    "type": "additional_tools",
                    "role": "developer",
                    "tools": [{"type": "custom", "name": "exec", "description": "exec", "input_schema": {}}],
                },
            ],
        }
        result = translate_to_chat(body)
        assert result["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {}}

    def test_additional_tools_extracted(self):
        """codex CLI sends tools inside input as additional_tools (role: developer).
        These must be extracted into chat tools, not dropped."""
        body = {
            "input": [
                {
                    "type": "additional_tools",
                    "role": "developer",
                    "tools": [{
                        "type": "custom",
                        "name": "exec",
                        "description": "Run a shell command",
                        "input_schema": {"type": "object", "properties": {}},
                    }],
                },
                {"role": "user", "content": "Run date"},
            ],
            "model": "gpt-5.6-sol",
        }
        result = translate_to_chat(body)
        assert len(result["tools"]) == 1
        assert result["tools"][0]["function"]["name"] == "exec"
        assert result["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {}}
        # additional_tools message itself must not become a chat message
        assert len(result["messages"]) == 1
        assert result["messages"][0]["role"] == "user"
        assert result["messages"][0]["content"] == "Run date"

    def test_developer_message_mapped_to_system(self):
        """developer role messages (codex system prompt) must map to system for
        compatible upstreams that reject unknown roles."""
        body = {
            "input": [
                {"role": "developer", "content": "You are Codex, an agent."},
                {"role": "user", "content": "Hi"},
            ],
        }
        result = translate_to_chat(body)
        assert len(result["messages"]) == 2
        assert result["messages"][0]["role"] == "system"
        assert result["messages"][0]["content"] == "You are Codex, an agent."
        assert result["messages"][1]["role"] == "user"

    def test_developer_message_content_blocks_flattened(self):
        """codex sends developer content as [{"type":"input_text","text":"..."}] blocks.
        They must be flattened to a plain string — upstreams reject list content
        on system messages."""
        body = {
            "input": [
                {
                    "role": "developer",
                    "content": [
                        {"type": "input_text", "text": "You are Codex, an agent."},
                        {"type": "input_text", "text": " Follow instructions."},
                    ],
                },
                {"role": "user", "content": "Hi"},
            ],
        }
        result = translate_to_chat(body)
        assert len(result["messages"]) == 2
        assert result["messages"][0]["role"] == "system"
        assert result["messages"][0]["content"] == "You are Codex, an agent. Follow instructions."
        assert isinstance(result["messages"][0]["content"], str)

    def test_function_call_item_mapped_to_assistant_tool_calls(self):
        """codex sends executed tool calls back as top-level function_call items
        (no role field). They must map to an assistant message with tool_calls —
        otherwise the tool result has no anchor."""
        body = {
            "input": [
                {"role": "user", "content": "Run echo hello"},
                {
                    "type": "function_call",
                    "id": "resp_x/item_1",
                    "name": "exec_command",
                    "arguments": '{"cmd": "echo hello"}',
                    "call_id": "call_123",
                },
                {
                    "type": "function_call_output",
                    "id": "fco_1",
                    "call_id": "call_123",
                    "output": "hello\n",
                },
            ],
        }
        result = translate_to_chat(body)
        assert len(result["messages"]) == 3
        # function_call -> assistant message with tool_calls
        assert result["messages"][1]["role"] == "assistant"
        assert result["messages"][1]["content"] is None
        tc = result["messages"][1]["tool_calls"][0]
        assert tc["id"] == "call_123"
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "exec_command"
        assert tc["function"]["arguments"] == '{"cmd": "echo hello"}'
        # function_call_output -> tool message
        assert result["messages"][2]["role"] == "tool"
        assert result["messages"][2]["tool_call_id"] == "call_123"
        assert result["messages"][2]["content"] == "hello\n"

    def test_consecutive_function_calls_merged_into_one_assistant_message(self):
        """Multiple consecutive function_call items must merge into a SINGLE
        assistant message carrying all tool_calls. Strict upstreams (DeepSeek
        official via opencode gateway, since the 0731 routing change) reject
        back-to-back assistant(tool_calls) messages (observed as HTTP 400
        'Upstream request failed' on codex multi-command rounds)."""
        body = {
            "input": [
                {"role": "user", "content": "Run three commands"},
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "ls"}',
                    "call_id": "call_1",
                },
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "pwd"}',
                    "call_id": "call_2",
                },
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "whoami"}',
                    "call_id": "call_3",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "a\n",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_2",
                    "output": "b\n",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_3",
                    "output": "c\n",
                },
            ],
        }
        result = translate_to_chat(body)
        # ONE assistant message with 3 tool_calls, then 3 tool messages
        assistants = [m for m in result["messages"] if m["role"] == "assistant"]
        assert len(assistants) == 1
        assert len(assistants[0]["tool_calls"]) == 3
        assert [tc["id"] for tc in assistants[0]["tool_calls"]] == [
            "call_1", "call_2", "call_3",
        ]
        tools = [m for m in result["messages"] if m["role"] == "tool"]
        assert len(tools) == 3
        assert tools[0]["tool_call_id"] == "call_1"

    def test_function_call_after_assistant_text_merges_tool_calls(self):
        """A function_call item directly after an assistant message (with text)
        must attach tool_calls to that message, not emit a second consecutive
        assistant message — strict upstreams reject consecutive assistants."""
        body = {
            "input": [
                {"role": "user", "content": "Check something"},
                {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Let me check"}],
                },
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "ls"}',
                    "call_id": "call_1",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "out\n",
                },
            ],
        }
        result = translate_to_chat(body)
        assistants = [m for m in result["messages"] if m["role"] == "assistant"]
        assert len(assistants) == 1
        assert assistants[0]["content"] == "Let me check"
        assert len(assistants[0]["tool_calls"]) == 1

    def test_orphan_function_calls_without_results_dropped(self):
        """function_call items with no matching function_call_output must be
        dropped. Codex failure loops accumulate calls that never produced a
        result; strict upstreams reject assistant tool_calls with no following
        tool message (HTTP 400 'Upstream request failed')."""
        body = {
            "input": [
                {"role": "user", "content": "Do something"},
                {
                    "type": "function_call",
                    "name": "exec",
                    "arguments": '{"cmd": "true"}',
                    "call_id": "call_orphan_1",
                },
                {
                    "type": "function_call",
                    "name": "exec",
                    "arguments": '{"cmd": "echo ok"}',
                    "call_id": "call_orphan_2",
                },
            ],
        }
        result = translate_to_chat(body)
        # No tool_calls, no tool messages — orphans fully dropped
        assert all("tool_calls" not in m for m in result["messages"])
        assert all(m["role"] != "tool" for m in result["messages"])
        assert len(result["messages"]) == 1  # only the user message

    def test_partial_orphan_function_calls_dropped_paired_kept(self):
        """Mixed case: 3 function_calls but only 2 results. The orphan call is
        dropped; the paired two are kept as one assistant + two tool messages."""
        body = {
            "input": [
                {"role": "user", "content": "Run commands"},
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "ls"}',
                    "call_id": "call_ok_1",
                },
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": '{"cmd": "pwd"}',
                    "call_id": "call_ok_2",
                },
                {
                    "type": "function_call",
                    "name": "exec",
                    "arguments": '{"cmd": "true"}',
                    "call_id": "call_orphan",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_ok_1",
                    "output": "a\n",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_ok_2",
                    "output": "b\n",
                },
            ],
        }
        result = translate_to_chat(body)
        assistants = [m for m in result["messages"] if m["role"] == "assistant"]
        tools = [m for m in result["messages"] if m["role"] == "tool"]
        assert len(assistants) == 1
        assert len(assistants[0]["tool_calls"]) == 2
        assert [tc["id"] for tc in assistants[0]["tool_calls"]] == [
            "call_ok_1", "call_ok_2",
        ]
        assert len(tools) == 2
        assert all("call_orphan" not in str(m) for m in result["messages"])

    def test_function_call_output_without_call_dropped(self):
        """A function_call_output with no matching function_call (reverse
        orphan) must be dropped — an unanchored tool message is rejected."""
        body = {
            "input": [
                {"role": "user", "content": "hi"},
                {
                    "type": "function_call_output",
                    "call_id": "call_ghost",
                    "output": "result\n",
                },
            ],
        }
        result = translate_to_chat(body)
        assert all(m["role"] != "tool" for m in result["messages"])
        assert len(result["messages"]) == 1

    def test_function_call_output_dict_output_json_encoded(self):
        """function_call_output.output may be a dict; it must be JSON-encoded
        into the tool message content string."""
        body = {
            "input": [
                {"role": "user", "content": "hi"},
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{}",
                    "call_id": "call_1",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": {"status": "ok", "data": [1, 2]},
                },
            ],
        }
        result = translate_to_chat(body)
        tool_msg = result["messages"][2]
        assert tool_msg["role"] == "tool"
        assert json.loads(tool_msg["content"]) == {"status": "ok", "data": [1, 2]}

    def test_additional_tools_merged_with_top_level_tools(self):
        body = {
            "input": [
                {
                    "type": "additional_tools",
                    "role": "developer",
                    "tools": [{"type": "custom", "name": "exec", "description": "exec tool"}],
                },
            ],
            "tools": [{"name": "top_level", "parameters": {}}],
        }
        result = translate_to_chat(body)
        names = {t["function"]["name"] for t in result["tools"]}
        assert names == {"exec", "top_level"}

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
