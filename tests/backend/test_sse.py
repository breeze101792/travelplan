"""Tests for the SSE event system — thread-safe publish/subscribe/stream."""
from __future__ import annotations

import json
import queue
import threading
import time

import pytest

from backend.sse import (
    _queues,
    _lock,
    plan_event_stream,
    publish_event,
    subscribe,
    unsubscribe,
)


def teardown_function():
    with _lock:
        _queues.clear()


class TestSubscribeUnsubscribe:
    def test_subscribe_returns_queue(self):
        q = subscribe(1)
        assert isinstance(q, queue.Queue)
        assert q.maxsize == 128

    def test_subscribe_adds_to_queues(self):
        q = subscribe(1)
        assert q in _queues.get(1, set())

    def test_unsubscribe_removes_queue(self):
        q = subscribe(2)
        assert q in _queues[2]
        unsubscribe(2, q)
        assert q not in _queues.get(2, set())

    def test_unsubscribe_unknown_plan_does_not_raise(self):
        q = queue.Queue()
        unsubscribe(999, q)


class TestPublishEvent:
    def test_publish_delivers_to_subscriber(self):
        q = subscribe(1)
        event = {"type": "test", "entity_id": 42}
        publish_event(1, event)
        received = q.get(timeout=1)
        assert received == event

    def test_publish_to_multiple_subscribers(self):
        q1 = subscribe(3)
        q2 = subscribe(3)
        publish_event(3, {"type": "broadcast"})
        assert q1.get(timeout=1) == {"type": "broadcast"}
        assert q2.get(timeout=1) == {"type": "broadcast"}

    def test_publish_to_different_plans(self):
        q_a = subscribe(10)
        q_b = subscribe(20)
        publish_event(10, {"type": "plan10"})
        publish_event(20, {"type": "plan20"})
        assert q_a.get(timeout=1) == {"type": "plan10"}
        assert q_b.get(timeout=1) == {"type": "plan20"}

    def test_publish_with_no_subscribers_does_not_raise(self):
        publish_event(999, {"type": "lonely"})

    def test_publish_removes_full_queue(self):
        small = queue.Queue(maxsize=1)
        with _lock:
            _queues[50].add(small)
        small.put_nowait({"placeholder": True})  # fill it
        publish_event(50, {"type": "drop"})
        assert small not in _queues.get(50, set())


class TestPlanEventStream:
    def test_stream_yields_events(self):
        events = []
        def collector():
            gen = plan_event_stream(100)
            events.append(next(gen))
            events.append(next(gen))
            gen.close()
        t = threading.Thread(target=collector, daemon=True)
        t.start()
        time.sleep(0.05)
        publish_event(100, {"type": "ev1"})
        publish_event(100, {"type": "ev2"})
        t.join(timeout=3)
        assert len(events) == 2
        assert json.loads(events[0].removeprefix("data: ").strip()) == {"type": "ev1"}
        assert json.loads(events[1].removeprefix("data: ").strip()) == {"type": "ev2"}

    def test_stream_sends_keepalive_on_timeout(self):
        gen = plan_event_stream(200)
        chunk = next(gen)
        assert chunk == ": keepalive\n\n"
        gen.close()

    def test_stream_unsubscribes_on_close(self):
        plan_id = 300
        gen = plan_event_stream(plan_id)
        next(gen)  # consume keepalive — subscribe already happened
        gen.close()
        assert _queues.get(plan_id, set()) == set()
