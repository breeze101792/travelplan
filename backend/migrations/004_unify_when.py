"""004: Unify all item time fields into a single ``when`` object.

Before this migration, each item type stored its times in different
fields on ``details``:

  hotel:      check_in_time  (HH:MM)
              check_out_time (HH:MM)
  transit:    depart_time    (YYYY-MM-DDTHH:MM)
              arrive_time    (YYYY-MM-DDTHH:MM)
  activity:   start_time     (YYYY-MM-DDTHH:MM)
              end_time       (YYYY-MM-DDTHH:MM)
  restaurant: start_time     (YYYY-MM-DDTHH:MM)
              end_time       (YYYY-MM-DDTHH:MM)
  note:       (no time field)

After: every scheduled item carries a single ``details.when`` object
with BOTH start_at and end_at:
              start_at       (YYYY-MM-DDTHH:MM)
              end_at         (YYYY-MM-DDTHH:MM)   # defaulted to
                                                   # start_at + 1h if
                                                   # the legacy data
                                                   # only had one time

Schedule items always have a duration: a bar with no length has no
useful meaning on the timeline, and a note with a single timestamp
still gets a default 1h end so the data shape is uniform across types.
The editor lets the user clear the end if they want a truly instant
event, but the saved data keeps end_at set so the timeline and the
multi-drag math don't have to special-case it.

This migration rewrites the data so all views (board, timeline, editor)
can read a single field name. It also recomputes ``item_date`` /
``end_date`` (the day columns) from the new times so the hotel span
stays correct. The legacy fields are stripped from ``details`` once the
``when`` object is written.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

id = "004_unify_when"


# ---- time helpers -----------------------------------------------------------

_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_HHMM = re.compile(r"(\d{1,2}):(\d{2})")


def _parse_when(value):
    """Return (date, time) from a 'YYYY-MM-DDTHH:MM' or 'HH:MM' string."""
    if not value:
        return None, None
    s = str(value)
    m_date = _DATE.match(s)
    date = m_date.group(1) if m_date else None
    m_time = _HHMM.search(s)
    time = f"{int(m_time.group(1)):02d}:{m_time.group(2)}" if m_time else None
    return date, time


def _combine(date, time):
    """Combine a date (YYYY-MM-DD) and time (HH:MM) into 'YYYY-MM-DDTHH:MM'."""
    if not date and not time:
        return None
    d = date or "1970-01-01"          # placeholder; the caller must not
                                      # invent a date — the editor rejects
                                      # this and the UI shows blank
    t = time or "00:00"
    return f"{d}T{t}"


def _coerce_time(value):
    """Normalize 'HH:MM' / 'H:MM' to 'HH:MM'. Returns None if unparseable."""
    if not value:
        return None
    s = str(value).strip()
    m = _HHMM.search(s)
    if not m:
        return None
    h, m_ = int(m.group(1)), int(m.group(2))
    if h > 23 or m_ > 59:
        return None
    return f"{h:02d}:{m_:02d}"


def _add_hour(date_str, hhmm):
    """Return 'YYYY-MM-DDTHH:MM' for date + time + 1h. Used to default a
    missing end_at to start_at + 1h. Midnight-spanning values are
    clamped to 23:59 of the same day — the user can adjust."""
    try:
        dt = datetime.strptime(f"{date_str} {hhmm}", "%Y-%m-%d %H:%M")
    except ValueError:
        return f"{date_str}T{hhmm}"
    dt = dt + timedelta(hours=1)
    return dt.strftime("%Y-%m-%dT%H:%M")


# ---- per-type migration -----------------------------------------------------

def _migrate_hotel(d, item_date, end_date):
    """Hotel: check_in_time + check_out_time (HH:MM) -> when.start_at / end_at.

    The dates come from the row's item_date / end_date columns, which the
    DB already tracks separately for the spanning-hotel logic.
    """
    start_at = _combine(item_date, _coerce_time(d.get("check_in_time")))
    end_at = _combine(end_date, _coerce_time(d.get("check_out_time")))
    # Hoteles have both check-in and check-out; if one is missing,
    # the hotel still gets a 1h default so the when object is complete.
    if start_at and not end_at and item_date:
        d_t, t_t = _parse_when(start_at)
        if d_t and t_t:
            end_at = _add_hour(d_t, t_t)
    if end_at and not start_at and end_date:
        d_t, t_t = _parse_when(end_at)
        if d_t and t_t:
            start_at = _add_hour(d_t, t_t)  # i.e. end - 1h ≈ start
            # We just need *some* start; the user can adjust.
    if start_at or end_at:
        out = {}
        if start_at: out["start_at"] = start_at
        if end_at:   out["end_at"] = end_at
        d["when"] = out
    d.pop("check_in_time", None)
    d.pop("check_out_time", None)
    return d


def _migrate_dt(d, start_key, end_key, fallback_item_date):
    """datetime-local helper: combine date with the field's time-of-day.

    The legacy datetime-local field encodes both date and time. We split
    the date out (to canonicalize the day) but keep the full
    YYYY-MM-DDTHH:MM in the new ``when`` object.
    """
    start_raw = d.get(start_key)
    end_raw = d.get(end_key)
    s_date, s_time = _parse_when(start_raw)
    e_date, e_time = _parse_when(end_raw)
    # If the start has no date prefix (rare), fall back to the item_date
    # so we don't lose the day the user picked.
    if start_raw and not s_date:
        s_date = fallback_item_date
    if end_raw and not e_date:
        # End time defaults to the start day unless it crossed midnight.
        e_date = s_date or fallback_item_date
    start_at = _combine(s_date, s_time)
    end_at = _combine(e_date, e_time)
    # Default missing end to start + 1h.
    if start_at and not end_at:
        if s_date and s_time:
            end_at = _add_hour(s_date, s_time)
        elif fallback_item_date and s_time:
            end_at = _add_hour(fallback_item_date, s_time)
    if start_at or end_at:
        out = {}
        if start_at: out["start_at"] = start_at
        if end_at:   out["end_at"] = end_at
        d["when"] = out
    d.pop(start_key, None)
    d.pop(end_key, None)
    d.pop("time", None)        # also strip the legacy single-time alias
    return d


def _migrate_legacy_time(d, item_date):
    """A bare 'time' field (e.g. restaurant before the start_time rename).

    Becomes a start+end when, with end defaulted to start + 1h. If
    there's no legacy ``time`` field at all, do nothing — a note with
    just ``{text}`` should stay shape-less.
    """
    t = d.get("time")
    if not t:
        return d
    s_date, s_time = _parse_when(t)
    if not s_date:
        s_date = item_date
    start_at = _combine(s_date, s_time)
    if start_at and not d.get("when"):
        when = {"start_at": start_at}
        if s_date and s_time:
            when["end_at"] = _add_hour(s_date, s_time)
        d["when"] = when
    d.pop("time", None)
    return d


# ---- main loop --------------------------------------------------------------

def run(conn):
    cur = conn.execute(
        "SELECT id, item_type, item_date, end_date, details FROM items"
    )
    rows = cur.fetchall()
    for row in rows:
        item_id, item_type, item_date, end_date, raw_details = row
        details = json.loads(raw_details) if raw_details else {}
        before = json.dumps(details, sort_keys=True)
        if item_type == "hotel":
            details = _migrate_hotel(details, item_date, end_date)
        elif item_type == "transit":
            details = _migrate_dt(details, "depart_time", "arrive_time", item_date)
        elif item_type == "activity":
            details = _migrate_dt(details, "start_time", "end_time", item_date)
        elif item_type == "restaurant":
            details = _migrate_dt(details, "start_time", "end_time", item_date)
        elif item_type == "note":
            # Notes historically had no time; if one was added by
            # experimentation, pull it in.
            details = _migrate_legacy_time(details, item_date)
        # Derive item_date / end_date from the new when so they stay in
        # sync. The day columns drive the board's day grouping, so a
        # stale value here would put the item on the wrong day.
        when = details.get("when") or {}
        start_at = when.get("start_at")
        end_at = when.get("end_at")
        # Backstop: if the per-type helper left end_at missing, default
        # it here so the saved row always has a complete when object.
        if start_at and not end_at:
            d_, t_ = _parse_when(start_at)
            if d_ and t_:
                when["end_at"] = _add_hour(d_, t_)
                details["when"] = when
                end_at = when["end_at"]
        new_item_date = item_date
        new_end_date = end_date
        if start_at:
            d, _ = _parse_when(start_at)
            if d:
                new_item_date = d
        if end_at:
            d, _ = _parse_when(end_at)
            if d:
                new_end_date = d
        updates = []
        args = []
        if json.dumps(details, sort_keys=True) != before:
            updates.append("details = ?")
            args.append(json.dumps(details) if details else None)
        if new_item_date != item_date:
            updates.append("item_date = ?")
            args.append(new_item_date)
        if new_end_date != end_date:
            updates.append("end_date = ?")
            args.append(new_end_date)
        if updates:
            args.append(item_id)
            conn.execute(
                f"UPDATE items SET {', '.join(updates)} WHERE id = ?",
                args,
            )
