"""
Lens 全协议实时测试脚本
   针对本地运行中的 Lens 服务，测试 Chat / Responses / Anthropic 三种协议的全特性。
   不依赖 pytest，直接使用 urllib 发送 HTTP 请求。
"""

import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://localhost:8080"
API_KEY = "sk-VriyOzWq63bNVBkiaFgBMGcsAGgjHQIac7nkDYIih14dq2JWTv1rI7UYnAwxp50H"

passed = 0
failed = 0
errors = []

def request(method, path, body=None, headers=None, raw_body=False, timeout=30):
    """Send HTTP request and return (status, data_or_text, headers)."""
    url = f"{BASE}{path}"
    hdrs = {}
    if body is not None and not raw_body:
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)

    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        resp_body = resp.read()
        content_type = resp.headers.get("Content-Type", "")
        if "text/event-stream" in content_type:
            return resp.status, resp_body.decode(), dict(resp.headers)
        try:
            return resp.status, json.loads(resp_body), dict(resp.headers)
        except json.JSONDecodeError:
            return resp.status, resp_body.decode(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        try:
            return e.code, json.loads(body_text), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, body_text, dict(e.headers)
    except Exception as e:
        return 0, str(e), {}

def check(test_name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {test_name}")
    else:
        failed += 1
        msg = f"  ❌ {test_name}: {detail}"
        print(msg)
        errors.append(msg)

def test_chat():
    print("\n" + "="*60)
    print("【Chat Completions 协议测试】")
    print("="*60)

    # 1. 基本非流式
    status, data, _ = request("POST", "/v1/chat/completions", {
        "model": "anything",
        "messages": [{"role": "user", "content": "Say exactly: pong"}],
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("非流式请求返回 200", status == 200, f"got {status}")
    if status == 200:
        check("响应包含 choices", "choices" in data)
        check("choices[0].message.content 非空",
              data.get("choices", [{}])[0].get("message", {}).get("content", "").strip() != "")
        check("响应包含 usage", "usage" in data)

    # 2. 模型固定验证
    status, data, _ = request("POST", "/v1/chat/completions", {
        "model": "gpt-4-ultra-super-max",
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("模型固定 — 不存在的模型名也正常工作", status == 200, f"got {status}")

    # 3. 流式
    status, text, headers = request("POST", "/v1/chat/completions", {
        "model": "test",
        "messages": [{"role": "user", "content": "Count to 3"}],
        "stream": True,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("流式请求返回 200", status == 200, f"got {status}")
    check("流式 Content-Type 是 text/event-stream",
          headers.get("Content-Type", "").startswith("text/event-stream"))
    check("流式包含多个 data: 行", text.count("data: ") > 1)
    check("流式以 [DONE] 结尾", "[DONE]" in text)

    # 4. 工具调用
    status, data, _ = request("POST", "/v1/chat/completions", {
        "model": "test",
        "messages": [{"role": "user", "content": "What's the weather in Paris?"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {
                    "type": "object",
                    "properties": {"location": {"type": "string"}},
                },
            },
        }],
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("工具调用返回 200", status == 200, f"got {status}")

    # 5. 非法 JSON
    status, data, _ = request("POST", "/v1/chat/completions",
        body=b"not valid json",
        headers={"Authorization": f"Bearer {API_KEY}",
                 "Content-Type": "application/json"},
        raw_body=True)
    check("非法 JSON 返回 400", status == 400, f"got {status}")

    # 6. 无 auth
    status, data, _ = request("POST", "/v1/chat/completions", {
        "messages": [{"role": "user", "content": "Hi"}]
    })
    check("无 auth 返回 401", status == 401, f"got {status}")

    # 7. 错误 auth
    status, data, _ = request("POST", "/v1/chat/completions", {
        "messages": [{"role": "user", "content": "Hi"}]
    }, headers={"Authorization": "Bearer WRONG_KEY"})
    check("错误 auth 返回 401", status == 401, f"got {status}")

def test_responses():
    print("\n" + "="*60)
    print("【Responses API 协议测试】")
    print("="*60)
    print("  (发送到 /v1/responses 路径，通过 body 中 input/instructions 路由)")

    # 1. 非流式 (instructions + input)
    # 使用 /v1/responses 路径 + body 含 input/instructions → 触发 responses 路由
    status, data, _ = request("POST", "/v1/responses", {
        "input": "Hello",
        "instructions": "Be concise",
        "model": "test",
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Responses 非流式返回 200", status == 200, f"got {status}")
    if status == 200:
        check("响应格式是 Responses API (id/object/output)",
              "id" in data and "object" in data and "output" in data)

    # 2. 流式
    status, text, headers = request("POST", "/v1/responses", {
        "input": "Say hello",
        "instructions": "One word",
        "model": "test",
        "stream": True,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Responses 流式返回 200", status == 200, f"got {status}")
    if isinstance(text, str):
        check("流式包含 SSE 事件", "event:" in text or "data:" in text, f"got {text[:200]}")

    # 3. 工具调用
    status, data, _ = request("POST", "/v1/responses", {
        "input": "What's the weather in Tokyo?",
        "instructions": "Use the weather tool",
        "model": "test",
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {
                    "type": "object",
                    "properties": {"location": {"type": "string"}},
                },
            },
        }],
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Responses 工具调用返回 200", status == 200, f"got {status}")

    # 4. 多轮 input
    status, data, _ = request("POST", "/v1/responses", {
        "input": [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello"},
            {"role": "user", "content": "What's up?"},
        ],
        "model": "test",
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Responses 多轮对话返回 200", status == 200, f"got {status}")

def test_anthropic():
    print("\n" + "="*60)
    print("【Anthropic Messages API 协议测试】")
    print("="*60)

    # 1. 基本非流式
    status, data, _ = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "Say exactly: pong"}],
        "max_tokens": 256,
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic 非流式返回 200", status == 200, f"got {status}")
    if status == 200:
        check("响应 type=message", data.get("type") == "message", f"got type={data.get('type')}")
        check("响应含 content 数组", isinstance(data.get("content"), list))
        if isinstance(data.get("content"), list) and data["content"]:
            check("content[0] 有 text", "text" in data["content"][0])
        check("响应有 model", "model" in data)
        check("响应有 usage", "usage" in data)

    # 2. 流式
    status, text, headers = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "Count to 3 slowly"}],
        "max_tokens": 256,
        "stream": True,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic 流式返回 200", status == 200, f"got {status}")
    check("流式 Content-Type 是 text/event-stream",
          headers.get("Content-Type", "").startswith("text/event-stream"),
          f"got {headers.get('Content-Type')}")
    check("流式包含 message_start 事件", "message_start" in text)
    check("流式包含 content_block_delta 事件", "content_block_delta" in text)
    check("流式以 message_stop 结尾", "message_stop" in text)

    # 3. System prompt
    status, data, _ = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "system": "You are a concise assistant. Reply with just 'OK'",
        "messages": [{"role": "user", "content": "Acknowledge"}],
        "max_tokens": 256,
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic system prompt 返回 200", status == 200, f"got {status}")

    # 4. 多轮对话
    status, data, _ = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "messages": [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "What is AI?"},
        ],
        "max_tokens": 512,
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic 多轮对话返回 200", status == 200, f"got {status}")

    # 5. 工具调用
    status, data, _ = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "What time is it now?"}],
        "tools": [{
            "name": "get_time",
            "description": "Get current time",
            "input_schema": {
                "type": "object",
                "properties": {"tz": {"type": "string"}},
            },
        }],
        "max_tokens": 256,
        "stream": False,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic 工具调用返回 200", status == 200, f"got {status}")

    # 6. stream 默认值测试（不传 stream 应默认 true）
    status, text, headers = request("POST", "/v1/messages", {
        "model": "claude-sonnet-4",
        "messages": [{"role": "user", "content": "Say exactly: STREAM_DEFAULT"}],
        "max_tokens": 256,
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("Anthropic 默认流式返回 SSE",
          headers.get("Content-Type", "").startswith("text/event-stream"),
          f"got Content-Type={headers.get('Content-Type')}")

def test_health_and_routes():
    print("\n" + "="*60)
    print("【健康检查和路由测试】")
    print("="*60)

    # 1. Health
    status, data, _ = request("GET", "/health")
    check("GET /health 返回 200", status == 200, f"got {status}")
    if status == 200:
        check("health 返回 status=ok", data.get("status") == "ok")
        check("health 返回 version", "version" in data)

    # 2. Readyz
    status, data, _ = request("GET", "/readyz")
    check("GET /readyz 返回 200", status == 200, f"got {status}")

    # 3. 模型列表
    status, data, _ = request("GET", "/v1/models")
    check("GET /v1/models 返回 200", status == 200, f"got {status}")
    if status == 200:
        check("模型列表含 data 数组", isinstance(data.get("data"), list))
        check("模型列表非空", len(data.get("data", [])) > 0)

    # 4. 路由检测 — body 中的 messages 字段应路由到 chat
    status, data, _ = request("POST", "/v1/some-unknown-path", {
        "messages": [{"role": "user", "content": "Hi"}],
    }, headers={"Authorization": f"Bearer {API_KEY}"})
    check("body 路由检测 (messages→chat) 返回 200", status == 200, f"got {status}")

    # 5. CORS 预检
    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        method="OPTIONS",
        headers={"Origin": "http://example.com", "Access-Control-Request-Method": "POST"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        check("OPTIONS 返回 200", resp.status == 200)
        check("CORS 头存在", resp.headers.get("Access-Control-Allow-Origin") == "*",
              f"got {resp.headers.get('Access-Control-Allow-Origin')}")
    except Exception as e:
        check(f"OPTIONS 请求失败: {e}", False)


if __name__ == "__main__":
    print("="*60)
    print("Lens 全协议实时测试")
    print(f"目标: {BASE}")
    print(f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)

    test_chat()
    test_responses()
    test_anthropic()
    test_health_and_routes()

    print("\n" + "="*60)
    print(f"测试完成: {passed} ✅ 通过, {failed} ❌ 失败, {passed + failed} 总数")
    print("="*60)

    if errors:
        print("\n问题列表:")
        for e in errors:
            print(f"  {e}")

    sys.exit(0 if failed == 0 else 1)
