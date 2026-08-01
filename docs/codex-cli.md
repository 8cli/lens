# Codex CLI 接入 Lens — 配置与调试记录

> 2026-08-01 · 本文档记录 Codex CLI（OpenAI 官方开源终端 Agent）通过 Lens 使用上游模型的完整接入过程、踩过的坑和修复方案，作为后续维护与排障的知识储备。

## 背景

Codex CLI 是 OpenAI 的命令行编程 Agent。其 API 协议为 **OpenAI Responses API**（新版已移除 `wire_api="chat"`），且行为与其他客户端（Claude Code、curl 直测）差异较大。Lens 作为协议翻译器需要完整支持其 Responses 语义才能正常使用工具调用。

## 配置方法

> 💡 **上下文窗口**：codex 内置注册表默认给 `gpt-5.6-sol` 272K 窗口（非 1M）。如需 1M，在 `config.toml` 顶层加 `model_context_window = 1000000`。完整机制与验证见 [codex-context-window.md](codex-context-window.md)。

### 1. 安装 Codex CLI（standalone 版）

```bash
# 安装后二进制在 ~/.codex/packages/standalone/current/bin/codex
# 通常会有 ~/.local/bin/codex 软链
codex --version   # 验证
```

### 2. 配置 `~/.codex/config.toml` 指向 Lens

```toml
model = "gpt-5.6-sol"              # 用 codex 认识的模型名，避免 metadata warning
model_provider = "lens"

[model_providers.lens]
name = "Lens"
base_url = "http://127.0.0.1:8080/v1"   # Lens 的 Responses 端点
wire_api = "responses"                  # 0.146 起必须为 responses，chat 已废弃
env_key = "LENS_API_KEY"
```

### 3. 设置 API Key

```bash
# 写入 ~/.codex/.env（推荐，chmod 600）
printf 'LENS_API_KEY=sk-xxx\n' > ~/.codex/.env

# 或写入 shell 配置文件
echo 'export LENS_API_KEY=sk-xxx' >> ~/.profile
```

### 4. 验证

```bash
export LENS_API_KEY=sk-xxx
codex exec --dangerously-bypass-approvals-and-sandbox "用 shell 运行 echo hello"
```

## 排查方法论（可复用）

调试 codex 这类复杂客户端时，以下方法非常有效：

1. **记录代理抓包** — 在 Lens 前加一层 HTTP 代理，完整记录请求/响应体，看清 codex 实际发送的格式（不要猜，要看真实的）
   ```python
   # 简易记录代理：收到 POST → 保存 body → 转发到 Lens → 保存响应
   ```
2. **逐项二分** — 隔离变量：只留 messages、只留 tools、单工具、简化参数，逐个发上游直测，定位触发 400 的字段
3. **上游直测对照** — 用 curl 直接打上游 API（跳过 Lens），区分"是 Lens 翻译错了"还是"上游拒绝了这个格式"
4. **对比双机行为** — 同配置下两台机器表现不同时（一台卡死、一台"成功"），"成功"那台可能是模型编造答案（幻觉）——用文件实际落盘验证

## 踩过的坑（按发现顺序）

### 1. `response.completed` 事件缺失

**症状**：codex 报 `stream disconnected before completion: stream closed before response.completed`

**根因**：Lens 的 Responses 流式翻译只发 `response.done`，而官方序列要求：

```
output_text.done → content_part.done → output_item.done → response.completed → response.done
```

codex 客户端等待 `response.completed`，缺失即判定流中断。

**修复**：补全完整事件序列，`response.completed` 与 `response.done` 共享同一最终 response 对象。

### 2. `response.function_call_arguments.done` 缺失

**症状**：codex 工具调用被静默放弃，只回显代码块不执行。

**根因**：上游（Console Go）习惯把 `finish_reason="tool_calls"` 放在**单独的最后一块**（与 tool_calls delta 不同块）。原实现只在"同一块里既有 tool_calls 又有 finish_reason"时发 `arguments.done`，永远不触发。

**修复**：在流结束的 finalize 阶段，为所有未发过 `arguments.done` 的 tool_call 补发。

### 3. `input[].additional_tools` 工具定义被丢弃

**症状**：Lens 日志显示请求到了上游，但模型从不调用工具（因为没有工具定义）。

**根因**：codex 不在顶层 `tools` 字段传工具，而是放在 `input` 数组的 `additional_tools`（`role: developer`）项里。Lens 只处理 `body["tools"]`，additional_tools 被当作未知消息丢弃。

**修复**：从 `input[].additional_tools` 提取工具定义，合并到 Chat Completions 的 `tools`。

### 4. developer 消息 content 是列表，未扁平化

**症状**：上游返回 400 `Error from provider (Console Go): Upstream request failed`

**根因**：codex 的 developer 消息 content 是 `[{"type":"input_text","text":"..."}]` 块列表（codex 系统提示，约 24KB）。Lens 原样放进 chat system 消息 → 上游拒绝 list 类型 content。

**修复**：提取 `input_text` 块的 text 拼接为纯字符串。同时把 developer 角色映射为 system（部分兼容上游拒绝 developer 角色）。

### 5. 空 `parameters: {}` 被上游拒绝

**症状**：带某些工具（如 codex 的 `exec`、`collaboration`，parameters 为空）时上游 400；其他工具正常。

**根因**：Console Go 上游对 `parameters: {}`（空对象、缺 `type`）返回 400。codex 的部分工具 schema 本身就是空 `{}`。

**修复**：`_normalize_tool()` 统一处理——parameters 为空或缺失 `type` 时归一化为 `{"type":"object","properties":{}}`。

### 6. `function_call` / `function_call_output` 回传映射（最关键的坑）

**症状**：本机 codex 无限循环重试同一工具调用（lens 日志看到几十轮相同请求）；xhub 看似"成功"但结果是**模型编造的**（让运行 `date` 返回了精确的 `00:00:00`，实际从未执行）。

**根因**：codex 执行完工具后，把结果作为**顶层 input item** 回传：

```json
{"type": "function_call", "name": "exec_command", "arguments": "{\"cmd\": \"echo hello\"}", "call_id": "call_xxx"}
{"type": "function_call_output", "call_id": "call_xxx", "output": "hello\n"}
```

这两个类型**没有 role 字段**，落入 Lens 默认的 `role="user"` 分支 → content 为空 → 变成空 user 消息，工具结果被静默丢弃。上游永远看不到工具结果 → 只能重复请求同一工具调用（循环）或编造答案（幻觉）。

**修复**（`00a838d`）：
- `function_call` → assistant 消息 + `tool_calls`
- `function_call_output` → tool 消息（`tool_call_id` + content，dict 输出 JSON 编码）

### 7. 上游严格校验：连续 tool_calls 消息被拒（400 Upstream request failed）

**症状**：codex 多命令轮（一次让模型跑 2+ 个 shell 命令）间歇性报 `Upstream request failed`（HTTP 400）；单命令、简单对话正常。直连上游同样 400。

**根因**：opencode 网关在 2026-07-31（DeepSeek V4-Flash 0731 正式版 + 提供商路由变更）后，对 deepseek-v4-flash 的 chat/completions **严格校验消息序列**：
- 拒绝**连续多条 `assistant(tool_calls)` 消息**——codex 一次回合发 3 个 `function_call` item，lens 原实现翻译成 3 条连续 assistant 消息，正好踩中
- 拒绝**裸 `assistant(content: null, 无 tool_calls)` 消息**（lens 忽略 assistant 消息的 `input_text` 块导致）
- 对 `tool_call_id` 格式敏感（`call_00_...` 通过、`call_x1` 被拒）

**修复**（commit `438dd91`）：`translate_to_chat` 把**连续 function_call items 合并为单条 assistant 消息携带全部 tool_calls**（OpenAI 标准格式），并把 function_call 附加到前置 assistant 文本消息上；assistant content 同时提取 `input_text`/`output_text` 块（防御裸 null）。仅影响连续 fc 场景，单 fc/交错模式行为不变。

**排查方法论**：codex 会话文件 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 记录完整对话与工具结果（payload 本身就是 item，无 `item` 包装），可**精确重放失败请求**做二分。

## 已知限制（非 Lens bug）

- **间歇性 `tool exec/apply_patch invoked with incompatible payload`** — codex 的 `exec`（JS 编排工具）schema 为空 `{}`，模型凭系统提示猜 payload 时偶尔生成不匹配的调用。codex 随后会用 shell 工具（exec_command）成功完成任务。**直连 OpenAI 官方 API 同样存在**，属 codex 模型行为。
- **codex 需要 `wire_api="responses"`** — 0.146 起已移除 chat 支持，Lens 的 Responses 翻译是必经之路。

## 相关提交

| Commit | 内容 |
|---|---|
| `19d321c` | response.completed + arguments.done 补全 |
| `3f7b459` | additional_tools 提取、developer 扁平化、parameters 归一化 |
| `00a838d` | function_call / function_call_output 回传映射 |

## 双机部署一致性

本机（cliserver）与 xhub（192.168.10.22）的 Lens 服务**配置完全一致**：

```
主上游: <内部上游地址（已脱敏）>   (deepseek-v4-flash)
备上游: <内部备上游地址（已脱敏）>  (deepseek-v4-flash)
```

两机 codex CLI 均已验证工具调用真实工作（文件创建/读取、shell 命令执行）。
