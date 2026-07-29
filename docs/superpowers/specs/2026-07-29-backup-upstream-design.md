# 主备上游 API 设计文档

## 概述

为 Lens 添加主备上游 API 回退能力：主上游失败时自动切换到备上游，提高服务可用性。

## 背景

当前 Lens 所有请求（Chat Completions / Responses API / Anthropic Messages）都通过 `send_chat_request()` 发往单一上游，失败直接返回 502/504。添加备用上游后，在网络故障、上游宕机、5xx 时可透明切换。

## 设计决策

### 回退策略

```
主上游请求
  ├── 2xx → 直接返回 ✅
  ├── 4xx → 不重试（客户端请求错误）
  ├── 超时 / 连不上 / 5xx → 如果有备 → 切备重试
  └── 都失败 → 返回最终错误
```

### 非功能约束

| 项目 | 决策 |
|------|------|
| 流式请求 | 握手阶段（首 chunk 前）可切备；首 chunk 后锁定主上游 |
| 重试次数 | 最多 1 次（切到备），备再失败就返回错误 |
| 错误日志 | 每次切换记录清晰日志，标明主/备和失败原因 |

## 改动范围

### 1. `config.py` — 新增配置读取函数

新增环境变量：

| 环境变量 | 用途 | 默认值 |
|----------|------|--------|
| `BACKUP_UPSTREAM_BASE_URL` | 备上游 base URL | 空（无备） |
| `BACKUP_API_KEY` | 备上游 API key | 空 |

不设 `BACKUP_*` 时行为与当前完全一致（无额外延迟）。

### 2. `upstream.py` — 重构为支持主备

- 将 `send_chat_request()` 替换为 `send_with_fallback()`
- 内部逻辑：先请求主；失败且符合可重试条件时，若有备则切换后重试
- 返回结构不变（`ClientResponse | web.Response`）

### 3. `handlers/chat.py`、`handlers/responses.py`、`handlers/anthropic.py` — 替换调用

三处将 `send_chat_request(app, body, log)` 替换为 `send_with_fallback(app, body, log)`。

### 4. `index.py` — 注入备配置

`create_app()` 中新增：
```python
app["backup_upstream_base_url"] = os.environ.get("BACKUP_UPSTREAM_BASE_URL", "")
app["backup_api_key"] = os.environ.get("BACKUP_API_KEY", "")
```

## 测试策略

1. 主上游正常 → 请求走主，备不被调用
2. 主上游 4xx → 不切备，直接返回错误
3. 主上游超时 → 切备重试
4. 主上游 5xx → 切备重试
5. 主上游 5xx + 无备配置 → 返回错误，不崩溃
6. 主备都失败 → 返回最终错误
7. 流式请求：主在首 chunk 后断流 → 不切换，按当前错误处理
