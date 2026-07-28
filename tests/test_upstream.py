"""Tests for upstream client."""

import pytest
from aperture.upstream import extract_usage


class TestExtractUsage:
    def test_openai_format(self):
        data = {"usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
        result = extract_usage(data)
        assert result["input_tokens"] == 10
        assert result["output_tokens"] == 20
        assert result["total_tokens"] == 30

    def test_responses_format(self):
        data = {"usage": {"input_tokens": 10, "output_tokens": 20}}
        result = extract_usage(data)
        assert result["input_tokens"] == 10
        assert result["output_tokens"] == 20

    def test_none(self):
        assert extract_usage({}) is None
        assert extract_usage(None) is None
