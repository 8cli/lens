"""Structured JSON logger.

Mirrors JS src/middleware/logger.js.
"""

import json
import sys
import time


class Logger:
    """Logger that emits structured JSON lines to stdout/stderr."""

    def __init__(self, request_id: str = "unknown"):
        self._request_id = request_id

    def info(self, event: str, data: dict | None = None) -> None:
        self._emit("info", event, data)

    def warn(self, event: str, data: dict | None = None) -> None:
        self._emit("warn", event, data)

    def error(self, event: str, data: dict | None = None) -> None:
        self._emit("error", event, data)

    def _emit(self, level: str, event: str, data: dict | None = None) -> None:
        entry = {
            "level": level,
            "event": event,
            "requestId": self._request_id,
            "timestamp": int(time.time() * 1000),
            **(data or {}),
        }
        line = json.dumps(entry, default=str)
        if level == "error":
            print(line, file=sys.stderr, flush=True)
        else:
            print(line, flush=True)


def create_logger(request_id: str = "unknown") -> Logger:
    """Create a structured JSON logger instance."""
    return Logger(request_id)
