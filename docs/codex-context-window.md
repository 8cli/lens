# Codex CLI 模型上下文窗口配置（1M）

> 2026-08-01 · 本文档记录 Codex CLI 0.146 的模型上下文窗口机制——codex 内置模型注册表实测、`model_context_window` 配置方法、以及与 Lens 后端模型的配合。作为 codex 接入知识储备的一部分（配套 [codex-cli.md](codex-cli.md)）。

## 背景：codex 的上下文窗口从哪来

Codex CLI 的上下文管理（何时触发自动压缩、压缩成什么）**取决于其二进制内置的模型注册表**，与后端实际运行的模型无关。

通过 `strings` 解析 codex 0.146.0 二进制，内置注册表如下：

| 模型 | `context_window` | `max_context_window` |
|---|---|---|
| `gpt-5.6-sol`（flagship） | **272000** (272K) | 272000 |
| `gpt-5.6-terra`（mini 档） | 272000 | 272000 |
| `gpt-5.6-luna`（nano 档） | 272000 | 272000 |
| `gpt-5.5` | 272000 | 272000 |
| `gpt-5.4` | 272000 | **1000000 (1M)** |
| `gpt-5.4-mini` | 272000 | 272000 |
| `gpt-5.2` | 272000 | 272000 |
| `codex-auto-review` | 272000 | **1000000 (1M)** |

**结论：** 即使用户配置 `gpt-5.6-sol`（codex 认识的旗舰模型名），默认上下文窗口也只有 **272K**，不是 1M。

## 配置 1M 上下文

### 方法：显式声明 `model_context_window`

在 `~/.codex/config.toml` 顶层加入：

```toml
model = "gpt-5.6-sol"
model_provider = "lens"

# 新增：声明模型支持 1M 上下文（覆盖内置注册表的 272K）
model_context_window = 1000000
# 可选：到达 900K（90%）时触发自动压缩，留余量避免撞上游硬上限
model_auto_compact_token_limit = 900000
```

### 键名实证（0.146 二进制确认存在）

```
model_context_window              ✓
model_auto_compact_token_limit    ✓
model_auto_compact_token_limit_scope ✓
model_max_output_tokens           ✗（0.146 中不存在，勿配置）
```

### 验证

```bash
codex doctor | grep -A4 'config'
# 期望：
#   ✓ config       loaded
#       model                    gpt-5.6-sol · lens
#       config.toml parse        ok
```

端到端实测：

```bash
codex exec --sandbox read-only --skip-git-repo-check "只回复两个字：成功"
```

## 重要提醒：上游模型是否真的支持 1M？

`model_context_window` 只影响 **codex 侧的上下文管理**（何时压缩、保留多少），**不会改变上游**。它不会让上游接受超限请求。

当前 Lens 后端模型是 `deepseek-v4-flash`（通过 `BACKEND_MODEL=deepseek-v4-flash` 锁定，Lens 日志可确认）：

```
主上游: <内部上游地址（已脱敏）>   (deepseek-v4-flash)
备上游: <内部备上游地址（已脱敏）>  (deepseek-v4-flash)
```

**风险场景：** 若上游实际只支持 272K，而 codex 按 1M 管理上下文，长对话会先于 codex 压缩到达上游硬上限 → 直接收到 400/context length exceeded 错误。

**应对：**
- 配置 `model_auto_compact_token_limit = 900000` 后，codex 会在 900K 时自动压缩，理论上在上游 1M 上限内安全（前提是上游真的支持 1M）
- 若实际遇到上游 400，说明上游窗口 < 900K，应把两个值调回 272K 或在两者之间取保守值
- 判断上游真实上限的方法：构造超长请求直测上游，或咨询上游文档

## 双机配置状态（2026-08-01）

本机（cliserver）与 xhub（192.168.10.22）已同步：

| 配置项 | 本机 | xhub |
|---|---|---|
| `model_context_window` | `1000000` | `1000000` |
| `model_auto_compact_token_limit` | `900000` | `900000` |
| `codex doctor` 验证 | ✅ parse ok | ✅ parse ok |
| 端到端 `codex exec` | ✅ 正常响应 | 待实测长对话 |

## 相关文件

- `~/.codex/config.toml` — 本机配置（改前备份 `config.toml.bak-1m`）
- `~/.codex/config.toml` — xhub 配置（改前备份 `config.toml.bak-1m`）
- [codex-cli.md](codex-cli.md) — Codex CLI 接入完整记录
