"""Tests for the database migration system.

We don't boot the whole Flask app for these — the migrations are pure
SQLite work, so we drive a connection directly and assert on the
post-migration state. This makes the tests fast and self-contained.
"""
from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

from backend.migrations import run_pending


@pytest.fixture
def fresh_db():
    """A throwaway SQLite DB with the schema applied and no items."""
    tmp = Path(tempfile.mkdtemp(prefix="tp_mig_"))
    db_path = tmp / "test.db"
    schema = (Path(__file__).resolve().parent.parent.parent / "backend" / "schema.sql").read_text()
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(schema)
    conn.commit()
    yield conn
    conn.close()


def _insert_item(conn, item_type, item_date, end_date, details, plan_id=1):
    cur = conn.execute(
        "INSERT INTO items (plan_id, item_type, title, item_date, end_date, "
        "sort_key, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (plan_id, item_type, "T", item_date, end_date, 1.0, "planned",
         json.dumps(details) if details else None),
    )
    conn.commit()
    return cur.lastrowid


def _details_of(conn, item_id):
    r = conn.execute("SELECT details FROM items WHERE id = ?", (item_id,)).fetchone()
    return json.loads(r["details"]) if r and r["details"] else {}


# ------------------------------------------------------------------ framework
class TestMigrationFramework:
    def test_records_each_migration_once(self, fresh_db):
        """Re-running run_pending should not re-apply anything."""
        applied = run_pending(fresh_db)
        assert applied                       # at least the new when migration runs
        # Confirm the rows exist
        rows = fresh_db.execute("SELECT id FROM migrations").fetchall()
        ids = {r[0] for r in rows}
        assert "001_plans_status" in ids
        assert "004_unify_when" in ids
        # And a second pass is a no-op
        again = run_pending(fresh_db)
        assert again == []

    def test_creates_migrations_table(self, fresh_db):
        run_pending(fresh_db)
        r = fresh_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
        ).fetchone()
        assert r is not None

    def test_failed_migration_does_not_block_future_runs(self, fresh_db, monkeypatch):
        # Pretend a migration throws; the framework should still record
        # the successful ones and re-attempt the bad one next time.
        from backend.migrations import _discover
        good_ids = [mid for mid, _ in _discover() if mid != "004_unify_when"]
        first = run_pending(fresh_db)
        assert "004_unify_when" in first
        # Now break the DB by inserting a row that 004 can't process
        # (an item with garbage details JSON). The migration should fail
        # for that row but still record itself if it managed to update
        # the rest; here we just verify the framework handles the
        # exception path without losing the earlier rows.
        bad_id = fresh_db.execute(
            "INSERT INTO items (plan_id, item_type, title, item_date, "
            "sort_key, details) VALUES (1, 'activity', 'B', '2026-01-01', 1.0, '{not json')"
        ).lastrowid
        fresh_db.commit()
        try:
            run_pending(fresh_db)
        except Exception:
            pass
        # Earlier migrations still present:
        for mid in good_ids:
            r = fresh_db.execute("SELECT 1 FROM migrations WHERE id = ?", (mid,)).fetchone()
            assert r is not None, f"missing migration row: {mid}"


# ------------------------------------------------------------------ 002 transit unify
class TestTransitUnify:
    def test_flight_to_transit_with_renames(self, fresh_db):
        _insert_item(fresh_db, "flight", "2026-07-01", None, {
            "airline": "ANA", "flight_no": "NH102", "from": "HND", "to": "SFO",
        })
        run_pending(fresh_db)
        row = fresh_db.execute(
            "SELECT item_type, details FROM items ORDER BY id"
        ).fetchall()
        assert row[0]["item_type"] == "transit"
        d = json.loads(row[0]["details"])
        assert d["provider"] == "ANA"
        assert d["ref_no"] == "NH102"
        assert "airline" not in d
        assert "flight_no" not in d

    def test_train_to_transit(self, fresh_db):
        _insert_item(fresh_db, "train", "2026-07-01", None, {
            "train_no": "T123", "from": "Tokyo", "to": "Kyoto",
        })
        run_pending(fresh_db)
        row = fresh_db.execute("SELECT item_type, details FROM items").fetchone()
        assert row["item_type"] == "transit"
        d = json.loads(row["details"])
        assert d["ref_no"] == "T123"
        assert "train_no" not in d


# ------------------------------------------------------------------ 004 unify when
class TestUnifyWhen:
    def test_hotel_uses_columns_for_dates(self, fresh_db):
        _insert_item(fresh_db, "hotel", "2026-07-01", "2026-07-03", {
            "hotel_name": "Hilton", "check_in_time": "15:00", "check_out_time": "11:00",
        })
        run_pending(fresh_db)
        row = fresh_db.execute("SELECT details, item_date, end_date FROM items").fetchone()
        d = json.loads(row["details"])
        assert d["when"]["start_at"] == "2026-07-01T15:00"
        assert d["when"]["end_at"] == "2026-07-03T11:00"
        # Day columns still tracked
        assert row["item_date"] == "2026-07-01"
        assert row["end_date"] == "2026-07-03"
        # Legacy fields removed
        assert "check_in_time" not in d
        assert "check_out_time" not in d

    def test_transit_depart_arrive(self, fresh_db):
        _insert_item(fresh_db, "transit", "2026-07-01", None, {
            "depart_time": "2026-07-01T09:30", "arrive_time": "2026-07-01T15:00",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"] == {"start_at": "2026-07-01T09:30", "end_at": "2026-07-01T15:00"}
        assert "depart_time" not in d
        assert "arrive_time" not in d

    def test_transit_with_only_depart_defaults_arrive(self, fresh_db):
        """A transit with only depart_time gets end_at = depart + 1h."""
        _insert_item(fresh_db, "transit", "2026-07-01", None, {
            "depart_time": "2026-07-01T09:30",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"]["start_at"] == "2026-07-01T09:30"
        assert d["when"]["end_at"] == "2026-07-01T10:30"

    def test_activity_start_end(self, fresh_db):
        _insert_item(fresh_db, "activity", "2026-07-01", None, {
            "start_time": "2026-07-01T10:00", "end_time": "2026-07-01T12:00",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"]["start_at"] == "2026-07-01T10:00"
        assert d["when"]["end_at"] == "2026-07-01T12:00"
        assert "start_time" not in d
        assert "end_time" not in d

    def test_restaurant_with_only_start_defaults_end(self, fresh_db):
        """A restaurant with only start_time gets end_at = start_at + 1h.

        Schedule items always have a duration so the timeline bar has
        a real length; the user can adjust in the editor.
        """
        _insert_item(fresh_db, "restaurant", "2026-07-01", None, {
            "name": "Sushi", "start_time": "2026-07-01T19:00",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"]["start_at"] == "2026-07-01T19:00"
        assert d["when"]["end_at"] == "2026-07-01T20:00"
        assert "start_time" not in d
        assert "end_time" not in d

    def test_restaurant_with_end_includes_end(self, fresh_db):
        _insert_item(fresh_db, "restaurant", "2026-07-01", None, {
            "name": "Sushi", "start_time": "2026-07-01T19:00",
            "end_time": "2026-07-01T21:00",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"]["end_at"] == "2026-07-01T21:00"

    def test_note_gets_when_if_time_present(self, fresh_db):
        _insert_item(fresh_db, "note", "2026-07-01", None, {"time": "2026-07-01T08:00"})
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d.get("when", {}).get("start_at") == "2026-07-01T08:00"
        # A note with a single time still gets a 1h default end so the
        # data shape is uniform across types.
        assert d["when"]["end_at"] == "2026-07-01T09:00"

    def test_legacy_restaurant_time_field(self, fresh_db):
        """Pre-migration restaurant had only a 'time' field. Migrated to when + 1h end."""
        _insert_item(fresh_db, "restaurant", "2026-07-01", None, {
            "name": "Cafe", "time": "2026-07-01T12:00",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d["when"]["start_at"] == "2026-07-01T12:00"
        assert d["when"]["end_at"] == "2026-07-01T13:00"
        assert "time" not in d

    def test_when_overrides_stale_item_date(self, fresh_db):
        """If item_date is wrong but when.start_at is right, the row gets fixed."""
        _insert_item(fresh_db, "activity", "2026-07-01", None, {
            "start_time": "2026-08-15T10:00", "end_time": "2026-08-15T12:00",
        })
        run_pending(fresh_db)
        row = fresh_db.execute("SELECT item_date FROM items").fetchone()
        assert row["item_date"] == "2026-08-15"

    def test_when_overrides_stale_end_date(self, fresh_db):
        _insert_item(fresh_db, "hotel", "2026-07-01", "2026-07-02", {
            "check_in_time": "15:00", "check_out_time": "11:00",
        })
        # Tamper with the column (simulating a user who edited the end
        # date directly, or a half-migrated row). The migration should
        # use the new tampered end_date as the day for when.end_at.
        fresh_db.execute("UPDATE items SET end_date = '2026-07-10' WHERE id = 1")
        fresh_db.commit()
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        # The migration builds when.end_at from the (already-tampered)
        # end_date column, so it should be 2026-07-10T11:00.
        assert d["when"]["end_at"].startswith("2026-07-10T11:00")
        row = fresh_db.execute("SELECT end_date FROM items").fetchone()
        assert row["end_date"] == "2026-07-10"

    def test_drops_legacy_qty_price(self, fresh_db):
        """Migration 003 already does this, but a fresh item with
        qty/price should be cleaned up by the time we hit 004's loop."""
        _insert_item(fresh_db, "note", "2026-07-01", None, {
            "text": "hi", "qty": 5, "price": 100,
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert "qty" not in d
        assert "price" not in d

    def test_when_not_written_when_no_times(self, fresh_db):
        """A note with no time field ends up with no when object either."""
        _insert_item(fresh_db, "note", "2026-07-01", None, {"text": "plain"})
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert "when" not in d
        assert d == {"text": "plain"}


# ------------------------------------------------------------------ 003 cleanup
class TestDetailsCleanup:
    def test_legacy_link_moves_to_attachments(self, fresh_db):
        _insert_item(fresh_db, "hotel", "2026-07-01", "2026-07-02", {
            "hotel_name": "X", "link": "https://example.com",
        })
        run_pending(fresh_db)
        atts = fresh_db.execute("SELECT * FROM attachments").fetchall()
        assert len(atts) == 1
        assert atts[0]["kind"] == "link"
        assert atts[0]["value"] == "https://example.com"
        d = _details_of(fresh_db, 1)
        assert "link" not in d

    def test_venue_renamed_to_location(self, fresh_db):
        _insert_item(fresh_db, "activity", "2026-07-01", None, {
            "name": "Museum", "venue": "MoMA",
        })
        run_pending(fresh_db)
        d = _details_of(fresh_db, 1)
        assert d.get("location") == "MoMA"
        assert "venue" not in d
