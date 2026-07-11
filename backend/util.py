"""Small shared helpers: JSON responses and money parsing/formatting."""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from flask import jsonify


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


def parse_amount_to_cents(amount, decimals: int = 2) -> int:
    """Accept an int (cents), a numeric string (units, e.g. '120.00'), or a float.
    Returns integer cents in the currency's smallest unit."""
    if amount is None:
        raise ValueError("amount required")
    if isinstance(amount, bool):
        raise ValueError("invalid amount")
    if isinstance(amount, int):
        return amount  # already in cents
    d = Decimal(str(amount))
    factor = Decimal(10) ** decimals
    cents = (d * factor).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return int(cents)


def format_cents(cents: int, decimals: int = 2) -> str:
    factor = Decimal(10) ** decimals
    val = Decimal(cents) / factor
    if decimals <= 0:
        return f"{val:.0f}"
    return f"{val:.{decimals}f}"