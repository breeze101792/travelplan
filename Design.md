# Plan pages — design

The two pages under `/plans/<id>/` (board = `plan.html`, timeline =
`timeline.html`) are two views over the same plan data. They share an
item model, a staging engine, an editor, and a chrome (header, pending
bar, toolbar, buffer-day controls). The two views differ in *how* they
lay items out; the *what* (item create / edit / move / stage / save)
is the same engine under both.

This file is the design contract for those two pages — both the parts
that are already wired and the parts that are still a TODO. If you are
adding a new feature, start here.

## Architecture

```
                plan.html           timeline.html
                ────────           ─────────────
template   plan.html           timeline.html
init       initItinerary()     initTimeline()
view       day columns         hour-of-day columns
items      one card per day    one bar per item at its time
           each card = one item, each day = a vertical list of cards
interaction
  ⌘+click   multi-select         multi-select
  right-clk  context menu         context menu
  ⌘A         select all           select all
  ⌘C/X/V/D   copy/cut/paste/dupe  copy/cut/paste/dupe
  drag       move item to a day   move item to time-of-day,
                                     or across days if dragged >30%
  resize     — (only via editor)  drag top/bottom edge of a bar
  click      select item          select item
  dblclick   open editor          open editor
  delete key remove selection     remove selection

shared
  header            plan title + date range (click to edit)
  pending bar       Revert / Redo / Save + status
  add-toolbar       +1/-1 day range controls, + Buffer day, Quick add
  buffer days       "scratchpad" days outside the trip range
  item editor       modal with type-specific fields, attachments, expenses
```

The two pages are *views*, not *modes*. They re-fetch the same `/api/plans/<id>/items`
and re-render the same staging engine's `viewItems()`. Switching
between them does not lose state — the pending bar's staged ops are
the same ops the other page would stage.

## Data model

`item.details` is a JSON column with one shape per `item_type`. For
every timed type the shape is mandatory:

```
flight:     { depart_time, arrive_time, ... }
train:      { depart_time, arrive_time, ... }
ticket:     { start_time,  end_time,     ... }
restaurant: { start_time,  end_time,     ... }   (was { time } before)
transport:  { start_time,  end_time,     ... }   (was { time } before)
activity:   { start_time,  end_time,     ... }
hotel:      { hotel_name, check_in_time, check_out_time, end_date on item, ... }
```

The `time` field on legacy rows is read by the timeline as a 1h bar
fallback; the next save writes `start_time` + `end_time` back so the
new shape is persisted (see `itemTimeWindow()` in `timeline.js` and
`makeFieldInput()` in `item-editor.js`).

`plan.buffer_days` is a list of `YYYY-MM-DD` strings that live on a
"scratchpad calendar" (year 9999) so they can never collide with a
trip date, regardless of how the trip range moves. The (plan_id, date)
pair is the unique key on `items`, so the date must be unique per
plan — `nextBufferDate()` walks 9999-12-31, 9999-12-30, … to find the
first free slot.

## Staging engine

The single source of truth for "what's the user trying to do, vs
what's the server confirmed last time they saved". Lives in
`static/js/staging.js`. Imported by both pages.

Concepts:

- `base` — last server-confirmed state (`baseItems`, `basePlan`).
- `ops` — ordered list of staged operations, with a `pointer` that
  points at the *applied* prefix. Undo moves the pointer back; redo
  moves it forward; a new add truncates the redo tail.
- `viewItems()` / `viewPlan()` — re-derive the visible state by
  applying `ops[0..pointer-1]` to `base`. Both pages render from this.
- `sessionOps` — ops that came in via a single editor session
  (e.g. a quick-add → editor → Apply). On Cancel, `discardSession()`
  removes them so the editor's preview is rolled back.

Op kinds the engine knows: `updatePlanTitleOp`, `updatePlanDatesOp`,
`updatePlanBufferDaysOp`, `updateItemOp`, `createBlankItemOp`,
`saveItemOp`, `deleteItemOp`, `moveItemOp`, `addLinkOp`,
`deleteAttachmentOp`, `uploadImageOp`, `addExpenseOp`,
`createItemsFromClipOp`, `timeEditItemOp`. Each has a one-line label
("Reschedule X", "Delete Y", …) shown in the pending bar.

`saveAll({ post, patch, del, upload })` walks the op list, calls the
matching API call for each, then resets `base` to the canonical
post-save state. A failed op halts the save and surfaces the error in
the pending bar (the user can Revert to roll back everything staged so
far).

## Pending bar

`<div id="pending-bar">`. Sticky to the top of the page. Both pages
include it in the same place in the template (right after the header).

Reads `staging.hasPending`, `staging.canUndo`, `staging.canRedo`,
`staging.saving`, `staging.failedOpIndex`. Buttons:
- `+ Add` (board only) — opens a type picker that stages a blank
  item and opens the editor. The timeline doesn't have an `+ Add`; the
  user clicks `Quick add` in the toolbar instead.
- `↶ Revert` — `staging.undo()`.
- `↷ Redo` — `staging.redo()`.
- `Save` — `staging.saveAll()`. Disabled while `saving` or with no
  pending changes.
- status text — last op's label + a `pb-failed` / `pb-blocked` class
  on a server error or a guarded action (e.g. "Can't trim the start
  — 2026-07-01 has items").

The bar is hidden entirely for `viewer` role. The beforeunload
listener (`window.addEventListener('beforeunload', …)`) calls
`preventDefault` when `staging.hasPending`, so the browser prompts
before the user navigates away with unsaved changes.

## Drag and drop

Board (`board.html` is the only file that drags; the timeline
delegates to timeline-internal pointer-based drag, see below). Native
HTML5 drag-and-drop, wired by `enableDragDrop` in
`static/js/board/drag.js`. The board's `card.draggable = true`
firing `onMove(itemId, { item_date, before_id, after_id })` and
`onUpload(itemId, file)` callbacks. Both callbacks are wired to the
staging engine:

- `onMove` stages a `moveItemOp` per item in the multi-selection (so
  dragging a single card while 3 are selected moves all 4). For
  spanning types (`spans_days: true`) it preserves the relative
  `end_date` by computing the new end_date = new_item_date + (end_date
  - item_date) on the client. Local (unsaved) drags open the editor
  instead of staging a move, because the editor's Apply captures the
  new date as part of the snapshot.
- `onUpload` stages an `uploadImageOp` for a real id, or opens the
  editor (and defers) for a local id.

Timeline. The timeline has its own pointer-based drag in
`timeline.js:wireBarDrag`. Body drag = move the bar to a new time
(same day) or to a new day (if the user drags the bar 30%+ of the
column width across the boundary). Top/bottom edge = resize. Edges
snap to the nearest 30-minute mark; the new end is clamped to
`[startH + 0.5h, 24h]` so a bar never goes below 30 minutes or past
midnight. Multi-drag: if the dragged bar is in a multi-selection, all
selected items shift by the same delta and to the same target day,
each keeping its own duration.

Both pages call into the same `timeEditItemOp` (defined in
`staging.js`) which PATCHes `item_date` + `details.start_time` +
`details.end_time` in one server call.

## Multi-select and context menu

Both pages share the same UX (modeled on macOS Finder):

- Plain click → open the item editor.
- ⌘ / Ctrl + click → toggle that one item in the selection.
- Shift + click → range select. On the board, the range walks the
  *board sequence* (day-then-position); on the timeline, it walks
  the *bar sequence* (day-then-start-time). Hotels are skipped in
  both — they're spans, not discrete items, and they don't make
  sense as part of a "move / cut / copy" selection.
- ⌘A → select every non-spanning item.
- ⌘C / ⌘X / ⌘V / ⌘D → clipboard: copy / cut / paste / duplicate the
  selection. Paste targets the *focused day* (board) or the
  *first-selected item's day* (timeline, where there's no day-click
  concept). Cutting stages a `deleteItemOp` chained to the paste's
  `createItemsFromClipOp` under the same session id so Cancel
  discards both.
- Right-click → opens the context menu. Right-clicking an unselected
  card adds it to the selection first (one-shot), so the menu acts
  on it.
- Delete / Backspace → delete the selection (stages one
  `deleteItemOp` per item).
- Escape → close the context menu, then clear the selection.
- Clicking on a non-interactive blank area (day section padding,
  plan header, board's outer margin) → clear the selection.

Both pages have the same `context-menu` block. Lives in
`item-editor.css` (extracted from `board.css` so the timeline doesn't
have to load the full board stylesheet). Toast layer also lives
there; toast kinds are `toast-warn` (e.g. "hotels can't be multi-
selected") and `toast-error`. Auto-dismiss after 3s.

## Buffer days

A buffer day is a trip-day-shaped column that sits *outside* the
trip's `start_date`..`end_date` range. It exists so the user can
park items they're "not sure about yet" without polluting the trip
itself. The data model is just a list of extra dates on the plan:

```sql
-- plans table
buffer_days  TEXT    -- JSON array of YYYY-MM-DD strings
```

`buildDays(plan)` on the board (and now on the timeline, after this
work) returns a unified `day[]` with `is_buffer: true` on the buffer
entries. The board then styles buffer days with a dashed border +
soft tint, hides the day number / date in the title (just "Buffer"),
and shows a × chip that calls `stageBufferRemove(date)`. The
× chip refuses to fire if the buffer has any items on it (block
error: "Can't remove this buffer day — it has item(s)").

`+ Buffer day` in the add-toolbar (both pages) calls
`nextBufferDate(plan)`, which walks 9999-12-31, 9999-12-30, … until
it finds a free slot. Each click of `+ Buffer day` adds the next-earlier
buffer.

**TODO (timeline):** Before this work, the timeline called
`buildDays(plan)` that returned only trip days. With buffer support
the timeline now calls the same shared `buildDays` (in
`plan-header.js` — see `Refactoring plan` below), gets the unified
list, and `renderDay` skips the hour gridlines for buffer days
(no schedule, just a holding area).

## Plan header

The header at the top of all four plan pages (Board / Timeline /
Expenses / Share) has the same markup. It comes from the shared
`_plan_header.html` Jinja partial, so the four templates can't drift:

```html
<header class="plan-header">
  <div class="plan-head-main">
    <h1 id="plan-title" class="plan-title">…</h1>
    <p id="plan-dates" class="plan-dates">…</p>
    <p class="plan-currency">Base currency: <strong id="plan-currency">…</strong></p>
  </div>
  <nav class="plan-nav-wrap">…</nav>
</header>
```

Each plan page sets `plan_active_page = 'board' | 'timeline' | 'expenses' | 'share'`
before including the partial, which highlights the right tab in the nav.

**Server-side date formatting.** The partial uses a `fmt_date()` helper
(injected via context processor in `app.py`, defined in `backend/util.py`)
that produces the same `"Mon DD, YYYY"` format as the frontend's
`fmtDate()`. This eliminates the "flash" the user would otherwise see
on first paint — without server formatting, the template renders
`2026-09-10 → 2026-09-12` (raw ISO), then the page's JS rewrites it
to `Sep 10, 2026 → Sep 12, 2026` a moment later. With server formatting
the first paint already shows the formatted string, so there's nothing
to rewrite (and the inline-edit repaint is a no-op for the date format).

Wired by `wirePlanHeader()` in `plan-header.js` (loaded only on Board
and Timeline — the Expenses/Share pages show a static header). The
title and dates become inline-editable (click → input → blur or Enter
commits, Escape reverts) on the two editor pages. Edits are staged,
not auto-saved: the user clicks Save in the pending bar. The
plan-currency line is read-only; currency is set on the plan itself,
not per-item.

The board's wireHeader / beginTitleEdit / beginDatesEdit / paintDates
were copy-pasted into the timeline in earlier work. This file
extracts them into a single source of truth so the two pages can't
drift — same for the toolbar (range controls, + Buffer day, Quick
add).

## Add toolbar (range + buffer + quick add)

The board has had the `add-toolbar` since the start. Before this
work, the timeline had no toolbar at all. With the new shared
`plan-header.js`, both pages get the same toolbar:

```
[‹ +1 day]  [−1 day ›]    |    [‹ −1 day]  [+1 day ›]    [+ Buffer day]    Quick add (Day N): [Hotel] [Activity] [Note] ...
```

Buttons:
- `‹ +1 day` / `−1 day ›` — extend the trip start by 1 day / trim.
- `‹ −1 day` / `+1 day ›` — same for the trip end.
- `+ Buffer day` — adds a buffer day.
- `Quick add (Day N)` — picker of type buttons, where N is the
  *focused day*. On the board, focused day is the day the user last
  clicked. On the timeline (no day-click concept), focused day is
  the day of the first item in the multi-selection, or day 0.

Trim guards: trimming an edge is blocked if the day being removed has
items on it. The user must move or delete them first. The block
message is shown in the pending bar as `pb-blocked` (red text).

The toolbar is hidden for `viewer` role.

## Refactoring plan (this work)

To make "the two pages are two views over the same data" real:

1. Extract the shared code into `static/js/plan-header.js`:
   - `buildDays(plan)` — same shape both pages use.
   - `wirePlanHeader({ plan, staging, ctx, onChange })` — title +
     dates + range-block messages.
   - `renderPlanToolbar({ days, settings, staging, ctx, onChange })` —
     range controls + Buffer day + Quick add.
   - `nextBufferDate(plan)` and `stageBufferAdd`, `stageBufferRemove` —
     buffer helpers.
   - `extendStartBy(delta)`, `extendEndBy(delta)` — guarded range
     extend/trim.

2. `itinerary.js` imports from `plan-header.js` and keeps the same
   behavior. The existing functions there are removed; the call sites
   (the `initItinerary()` boot path) call the shared ones.

3. `timeline.js` gets the same imports and uses the same toolbar. Its
   `renderDay` is taught about `is_buffer: true` days: skip the hour
   gridlines, draw a "+ Add item" pill (timeline doesn't have a
   per-card "Add item" dropdown, the board does), and show a × chip
   for removing the buffer.

4. `timeline.html` template includes `#add-toolbar` (currently only
   `plan.html` has it).

5. The header `wireHeader` is removed from both page modules; both
   import `wirePlanHeader` from `plan-header.js`.

The shared module is a *contract* — the rule is: "if you change the
header on one page, you change it on both, in the same commit,
because the code lives in one place." That's the test: an inline-edit
on the board's title is reflected on the timeline in the same render
cycle, no extra wiring.

## Shared template partial

The same "one source of truth" rule applies on the template side:
all four plan pages (`plan.html`, `timeline.html`, `expenses.html`,
`share.html`) include `_plan_header.html` for the header markup.
Before this, the four templates each had their own copy of the
`<header class="plan-header">…</header>` block, and the share page
didn't even include the dates line. The partial fixes both: the four
pages can't drift, and they all show the same title + dates + currency
+ nav. Each page sets `plan_active_page` before including the partial
so the right tab gets `aria-current="page"`.

The partial also uses server-side date formatting (via `fmt_date()`
in `backend/util.py`, injected as a context processor in `app.py`)
to match the frontend's `fmtDate()`. Without this, the first paint
shows raw ISO (`2026-09-10 → 2026-09-12`) and the page's JS rewrites
it to `Sep 10, 2026 → Sep 12, 2026` a moment later — the "flash"
the user saw. With server formatting, the first paint already shows
the formatted string, so there's nothing to rewrite.

## Future ideas (not yet implemented)

- Drag a buffer day to reorder it within the buffer list. Currently
  `nextBufferDate()` is monotonic (always picks the next-earlier free
  date); reordering would need a separate op.
- Multi-day range select on the timeline (select the bars between
  two hours across days, e.g. 09:00 on Day 2 → 11:00 on Day 4).
  Currently the timeline range-selects on the bar sequence, not on
  a time range.
- Inline editing of item fields on the timeline (e.g. click the
  bar to change the title, not just open the editor). The board
  has a "click title to rename" affordance; the timeline doesn't
  yet.
- Timeline "Now" line + jump-to-today button (the "now" line is
  drawn, but there's no way to scroll the timeline horizontally to
  the current day).
