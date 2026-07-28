"""Small shared helpers: JSON responses and money parsing/formatting."""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from datetime import date

from flask import jsonify


# Same short month names the frontend's fmtDate() uses, so server-rendered
# headers don't "flash" to a different format on the first paint.
_MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def fmt_date(iso):
    """Format an ISO date string (YYYY-MM-DD) the same way as
    frontend's fmtDate() — "Jul 1, 2026". Returns '' for falsy / unparseable
    values so the template can use `{{ fmt_date(plan.start_date) }}`
    without a NoneType check. Also accepts a `date` object directly."""
    if not iso:
        return ""
    if isinstance(iso, date):
        d = iso
    else:
        try:
            d = date.fromisoformat(iso)
        except (TypeError, ValueError):
            return ""
    return f"{_MONTHS[d.month - 1]} {d.day}, {d.year}"


def ok(payload=None, **extra):
    """Return a 200 JSON response. ``ok({"x":1})`` or ``ok(x=1)``."""
    if payload is None:
        payload = {}
    if isinstance(payload, dict):
        payload.update(extra)
        return jsonify(payload)
    return jsonify({"data": payload, **extra})


def err(message: str, status: int = 400, **extra):
    return jsonify({"error": message, **extra}), status


def check_version(row: dict | None, data: dict) -> dict | None:
    """If the client sent `expected_updated_at`, verify it matches the
    current row's `updated_at`. Return a 409 response dict on mismatch,
    or None if the version is acceptable (or not checked)."""
    if not row:
        return None
    expected = data.get("expected_updated_at")
    if expected and row.get("updated_at") and row["updated_at"] != expected:
        return {
            "error": "conflict",
            "message": "This data was modified by another user. Reload and try again.",
            "current": row,
        }
    return None


def parse_amount_to_cents(amount, decimals: int = 2) -> int:
    """Accept an int (cents), a numeric string (units, e.g. '120.00'), or a float.
    Returns integer cents in the currency's smallest unit."""
    if amount is None:
        raise ValueError("amount required")
    if isinstance(amount, bool):
        raise ValueError("invalid amount")
    if isinstance(amount, int):
        return amount  # already in cents
    try:
        d = Decimal(str(amount))
        factor = Decimal(10) ** decimals
        cents = (d * factor).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise ValueError("invalid amount")
    return int(cents)


def format_cents(cents: int, decimals: int = 2) -> str:
    factor = Decimal(10) ** decimals
    val = Decimal(cents) / factor
    if decimals <= 0:
        return f"{val:.0f}"
    return f"{val:.{decimals}f}"