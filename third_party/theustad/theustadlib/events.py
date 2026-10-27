"""Adapters for Codex JSONL events."""

import json
from typing import Any


def parse_line(line: str) -> dict[str, Any] | None:
    """Parse one JSONL line, returning only object-shaped events."""
    try:
        event = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None
    return event if isinstance(event, dict) else None


def _text_content(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for block in value:
            text = _text_content(block)
            if text is not None:
                parts.append(text)
        return "\n".join(parts) if parts else None
    if isinstance(value, dict):
        for key in ("text", "content", "message"):
            if key in value:
                text = _text_content(value[key])
                if text is not None:
                    return text
    return None


def extract_agent_text(event: dict[str, Any]) -> str | None:
    """Extract text from the documented Codex agent-message envelopes."""
    payloads: list[dict[str, Any]] = []

    item = event.get("item")
    if (
        event.get("type") == "item.completed"
        and isinstance(item, dict)
        and item.get("type") == "agent_message"
    ):
        payloads.append(item)

    message = event.get("msg")
    if isinstance(message, dict) and message.get("type") == "agent_message":
        payloads.append(message)

    if event.get("type") == "agent_message":
        payloads.append(event)

    for payload in payloads:
        for key in ("text", "message", "content"):
            if key in payload:
                text = _text_content(payload[key])
                if text is not None:
                    return text
    return None


def extract_thread_id(event: dict[str, Any]) -> str | None:
    """Extract a thread or session identifier from known event locations."""
    containers = [event]
    message = event.get("msg")
    if isinstance(message, dict):
        containers.append(message)

    for container in containers:
        for key in ("thread_id", "session_id"):
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _compact(value: Any) -> str:
    if isinstance(value, list):
        value = " ".join(str(part) for part in value)
    return " ".join(str(value).split())


def describe(event: dict[str, Any]) -> str:
    """Return a compact description of a command, file change, or event."""
    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type:
        event_type = "event"

    payload: dict[str, Any] = event
    for key in ("item", "msg"):
        candidate = event.get(key)
        if isinstance(candidate, dict):
            payload = candidate
            break

    item_type = payload.get("type")
    if item_type == "command_execution":
        command = _compact(payload.get("command", ""))
        return f"command: {command}" if command else "command_execution"

    if item_type == "file_change":
        paths: list[str] = []
        changes = payload.get("changes")
        if isinstance(changes, list):
            for change in changes:
                if isinstance(change, dict):
                    path = change.get("path")
                    if isinstance(path, str) and path:
                        paths.append(path)
        path = payload.get("path")
        if isinstance(path, str) and path:
            paths.append(path)
        return f"files: {', '.join(paths)}" if paths else "file_change"

    if payload is not event and isinstance(item_type, str) and item_type:
        return f"{event_type}: {item_type}"
    return event_type
