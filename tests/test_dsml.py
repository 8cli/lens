"""Tests for DSML tool call normalization."""

import json
from aperture.translators.dsml import normalize_dsml_tool_calls


class TestNormalizeDsmlToolCalls:
    def test_no_dsml_content_passthrough(self):
        body = {"choices": [{"message": {"content": "Hello world"}, "finish_reason": "stop"}]}
        result = normalize_dsml_tool_calls(body)
        assert result["choices"][0]["message"]["content"] == "Hello world"
        assert "tool_calls" not in result["choices"][0]["message"]

    def test_dsml_invoke_extracts_tool_call(self):
        dsml = '<invoke name="search"><parameter name="query">hello</parameter></invoke>'
        body = {"choices": [{"message": {"content": dsml}, "finish_reason": "stop"}]}
        result = normalize_dsml_tool_calls(body)
        msg = result["choices"][0]["message"]
        assert len(msg["tool_calls"]) == 1
        assert msg["tool_calls"][0]["function"]["name"] == "search"
        args = json.loads(msg["tool_calls"][0]["function"]["arguments"])
        assert args == {"query": "hello"}
        assert result["choices"][0]["finish_reason"] == "tool_calls"

    def test_dsml_multiple_invokes(self):
        dsml = (
            '<invoke name="search"><parameter name="q">hello</parameter></invoke>'
            '<invoke name="calc"><parameter name="expr">1+1</parameter></invoke>'
        )
        body = {"choices": [{"message": {"content": dsml}, "finish_reason": "stop"}]}
        result = normalize_dsml_tool_calls(body)
        assert len(result["choices"][0]["message"]["tool_calls"]) == 2

    def test_dsml_content_too_long_skipped(self):
        body = {
            "choices": [{
                "message": {"content": "<invoke name=\"x\">" + "a" * 200_000},
                "finish_reason": "stop",
            }]
        }
        result = normalize_dsml_tool_calls(body)
        assert "tool_calls" not in result["choices"][0]["message"]

    def test_dsml_with_prose_preserved(self):
        dsml = (
            'Let me search for that. '
            '<invoke name="search"><parameter name="q">weather</parameter></invoke>'
        )
        body = {"choices": [{"message": {"content": dsml}, "finish_reason": "stop"}]}
        result = normalize_dsml_tool_calls(body)
        msg = result["choices"][0]["message"]
        assert msg["content"] == "Let me search for that."
        assert len(msg["tool_calls"]) == 1

    def test_null_choices_handled(self):
        assert normalize_dsml_tool_calls(None) is None
        assert normalize_dsml_tool_calls({}) == {}
