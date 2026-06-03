"""Import progress tracking via Redis pub/sub + SSE.

Keys:
- ``import:progress:<task_id>`` — JSON hash with current state
- ``import:active:<user_id>`` — active task_id for a user
Channel:
- ``import:progress:user:<user_id>`` — pub/sub for SSE consumers
"""

import json
import logging
import threading
import time
from collections.abc import Generator
from contextlib import suppress
from typing import Any

from app.integrations.redis_client import get_redis_client
from app.utils.sse import format_comment, format_event

logger = logging.getLogger(__name__)

PROGRESS_TTL_SECONDS = 3600
SSE_HEARTBEAT_SECONDS = 15.0
SSE_POLL_TIMEOUT_SECONDS = 1.0


def _task_key(task_id: str) -> str:
    return f"import:progress:{task_id}"


def _active_key(user_id: str) -> str:
    return f"import:active:{user_id}"


def _user_channel(user_id: str) -> str:
    return f"import:progress:user:{user_id}"


def update_progress(
    task_id: str,
    user_id: str,
    *,
    phase: str,
    percent: int,
    chunks_done: int = 0,
    records_processed: int = 0,
    message: str = "",
) -> None:
    """Write progress to Redis and broadcast to SSE consumers."""
    try:
        client = get_redis_client()
        payload: dict[str, Any] = {
            "task_id": task_id,
            "user_id": user_id,
            "phase": phase,
            "percent": min(percent, 100),
            "chunks_done": chunks_done,
            "records_processed": records_processed,
            "message": message,
        }
        data = json.dumps(payload)
        pipe = client.pipeline(transaction=False)
        pipe.set(_task_key(task_id), data, ex=PROGRESS_TTL_SECONDS)
        pipe.publish(_user_channel(user_id), data)
        if phase in ("complete", "error"):
            pipe.delete(_active_key(user_id))
        else:
            pipe.set(_active_key(user_id), task_id, ex=PROGRESS_TTL_SECONDS)
        pipe.execute()
    except Exception as exc:
        logger.warning("Failed to update import progress: %s", exc)


def get_progress(task_id: str) -> dict[str, Any] | None:
    """Fetch current progress for a task."""
    try:
        client = get_redis_client()
        raw = client.get(_task_key(task_id))
        if raw:
            return json.loads(raw)
    except Exception as exc:
        logger.warning("Failed to get import progress: %s", exc)
    return None


def get_active_import(user_id: str) -> dict[str, Any] | None:
    """Get active import progress for a user, if any."""
    try:
        client = get_redis_client()
        task_id = client.get(_active_key(user_id))
        if task_id:
            return get_progress(task_id)
    except Exception as exc:
        logger.warning("Failed to get active import: %s", exc)
    return None


def stream_import_progress(
    user_id: str,
    task_id: str,
    *,
    stop_event: threading.Event | None = None,
) -> Generator[str, None, None]:
    """Yield SSE frames for import progress updates."""
    pubsub = get_redis_client().pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe(_user_channel(user_id))
    with suppress(Exception):
        pubsub.get_message(ignore_subscribe_messages=False, timeout=1.0)

    yield format_comment("connected")

    current = get_progress(task_id)
    if current:
        yield format_event(json.dumps(current), event_type="import.progress")
        if current.get("phase") in ("complete", "error"):
            return

    last_heartbeat = time.monotonic()
    try:
        while stop_event is None or not stop_event.is_set():
            message = pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=SSE_POLL_TIMEOUT_SECONDS,
            )
            if message and message.get("type") == "message":
                data = message.get("data")
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
                if isinstance(data, str):
                    try:
                        parsed = json.loads(data)
                        if parsed.get("task_id") == task_id:
                            yield format_event(data, event_type="import.progress")
                            last_heartbeat = time.monotonic()
                            if parsed.get("phase") in ("complete", "error"):
                                return
                    except json.JSONDecodeError:
                        pass
                    continue

            now = time.monotonic()
            if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                yield format_comment("heartbeat")
                last_heartbeat = now
    finally:
        with suppress(Exception):
            pubsub.unsubscribe()
            pubsub.close()
