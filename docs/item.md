# Item Design

## Overview

An **item** is the core unit of a trip itinerary — a single entry on a day's schedule. Items are **not** formal classes anywhere in the codebase; they are plain `dict` objects (Python) or plain `Object` values (JavaScript) flowing between the SQLite DB, the JSON API, the staging engine, and the UI.

---

## Database Schema

```sql
CREATE TABLE items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL,            -- hotel|transit|restaurant|activity|note
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
```

---

## Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `int` | autoincrement primary key; unsaved local drafts use a `_-<N>` string |
| `plan_id` | `int` | foreign key to `plans.id` |
| `item_type` | `string` | type discriminator (see below) |
| `title` | `string` | display title |
| `item_date` | `string`/`null` | ISO date `YYYY-MM-DD` — the day column this item renders in |
| `end_date` | `string`/`null` | ISO date — for spanning types (hotel); item renders on every day in `[item_date, end_date)` |
| `sort_key` | `float` | fractional ordering; recalculated by the staging engine on drag |
| `status` | `string` | `planned` (default), `confirmed`, or `done` |
| `details` | `object` | type-specific JSON blob (see per-type fields below) |
| `created_by` | `int`/`null` | FK to `users.id` |
| `created_at` | `string` | ISO datetime |
| `updated_at` | `string` | ISO datetime |

---

## Item Types

Defined in `data/config/settings.json` (served to the frontend via
`GET /api/settings`) and validated against the hardcoded `ITEM_TYPES` set in
`backend/blueprints/items.py`. Each type has a `label`, `icon` (for UI),
`spans_days` flag, and a typed field list that drives the editor form.

### hotel
- **spans_days:** `true` — renders across `[item_date, end_date)`
- `hotel_name`, `address`, `check_in_time`, `check_out_time`, `booking_ref`, `note`

### transit
- **spans_days:** `false`
- A unified type for flights, trains, buses, ferries, taxis, and rental cars.
  The `mode` field (select) distinguishes the sub-type at entry time.
- `mode` (Flight/Train/Bus/Ferry/Taxi/Rental car), `provider`, `ref_no`,
  `from`, `to`, `depart_time`, `arrive_time`, `seat`, `confirmation`, `note`

### activity
- **spans_days:** `false`
- `name`, `location`, `start_time`, `end_time`, `note`

### restaurant
- **spans_days:** `false`
- `name`, `address`, `start_time`, `end_time`, `party_size`, `note`

### note
- **spans_days:** `false`
- `text`

---

## Companion Data (attached to item after loading)

### Attachments (`attachments`)

Stored in the `attachments` table:

```sql
CREATE TABLE attachments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('image', 'link')),
  value    TEXT NOT NULL,   -- URL (link) or file path (image)
  caption  TEXT NOT NULL DEFAULT ''
);
```

Two kinds:
- **image** — server-side file upload, value is a relative path under `data/uploads/`
- **link** — arbitrary URL

### Geocodes (`geocodes`)

Stored in the `item_geocodes` table. Each item can have 0+ geocoded points (lat/lng + label), manually added or reverse-geocoded from an address field.

```sql
CREATE TABLE item_geocodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

---

## Frontend Shape

At runtime, items carry additional transient fields:

| Field | Type | Description |
|-------|------|-------------|
| `isLocal` | `boolean` | `true` for unsaved local drafts (frontend-only) |
| `isNew` | `boolean` | `true` for brand-new items not yet saved |
| `attachments` | `array` | list of attachment objects (loaded via `_attach()`) |
| `geocodes` | `array` | list of geocode objects (loaded via `_attach()`) |

The `_attach()` function in `backend/blueprints/items.py:64` decorates raw DB rows with parsed `details` (JSON), `attachments`, and `geocodes`.

---

## Clipboard Serialization

When cut/copy-pasting items, only a portable subset is serialized (see `frontend/static/js/clipboard.js:66`):

```js
{
  item_type, title, details, status, item_date, end_date,
  links: [{ value, caption }]   // image attachments dropped
}
```

---

## API Endpoints

Item CRUD lives in `backend/blueprints/items.py`; image upload lives in
`backend/blueprints/uploads.py`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plans/<id>/items` | list all items for a plan |
| `POST` | `/api/plans/<id>/items` | create a new item |
| `PATCH` | `/api/items/<id>` | edit item fields (title, dates, status, details, geocodes) |
| `DELETE` | `/api/items/<id>` | delete an item |
| `POST` | `/api/items/<id>/move` | drag-and-drop reorder/move |
| `POST` | `/api/items/<id>/attachments` | add a link attachment |
| `PATCH` | `/api/attachments/<id>` | update a link attachment (value/caption) |
| `DELETE` | `/api/attachments/<id>` | delete an attachment (image or link) |
| `POST` | `/api/items/<id>/upload` | upload an image attachment (multipart) |

Geocodes are saved via the `geocodes` field in the `PATCH /api/items/<id>`
body (an array of `{ label, lat, lng, sort_order }`). Image attachments are
stored in the `attachments` table with `kind='image'` and are deleted via
`DELETE /api/attachments/<id>`.

Items also link to `expenses` (0+ per item) via `expenses.item_id`.

---

## Key Design Decisions

1. **No ORM / no class** — items are plain dicts everywhere. The Python backend uses `sqlite3.Row` + `dict()` conversion. The JS frontend uses plain objects.
2. **Type-specific fields go in `details` JSON** — the core schema stays generic; type-specific UI fields are driven purely by `settings.json`.
3. **`spans_days`** — only `hotel` currently spans days. The item renders on every day in `[item_date, end_date)`.
4. **`sort_key`** — fractional indexing (similar to jira) to avoid reindexing siblings on every drag. Recalculated by the staging engine.
5. **Two-phase save** — items can exist as local drafts (`isLocal`, `isNew`) before being committed to the server via the staging/pending bar.
