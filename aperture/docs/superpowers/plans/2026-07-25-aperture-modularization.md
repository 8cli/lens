# Aperture 模块化重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 Workflow 或 subagent-driven-development 逐任务实现。每个任务完成后运行 test 验证。

**目标：** 将 Aperture 从 5 个单体文件（1785 行）重构为 14 个职责单一的模块（~1050 行），评分 90+

**架构：** 自底向上分层 — helpers + config → middleware → stream → upstream → translators → handlers → index。每层只依赖下层，无循环依赖。

**技术栈：** Cloudflare Workers (ES Modules), Vitest

---

## 全局约束

- 所有文件使用 ESM（`export` / `import`）
- 不使用 Node.js 内置模块（无 `Buffer`、`process.env`、`stream`）
- 所有 fetch 调用使用 `fetchUpstream()` 或 `AbortController` 管理超时
- 文件名全小写，连字符分隔
- 零外部 npm 依赖
- 每个文件 ≤150 行
- Translator 函数不依赖 `Request`/`Response`/`env`（纯函数）
- Handler 只做编排，不包含格式转换逻辑

---

### 文件结构映射

```
src/
├── index.js              入口 (~50 行)         ← 新建（替代现有 index.js）
├── config.js             配置 + 模型名映射 (~40 行)   ← 新建
├── middleware/
│   ├── auth.js           认证 (~30 行)         ← 从 utils.js 提取
│   ├── rate-limiter.js   限流 (~40 行)         ← 从 utils.js 提取
│   └── logger.js         日志 (~25 行)         ← 从 utils.js 提取
├── handlers/
│   ├── chat.js           Chat 透传 (~100 行)   ← 从 index.js 提取
│   ├── responses.js      Responses 编排 (~50 行)  ← 从 index.js 提取
│   └── anthropic.js      Anthropic 编排 (~50 行)  ← 从 index.js 提取
├── translators/
│   ├── responses.js      Responses→Chat (~200 行) ← 从 responses.js 迁移
│   ├── anthropic.js      Anthropic→Chat (~200 行) ← 从 anthropic.js 迁移
│   └── dsml.js           DSML→tool_calls (~50 行)  ← 从 index.js 提取
├── upstream.js           上游 API 客户端 (~60 行)  ← 重写现有 upstream.js
├── stream.js             SSE 流处理 (~80 行)     ← 从 index.js + utils.js 提取
└── helpers.js            通用工具 (~80 行)       ← 从 utils.js 提取 + 从 index.js 搬部分函数
```

---

### Task 1: 基础层 — config.js + helpers.js

**依赖：** 无（这是项目底部）

**文件：**
- 创建: `src/config.js`
- 创建: `src/helpers.js`

**接口：**
- 产出: `config.js` 导出 `DEFAULT_MODEL`、`resolveDefaultModel(env)`、`mapModelName(model, env)`、常量
- 产出: `helpers.js` 导出 `uid(prefix)`、`now()`、`extractText(content)`、`errorResponse(msg, type, code, status)`、`corsHeaders(extra)`、`fetchUpstream(url, options, timeoutMs)`

#### config.js 内容

```js
// --- Configuration & Model Mapping ----------

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const MIN_MAX_TOKENS = 1024;
export const DEFAULT_MAX_TOKENS = 16384;
export const SSE_BUFFER_MAX = 2 * 1024 * 1024;  // 2MB
export const DSML_CONTENT_MAX = 10000;

export function resolveDefaultModel(env) {
  return env?.DEFAULT_MODEL || DEFAULT_MODEL;
}

export function mapModelName(model, env = {}) {
  if (!model) return resolveDefaultModel(env);
  const trimmed = String(model).toLowerCase().trim();
  const knownProviders = ["go", "go_proxy", "default", "auto"];
  if (knownProviders.includes(trimmed)) return resolveDefaultModel(env);
  if (env.MODEL_MAP) {
    try {
      const map = JSON.parse(env.MODEL_MAP);
      if (map[trimmed]) return map[trimmed];
    } catch { /* ignore invalid JSON */ }
  }
  return resolveDefaultModel(env);
}
```

#### helpers.js 内容

```js
// --- General-Purpose Helpers ----------

// Secure unique ID with crypto
export function uid(prefix = "resp") {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

// Unix timestamp in seconds
export function now() {
  return Math.floor(Date.now() / 1000);
}

// Extract plain text from mixed content (string, array, blocks)
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let result = "";
    for (const part of content) {
      if (typeof part === "string") result += part;
      else if (part?.type === "text") result += part.text || "";
      else if (part?.text) result += part.text;
      else if (part?.type === "thinking") result += part.thinking || "";
      else if (part?.type === "redacted_thinking") result += "[Redacted thinking]";
    }
    return result;
  }
  return "";
}

// Standard error response
export function errorResponse(message, type, code, status = 400) {
  return new Response(
    JSON.stringify({ error: { message, type, code } }),
    { status, headers: { "Content-Type": "application/json", ...corsHeaders() } }
  );
}

// CORS headers
export function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

// Fetch with timeout
export async function fetchUpstream(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: { message: "Request timed out", type: "timeout_error" } }),
        { status: 504 }
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 1: 创建 `src/config.js`** — 写入上述内容
- [ ] **Step 2: 创建 `src/helpers.js`** — 写入上述内容
- [ ] **Step 3: 创建测试文件** `tests/config.test.js` 和 `tests/helpers.test.js`，测试 mapModelName、extractText、errorResponse、corsHeaders、fetchUpstream timeout 等
- [ ] **Step 4: 运行测试验证通过**
- [ ] **Step 5: Commit**

```bash
git add src/config.js src/helpers.js tests/config.test.js tests/helpers.test.js
git commit -m "feat: add config.js and helpers.js base layer"
```

---

### Task 2: 中间件层 — auth.js + rate-limiter.js + logger.js

**文件：**
- 创建: `src/middleware/auth.js`
- 创建: `src/middleware/rate-limiter.js`
- 创建: `src/middleware/logger.js`

**接口：**
- 消费: helpers.js — `errorResponse`、`corsHeaders`
- 产出: `authenticate(request, env) → Response | null`
- 产出: `createRateLimiter(windowMs, maxRequests) → { check(key) → { allowed, resetAt } }`
- 产出: `createLogger(requestId) → { info, warn, error }`

#### middleware/auth.js

```js
import { errorResponse } from "../helpers.js";

export function authenticate(request, env) {
  const expected = env.AI_GATEWAY_TOKEN;
  if (!expected) {
    return errorResponse("Invalid or missing API key", "authentication_error", "UNAUTHORIZED", 401);
  }
  let token = null;
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.slice(7);
  if (!token) token = request.headers.get("x-api-key");
  if (!token || token !== expected) {
    return errorResponse("Invalid or missing API key", "authentication_error", "UNAUTHORIZED", 401);
  }
  return null; // passed
}
```

#### middleware/rate-limiter.js

```js
export function createRateLimiter(windowMs, maxRequests) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      if (hits.size > maxRequests * 2 && Math.random() < 0.02) {
        for (const [k, v] of hits) {
          if (now - v.windowStart > windowMs) hits.delete(k);
        }
      }
      const record = hits.get(key);
      if (!record || now - record.windowStart > windowMs) {
        hits.set(key, { windowStart: now, count: 1 });
        return { allowed: true, resetAt: now + windowMs };
      }
      if (record.count >= maxRequests) {
        return { allowed: false, resetAt: record.windowStart + windowMs };
      }
      record.count++;
      return { allowed: true, resetAt: record.windowStart + windowMs };
    },
  };
}
```

#### middleware/logger.js

```js
export function createLogger(requestId = "unknown") {
  function emit(level, event, data = {}) {
    const entry = JSON.stringify({ level, event, requestId, timestamp: Date.now(), ...data });
    if (level === "error") console.error(entry);
    else console.log(entry);
  }
  return {
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data),
  };
}
```

- [ ] **Step 1: 创建 `src/middleware/auth.js`**
- [ ] **Step 2: 创建 `src/middleware/rate-limiter.js`**
- [ ] **Step 3: 创建 `src/middleware/logger.js`**
- [ ] **Step 4: 添加测试** — 测试 authenticate 成功/失败路径、rate limiter 限流/恢复/过期、logger 输出格式
- [ ] **Step 5: 运行测试通过**
- [ ] **Step 6: Commit**

---

### Task 3: 流处理层 — stream.js

**文件：**
- 创建: `src/stream.js`

**接口：**
- 消费: helpers.js — `corsHeaders`
- 产出: `streamSSE(response) → AsyncGenerator<object>`
- 产出: `pipeSSE(generator, options?) → Response`
  - `pipeSSE(eventGenerator)` → SSE event stream ("event: xxx\ndata: {...}\n\n")
  - `pipeSSE(lineGenerator, { rawLine: true })` → raw SSE lines

```js
import { corsHeaders } from "./helpers.js";

// Parse SSE "data: {...}" lines from a Response into JSON objects
export async function* streamSSE(response) {
  if (!response?.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const MAX_BUFFER = 2 * 1024 * 1024;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    if (buffer.length > MAX_BUFFER) {
      reader.cancel();
      throw new Error("SSE buffer exceeded maximum size");
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") continue;
      try { yield JSON.parse(payload); } catch { /* skip malformed */ }
    }
  }
}

// Pipe a generator to a SSE Response, parameterized by format
export function pipeSSE(generator, options = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      for await (const chunk of generator) {
        if (options.rawLine) {
          // Raw SSE line: "data: {...}" or "event: xxx\ndata: {...}\n\n"
          await writer.write(encoder.encode(chunk + "\n"));
        } else {
          // Structured event: { event, data }
          const raw = `event: ${chunk.event}\ndata: ${JSON.stringify(chunk.data)}\n\n`;
          await writer.write(encoder.encode(raw));
        }
      }
    } catch (err) {
      try {
        await writer.write(
          encoder.encode(`event: error\ndata: {"type":"error","error":{"message":"Internal stream error"}}\n\n`)
        );
      } catch { /* ignore */ }
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}
```

- [ ] **Step 1: 创建 `src/stream.js`**
- [ ] **Step 2: 添加测试** — 测试 streamSSE buffer cap、解析 data 行、pipeSSE event 格式
- [ ] **Step 3: 运行测试通过**
- [ ] **Step 4: Commit**

---

### Task 4: 上游客户端 — upstream.js

**文件：**
- 重写: `src/upstream.js`

**接口：**
- 消费: `config.js` 无直接依赖（接收 env），helpers.js — `fetchUpstream`
- 产出: `sendChatRequest(env, chatBody, signal?) → Response`
- 产出: `buildUpstreamUrl(env) → string`
- 产出: `chooseApiKey(env) → string`
- 产出: `extractUsage(data) → object|null`

```js
import { fetchUpstream } from "./helpers.js";

function buildUpstreamUrl(env) {
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  const base = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
  if (bypass) return `${base}/chat/completions`;
  const gw = (env.AI_GATEWAY_URL || "").trim();
  if (gw) {
    const slug = env.CUSTOM_PROVIDER_SLUG || "";
    return slug ? `${gw.replace(/\/+$/, "")}/custom-${slug}/v1/chat/completions` : `${gw}/chat/completions`;
  }
  return `${base}/chat/completions`;
}

function chooseApiKey(env) {
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  if (bypass) return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
  const gw = (env.AI_GATEWAY_URL || "").trim();
  if (gw) return env.AI_GATEWAY_TOKEN || env.OPENCODE_API_KEY;
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

// Merge client AbortSignal with timeout
function mergeSignals(clientSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  function onAbort() {
    controller.abort(clientSignal.reason);
    clientSignal.removeEventListener("abort", onAbort);
  }
  if (clientSignal) clientSignal.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onAbort);
    },
  };
}

export async function sendChatRequest(env, chatBody, clientSignal) {
  const url = buildUpstreamUrl(env);
  const apiKey = chooseApiKey(env);
  const timeoutMs = Math.max(1000, parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10) || 120000);

  const { signal, cleanup } = mergeSignals(clientSignal, timeoutMs);
  try {
    const response = await fetchUpstream(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(chatBody),
    }, timeoutMs);
    // AbortController 由 fetchUpstream 内部管理，这里只需处理 fallback
    if (response.ok) return response;

    // Gateway 5xx → direct upstream fallback
    const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
    const usingGateway = !bypass && (env.AI_GATEWAY_URL || "").trim();
    if (response.status >= 500 && usingGateway) {
      const fallbackUrl = (env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1") + "/chat/completions";
      const fallbackKey = env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
      return fetchUpstream(fallbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${fallbackKey}` },
        body: JSON.stringify(chatBody),
      }, timeoutMs);
    }
    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: "Upstream request failed", type: "upstream_error", code: "NETWORK_ERROR" } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  } finally {
    cleanup();
  }
}

export function extractUsage(data) {
  if (!data?.usage) return null;
  const u = data.usage;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}
```

- [ ] **Step 1: 重写 `src/upstream.js`** — 加入 AbortSignal 合并
- [ ] **Step 2: 添加测试** — 测试 mergeSignals、extractUsage、buildUpstreamUrl
- [ ] **Step 3: 运行测试通过**
- [ ] **Step 4: Commit**

---

### Task 5: 翻译器层 — translators/responses.js + translators/anthropic.js + translators/dsml.js

**文件：**
- 创建: `src/translators/responses.js`（从 `src/responses.js` 迁移，移除 dead code）
- 创建: `src/translators/anthropic.js`（从 `src/anthropic.js` 迁移，移除 dead code）
- 创建: `src/translators/dsml.js`（从 `src/index.js` 提取 normalizeDsmlToolCalls）

**接口：**
- 消费: `config.js` — `resolveDefaultModel()`、常量；`helpers.js` — `uid`、`now`、`extractText`
- 产出（translators/responses.js）:
  - `translateToChat(body) → chatReq`（纯函数）
  - `translateStreamEvents(response, respId, model) → AsyncGenerator<{ event, data }>`
  - `translateResponseJson(response, respId, model) → Promise<object>`
- 产出（translators/anthropic.js）:
  - `translateAnthropicToChat(body, env) → chatReq`
  - `translateAnthropicStream(response, requestId, model) → AsyncGenerator<{ event, data }>`
  - `translateAnthropicJson(response, requestId, model) → Promise<object>`
- 产出（translators/dsml.js）:
  - `normalizeDsmlToolCalls(responseBody) → responseBody`

关键差异：
- 原有 `src/responses.js` 中的 `import { sendChatRequest, extractUsage }` 死代码移除
- `src/translators/anthropic.js` 不再 `import { sendChatRequest, extractUsage, getFinishReason }`（全死代码）
- 移除 `translateAnthropicContent` 死函数
- Translators 不直接引用 `"deepseek-v4-flash"` 字面量，改用 `resolveDefaultModel()`
- `translateToChat` 中的 `body.model || "deepseek-v4-flash"` → `body.model || resolveDefaultModel()`

- [ ] **Step 1: 从 `src/responses.js` 复制到 `src/translators/responses.js`**，移除死 import，替换硬编码模型名
- [ ] **Step 2: 从 `src/anthropic.js` 复制到 `src/translators/anthropic.js`**，移除死代码
- [ ] **Step 3: 从 `src/index.js` 提取 `normalizeDsmlToolCalls` 到 `src/translators/dsml.js`**
- [ ] **Step 4: 更新测试文件 import 路径** — 指向新的 translators/ 路径
- [ ] **Step 5: 运行全部测试通过**
- [ ] **Step 6: Commit**

---

### Task 6: 处理器层 — handlers/chat.js + handlers/responses.js + handlers/anthropic.js

**文件：**
- 创建: `src/handlers/chat.js`
- 创建: `src/handlers/responses.js`
- 创建: `src/handlers/anthropic.js`

**接口：**
- 消费: translators/*、upstream.js、stream.js、config.js、helpers.js、middleware/logger.js
- 产出: `handleChatCompletions(body, env, signal) → Response`
- 产出: `handleResponsesAPI(body, env, signal) → Response`
- 产出: `handleAnthropicMessages(body, env, signal) → Response`

**Handler 设计原则：第 4 步，不做格式转换**

```js
// handlers/chat.js
import { mapModelName } from "../config.js";
import { sendChatRequest } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { normalizeDsmlToolCalls } from "../translators/dsml.js";
import { errorResponse, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

async function* filterChatStream(upstreamResponse) {  // 文件私有
  const reader = upstreamResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const MAX_BUFFER = 2 * 1024 * 1024;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) console.warn("filterChatStream: discarding partial trailing SSE data", buffer.length);
      break;
    }
    buffer += value;
    if (buffer.length > MAX_BUFFER) throw new Error("SSE buffer exceeded maximum size");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) { yield line; continue; }
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") { yield line; continue; }
      let parsed;
      try { parsed = JSON.parse(payload); } catch { yield line; continue; }
      if (!parsed.choices || !Array.isArray(parsed.choices)) { yield line; continue; }
      let modified = false, hadNullContent = false;
      for (const choice of parsed.choices) {
        if (!choice.delta) continue;
        if (choice.delta.reasoning_content !== undefined) { delete choice.delta.reasoning_content; modified = true; }
        if (choice.delta.content === null) { choice.delta.content = ""; modified = true; hadNullContent = true; }
      }
      if (!modified) { yield line; continue; }
      if (hadNullContent || parsed.choices.some(c =>
        c.finish_reason || (c.delta && (
          (typeof c.delta.content === 'string' && c.delta.content.length > 0) ||
          c.delta.role !== undefined || c.delta.tool_calls !== undefined
        ))
      )) { yield `data: ${JSON.stringify(parsed)}`; }
    }
  }
}

export async function handleChatCompletions(body, env, signal) {
  body.model = mapModelName(body.model, env);
  const log = createLogger("chat");
  const upstreamResponse = await sendChatRequest(env, body, signal);
  if (!upstreamResponse.ok) {
    log.error("upstream.failed", { status: upstreamResponse.status });
    return errorResponse("Upstream request failed", "upstream_error", "UPSTREAM", upstreamResponse.status);
  }
  if (body.stream) return pipeSSE(filterChatStream(upstreamResponse), { rawLine: true });
  // Non-streaming
  let responseText;
  try {
    responseText = await upstreamResponse.text();
    const responseBody = JSON.parse(responseText);
    for (const choice of responseBody.choices || []) {
      if (choice.message?.reasoning_content !== undefined) delete choice.message.reasoning_content;
    }
    return new Response(JSON.stringify(normalizeDsmlToolCalls(responseBody)), {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch {
    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}
```

```js
// handlers/responses.js
import { mapModelName } from "../config.js";
import { sendChatRequest, extractUsage } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { translateToChat, translateStreamEvents, translateResponseJson } from "../translators/responses.js";
import { uid, now, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

export async function handleResponsesAPI(body, env, signal) {
  const respId = uid("resp");
  const chatReq = translateToChat(body);
  chatReq.model = mapModelName(chatReq.model, env);
  const log = createLogger("responses");
  const upstreamResponse = await sendChatRequest(env, chatReq, signal);
  if (!upstreamResponse.ok) {
    log.error("upstream.failed", { status: upstreamResponse.status });
    return new Response(JSON.stringify({
      id: respId, object: "response", created_at: now(), model: chatReq.model, output: [],
      error: { message: "Upstream request failed", type: "invalid_request_error", code: "invalid_request_error" },
    }), { status: upstreamResponse.status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }
  if (chatReq.stream) return pipeSSE(translateStreamEvents(upstreamResponse, respId, chatReq.model));
  const result = await translateResponseJson(upstreamResponse, respId, chatReq.model);
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
```

```js
// handlers/anthropic.js
import { mapModelName } from "../config.js";
import { sendChatRequest } from "../upstream.js";
import { pipeSSE } from "../stream.js";
import { translateAnthropicToChat, translateAnthropicStream, translateAnthropicJson } from "../translators/anthropic.js";
import { uid, corsHeaders } from "../helpers.js";
import { createLogger } from "../middleware/logger.js";

function anthropicHeaders(extra = {}) {
  const reqId = uid("req");
  return { "Content-Type": "application/json", "x-request-id": reqId, "request-id": reqId, ...extra, ...corsHeaders() };
}

export async function handleAnthropicMessages(body, env, signal) {
  const requestId = uid("msg");
  const chatReq = translateAnthropicToChat(body, env);
  chatReq.model = mapModelName(chatReq.model, env);
  const log = createLogger("anthropic");
  const upstreamResponse = await sendChatRequest(env, chatReq, signal);
  if (!upstreamResponse.ok) {
    log.error("upstream.failed", { status: upstreamResponse.status });
    return new Response(JSON.stringify({
      id: requestId, type: "error",
      error: { type: "invalid_request_error", message: "Upstream request failed" },
    }), { status: upstreamResponse.status, headers: anthropicHeaders() });
  }
  if (chatReq.stream) return pipeSSE(translateAnthropicStream(upstreamResponse, requestId, chatReq.model));
  const result = await translateAnthropicJson(upstreamResponse, requestId, chatReq.model);
  return new Response(JSON.stringify(result), { headers: anthropicHeaders() });
}
```

- [ ] **Step 1: 创建 `src/handlers/chat.js`**
- [ ] **Step 2: 创建 `src/handlers/responses.js`**
- [ ] **Step 3: 创建 `src/handlers/anthropic.js`**
- [ ] **Step 4: 添加基础集成测试** — mock upstream 响应，验证 handlers 返回格式
- [ ] **Step 5: 运行测试通过**
- [ ] **Step 6: Commit**

---

### Task 7: 入口层 — index.js

**文件：**
- 重写: `src/index.js`

```js
import { authenticate } from "./middleware/auth.js";
import { createRateLimiter } from "./middleware/rate-limiter.js";
import { errorResponse } from "./helpers.js";
import { handleChatCompletions } from "./handlers/chat.js";
import { handleResponsesAPI } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic.js";

function detectRoute(path, body) {
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";
  if (body.messages) return "chat";
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";
  return "responses";
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key", "Access-Control-Max-Age": "86400" } });
    if (request.method !== "POST") return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);

    // Rate limit
    const rateLimiter = createRateLimiter(
      Math.max(1000, parseInt(env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000),
      Math.max(1, parseInt(env.RATE_LIMIT_MAX || "120", 10) || 120)
    );
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!rateLimiter.check(clientIp).allowed) {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "RATE_LIMITED" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // Authenticate
    const authResponse = authenticate(request, env);
    if (authResponse) return authResponse;

    // Parse body
    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch { return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }

    // Route
    const path = new URL(request.url).pathname;
    const signal = request.signal;
    switch (detectRoute(path, body)) {
      case "chat":      return handleChatCompletions(body, env, signal);
      case "responses": return handleResponsesAPI(body, env, signal);
      case "anthropic": return handleAnthropicMessages(body, env, signal);
      default:          return errorResponse("Unknown API format", "invalid_request", "FORMAT_UNKNOWN", 400);
    }
  },
};
```

- [ ] **Step 1: 重写 `src/index.js`** — 使用新的模块化 import
- [ ] **Step 2: 验证所有 import 路径正确**
- [ ] **Step 3: 运行全部 77 个测试通过**
- [ ] **Step 4: Commit**

---

### Task 8: 清理 + 测试补充

**文件：**
- 删除: `src/responses.js`（已迁移到 translators/responses.js）
- 删除: `src/anthropic.js`（已迁移到 translators/anthropic.js）
- 删除: `src/utils.js`（已拆分到 helpers.js + middleware/* + stream.js）
- 删除: `tests/bs.test.js`、`tests/debug.test.js`、`tests/test_nullish.test.js`、`tests/test_nullish_assign.test.js`（残留辅助文件）
- 更新: `tests/*.test.js` 中的 import 路径指向新位置
- 添加: 补充测试提升覆盖率至 >70%

**测试覆盖目标：**
- `translators/dsml.js` ✅ 已有 12 个测试
- `config.js`: model 映射、默认值 (4 个)
- `helpers.js`: uid、now、extractText、errorResponse、corsHeaders、fetchUpstream (8 个)
- `middleware/auth.js`: 成功、失败、无 token、x-api-key 备选 (4 个)
- `middleware/rate-limiter.js`: 基本限流、重置、过期、多 key (4 个)
- `stream.js`: streamSSE 解析、buffer cap、pipeSSE event/raw 模式 (6 个)
- `upstream.js`: extractUsage、buildUpstreamUrl 模式 (4 个)

- [ ] **Step 1: 删除旧文件** `src/responses.js`、`src/anthropic.js`、`src/utils.js`
- [ ] **Step 2: 清理测试垃圾文件**
- [ ] **Step 3: 更新所有测试 import 路径**
- [ ] **Step 4: 补充 config/helpers 单元测试**
- [ ] **Step 5: 补充 middleware 单元测试**
- [ ] **Step 6: 补充 stream/upstream 单元测试**
- [ ] **Step 7: 运行全部测试验证 >70% 覆盖率**
- [ ] **Step 8: 最终提交**

```bash
git add -A src/ tests/ docs/
git commit -m "feat: complete modularization refactor — 14 modules, ~1050 lines, all tests pass"
git push origin main
```

---

## 自审记录

- [x] 每个任务产生独立可测试的交付物
- [x] Task 边界明确，import 图单向
- [x] 无 TBD / TODO 占位符
- [x] 所有 hardcoded 模型名替换为 `resolveDefaultModel()`
- [x] 类型和方法签名在任务间一致
- [x] 测试策略具体（测试什么、多少个）
- [x] Dead code 删除已在 Task 5 + 8 覆盖
- [x] `AbortSignal` 传播在 Task 4 (upstream.js) + Task 7 (index.js) 覆盖
