"""007: Add ``payment_allocations`` so payments settle per-currency debt.

Before 007 a payment carried one currency and amount, and settlement applied
that amount to whichever currency's debt matched the payment's own currency —
its own-currency debt. A cross-currency payment (money paid in one currency to
retire debt in another) was therefore applied inconsistently between the
single- and per-currency settlement modes. This table records, per payment,
which currency-debt each part of the payment retires, in the debt currency's
own minor units, so both modes derive remaining balances from one path.

The backfill gives every existing payment a single allocation in its own
currency equal to its full amount: the pre-007 behavior, so recorded data does
not move. ``IF NOT EXISTS`` and ``INSERT OR IGNORE`` make the migration
idempotent and safe to re-run.
"""
from __future__ import annotations

id = "007_payment_allocations"


def run(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS payment_allocations (
          payment_id   INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
          currency     TEXT NOT NULL,
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          PRIMARY KEY (payment_id, currency)
        )
    """)
    conn.execute(
        """INSERT OR IGNORE INTO payment_allocations (payment_id, currency, amount_cents)
           SELECT id, currency, amount_cents FROM payments"""
    )
