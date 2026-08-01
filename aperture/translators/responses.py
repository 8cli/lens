"""OpenAI Responses API -> Chat Completions translation.

Mirrors JS src/translators/responses.js.
"""

import json
from typing import AsyncIterator

from aiohttp import ClientResponse

from ..helpers import uid, now, extract_text
from ..stream import stream_sse


def translate_to_chat(body: dict) -> dict:
    """Translate an OpenAI Responses API request to Chat Completions format.

    Args:
        body: Parsed JSON body of a Responses API request.

    Returns:
        Chat Completions request body (dict).
    """
    messages = []

    # Instructions -> system message (prepended first)
    instructions = body.get("instructions", "")
    if instructions:
        messages.append({"role": "system", "content": instructions})

    # Input -> user messages
    inp = body.get("input", "")
    if isinstance(inp, str):
        messages.append({"role": "user", "content": inp})

    elif isinstance(inp, list):
        for msg in inp:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "user":
                if isinstance(content, str):
                    messages.append({"role": "user", "content": content})
                elif isinstance(content, list):
                    texts = []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type", "")
                        if btype == "input_text":
                            texts.append(block.get("text", ""))
                        elif btype == "input_image":
                            img_url = block.get("image_url", {})
                            if isinstance(img_url, dict) and img_url.get("url"):
                                texts.append(f"[Image: {img_url['url']}]")
                    messages.append({"role": "user", "content": "".join(texts)})

            elif role == "assistant":
                if isinstance(content, str):
                    messages.append({"role": "assistant", "content": content})
                elif isinstance(content, list):
                    text_parts = []
                    tool_calls = []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type", "")
                        if btype == "output_text":
                            text_parts.append(block.get("text", ""))
                        elif btype == "function_call":
                            tool_calls.append({
                                "id": block.get("id", uid("call")),
                                "type": "function",
                                "function": {
                                    "name": block.get("name", ""),
                                    "arguments": json.dumps(block.get("arguments", {})),
                                },
                            })
                    msg_obj = {"role": "assistant", "content": "".join(text_parts) or None}
                    if tool_calls:
                        msg_obj["tool_calls"] = tool_calls
                    messages.append(msg_obj)

    # Build chat body
    chat = {
        "model": body.get("model", ""),
        "messages": messages,
        "stream": body.get("stream", False),
    }

    # Map parameters
    if "max_output_tokens" in body:
        chat["max_tokens"] = body["max_output_tokens"]
    if "temperature" in body:
        chat["temperature"] = body["temperature"]
    if "top_p" in body:
        chat["top_p"] = body["top_p"]
    if "stop" in body:
        chat["stop"] = body["stop"]

    # Map tools
    # Both Responses API and Chat Completions use:
    #   {"type":"function", "function":{"name":"...", "description":"...", "parameters":{...}}}
    # Also handle legacy flat format: {"name":"...", "description":"...", "parameters":{...}}
    if "tools" in body and body["tools"]:
        tools = []
        for t in body["tools"]:
            if not isinstance(t, dict):
                continue
            ttype = t.get("type", "")
            if ttype == "function" or (t.get("name") and not ttype) or not ttype:
                fn = t.get("function", t)
                tools.append({
                    "type": "function",
                    "function": {
                        "name": fn.get("name", ""),
                        "description": fn.get("description", ""),
                        "parameters": fn.get("parameters", fn.get("input_schema", {})),
                    },
                })
        if tools:
            chat["tools"] = tools
            chat["tool_choice"] = body.get("tool_choice", "auto")

    # Metadata
    metadata = body.get("metadata")
    if isinstance(metadata, dict) and "user_id" in metadata:
        chat["user"] = metadata["user_id"]

    return chat


async def translate_stream_events(
    response: ClientResponse,
    resp_id: str,
    model: str,
) -> AsyncIterator[dict]:
    """Translate upstream Chat Completions SSE to Responses API events.

    Yields {event, data} dicts for pipe_sse().
    """
    output_index = 0
    item_index = 0

    yield {
        "event": "response.output_item.added",
        "data": {
            "type": "response.output_item.added",
            "output_index": output_index,
            "item": {
                "id": f"{resp_id}/item_{item_index}",
                "type": "message",
                "role": "assistant",
                "status": "in_progress",
                "content": [],
            },
        },
    }

    content_index = 0
    accumulated_text = ""
    last_finish_reason = None
    tool_call_items: dict[int, dict] = {}

    async for chunk in stream_sse(response):
        for choice in chunk.get("choices", []):
            delta = choice.get("delta", {}) or {}
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                last_finish_reason = finish_reason

            content = delta.get("content", "")
            tool_calls = delta.get("tool_calls")

            # Text content
            if content:
                if not accumulated_text:
                    yield {
                        "event": "response.content_part.added",
                        "data": {
                            "type": "response.content_part.added",
                            "output_index": output_index,
                            "part": {
                                "type": "output_text",
                                "text": "",
                            },
                        },
                    }
                accumulated_text += content
                yield {
                    "event": "response.output_text.delta",
                    "data": {
                        "type": "response.output_text.delta",
                        "output_index": output_index,
                        "content_index": content_index,
                        "delta": content,
                    },
                }

            # Tool calls
            if tool_calls:
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    tc_id = tc.get("id", uid("call"))
                    idx = tc.get("index", 0)
                    if idx not in tool_call_items:
                        item_index += 1
                        tool_call_items[idx] = {
                            "item_id": f"{resp_id}/item_{item_index}",
                            "name": fn.get("name", ""),
                            "call_id": tc_id,
                            "arguments": "",
                        }
                        yield {
                            "event": "response.output_item.added",
                            "data": {
                                "type": "response.output_item.added",
                                "output_index": output_index + 1,
                                "item": {
                                    "id": tool_call_items[idx]["item_id"],
                                    "type": "function_call",
                                    "status": "in_progress",
                                    "name": tool_call_items[idx]["name"],
                                    "call_id": tool_call_items[idx]["call_id"],
                                    "arguments": "",
                                },
                            },
                        }

                    arg_delta = fn.get("arguments", "")
                    if arg_delta:
                        tool_call_items[idx]["arguments"] += arg_delta
                        yield {
                            "event": "response.function_call_arguments.delta",
                            "data": {
                                "type": "response.function_call_arguments.delta",
                                "output_index": output_index + 1,
                                "item_id": tool_call_items[idx]["item_id"],
                                "delta": arg_delta,
                            },
                        }

                    if finish_reason in ("tool_calls", "stop"):
                        yield {
                            "event": "response.function_call_arguments.done",
                            "data": {
                                "type": "response.function_call_arguments.done",
                                "item_id": tool_call_items[idx]["item_id"],
                                "name": tool_call_items[idx]["name"],
                                "arguments": tool_call_items[idx]["arguments"],
                            },
                        }

    # Finalize text output
    text_item_id = f"{resp_id}/item_0"
    output_items = []
    if accumulated_text:
        yield {
            "event": "response.output_text.done",
            "data": {
                "type": "response.output_text.done",
                "output_index": output_index,
                "content_index": content_index,
                "text": accumulated_text,
            },
        }
        yield {
            "event": "response.content_part.done",
            "data": {
                "type": "response.content_part.done",
                "output_index": output_index,
                "content_index": content_index,
                "part": {"type": "output_text", "text": accumulated_text},
            },
        }
        yield {
            "event": "response.output_item.done",
            "data": {
                "type": "response.output_item.done",
                "output_index": output_index,
                "item": {
                    "id": text_item_id,
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": accumulated_text}],
                },
            },
        }
        output_items.append({
            "id": text_item_id,
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": accumulated_text}],
        })

    # Finalize tool call items
    for idx in sorted(tool_call_items):
        item = tool_call_items[idx]
        yield {
            "event": "response.output_item.done",
            "data": {
                "type": "response.output_item.done",
                "output_index": output_index + 1,
                "item": {
                    "id": item["item_id"],
                    "type": "function_call",
                    "status": "completed",
                    "name": item["name"],
                    "call_id": item["call_id"],
                    "arguments": item["arguments"],
                },
            },
        }
        output_items.append({
            "id": item["item_id"],
            "type": "function_call",
            "status": "completed",
            "name": item["name"],
            "call_id": item["call_id"],
            "arguments": item["arguments"],
        })

    # Final response object (shared by response.completed and response.done)
    final_response = {
        "id": resp_id,
        "object": "response",
        "created_at": now(),
        "status": "completed",
        "model": model,
        "output": output_items,
    }

    yield {
        "event": "response.completed",
        "data": {
            "type": "response.completed",
            "response": final_response,
        },
    }

    yield {
        "event": "response.done",
        "data": {
            "type": "response.done",
            "response": final_response,
        },
    }


async def translate_response_json(
    response: ClientResponse,
    resp_id: str,
    model: str,
) -> dict:
    """Translate a complete Chat Completion response to Responses API JSON."""
    data = await response.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {})

    output = []

    # Text output
    content = message.get("content", "")
    if content:
        output.append({
            "id": f"{resp_id}/text",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [
                {"type": "output_text", "text": content},
            ],
        })

    # Tool call output
    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        output.append({
            "id": tc.get("id", uid("call")),
            "type": "function_call",
            "status": "completed",
            "name": fn.get("name", ""),
            "call_id": tc.get("id", uid("call")),
            "arguments": fn.get("arguments", "{}"),
        })

    usage = data.get("usage", {})
    return {
        "id": resp_id,
        "object": "response",
        "created_at": now(),
        "model": model,
        "status": "completed",
        "output": output,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
            "output_tokens": usage.get("completion_tokens", usage.get("output_tokens", 0)),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }
