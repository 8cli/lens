# Lens 会浪费 Token 吗？（排查与实测结论，2026-08-01）

> 结论先行：**Lens 不会造成 token 浪费** —— 它是零开销透传，实测与直连上游消耗完全一致；客户端看到的 usage 是真实的，不存在隐藏计费或注入。

## 排查背景

用户疑问：Lens 作为协议翻译层（Anthropic/Responses → Chat Completions），会不会在转发过程中往请求里加东西，导致同样的对话比直连上游多花 token？

## 代码层面确认（三处关键点）

### 1. 请求体原样透传 — `aperture/upstream.py`

```python
resp = await client.post(url, json=chat_body, headers=headers, timeout=timeout)
```

`send_chat_request()` 拿到的 `chat_body` 是 handlers 翻译后的最终请求体，**直接原样 POST 给上游**，不追加、不修改内容（只按 stream 区分超时语义）。

### 2. Chat 路径纯 passthrough — `aperture/handlers/chat.py`

模块注释即定位：*"Chat Completions handler — passthrough with model override and stream filtering"*。对请求体只做两件事：

- 覆盖 `model` 为显示名（不泄露后端模型），**不改变消息内容**
- 流式响应过滤：删 `reasoning_content` 字段、空 content 归一化——这是**减少**转发字节，不是增加

### 3. 翻译层只做格式转换，且会主动省 token — `aperture/translators/`

- Anthropic → Chat / Responses → Chat：逐字段直译，无默认 system 注入、无系统提示拼接
- **孤儿 function_call 丢弃**（commit `eba83d4`）：预扫描 call_id 成对校验，无结果的 function_call / 无匹配的 function_call_output 双向丢弃——**反而省 token**（不把悬空 tool_calls 发给上游）
- 合并连续 function_call 为单条 assistant 多 tool_calls（commit `438dd91`）：OpenAI 标准格式，同样不增内容

## 实测验证：同请求，经 Lens vs 直连上游

最小请求：`{"messages":[{"role":"user","content":"Say OK"}],"max_tokens":16}`

| 路径 | prompt_tokens | completion_tokens | reasoning_tokens | total_tokens |
|---|---|---|---|---|
| **直连上游** | 85 | 16 | 16 | 101 |
| **经 Lens** | 85 | 16 | 16 | 101 |

**完全一致** → Lens 未注入任何内容。85 个 prompt tokens 中约 81 个是 **上游模型自带的默认 system 模板**（直连同样产生，非 Lens 所加）。

## Token 消耗的真实来源（都不是 Lens）

| 来源 | 说明 | 可控杠杆 |
|---|---|---|
| **客户端全量历史**（大头） | codex / Claude Code 每次请求携带全部对话历史，Lens 不裁剪 | codex `model_context_window`（当前按 1M/900K 管理；若上游实际窗口 < 900K 需调回 272K，否则上下文管理失真会撞上游 400） |
| **上游默认模板** | deepseek 官方 API 自带 ~81 token 默认 system，直连同样 | 无（模型/网关行为） |
| **推理 token** | v4-flash 每次先思考；`max_tokens=16` 时全被 reasoning 吃掉导致 content 为空 | 客户端调大 max_tokens |

## Usage 透传完整性

Lens 完整透传上游 usage（`prompt_tokens` / `completion_tokens` / `total_tokens`，含 `prompt_tokens_details`、`completion_tokens_details`、reasoning 相关字段），三种协议路径均实现（`upstream.py` 的 `extract_usage` / `translators/anthropic.py` / `translators/responses.py`）。客户端看到的消耗即上游真实计费。

## 结论

- **Lens 不会造成 token 浪费**：零注入、零开销、usage 真实透传，实测消耗与直连上游逐字节一致
- 如果感觉 token 消耗大，杠杆在**客户端上下文配置**（codex 1M 管理窗口待校准），不在 Lens
- 唯一需要注意的配置联动：codex 上下文窗口若超过上游实际支持会撞 400（见 [codex-context-window.md](codex-context-window.md)）
