-- TravelPlan schema. All money is integer cents; `decimals` drives display.
-- Splits are computed once at creation and cached immutably in expense_splits.owed_cents.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  start_date   TEXT,   -- ISO date; trip range drives the day columns
  end_date     TEXT,
  base_currency TEXT NOT NULL DEFAULT 'USD',  -- ISO 4217; settlement target currency
  cover_image  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-plan sharing. Owner is implicit via plans.owner_id; this table holds the rest.
CREATE TABLE IF NOT EXISTS plan_members (
  plan_id   INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor','viewer')),
  added_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_id, user_id)
);

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL,            -- hotel|flight|train|ticket|restaurant|activity|transport|note
  title      TEXT NOT NULL,
  item_date  TEXT,                     -- start date (the day this item belongs to)
  end_date   TEXT,                     -- nullable; hotel = check-out; rendered on every day in [start,end)
  sort_key   REAL NOT NULL DEFAULT 0,  -- fractional ordering for drag reorder
  status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done')),
  details    TEXT,                      -- JSON of type-specific basic fields
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_plan ON items(plan_id, item_date);

-- Per-plan buffer days: a planning scratchpad for items the user isn't sure
-- about yet. Distinct from the trip's [start_date, end_date] range; can sit
-- outside that range or inside it. Each (plan, date) is unique. Cascades on
-- plan delete.
CREATE TABLE IF NOT EXISTS plan_buffer_days (
  plan_id  INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  date     TEXT    NOT NULL,
  PRIMARY KEY (plan_id, date)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('image','link')),
  value      TEXT NOT NULL,            -- stored filename (image) or URL (link)
  caption    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expense engine (Splitwise-style). expense_splits.owed_cents is immutable once written.
CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,  -- optional link to an item
  description  TEXT NOT NULL,
  currency     TEXT NOT NULL,          -- this expense's own currency (ISO 4217)
  decimals     INTEGER NOT NULL DEFAULT 2,
  total_cents  INTEGER NOT NULL CHECK (total_cents > 0),
  split_method TEXT NOT NULL DEFAULT 'EQUAL'
               CHECK (split_method IN ('EQUAL','EXACT','PERCENTAGE','SHARES')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_plan ON expenses(plan_id);
CREATE INDEX IF NOT EXISTS idx_expenses_item ON expenses(item_id);

CREATE TABLE IF NOT EXISTS expense_payers (          -- who paid (one or more)
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid_cents INTEGER NOT NULL CHECK (paid_cents > 0),
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE IF NOT EXISTS expense_splits (          -- who owes how much (cached, immutable)
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value_cents INTEGER,   -- EXACT: amount owed (cents)
  value_denom INTEGER,   -- PERCENTAGE: basis points (10000 = 100%); SHARES: count
  owed_cents  INTEGER NOT NULL CHECK (owed_cents >= 0),
  PRIMARY KEY (expense_id, user_id)
);

-- User-supplied exchange rates (saved so settlement is reproducible).
CREATE TABLE IF NOT EXISTS plan_rates (
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  currency   TEXT NOT NULL,
  rate       REAL NOT NULL,            -- multiplier from this currency to plan.base_currency
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_id, currency)
);

-- Real-world transfers recorded by users to track "settled".
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id   INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_plan ON payments(plan_id);