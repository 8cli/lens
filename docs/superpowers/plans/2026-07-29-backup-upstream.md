# 主备上游 API 回退 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lens 添加主备上游 API 回退能力，主上游超时/断连/5xx 时自动切到备上游重试。

**Architecture:** 改 `send_chat_request()` 使其接受可选自定义 URL/headers，新增 `send_with_fallback()` 包装重试逻辑。三个 handler 模块各替换一处调用。新增的 `BACKUP_*` 环境变量由 `config.py` 读取、`index.py` 注入 app 对象。

**Tech Stack:** Python 3.10+, aiohttp

## Global Constraints

- BACKUP_UPSTREAM_BASE_URL 为空时行为与当前完全一致，无额外延迟
- 最多重试 1 次（切到备），备再失败直接返回错误
- 流式请求在首 chunk 前可切备；首 chunk 后锁定主上游
- 4xx 不重试
- 每次切换记录清晰日志

---

### Task 1: 修改 upstream.py — 增加 fallback 支持

**Files:**
- Modify: `aperture/upstream.py`

**Interfaces:**
- Consumes: `app` dict with `backup_upstream_base_url`, `backup_api_key` keys
- Produces: `send_chat_request(app, chat_body, log, url_override=None, headers_override=None)` — 可选覆盖 URL 和 headers
- Produces: `send_with_fallback(app, chat_body, log) → ClientResponse | web.Response` — 主备回退入口

- [ ] **Step 1: Modify `send_chat_request()` 签名**

给 `send_chat_request()` 增加可选的 `url_override` 和 `headers_override` 参数，以便 fallback 时复用同一函数：

```python
async def send_chat_request(
    app: web.Application,
    chat_body: dict,
    log: Logger | None = None,
    url_override: str | None = None,
    headers_override: dict | None = None,
) -> ClientResponse | web.Response:
```

在函数头部替换 URL 和 headers 构建：

```python
    url = url_override or build_upstream_url(app)
    headers = headers_override or build_auth_headers(app)
```

其余逻辑完全不变。

- [ ] **Step 2: 新增 `send_with_fallback()`**

```python
async def send_with_fallback(
    app: web.Application,
    chat_body: dict,
    log: Logger | None = None,
) -> ClientResponse | web.Response:
    """Send request with primary/backup fallback.

    Tries primary upstream first. If the failure is retryable
    (timeout, connection error, 5xx) and a backup is configured,
    retries once on the backup upstream.
    """
    # Step 1: Try primary
    resp = await send_chat_request(app, chat_body, log)
    if _is_success(resp):
        return resp
    
    if _is_retryable(resp) and _has_backup(app):
        log and log.warn("upstream.fallback", {
            "reason": _error_code(resp),
            "from": app.get("upstream_base_url", ""),
            "to": app.get("backup_upstream_base_url", ""),
        })
        backup_url = _build_backup_url(app)
        backup_headers = _build_backup_headers(app)
        resp = await send_chat_request(app, chat_body, log, url_override=backup_url, headers_override=backup_headers)
    
    return resp
```

- [ ] **Step 3: 新增辅助函数**

```python
def _is_success(resp: ClientResponse | web.Response) -> bool:
    """2xx from upstream is success; web.Response means send_chat_request already errored."""
    if isinstance(resp, web.Response):
        return False
    return resp.status < 400


def _is_retryable(resp: ClientResponse | web.Response) -> bool:
    """Timeout (504), connection error (502), or upstream 5xx."""
    if isinstance(resp, web.Response):
        return resp.status in (502, 504)
    return resp.status >= 500


def _error_code(resp: ClientResponse | web.Response) -> str:
    if isinstance(resp, web.Response):
        body = resp.body
        if isinstance(body, bytes):
            try:
                import json
                payload = json.loads(body)
                return payload.get("error", {}).get("code", f"HTTP_{resp.status}")
            except Exception:
                pass
        return f"HTTP_{resp.status}"
    return f"HTTP_{resp.status}"


def _has_backup(app: web.Application) -> bool:
    return bool(app.get("backup_upstream_base_url", ""))


def _build_backup_url(app: web.Application) -> str:
    base_url = app.get("backup_upstream_base_url", "")
    return f"{base_url.rstrip('/')}/chat/completions"


def _build_backup_headers(app: web.Application) -> dict:
    api_key = app.get("backup_api_key", "")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
```

- [ ] **Step 4: 暴露新函数到 `__all__` 或直接保留模块级导出**

确保 `send_with_fallback` 可以被 handler 模块 `from ..upstream import send_with_fallback`。

- [ ] **Step 5: 运行现有测试确保没破坏**

```bash
cd /home/yupeng/lens && python -m pytest tests/test_upstream.py -v
```

预期：全部 PASS

- [ ] **Step 6: 提交**

```bash
git add aperture/upstream.py
git commit -m "feat: add send_with_fallback for primary/backup upstream retry"
```

---

### Task 2: 修改 config.py — 新增备配置读取

**Files:**
- Modify: `aperture/config.py`

- [ ] **Step 1: 在 config.py 中新增导入（无额外代码需要，直接在 index.py 中读 env）**

其实不需要改 config.py。backup 的 URL 和 key 直接在 `index.py` 里通过 `os.environ.get()` 读取即可，和现有的 `UPSTREAM_BASE_URL` / `API_KEY` 风格一致。

- [ ] **Step 2: 提交**

```bash
git add aperture/config.py
git commit -m "chore: no changes needed — backup config read via os.environ in index.py"
```

---

### Task 3: 修改 index.py — 注入备配置到 app

**Files:**
- Modify: `aperture/index.py`

- [ ] **Step 1: 在 `create_app()` 的主上游配置之后，新增备配置**

```python
    # Backup upstream (optional)
    app["backup_upstream_base_url"] = os.environ.get("BACKUP_UPSTREAM_BASE_URL", "")
    app["backup_api_key"] = os.environ.get("BACKUP_API_KEY", "")
```

放在现有主上游配置下方：

```python
    app["upstream_base_url"] = os.environ.get("UPSTREAM_BASE_URL", "https://opencode.ai/zen/go/v1")
    app["api_key"] = os.environ.get("API_KEY", "")
```

- [ ] **Step 2: 提交**

```bash
git add aperture/index.py
git commit -m "feat: inject backup_upstream_base_url and backup_api_key into app"
```

---

### Task 4: 修改三个 handler — 替换 send_chat_request 为 send_with_fallback

**Files:**
- Modify: `aperture/handlers/chat.py`
- Modify: `aperture/handlers/responses.py`
- Modify: `aperture/handlers/anthropic.py`

- [ ] **Step 1: handler/chat.py — 替换导入和调用**

导入：
```python
from ..upstream import send_with_fallback
```

调用（第 98 行）：
```python
    # Before:
    upstream_response = await send_chat_request(app, body, log)
    # After:
    upstream_response = await send_with_fallback(app, body, log)
```

移除不再使用的 `send_chat_request` 导入。

- [ ] **Step 2: handler/responses.py — 替换导入和调用**

导入：
```python
from ..upstream import send_with_fallback
```

调用（第 24 行）：
```python
    upstream_response = await send_with_fallback(app, chat_req, log)
```

移除 `send_chat_request` 导入。

- [ ] **Step 3: handler/anthropic.py — 替换导入和调用**

导入：
```python
from ..upstream import send_with_fallback
```

调用（第 30 行）：
```python
    upstream_response = await send_with_fallback(app, chat_req, log)
```

移除 `send_chat_request` 导入。

- [ ] **Step 4: 验证导入完整性**

```bash
cd /home/yupeng/lens && python -c "from aperture.upstream import send_with_fallback; print('OK')"
```

- [ ] **Step 5: 提交**

```bash
git add aperture/handlers/chat.py aperture/handlers/responses.py aperture/handlers/anthropic.py
git commit -m "feat: wire send_with_fallback into all three handlers"
```

---

### Task 5: 编写 fallback 测试

**Files:**
- Create: `tests/test_fallback.py`

- [ ] **Step 1: 创建测试文件**

```python
"""Tests for upstream fallback logic."""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from aiohttp import web, ClientConnectionError
from aperture.upstream import send_with_fallback, send_chat_request
from aperture.middleware.logger import Logger


def _make_app(backup_url="", backup_key="", **overrides):
    """Create a minimal app dict for testing."""
    base = {
        "upstream_base_url": "http://primary.test/v1",
        "api_key": "sk-primary",
        "request_timeout": 30000,
        "backup_upstream_base_url": backup_url,
        "backup_api_key": backup_key,
    }
    if overrides:
        base.update(overrides)
    app = MagicMock()
    def get_side(key, default=None):
        return base.get(key, default)
    app.get.side_effect = get_side
    return app


@pytest.mark.asyncio
async def test_fallback_primary_success():
    """Primary 2xx → no fallback called."""
    session = MagicMock()
    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.ok = True
    session.post = AsyncMock(return_value=mock_resp)
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 200
    assert session.post.call_count == 1
    # Verify it called primary URL
    call_url = session.post.call_args[0][0]
    assert "primary" in call_url


@pytest.mark.asyncio
async def test_fallback_primary_4xx_no_retry():
    """Primary 4xx → NOT retried on backup."""
    session = MagicMock()
    mock_resp = MagicMock()
    mock_resp.status = 400
    mock_resp.ok = False
    session.post = AsyncMock(return_value=mock_resp)
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    # Should return the 400 without retrying
    assert resp.status == 400
    assert session.post.call_count == 1


@pytest.mark.asyncio
async def test_fallback_primary_timeout():
    """Primary timeout → retry on backup."""
    session = MagicMock()
    # First call: timeout
    session.post = AsyncMock(side_effect=[
        asyncio.TimeoutError(),
        # fallback call
        MagicMock(status=200, ok=True),
    ])
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 200
    assert session.post.call_count == 2
    # Verify second call went to backup
    call_urls = [call[0][0] for call in session.post.call_args_list]
    assert any("backup" in url for url in call_urls)


@pytest.mark.asyncio
async def test_fallback_primary_5xx():
    """Primary 5xx → retry on backup."""
    session = MagicMock()
    primary_resp = MagicMock()
    primary_resp.status = 502
    primary_resp.ok = False
    backup_resp = MagicMock()
    backup_resp.status = 200
    backup_resp.ok = True
    
    session.post = AsyncMock(side_effect=[primary_resp, backup_resp])
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 200
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_fallback_no_backup_configured():
    """Primary timeout, no backup → returns error, no crash."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=asyncio.TimeoutError())
    
    app = _make_app(backup_url="", backup_key="", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 504
    assert session.post.call_count == 1


@pytest.mark.asyncio
async def test_fallback_both_fail():
    """Primary fails, backup also fails → return final error."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=[
        asyncio.TimeoutError(),
        ClientConnectionError("Backup refused"),
    ])
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 502
    assert session.post.call_count == 2


@pytest.mark.asyncio
async def test_fallback_primary_connection_error():
    """Primary connection error → retry on backup."""
    session = MagicMock()
    session.post = AsyncMock(side_effect=[
        ClientConnectionError("Connection refused"),
        MagicMock(status=200, ok=True),
    ])
    
    app = _make_app("http://backup.test/v1", "sk-backup", client=session)
    resp = await send_with_fallback(app, {"model": "test"})
    
    assert resp.status == 200
    assert session.post.call_count == 2
```

- [ ] **Step 2: 运行测试**

```bash
cd /home/yupeng/lens && python -m pytest tests/test_fallback.py -v
```

预期：全部 PASS

- [ ] **Step 3: 提交**

```bash
git add tests/test_fallback.py
git commit -m "test: primary/backup fallback test suite"
```

---

### Task 6: 整体验证

- [ ] **Step 1: 全量测试**

```bash
cd /home/yupeng/lens && python -m pytest -v
```

预期：全部 PASS

- [ ] **Step 2: 推送到 GitHub**

```bash
git push origin main
```

- [ ] **Step 3: 重启 Lens 服务**

```bash
sudo systemctl restart lens
```

- [ ] **Step 4: 验证服务启动正常**

```bash
sudo systemctl --no-pager status lens
```
