# Lens

> *This project was ported from [Aperture](https://github.com/YKaiXu/aperture) (TypeScript / Cloudflare Workers) to Python for lightweight deployment on OpenWRT and similar edge environments.*

**Lens** is an AI protocol translator — a lightweight proxy that converts between different LLM API formats. It sits between your AI client and the upstream provider, translating requests and responses on the fly.

```
Your App (Chat Completions API)          Upstream Provider
       │                                       ▲
       │  POST /v1/chat/completions            │
       │  { messages, model, ... }             │ Anthropic Messages API
       │                                       │ or Responses API
       ▼                                       │
    ┌──────────────────────────────────────────┴─┐
    │                   Lens                      │
    │                                             │
    │  Anthropic Messages  ↔  Chat Completions    │
    │  OpenAI Responses    ↔  Chat Completions    │
    │  DSML ↔ OpenAI tool_calls                   │
    └─────────────────────────────────────────────┘
```

## Features

- **Protocol translation** — Anthropic Messages API ↔ Chat Completions, OpenAI Responses API ↔ Chat Completions
- **Streaming** — Full SSE streaming support for all protocols
- **DSML support** — DeepSeek-style `<dsml>` XML tool call normalization
- **Authentication** — API key validation (Bearer token or x-api-key header)
- **Rate limiting** — Sliding-window rate limiter with configurable window and max requests
- **CORS** — Configurable CORS headers
- **Lightweight** — Single runtime dependency (`aiohttp`), pure Python 3.10+

## Quick Start

```bash
pip install aiohttp

# Clone and run
git clone https://github.com/YKaiXu/lens.git
cd lens

API_KEY=sk-your-key \
UPSTREAM_BASE_URL=https://api.example.com/v1 \
python3 -m aperture
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `API_KEY` | — | Required. Authentication key for incoming requests |
| `UPSTREAM_BASE_URL` | `http://localhost:8080/v1` | Base URL of the upstream Chat Completions API |
| `DEFAULT_MODEL` | `gpt-4o-mini` | Default model name for translated requests |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |
| `PORT` | `8000` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |

## Design

Lens follows a clean three-layer architecture:

1. **Translators** — Pure stateless functions that convert between API formats
2. **Handlers** — Orchestration layer that chains translation → upstream call → reverse translation
3. **Middleware** — CORS → rate limiting → authentication (order matters)

## Testing

```bash
pip install pytest pytest-asyncio pytest-aiohttp
pytest tests/
```
