# Aperture 🔭 — Claude 工作规则

> 本项目是部署在 Cloudflare Workers 上的 AI 协议翻译器。Claude 在协助开发、审查、修复时必须遵守以下规则。

---

## 1. 项目架构

```
客户端 ──→ Aperture Worker ──→ AI Gateway ──→ 上游 API (opencode.ai)
              │
              ├─ src/index.js              入口 (~64 行) — CORS → 限流 → 认证 → 路由
              ├─ src/config.js             配置与模型映射
              ├─ src/helpers.js            通用工具（底部依赖层）
              ├─ src/stream.js             SSE 流处理（streamSSE + pipeSSE）
              ├─ src/upstream.js           上游 API 客户端（AbortSignal 合并）
              ├─ src/middleware/
              │   ├─ auth.js               认证（Bearer + x-api-key）
              │   ├─ rate-limiter.js        滑动窗口限流
              │   └─ logger.js             结构化日志
              ├─ src/handlers/
              │   ├─ chat.js               Chat 透传 + filterChatStream
              │   ├─ responses.js           Responses API 编排
              │   └─ anthropic.js           Anthropic API 编排
              └─ src/translators/
                  ├─ responses.js           Responses ↔ Chat（纯函数）
                  ├─ anthropic.js           Anthropic ↔ Chat（纯函数）
                  └─ dsml.js                DeepSeek DSML 适配
```

**核心原则：** Worker 只做协议翻译，不做策略决策。限速、缓存、模型映射交给 AI Gateway。

---

## 2. 编码规范

### 2.1 运行时约束
- **零依赖**：不使用 npm 依赖，纯 ES Modules JavaScript
- **Cloudflare Workers 运行时**：使用 `fetch`、`crypto.getRandomValues`、`TextEncoder`、`AbortController`、`TransformStream`
- **无 Node.js API**：不使用 `fs`、`path`、`Buffer` 等 Node 专有 API

### 2.2 模块规范
- 所有源文件使用 `.js` 扩展名，ES Module `import`/`export`
- 分层单向依赖：`helpers → middleware/stream → upstream → translators → handlers → index`
- 每个文件 ≤150 行，单一职责
- Translators 是纯函数，不依赖 Request/Response/env
- Handlers 只做编排（翻译请求 → 调上游 → 翻译响应 → 返回）

### 2.3 命名约定
- 异步生成器用 `translate*Stream` 命名（如 `translateStreamEvents`）
- 纯翻译函数用 `translate*` 命名（如 `translateToChat`）
- 常量全大写下划线（如 `DEFAULT_MODEL`、`MIN_MAX_TOKENS`）

### 2.4 错误处理
- 所有 `JSON.parse` 必须包在 `try/catch` 中
- 流式管道的 `catch` 块**必须**记录结构化日志，禁止空 `catch { /* ignore */ }`
- 上游错误返回给客户端前**必须**脱敏——只返回通用错误消息，详细内容记录服务端日志

---

## 3. 安全规则

### 3.1 认证
- 认证在限流之后执行（防止暴力破解）
- `AI_GATEWAY_TOKEN` 缺失时返回 **401**（不要返回 500 泄露配置状态）
- 不要在前端日志中输出 token、API key、Authorization 头

### 3.2 上游错误脱敏
```javascript
// ❌ 禁止：把上游原始错误直接给客户端
return errorResponse(`Upstream: ${errBody}`, ...);

// ✅ 正确：通用消息给客户端，详细日志服务端记录
log.error("upstream.failed", { status, detail: errBody });
return errorResponse("Upstream request failed", "upstream_error", "UPSTREAM", status);
```

### 3.3 输入验证
- 解析 `env` 数值变量时用 `parseInt` + 回退验证，防 NaN：
  ```javascript
  const timeout = Math.max(1000, parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10) || 120000);
  ```
- 流式缓冲区必须设上限（如 2MB），防止内存耗尽

### 3.4 ReDoS 防护
- **禁止**在 Worker 中使用复杂正则处理不可信输入
- XML/DSML 解析用字符串索引（`indexOf`/`substring`）替代正则
- 正则必须有输入长度上限或匹配次数上限

---

## 4. 协议翻译正确性

### 4.1 通用规则
- 所有翻译后的响应中的 `model` 字段**必须**使用上游实际模型名，禁止硬编码 `deepseek-v4-flash`
- message/item ID 在生命周期内保持一致——`added` 和 `done` 使用同一个 ID
- 流式和非流式路径的字段过滤必须一致（如 `reasoning_content`）

### 4.2 Responses API
- `body.input` 可以是字符串或数组——字符串必须整体处理，不能按字符迭代
- `toolCallsMap` 是普通对象，清空用 `Object.keys(...).forEach(delete)`，不能用 `.length = 0`

### 4.3 Anthropic Messages
- assistant 消息中的 `tool_use` 块**必须**转换为 OpenAI `tool_calls`
- 用户消息中的图片块必须使用标准 OpenAI `content` 数组格式（`type: "image_url"`），禁止用非标准 `images` 字段
- `top_k` 不映射到 Chat Completions——OpenAI 规范没有该参数

### 4.4 SSE 格式
- SSE 事件必须严格遵循 `event: xxx\ndata: {...}\n\n`（两个换行）
- 流式管道错误时必须写入 `event: error` 事件再关闭流

---

## 5. 配置与部署

### 5.1 环境变量
- 数值变量（`RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW_MS`、`REQUEST_TIMEOUT_MS`）在 `wrangler.jsonc` 中以字符串形式定义，运行时解析
- `DEFAULT_MODEL` 是默认模型名，可通过 `env.DEFAULT_MODEL` 覆盖
- `USE_GATEWAY` 控制是否走 AI Gateway；`wrangler.jsonc` 中默认 `"false"`（直连模式）
  - 直连时无需设置 `AI_GATEWAY_URL`，避免配置残留导致误走 Gateway
  - 启用 Gateway：`wrangler secret put USE_GATEWAY true` + 设置 `AI_GATEWAY_URL` secret

### 5.2 限流器
- 限流器在 `fetch()` 内实例化（可读取 `env`），不能模块级硬编码
- `hits` Map 必须定期清理过期条目，防内存泄漏

### 5.3 部署检查清单
- [ ] `wrangler.jsonc` 中 `USE_GATEWAY` 已按需设置（`false`=直连，`true`=Gateway）
- [ ] `AI_GATEWAY_TOKEN` secret 已设置（必填）；`AI_GATEWAY_URL`（Gateway 模式必填）
- [ ] `npm test` 通过（所有测试存在且通过）
- [ ] 无硬编码模型名残留（搜索 `"deepseek-v4-flash"` 确认）

---

## 6. 测试要求

### 6.1 必须覆盖的测试场景
- `translateToChat`：字符串 input、数组 input、各种 item type
- `translateStreamEvents`：流式文本、工具调用、finish_reason 处理
- `translateAnthropicToChat`：文本消息、图片消息、tool_use、tool_result
- `translateAnthropicStream`：content_block_start/delta/stop 生命周期
- `filterChatStream`：reasoning_content 过滤、null content 转换
- `normalizeDsmlToolCalls`：DSML 检测、invoke 提取、参数解析

### 6.2 测试框架
- 使用 vitest（已声明为 devDependency）
- 15 个测试文件，356+ 测试，99%+ 行覆盖率，100% 函数覆盖率
- 包含真实 E2E 测试（`tests/e2e.test.js`，启动真实 HTTP 上游服务器）
- 纯翻译函数无需 mock 即可测试
- 提交前运行 `npm test` 确认全部通过

---

## 7. Claude 工作流

### 7.1 修改代码前
1. 读取相关源文件（不要假设已知）
2. 检查是否有 `CLAUDE.md` 规则冲突
3. 优先修复 Critical 级别问题

### 7.2 修改代码时
1. 每个修复单独 commit，消息格式：`fix(scope): 描述`
2. 修改后搜索硬编码值确认已清理
3. 流式相关修改后检查 SSE 格式正确性（`\n\n` 结尾）

### 7.3 修改代码后
1. 验证 `npm test` 通过（356+ 测试全部通过）
2. 运行 `grep -rn "deepseek-v4-flash" src/ --include='*.js'` 确认除 config.js 外无残留硬编码
3. 推送到 GitHub 前确认 git remote 正确

---

## 8. 禁止事项

- ❌ 在翻译响应中硬编码模型名
- ❌ 把上游错误原文直接返回给客户端
- ❌ 空 `catch` 块不记录日志
- ❌ 模块级硬编码限流参数
- ❌ 使用复杂正则处理不可信输入
- ❌ 生成两个不同的 request-id 用于同一请求
- ❌ 在 `toolCallsMap`（普通对象）上用 `.length = 0`
- ❌ 遗漏 `top_k` 到 Chat Completions 的映射（应该移除）

## 9. 长程任务规则

- **长程任务不停止**：对于审查、修复、重构等多步骤任务，在没有用户明确确认前不要停止工作
- 不要在完成中途停下来询问"是否需要继续"——除非遇到破坏性操作或真正的二选一决策
- 如果上下文即将超限，优先完成当前修复批次并提交，再继续下一批
- 每完成一个修复阶段，直接汇报进展并继续下一阶段，不等待用户响应

---

*最后更新：2026-07-25*
