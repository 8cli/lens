<p align="center">
  <img src="https://img.shields.io/badge/status-production%20ready-2ea44f?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/github/actions/workflow/status/YKaiXu/aperture/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/badge/coverage-98.8%25-2ea44f?style=flat-square" alt="Coverage" />
  <img src="https://img.shields.io/github/license/YKaiXu/aperture?style=flat-square" alt="License" />
</p>

# Aperture 🔭

**AI 协议翻译器** — 在 OpenAI Responses API、Anthropic Messages API 和 OpenAI Chat Completions 格式之间无缝翻译，部署在 Cloudflare Workers 上。

## 为什么需要 Aperture？

AI 模型的 API 格式正在碎片化，而 Chat Completions 是事实标准。Aperture 让你为任意格式编写的客户端，可以无缝调用任意上游。

| 客户端 SDK → | Aperture 翻译为 → | 上游收到的格式 |
|---|---|---|
| OpenAI Responses API (`POST /`) | ✅ Chat Completions | Chat Completions |
| Anthropic Messages API (`POST /v1/messages`) | ✅ Chat Completions | Chat Completions |
| OpenAI Chat Completions (`POST /v1/chat/completions`) | ✅ 透传 (过滤 reasoning_content) | Chat Completions |

## 架构

```
src/
├── index.js              入口 (64 行)          CORS → 限流 → 认证 → 路由
├── config.js             配置与模型映射         DEFAULT_MODEL、mapModelName
├── helpers.js            通用工具              uid、fetchUpstream、corsHeaders
├── stream.js             SSE 流处理            统一 pipeSSE (raw/event 双模式)
├── upstream.js           上游 API 客户端       AbortSignal 合并、Gateway 回退
├── middleware/
│   ├── auth.js           认证                  Bearer + x-api-key 双模式
│   ├── rate-limiter.js   限流                  滑动窗口 + TTL 修剪
│   └── logger.js         日志                  结构化 JSON
├── handlers/
│   ├── chat.js           Chat 透传 + filterChatStream
│   ├── responses.js      Responses API 编排
│   └── anthropic.js      Anthropic API 编排
└── translators/
    ├── responses.js      Responses ↔ Chat (纯函数)
    ├── anthropic.js      Anthropic ↔ Chat (纯函数)
    └── dsml.js           DeepSeek DSML → tool_calls
```

### 设计原则

- **分层单向依赖** — `helpers → middleware → stream → upstream → translators → handlers → index`
- **Translators 是纯函数** — 不依赖 Request/Response/env，直接单元测试
- **Handlers 只做编排** — 翻译请求 → 调上游 → 翻译响应 → 返回
- **零外部依赖** — 纯 Web API，bundle < 50KB

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) 22+
- [Cloudflare Workers](https://workers.cloudflare.com/) 账号
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 部署

```bash
# 安装
npm install

# 配置密钥
wrangler secret put AI_GATEWAY_TOKEN

# 部署
npm run deploy
```

### API 路由

```bash
# Chat Completions
curl https://g2o.blogger.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"你好！"}],"stream":true}'

# Anthropic Messages (Claude Code / CLI)
curl https://g2o.blogger.workers.dev/v1/messages \
  -H "x-api-key: $AI_GATEWAY_TOKEN" \
  -d '{"max_tokens":1024,"messages":[{"role":"user","content":"你好！"}]}'

# OpenAI Responses API
curl https://g2o.blogger.workers.dev/ \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"input":"你好！"}'
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `UPSTREAM_BASE_URL` | 上游 API 地址 | `https://opencode.ai/zen/go/v1` |
| `AI_GATEWAY_TOKEN` | API 认证令牌 | — |
| `OPENCODE_API_KEY` | 上游 API Key | — |
| `DEFAULT_MODEL` | 默认模型名 | `deepseek-v4-flash` |
| `MODEL_MAP` | 模型名映射 JSON | `{"dv4f":"deepseek-v4-flash"}` |
| `USE_GATEWAY` | 显式启用 AI Gateway 路由 | `false`（直连） |
| `AI_GATEWAY_URL` | Cloudflare AI Gateway 地址（secret 设置） | — |
| `BYPASS_GATEWAY` | (旧) 跳过 AI Gateway，由 USE_GATEWAY 替代 | `false` |
| `REQUEST_TIMEOUT_MS` | 超时毫秒数 | `120000` |
| `RATE_LIMIT_MAX` | 限流窗口最大请求数 | `120` |
| `RATE_LIMIT_WINDOW_MS` | 限流窗口 (ms) | `60000` |

## 协议转换特性

### Anthropic → Chat

| Anthropic | Chat Completions |
|---|---|
| `tool_result` blocks | → 转化为 user text |
| `tool_use` blocks | → `tool_calls` (保留 id/name/arguments) |
| `thinking` blocks | → 剥离或转为 `thinking` 配置 |
| `tool_choice.type: "any"` | → `tool_choice: "required"` |
| 流式 content_block_start/delta/stop | → 文本 + tool_call 分隔 |

### Responses API → Chat

| Responses | Chat Completions |
|---|---|
| `input` (string/array) | → `messages[]` |
| `function_call` items | → `assistant.tool_calls` |
| `reasoning` items | → 摘要嵌入 assistant content |
| `instructions` | → `system` message |
| `reasoning.effort` | → `reasoning_effort` (语义映射) |

### DSML 适配

DeepSeek 模型有时使用 XML 格式的 tool calling。Aperture 自动检测并转换为标准 JSON 格式，同时保留 XML 以外的文本内容。

## Cloudflare AI Gateway

Aperture 原生支持 AI Gateway。通过 `USE_GATEWAY=true` 启用（默认直连）：

```bash
wrangler secret put AI_GATEWAY_URL  # 设置 Gateway 地址（含 Account ID）
wrangler secret put USE_GATEWAY true  # 启用 Gateway 路由
```

Gateway 模式下，上游 5xx 会自动回退直连上游。

## 测试

```bash
npm test                    # 348+ 测试，98.8% 覆盖率
npx vitest run --coverage   # 覆盖率报告
```

| 层级 | 覆盖 | 方式 |
|---|---|---|
| 单元测试 | translators、config、helpers | 纯函数，零 mock |
| 中间件测试 | auth、rate-limiter、logger | 闭包 + spy |
| 流测试 | streamSSE、pipeSSE | Mock Response |
| Handler 测试 | 3 个 handler 编排逻辑 | Mock upstream |
| 集成测试 | 完整请求管线 | Mock handler |
| **E2E 测试** | **全链路：index.js → 真实 HTTP 上游** | **Node http 服务器** |

## 已知限制

### 内置搜索工具不可用

Aperture 是**协议翻译层**，不是 AI 服务提供商。以下依赖服务端基础设施的内置工具**无法工作**：

| 工具 | 协议 | 原因 |
|---|---|---|
| `web_search_20250305` | Anthropic Messages | 需要 Anthropic 服务器执行搜索 |
| `web_search_preview` | OpenAI Responses | 需要 OpenAI 服务器执行搜索 |
| `computer_use` | Anthropic Messages | 需要 Anthropic 服务器执行操作 |

**自定义工具（function calling）完全正常** ✅ — 包括工具定义、模型产出 tool_use、回传 tool_result 的完整链路。

### 需要搜索怎么办？

Aperture 只做协议翻译，不替客户端执行外部功能。搜索能力由客户端侧解决：

```
推荐方案：本地 MCP 搜索工具
Claude Code ──→ MCP 子进程（本机）──→ HTTP 请求搜索 API
```

配置示例（`~/.claude/settings.json`）：

```json
{
  "mcpServers": {
    "web-fetch": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-web-search"]
    }
  }
}
```

### 企业网络限制

如果你的机器部署在公司网络环境下，WebFetch 的 HTTP 请求从本机发出，受公司出站白名单（如 Cowork/Vanta、Zscaler、Netskope 等安全策略）管控。如果需要的域名不在白名单中，WebFetch 无法访问。

**折中方案**：给 Aperture 添加一个 `/v1/fetch` 代理端点，让 Cloudflare Workers（已受白名单信任）代抓内容。详见 [issue #fetch-proxy](https://github.com/YKaiXu/aperture/issues)。

## 性能

- **bundle < 50KB** — 零外部依赖，极速冷启动
- **AbortSignal 传播** — 客户端断开自动取消上游请求
- **2MB SSE buffer cap** — 防止内存耗尽
- **限流器 TTL 修剪** — 防止内存泄漏

## 开发

```bash
git clone https://github.com/YKaiXu/aperture.git
cd aperture && npm install
npm test              # 测试
npm run dev           # wrangler dev
npm run deploy        # wrangler deploy
```

## 许可

MIT
