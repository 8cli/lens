# Lens

> *本项目从 [Aperture](https://github.com/YKaiXu/aperture)（TypeScript / Cloudflare Workers）移植到 Python，用于在 OpenWRT 等轻量边缘环境中部署。*

**Lens** 是一个 AI 协议翻译器——在客户端与上游 API 之间转换请求/响应的轻量代理。

```
你的应用 (Chat Completions API)         上游提供商
       │                                       ▲
       │  POST /v1/chat/completions            │
       │  { messages, model, ... }             │ Anthropic Messages API
       │                                       │ 或 Responses API
       │                                       │ 或 Chat Completions
       ▼                                       │
    ┌──────────────────────────────────────────┴─┐
    │                   Lens                      │
    │                                             │
    │  Anthropic Messages  ↔  Chat Completions    │
    │  OpenAI Responses    ↔  Chat Completions    │
    │  DSML ↔ OpenAI tool_calls                   │
    └─────────────────────────────────────────────┘
```

## 功能

- **协议翻译** — Anthropic Messages API ↔ Chat Completions、OpenAI Responses API ↔ Chat Completions
- **流式响应** — 所有协议均支持完整 SSE 流式传输
- **DSML 支持** — DeepSeek 风格 `<dsml>` XML 工具调用标准化
- **身份认证** — API Key 验证（Bearer Token 或 x-api-key 请求头）
- **速率限制** — 滑动窗口限流器，可配置窗口和最大请求数
- **CORS** — 可配置的跨域请求头
- **主备回退** — 上游超时/断连/5xx 时自动切换到备用上游重试
- **一键切换** — `swap-upstream.sh` 一键互换主备上游
- **轻量运行** — 仅依赖 `aiohttp`，纯 Python，运行内存约 27MB

## 快速开始

```bash
pip install aiohttp

# 克隆并运行
git clone https://github.com/YKaiXu/lens.git
cd lens

API_KEY=sk-your-key \
UPSTREAM_BASE_URL=https://api.example.com/v1 \
python3 -m aperture
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `API_KEY` | — | 必填。客户端请求的认证密钥 |
| `UPSTREAM_BASE_URL` | `https://opencode.ai/zen/go/v1` | 上游 Chat Completions API 地址 |
| `BACKUP_UPSTREAM_BASE_URL` | `""` | 备用上游地址（留空则关闭回退） |
| `BACKUP_API_KEY` | `""` | 备用上游的 API Key |
| `BACKUP_ENABLED` | `true` | 回退开关，设为 `false` 则禁用（即使配置了 URL） |
| `APERTURE_HOST` | `0.0.0.0` | 监听地址 |
| `APERTURE_PORT` | `8080` | 监听端口 |
| `REQUEST_TIMEOUT_MS` | `120000` | 上游请求超时时间（毫秒） |
| `UPSTREAM_RPM` | `0` | 上游 RPM 限速（0=关闭）。如英伟达免费 API 设为 `40`，超限请求自动排队 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 入站限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | `120` | 入站每窗口最大请求数 |
| `LOG_DIR` | `/var/log/lens` | 日志目录（10MB 自动轮转） |

### 主备回退逻辑

```
主上游成功 (2xx/3xx)  → 正常返回，不触发回退
主上游 4xx            → 不重试，直接返回
主上游 5xx            → 自动切换到备用上游重试一次
主上游超时/断连       → 自动切换到备用上游重试一次
备用也失败            → 返回最终错误
```

`BACKUP_ENABLED=false` 或 `BACKUP_UPSTREAM_BASE_URL` 为空时，回退功能完全关闭，行为与无回退时一致。

### 一键切换主备

```bash
sudo ./swap-upstream.sh
```

互换主上游和备用上游的配置，重启 Lens 服务。无额外依赖。

## 架构

Lens 采用清晰的三层架构：

1. **Translators（翻译层）** — 纯函数，在 API 格式之间转换
2. **Handlers（处理层）** — 编排层：翻译 → 上游调用 → 反向翻译
3. **Middleware（中间件）** — CORS → 限流 → 认证（顺序有讲究）

## 测试

```bash
pip install pytest pytest-asyncio pytest-aiohttp
pytest tests/
```

## 部署

```bash
# 安装 systemd 服务
sudo cp lens.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lens

# 查看日志
sudo journalctl -u lens -f
# 或查看文件日志
tail -f /var/log/lens/lens.log
```