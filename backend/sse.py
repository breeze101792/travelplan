"""SSE (Server-Sent Events) — real-time push for plan data changes.

Usage:
  from .sse import publish_event, plan_event_stream

  # After a successful mutation:
  publish_event(plan_id, {"type": "item.updated", "entity_id": 42})

  # In a Flask route:
  return Response(plan_event_stream(plan_id), mimetype='text/event-stream')
"""
from __future__ import annotations

import json
import queue
import threading
import time
from collections import defaultdict

# Per-plan event queues. Each queue holds events to be delivered to SSE
# clients subscribed to that plan. A client is represented by a
# queue.Queue that it reads from.
_queues: dict[int, set[queue.Queue]] = defaultdict(set)
_lock = threading.Lock()


def publish_event(plan_id: int, event: dict) -> None:
    """Push an event to all SSE clients subscribed to this plan."""
    with _lock:
        dead = set()
        for q in _queues.get(plan_id, set()):
            try:
                q.put_nowait(event)
            except queue.Full:
                dead.add(q)
        for q in dead:
            _queues[plan_id].discard(q)


def subscribe(plan_id: int) -> queue.Queue:
    """Register a new SSE client for this plan. Returns a queue to read from."""
    q: queue.Queue = queue.Queue(maxsize=128)
    with _lock:
        _queues[plan_id].add(q)
    return q


def unsubscribe(plan_id: int, q: queue.Queue) -> None:
    """Remove a client from the plan's subscriber set."""
    with _lock:
        _queues[plan_id].discard(q)


def plan_event_stream(plan_id: int):
    """Generator for a Flask SSE response. Yields ``data: ...\n\n`` lines."""
    q = subscribe(plan_id)
    try:
        while True:
            try:
                event = q.get(timeout=30)
                yield f"data: {json.dumps(event)}\n\n"
            except queue.Empty:
                # Keepalive ping — prevents proxies from closing the connection
                yield ": keepalive\n\n"
    except GeneratorExit:
        pass
    finally:
        unsubscribe(plan_id, q)