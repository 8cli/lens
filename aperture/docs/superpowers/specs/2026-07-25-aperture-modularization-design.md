# Aperture 模块化重构设计

> 目标评分：90+，将 Aperture 打造为结构科学、业务逻辑合理、代码简洁的经典 Cloudflare Workers 项目
> 日期：2026-07-25

---

## 1. 项目背景

Aperture 是部署在 Cloudflare Workers 上的 AI 协议翻译器，GitHub 上为数不多的 Workers 协议转换项目。当前状态：

- **3 条协议路径**：OpenAI Responses API → Chat / Anthropic Messages API → Chat / Chat Completions 透传
- **5 个源文件**，1785 行代码
- **核心翻译路径测试已覆盖**（77 个测试通过），但 ~45% 行覆盖率
- **代码质量问题**：函数过大（4 个函数 >150 行）、重复逻辑、硬编码常量散落、死代码

## 2. 技术约束

- **运行时**：Cloudflare Workers (ES Modules)，无 Node.js API
- **可用 API**：`fetch`、`Request`、`Response`、`TransformStream`、`ReadableStream`、`AbortController`、`crypto`
- **兼容性标志**：`nodejs_compat`
- **环境变量**：通过 `env` 绑定注入（无 `process.env`）
- **测试框架**：Vitest（`@cloudflare/vitest-pool-workers` 可选）

## 3. 架构概览

```
src/
├── index.js               入口 (~50 行)
├── config.js              配置 (~40 行)
├── middleware/
│   ├── auth.js            认证 (~30 行)
│   ├── rate-limiter.js    限流 (~40 行)
│   └── logger.js          结构化日志 (~25 行)
├── handlers/
│   ├── chat.js            Chat Completions 透传 (~100 行)
│   ├── responses.js       Responses API 编排 (~50 行)
│   └── anthropic.js       Anthropic API 编排 (~50 行)
├── translators/
│   ├── responses.js       Responses→Chat 转换 (~200 行)
│   ├── anthropic.js       Anthropic→Chat 转换 (~200 行)
│   └── dsml.js            DSML→标准 tool_calls 转换 (~50 行)
├── upstream.js            上游 API 调用 (~60 行)
├── stream.js              SSE 流处理 (~80 行)
└── helpers.js             通用工具函数 (~80 行)
```

**总计约 ~1050 行**（较当前 1785 行精简 ~40%）

## 4. 模块设计规格

### 4.1 `index.js` — 入口

**职责：** 请求入口，仅做编排

```
fetch(request, env) → {
  1. OPTIONS → CORS preflight
  2. POST 校验
  3. 限流（rate-limiter.check）
  4. 认证（authenticate）
  5. 解析 body
  6. 路由（detectRoute）
  7. dispatch → handler
}
```

**边界：** 不包含任何业务逻辑。所有分支逻辑委托给 middleware → handler。

### 4.2 `config.js` — 配置

**职责：** 所有配置常量和模型名映射

```js
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const MIN_MAX_TOKENS = 1024;
export const DEFAULT_MAX_TOKENS = 16384;
export const SSE_BUFFER_MAX = 2 * 1024 * 1024;  // 2MB
export const DSML_CONTENT_MAX = 10000;

export function mapModelName(model, env)  // 从 config.js 移入，不含 hardcoded fallback
export function resolveDefaultModel(env)
```

**边界：** 纯函数 + 常量，零依赖，完全可单元测试。

### 4.3 `middleware/auth.js` — 认证

**职责：** Bearer token 和 x-api-key 双模式认证

```js
export function authenticate(request, env) → Response | null
// null = 通过, Response = 401
```

**边界：** 不修改 `request`，不读取 body。

### 4.4 `middleware/rate-limiter.js` — 限流

**职责：** 滑动窗口限流器

```js
export function createRateLimiter(windowMs, maxRequests) → 
  { check(key): { allowed, resetAt } }
```

**边界：** 无状态（返回闭包），可单元测试。所有配置来自外部注入。

### 4.5 `middleware/logger.js` — 日志

**职责：** 结构化 JSON 日志

```js
export function createLogger(requestId) → { info, warn, error }
```

**边界：** 仅输出 `console.log/error`，不读写外部状态。

### 4.6 `handlers/chat.js` — Chat Completions 透传

**职责：** 处理 `/v1/chat/completions` 请求

```
handleChatCompletions(body, env) → Response {
  1. mapModelName(body.model, env)
  2. sendChatRequest(env, chatBody, signal)
  3. if (!ok) → return errorResponse
  4. if (stream) → pipeSSE(filterChatStream(upstreamResponse))
  5. else → JSON.parse → normalizeDsmlToolCalls → return
}
```

**私有实现：** `filterChatStream()` 不导出（此文件的内部实现细节）。

### 4.7 `handlers/responses.js` — Responses API

**职责：** 处理 POST /（Responses API 格式）

```
handleResponsesAPI(body, env) → Response {
  1. translateToChat(body) → chatReq
  2. mapModelName(chatReq.model, env)
  3. sendChatRequest(env, chatReq, signal)
  4. if (!ok) → return error response
  5. if (stream) → pipeSSE(translateStreamEvents(...))
  6. else → translateResponseJson(...) → return
}
```

**边界：** 不做格式转换，只控制流程。转换委托给 `translators/responses.js`。

### 4.8 `handlers/anthropic.js` — Anthropic API

**职责：** 处理 POST /v1/messages

```
handleAnthropicMessages(body, env) → Response {
  1. translateAnthropicToChat(body, env) → chatReq
  2. mapModelName(chatReq.model, env)
  3. sendChatRequest(env, chatReq, signal)
  4. if (!ok) → return error response
  5. if (stream) → pipeSSE(translateAnthropicStream(...))
  6. else → translateAnthropicJson(...) → return
}
```

**边界：** 同上。

### 4.9 `translators/responses.js` — Responses 格式转换

**职责：** OpenAI Responses API ↔ Chat Completions 格式互转

当前 3 个导出函数保留，但重构为纯函数/生成器：
- `translateToChat(body)` → chatReq (纯函数，无 env 依赖)
- `translateStreamEvents(upstreamResponse, respId, model)` → AsyncGenerator (只做 SSE 事件翻译)
- `translateResponseJson(upstreamResponse, respId, model)` → response (只做 JSON 翻译)

**关键改进：**
- `translateToChat` 内部 `body.model || resolveDefaultModel()` → 不再硬编码 `"deepseek-v4-flash"`
- `translateToChat` 暴露参数映射为独立函数 `mapChatParams(body)` → 可独立测试

### 4.10 `translators/anthropic.js` — Anthropic 格式转换

**职责：** Anthropic Messages API ↔ Chat Completions 格式互转

- `translateAnthropicToChat(body, env)` → chatReq
- `translateAnthropicStream(upstreamResponse, requestId, model)` → AsyncGenerator
- `translateAnthropicJson(upstreamResponse, requestId, model)` → response

**关键改进：**
- 内部辅助函数（`translateModel`, `mapFinishReason`, `mapAnthropicToolChoice`）改为文件私有
- 移除死亡的 `translateAnthropicContent`

### 4.11 `translators/dsml.js` — DSML 适配器

**职责：** DeepSeek 非标准 tool calling 格式检测和标准化

- `normalizeDsmlToolCalls(responseBody)` → 处理后的 responseBody

从 `index.js` 独立至此。零依赖（纯函数），已通过 12 个测试。

### 4.12 `upstream.js` — 上游 API 客户端

**职责：** 封装向上游发送 Chat Completions 请求的全部逻辑

- `sendChatRequest(env, chatBody, signal?)` → Response
- `buildUpstreamUrl(env)` → URL string
- `chooseApiKey(env)` → API key string
- `extractUsage(data)` → usage object

**关键改进：**
- 接收 `AbortSignal` 参数 → 合并客户端 signal 和超时 signal
- `sendChatRequest` 内 catch 网络错误 → 返回 502 Response（不移交给调用方）
- Gateway 5xx fallback 逻辑保持

### 4.13 `stream.js` — SSE 流处理

**职责：** 所有 SSE 流处理的统一入口

- `streamSSE(response)` → AsyncGenerator (从 upstream response 解析 data 行)
- `pipeSSE(generator, extraHeaders)` → Response (统一 TransformStream 管道)

**关键改进：**
- 当前 `pipeEventStream`(events) 和 `pipeChatStream`(lines) 合并为一个通用 `pipeSSE`。通过参数化的 `serializer` 区分数据格式：

```js
// 用法
pipeSSE(eventGenerator)                    // → "event: xxx\ndata: {...}\n\n"
pipeSSE(lineGenerator, { rawLine: true })  // → "data: {...}\n"
```

- `streamSSE` 保持 2MB buffer cap 保护

### 4.14 `helpers.js` — 通用工具

**职责：** 零依赖的纯工具函数

- `uid(prefix)` → string
- `now()` → number
- `extractText(content)` → string
- `errorResponse(message, type, code, status)` → Response
- `corsHeaders(extra)` → object
- `fetchUpstream(url, options, timeoutMs)` → Response

**边界：** 不含任何业务逻辑。

## 5. 数据流图

```
Client Request
     │
     ▼
  index.js (入口)
     │
     ├── OPTIONS → CORS (跳过所有)
     │
     └── POST
         │
         ├── middleware/rate-limiter.js ──── 429 ──→ Response
         │
         ├── middleware/auth.js ───────────── 401 ──→ Response
         │
         ├── parse body (JSON)
         │
         ├── detectRoute()
         │
         ├── handlers/chat.js ────────── translators/dsml.js
         │    ├── upstream.js                 stream.js
         │    └── stream.js (pipeSSE)
         │
         ├── handlers/responses.js ───── translators/responses.js
         │    ├── upstream.js                 stream.js
         │    └── stream.js (pipeSSE)
         │
         └── handlers/anthropic.js ───── translators/anthropic.js
              ├── upstream.js                 stream.js
              └── stream.js (pipeSSE)
```

## 6. 测试策略

| 层级 | 测试目标 | 工具 |
|---|---|---|
| **单元测试** | Translators (纯函数)、helpers、config、middleware | Vitest，纯 mock |
| **集成测试** | Handlers (mock upstream 返回) | Vitest + `@cloudflare/vitest-pool-workers` |
| **特性测试** | 完整请求→响应路径 | `wrangler dev` + curl 脚本 |

**目标覆盖率：** 行覆盖率 >70%，分支覆盖率 >80%

## 7. 非功能性目标

- **包体积**：当前无依赖，重构后也保持零外部依赖，bundle < 50KB
- **冷启动**：无顶层 `await`、无动态 `import()`，模块图线性加载
- **请求超时**：`sendChatRequest` 接收 `AbortSignal`，客户端断开时取消上游请求
- **错误处理**：网络错误 → 502，所有解析错误 → 结构化错误响应，流错误 → SSE error event
- **可观测性**：`createLogger` 统一 JSON 格式，`x-request-id` 贯穿链路

## 8. 实现顺序

实现按依赖关系自底向上进行，确保每一步都可以独立测试验证：

1. `config.js` + `helpers.js` — 零依赖基础层
2. `middleware/` — 仅依赖 helpers
3. `stream.js` — 仅依赖 helpers
4. `upstream.js` — 依赖 config + helpers
5. `translators/` — 仅依赖 config + helpers
6. `handlers/` — 依赖 translators + upstream + stream + config
7. `index.js` — 依赖所有以上模块
8. 补充测试，验证覆盖率目标

---

## 9. 自审记录

- [x] 无 TBD / 占位符
- [x] 模块责任边界不重叠
- [x] import 图单向（无循环依赖）
- [x] 设计约束与 CF Workers 运行时一致
- [x] 测试策略具体可行
- [x] 无遗漏的硬编码模型名
- [x] `AbortSignal` 传播已纳入 spec
- [x] 范围聚焦于重构优化，未引入新功能
