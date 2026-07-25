/* timeline.js — 24-hour timeline view of a plan.
 *
 * initTimeline({ planId, role })
 *
 * Renders each day as a vertical lane (0:00 at top → 24:00 at bottom) and
 * draws each timed item as a bar positioned by its start/end time-of-day.
 * Hotels appear as a thin band on every day in their date range. Items with
 * no time (notes) appear as a chip strip below the day. Overlapping bars in
 * the same day are stacked side-by-side so nothing hides another item.
 * Buffer days (scratchpad, year 9999) render as their own columns without
 * hour gridlines — a planning scratchpad, not a schedule.
 *
 * Drag/resize (owner/member only): grab a bar to change its time-of-day,
 * drag across day columns to move the item to a different day, drag the top
 * or bottom edge to resize start/end. Snaps to 30-minute increments. Each
 * gesture stages a TIME_EDIT op via the Staging engine so it shares the
 * board's pending bar (Save / Revert) — the change is not persisted until
 * the user clicks Save.
 *
 * Data sources (same as the board):
 *   GET /api/plans/<id>            - plan (title, dates, base_currency)
 *   GET /api/plans/<id>/items      - items; each has item_type, item_date,
 *                                    end_date, details (JSON of type-specific
 *                                    fields with time-of-day)
 */
import { apiGet, apiPost, apiPatch, apiDel } from '/static/js/api.js';
import { el, clear, loadSettings } from '/static/js/util.js';
import { Staging, timeEditItemOp, moveItemOp, deleteItemOp, createItemsFromClipOp, createBlankItemOp } from '/static/js/staging.js';
import { openItemEditor } from '/static/js/item-editor.js';
import { clipboardGet, clipboardSet, serializeItem } from '/static/js/clipboard.js';
import { buildDays, isoOf, wirePlanHeader, renderEditBar, makeDayActions } from '/static/js/plan-header.js';
import { expandHotelEvents } from '/static/js/hotel-events.js';

let HOUR_PX = 36;     // recalculated by updateScale() to fill viewport

/* ---------- helpers ---------- */

// Extract the hour-of-day (0–24, float) from a field value. The field may be
// a `datetime-local` value ("YYYY-MM-DDTHH:MM" or with seconds) or a bare
// "HH:MM". Returns null if the value is missing/unparseable.
function timeOfDay(v) {
  if (v == null) return null;
  const s = String(v);
  const m = s.match(/T?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23) return null;
  return h + min / 60;
}

// Field name to read for an item type's "start time of day".
// (Single-source so adding a new type only needs one edit.)
//
// Every timed item type has BOTH a start and an end field on its
// details. restaurant and transport used to have only `time` (a point
// in time), which made the resize handles write to nothing; both have
// been moved to start_time + end_time so they share the same
// drag/resize contract as activity/ticket/flight/train. The
// default-fill in itemTimeWindow() below handles existing rows that
// only have `time`.
const TIME_FIELDS = {
  hotel:      { start: 'time',      end: 'time'       },
  transit:    { start: 'depart_time', end: 'arrive_time', label: 'transit' },
  flight:     { start: 'depart_time', end: 'arrive_time', label: 'flight' },
  train:      { start: 'depart_time', end: 'arrive_time', label: 'train' },
  ticket:     { start: 'start_time',  end: 'end_time'    },
  restaurant: { start: 'start_time',  end: 'end_time'    },
  activity:   { start: 'start_time',  end: 'end_time'    },
  transport:  { start: 'start_time',  end: 'end_time'    },
};

/* Does this item type have a real `end` field on its details, or is the
 * end time synthesized as a default (e.g. 1h after start) for display
 * only? If the type has no real end, the timeline should NOT offer
 * resize handles — dragging them would set a value the data model
 * doesn't store, and the bar would snap back on re-render, leaving the
 * user thinking "the resize is broken". */
function typeHasEndField(itemType) {
  return !!(TIME_FIELDS[itemType] && TIME_FIELDS[itemType].end);
}

// For a given item, return { start: hours, end: hours } on the item's date,
// or null if no time info is available.
//
// Backward compat: items that pre-date the restaurant/transport →
// start_time + end_time migration still have only a `time` field. We
// treat that as a 1h bar (start = time, end = start + 1h) so the bar
// still renders, just with a default duration. The next save writes
// both start_time and end_time back so the new shape persists.
function itemTimeWindow(item) {
  const d = item.details || {};
  if (item.item_type === 'hotel') {
    if (item._hotelEvent) {
      // Check-in / check-out events — render as timed bars.
      const time = timeOfDay(d.time);
      if (time != null) return { start: time, end: time + 1 };
      return null;
    }
    // Regular spanning hotels are handled by renderHotelStays() below.
    return null;
  }
  const f = TIME_FIELDS[item.item_type];
  if (!f) return null;
  // Try the new shape first, then the legacy `time` field. The legacy
  // fallback keeps pre-migration data rendering correctly without
  // forcing a server-side rewrite.
  const start = timeOfDay(d[f.start] || d.time);
  if (start == null) return null;
  let end = f.end ? timeOfDay(d[f.end]) : null;
  if (end == null) end = start + 1; // 1-hour default for legacy single-time data
  if (end < start) end = start + 0.5; // arrive before depart => treat as instant
  return { start, end };
}

// Nights a hotel covers (check-in inclusive, checkout exclusive — matches the
// board's "hotel renders on every night" rule). Single-night stays return
// [checkin] (1 element). Hotel without an end_date returns [].
function hotelNights(item) {
  if (item.item_type !== 'hotel' || !item.item_date || !item.end_date) return [];
  const out = [];
  const d = new Date(item.item_date + 'T00:00:00');
  const end = new Date(item.end_date + 'T00:00:00');
  while (d < end) {
    out.push(isoOf(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Position of a hotel stay within a hotel's night list ("first", "middle",
// "last", or "only" for single-night stays). Returns null for non-hotels.
function hotelPosition(hotelItem, date) {
  const nights = hotelNights(hotelItem);
  if (!nights.length) return null;
  const i = nights.indexOf(date);
  if (i < 0) return null;
  if (nights.length === 1) return 'only';
  if (i === 0) return 'first';
  if (i === nights.length - 1) return 'last';
  return 'middle';
}

// Stack overlapping bars side-by-side within a day. Each bar gets a
// "column index" in [0..maxCols) so its horizontal width is colWidth.
//
// Algorithm: sort by start, then by descending duration, then by main-vs-backup
// (main items claim the leftmost columns first — so the plan is always
// to the left of the alternative). For each bar, find the lowest column
// index whose previous occupant ends at or before the new bar's start;
// if none, append a new column. This is the standard interval
// graph-coloring / strip-packing approach.
function assignColumns(intervals) {
  // intervals: [{start, end, isBackup}], returns same array augmented with .col
  // The minimum bar height (20px) makes a bar visually taller than its
  // temporal span, so we use a "visual end" that accounts for that when
  // deciding whether two items can share a column.
  function visualEnd(it) {
    const naturalPx = (it.end - it.start) * HOUR_PX;
    return it.start + Math.max(20, naturalPx) / HOUR_PX;
  }
  function visuallyOverlap(a, b) {
    return a.start < visualEnd(b) && b.start < visualEnd(a);
  }
  const sorted = intervals.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if ((b.end - b.start) !== (a.end - a.start)) return (b.end - b.start) - (a.end - a.start);
    return (a.isBackup ? 1 : 0) - (b.isBackup ? 1 : 0);
  });
  // First pass — assign columns based on visual end (so a short bar that
  // gets stretched to 20px still blocks the column until its visual bottom).
  const cols = [];
  for (const it of sorted) {
    let placed = -1;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i] <= it.start) { placed = i; break; }
    }
    if (placed === -1) { placed = cols.length; }
    cols[placed] = visualEnd(it);
    it.col = placed;
  }
  // Second pass — count columns whose items visually overlap this one,
  // so side-by-side items each get the correct narrowed width.
  const colByItem = new Map(sorted.map(it => [it, it.col]));
  for (const it of sorted) {
    const overlapCols = new Set([colByItem.get(it)]);
    for (const other of sorted) {
      if (other === it) continue;
      if (visuallyOverlap(it, other)) {
        overlapCols.add(colByItem.get(other));
      }
    }
    it.totalCols = overlapCols.size;
    if (it.totalCols === 1) it.col = 0;
  }
  return sorted;
}

function updateScale(root) {
  const top = root.getBoundingClientRect().top;
  const avail = window.innerHeight - top - 16;
  HOUR_PX = Math.max(36, Math.floor(avail / 24));
  root.style.setProperty('--tl-h', HOUR_PX + 'px');
}

/* ---------- rendering ---------- */

// Build one .tl-item bar positioned in the day column. Shared by every item
// type (hotels, flights, etc.) so they all share the same visual language.
// `extraClass` lets callers add additional classes (e.g. .tl-item-backup
// for alternative/backup items). When `draggable` is true, the bar gets
// resize handles and a grab cursor so the user can move/resize it on the
// timeline. Hotels always pass `draggable: false` — they are an overnight
// span, not a single point in time, so resizing is best done in the editor.
//
// When `item` is provided, the bar carries data-* attributes (id, time
// field names, source day, start/end hours) that the drag handler reads
// without re-looking-up the item. Hotels don't need any of this so the
// call site can omit `item`.
function makeBar({ kind, top, end, totalCols, col, title, time, titleText, extraClass = '', draggable = true, item, day, linkUrl }) {
  const w = totalCols || 1;
  const left = 22 + (col / w) * (100 - 22 - 4) + '%';
  const width = (1 / w) * (100 - 22 - 4) + '%';
  const topPx = top * HOUR_PX;
  const height = Math.max(20, (end - top) * HOUR_PX);
  const baseClass = `tl-item ${kind}` + (w > 1 ? ' multi' : '') + extraClass;
  // Hotels get a stable class hook so the CSS opt-out rule can target them.
  const isHotelEvent = item && item._hotelEvent;
  const klass = kind === 'hotel' && !isHotelEvent ? `${baseClass} tl-item-hotel` : baseClass;
  const node = el('div', {
    class: klass,
    style: `top:${topPx}px; height:${height}px; left:${left}; width:calc(${width} - 2px);`,
    title: titleText,
  }, [
    el('div', { class: 'tl-item-title', text: title || kind }),
    time ? el('div', { class: 'tl-item-time', text: time }) : null,
    linkUrl ? el('a', {
      class: 'tl-item-link', href: linkUrl, target: '_blank', rel: 'noopener',
      html: '🔗', title: 'Open link',
      onclick: (e) => e.stopPropagation(),
    }) : null,
  ]);
  if (item) {
    node.dataset.itemId = String(item.id);
    if (item._hotelEvent) {
      node.dataset.hotelEvent = item._hotelEvent;
      node.dataset.hotelId = String(item._hotelId);
    }
  }
  if (draggable && item && (kind !== 'hotel' || item._hotelEvent)) {
    const f = TIME_FIELDS[item.item_type] || {};
    const timeFields = item._hotelEvent
      ? { start: item._hotelEvent === 'check-in' ? 'check_in_time' : 'check_out_time',
           end:  item._hotelEvent === 'check-in' ? 'check_in_time' : 'check_out_time' }
      : { start: f.start || 'start_time', end: f.end || 'end_time' };
    node.dataset.timeField = JSON.stringify(timeFields);
    if (day) node.dataset.day = day;
    node.dataset.start = String(top);
    node.dataset.end = String(end);
    // Resize handles are wired for every draggable bar. The handles
    // read their start/end from the data-* attributes and commit them
    // to start_time / end_time on the item's details.
    node.appendChild(el('div', { class: 'tl-resize top',    'data-resize': 'top' }));
    node.appendChild(el('div', { class: 'tl-resize bottom', 'data-resize': 'bottom' }));
  }
  return node;
}

function renderHourCol() {
  const col = el('div', { class: 'hour-col' });
  for (let h = 0; h <= 24; h++) {
    col.appendChild(el('div', {
      class: 'hour-label' + (h % 6 === 0 || h === 0 || h === 24 ? ' major' : ''),
      text: h === 24 ? '24' : String(h).padStart(2, '0'),
    }));
  }
  return col;
}

function renderDay(day, items, settings, nowFraction, ctx, staging, setBlockError, onChange) {
  // Buffer days are a planning scratchpad — no hour gridlines, no hotel
  // bar, no "now" line. Just a column for items the user isn't sure
  // about yet. The shared `makeDayActions` adds the × close chip.
  const isBuffer = !!day.is_buffer;
  const sec = el('section', { class: 'day' + (isBuffer ? ' day-buffer' : '') });
  sec.appendChild(el('div', { class: 'day-head' }, [
    el('div', { class: 'date', text: day.label }),
    ctx ? makeDayActions(day, { ctx, staging, setBlockError, onChange }) : null,
  ]));

  const grid = el('div', { class: 'day-grid' });

  if (!isBuffer) {
    // Hour gridlines + labels (every 6 hours, since CSS already draws 1h lines).
    for (let h = 6; h <= 24; h += 6) {
      grid.appendChild(el('div', {
        class: 'hour-label major',
        style: `top: ${h * HOUR_PX}px;`,
        text: String(h).padStart(2, '0') + ':00',
      }));
    }
    // Half-hour faint lines.
    for (let h = 1; h < 24; h++) {
      grid.appendChild(el('div', { class: 'half-gridline', style: `top: ${h * HOUR_PX}px;` }));
    }

    // "Now" line if this day is today.
    if (nowFraction != null) {
      grid.appendChild(el('div', { class: 'now-line', style: `top: ${nowFraction * HOUR_PX}px;` }));
    }

    // Hotel stays: every night the trip is in the hotel, draw ONE compact bar
    // pinned to 23:00→24:00 at the bottom of the day (the "you'll be sleeping
    // here" indicator). Hotels are an overnight thing — they should never fight
    // for daytime space with flights, activities, or meals. The label on the
    // bar says what's happening that night: check-in time on the first night,
    // check-out time on the last night, "night N of M" in the middle.
    const HOTEL_TOP = 23;
    const HOTEL_END = 24;
    const tiHotel = settings.item_types.hotel || { label: 'Hotel' };
    const hotelsHere = items.filter((i) => i.item_type === 'hotel' && hotelPosition(i, day.date));
    for (const h of hotelsHere) {
      const d = h.details || {};
      const position = hotelPosition(h, day.date);
      const nights = hotelNights(h).length;
      const label = d.hotel_name || h.title || tiHotel.label;
      let time, titleText;
      if (position === 'only') {
        time = `check-in ${d.check_in_time || '15:00'} → check-out ${d.check_out_time || '11:00'}`;
        titleText = `Hotel: ${label} (single night — check in ${d.check_in_time || '15:00'}, check out ${d.check_out_time || '11:00'})`;
      } else if (position === 'first') {
        time = `check-in ${d.check_in_time || '15:00'} · ${nights} night${nights > 1 ? 's' : ''}`;
        titleText = `Hotel: ${label} — check in ${d.check_in_time || '15:00'}, ${nights} nights`;
      } else if (position === 'last') {
        time = `check-out ${d.check_out_time || '11:00'}`;
        titleText = `Hotel: ${label} — check out ${d.check_out_time || '11:00'}`;
      } else {
        const nightIdx = hotelNights(h).indexOf(day.date) + 1;
        time = `night ${nightIdx} of ${nights}`;
        titleText = `Hotel: ${label} (night ${nightIdx} of ${nights})`;
      }
      grid.appendChild(makeBar({
        kind: 'hotel', top: HOTEL_TOP, end: HOTEL_END, totalCols: 1, col: 0,
        title: `🏨 ${label}`,
        time,
        titleText,
        draggable: false,
        linkUrl: d.link,
        item: h,
      }));
    }
  }

  // Timed bars: collect intervals, stack, draw. Hotels are handled above
  // (each night draws its own bar/segment), so we skip them here.
  // isBackup is read from details.is_backup (set via the item editor's
  // 'backup' checkbox). Mains get the leftmost column when bars overlap.
  // Items without a time field are included as unscheduled bars at 00:00
  // so the user can drag them to a time slot.
  const timed = [];
  for (const it of items) {
    if (it.item_type === 'hotel' && !it._hotelEvent) continue;
    if (it.item_date !== day.date) continue;
    const d = it.details || {};
    const w = itemTimeWindow(it);
    timed.push({ item: it, start: w ? w.start : 0, end: w ? w.end : 0.5, isBackup: !!d.is_backup, unscheduled: !w });
  }
  const stacked = assignColumns(timed);
  for (const s of stacked) {
    const it = s.item;
    const ti = settings.item_types[it.item_type] || { label: it.item_type };
    const d = it.details || {};
    const f = TIME_FIELDS[it.item_type] || {};
    // Render the time range. For legacy items that still have only
    // `time` (restaurant/transport created before the start+end
    // migration), fall back to that field so the bar's subtitle
    // shows the time the user actually entered.
    const startTxt = f.start ? (d[f.start] || (d.time || '').replace('T', ' ')).replace('T', ' ') : '';
    const endTxt   = f.end   ? (d[f.end]   || '').replace('T', ' ') : '';
    const isBackup = s.isBackup;
    const durationHrs = s.end - s.start;
    const barTime = durationHrs > 1.5 ? (startTxt + (endTxt ? ' → ' + endTxt.split(' ').pop() : '')) : '';
    const extraClass = (isBackup ? ' tl-item-backup' : '') + (s.unscheduled ? ' tl-item-unscheduled' : '');
    grid.appendChild(makeBar({
      kind: it.item_type,
      top: s.start, end: s.end, totalCols: s.totalCols, col: s.col,
      title: (isBackup ? '⤷ ' : '') + (it.title || ti.label),
      time: s.unscheduled ? '' : barTime,
      titleText: `${ti.label}: ${it.title}`
                 + (startTxt ? ` (${startTxt}${endTxt ? ' – ' + endTxt : ''})` : '')
                 + (s.unscheduled ? ' — drag to a time slot' : ''),
      extraClass,
      item: it,
      day: day.date,
      linkUrl: d.link,
    }));
  }

  // No-time items that weren't rendered as timed bars appear as chips.
  sec.appendChild(grid);
  const renderedIds = new Set(timed.map(s => s.item.id));
  const untimed = items.filter((it) => it.item_type !== 'hotel' && it.item_date === day.date && !renderedIds.has(it.id));
  if (untimed.length) {
    const strip = el('div', { class: 'tl-untimed' });
    for (const it of untimed) {
      const ti = settings.item_types[it.item_type] || { label: it.item_type };
      strip.appendChild(el('span', { class: 'chip', title: it.title, text: `${ti.label}: ${it.title}` }));
    }
    sec.appendChild(strip);
  } else {
    sec.appendChild(el('div', { class: 'tl-untimed' }));
  }

  return sec;
}

function nowFractionFor(date) {
  // Return hour-of-day 0–24 if `date` is today, else null.
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (today !== date) return null;
  return t.getHours() + t.getMinutes() / 60;
}

function renderEmpty(message) {
  return el('div', { class: 'empty-state', text: message });
}

/* ---------- drag / resize ---------- */

// Snap a fractional hour (0..24) to the nearest 30-minute mark. Used at
// pointerup so the bar lands on a clean time (no in-between snapping during
// the drag — that would make the bar jitter as it crossed the threshold).
function snapHalfHour(t) {
  const snapped = Math.round(t * 2) / 2;       // nearest 0.5h
  return Math.max(0, Math.min(24, snapped));
}

// Combine a date (YYYY-MM-DD) and a fractional hour (0..24) into a
// `YYYY-MM-DDTHH:MM` string for the details.start_time / details.end_time
// fields. The date string is the bar's source day (or the cross-day target
// if the user dragged into another column).
function combineDateHour(date, hours) {
  const snapped = snapHalfHour(hours);
  // Snap to whole minutes first; floor the hour to avoid 24:30 wrapping.
  const whole = Math.floor(snapped);
  const mins = Math.round((snapped - whole) * 60);
  const hh = String(whole).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  return `${date}T${hh}:${mm}`;
}

/* Pure math for the drag/resize gestures, extracted so tests can verify
 * the boundary cases without needing real pointer events. The drag
 * handler delegates to these; the live-preview and the onUp commit use
 * the same functions so a fix in one place covers both. */

/* moveTimeWindow({ startH, endH, dyPx }) — shift start and end by the
 * same delta (clamped so neither end runs off [0, 24]). Returns
 * { startH, endH } with the duration preserved. Used for body-drag. */
export function moveTimeWindow({ startH, endH, dyPx }) {
  const rawDelta = snapHalfHour(startH + dyPx / HOUR_PX) - startH;
  const delta = Math.max(-startH, Math.min(rawDelta, 24 - endH));
  return { startH: startH + delta, endH: endH + delta };
}

/* resizeTop({ endH, newTopH }) — the top edge moves; the bottom stays.
 * Clamps so the new top is at most `endH - 0.5h`. Returns { startH, endH }. */
export function resizeTop({ endH, newTopH }) {
  const startH = Math.min(snapHalfHour(newTopH), endH - 0.5);
  return { startH, endH };
}

/* resizeBottom({ startH, newBottomH }) — the bottom edge moves; the top
 * stays. Clamps so the new bottom is at least `startH + 0.5h`. Returns
 * { startH, endH }. */
export function resizeBottom({ startH, newBottomH }) {
  const endH = Math.max(snapHalfHour(newBottomH), startH + 0.5);
  return { startH, endH };
}

/* Resolve which day a horizontal pixel x falls into. The timeline lays
 * out an hour-col + N day columns in a flex row. We compare the x
 * against each .day's bounding rect (rects are stable as long as nothing
 * in the row changes width mid-drag, which it doesn't). Returns the day
 * object's { date, index, label, node } or null if x is in the hour-col
 * gutter / off the end. */
function findDayAt(x) {
  const sections = document.querySelectorAll('#timeline .day');
  for (const sec of sections) {
    const r = sec.getBoundingClientRect();
    if (x >= r.left && x <= r.right) return sec;
  }
  return null;
}

// Day column the user is currently dragging over. Used to (a) draw the
// drop-target outline and (b) decide whether a horizontal drag far enough
// into the next/prev column should move the item to that day. The threshold
// is 30% of the column width — small enough that a quick "fling" of the
// pointer can change days, but not so small that the bar flips day on a
// wiggle.
const CROSS_DAY_FRACTION = 0.30;
function dragDayThresholdPx(dayNode) {
  return dayNode.getBoundingClientRect().width * CROSS_DAY_FRACTION;
}

/* Wire pointer-based drag/resize for one bar element. The bar carries
 * data-* attributes set by makeBar / renderDay so the handler doesn't need
 * to look up the item or its time field every time the pointer moves:
 *   data-item-id    item id
 *   data-time-field { start, end } — field names in details
 *   data-day        the bar's current day (date)
 *   data-start      hours (0..24) at drag start
 *   data-end        hours (0..24) at drag start
 *
 * `staging` is the Staging engine; `getViewItems` returns the current
 * staged view (so we can look up live title/details when staging).
 * `getSelection` (optional) and `onMultiDrag` (optional) are the multi-
 * drag hook: when the dragged bar is part of a multi-selection, the
 * onUp delegates to onMultiDrag instead of staging a single TIME_EDIT
 * — the boot's onMultiDrag stages a TIME_EDIT per selected item. */
function wireBarDrag({ bar, staging, getViewItems, getSelection, onMultiDrag, ctx }) {
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;            // left button only
    if (ctx.role === 'viewer') return;
    const itemId = bar.dataset.itemId;
    if (!itemId) return;
    const isHotelEvent = bar.dataset.hotelEvent;
    const it = isHotelEvent
      ? getViewItems().find(x => String(x.id) === String(bar.dataset.hotelId))
      : getViewItems().find(x => String(x.id) === String(itemId));
    if (!it) return;
    const fields = JSON.parse(bar.dataset.timeField || '{}');
    const dayIso = bar.dataset.day;
    const startH = Number(bar.dataset.start);
    const endH = Number(bar.dataset.end);
    if (!fields.start) return;             // no time fields to edit

    // Resize = mousedown landed on a .tl-resize handle; move = body.
    const resizeEdge = e.target && e.target.dataset && e.target.dataset.resize;
    const mode = resizeEdge === 'top' || resizeEdge === 'bottom' ? 'resize' : 'move';

    // Pointer capture keeps the events flowing even if the pointer leaves
    // the bar (which it will on a long drag). We re-render between drag
    // frames so the bar follows the pointer.
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');

    // Find the originating day column. We'll resolve the "current" day on
    // every move so cross-day drops are obvious.
    const startDayNode = bar.closest('.day');
    const startX = e.clientX;
    const startY = e.clientY;
    const startDuration = endH - startH;

    // The day we're hovering over on this frame. Initially the bar's own.
    let hoverDayNode = startDayNode;
    let hoverDayIso = dayIso;

    function onMove(ev) {
      const dy = ev.clientY - startY;
      const newStart = snapHalfHour(startH + dy / HOUR_PX);

      // Cross-day moves are only relevant when the user is moving the
      // bar (not resizing — resize keeps the bar on its source day).
      // When the pointer drags more than 30% of the originating day
      // width into the next/prev column, the drop target becomes that
      // column. We use the originating width so the threshold doesn't
      // wobble as the user crosses columns of different widths.
      if (mode === 'move') {
        const next = findDayAt(ev.clientX);
        if (next && next !== hoverDayNode) {
          const threshold = dragDayThresholdPx(startDayNode);
          const within = (x) => Math.abs(x - startX) >= threshold;
          if (within(ev.clientX)) {
            if (hoverDayNode) hoverDayNode.classList.remove('drop-target');
            hoverDayNode = next;
            hoverDayNode.classList.add('drop-target');
            hoverDayIso = next.dataset.day || hoverDayIso;
          }
        }
      }

      // Live update the bar's visual position so the user has immediate
      // feedback. We only redraw the *bar* (not the whole grid) — the
      // .day section is still mounted; we just restyle the bar in place.
      //
      // The math lives in moveTimeWindow/resizeTop/resizeBottom (above)
      // so the onUp commit and the live preview share one source of
      // truth. Stash the moving edge value(s) on the bar so onUp can
      // commit them without recomputing.
      if (mode === 'move') {
        const r = moveTimeWindow({ startH, endH, dyPx: dy });
        bar.style.top = `${r.startH * HOUR_PX}px`;
        bar.style.height = `${Math.max(20, startDuration * HOUR_PX)}px`;
        bar._pendingStart = r.startH;
        bar._pendingEnd = r.endH;
      } else if (mode === 'resize' && resizeEdge === 'top') {
        const r = resizeTop({ endH, newTopH: newStart });
        bar.style.top = `${r.startH * HOUR_PX}px`;
        bar.style.height = `${Math.max(20, (r.endH - r.startH) * HOUR_PX)}px`;
        bar._pendingStart = r.startH;
      } else if (mode === 'resize' && resizeEdge === 'bottom') {
        // The new bottom is endH + dy/HOUR_PX (NOT newStart, which
        // is startH + dy and would compress the bar on a non-zero
        // duration). resizeBottom clamps so the bottom is at least
        // startH + 0.5h.
        const r = resizeBottom({ startH, newBottomH: endH + dy / HOUR_PX });
        bar.style.height = `${Math.max(20, (r.endH - r.startH) * HOUR_PX)}px`;
        bar._pendingEnd = r.endH;
      }
    }

    function onUp(ev) {
      bar.releasePointerCapture(e.pointerId);
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      bar.classList.remove('dragging');
      if (hoverDayNode) hoverDayNode.classList.remove('drop-target');

      // Compute the final (start, end) for this gesture. For move,
      // _pendingStart and _pendingEnd both hold the (clamped, duration-
      // preserving) values so the new item has the same duration as
      // before. For resize-top, _pendingStart holds the new start
      // (and end is unchanged). For resize-bottom, _pendingEnd holds
      // the new end (and start is unchanged).
      let newStartH = bar._pendingStart != null ? bar._pendingStart : startH;
      let newEndH = bar._pendingEnd != null ? bar._pendingEnd : endH;
      if (mode === 'resize' && resizeEdge === 'top') {
        newStartH = Math.min(newStartH, endH - 0.5);
        newEndH = endH;
      } else if (mode === 'resize' && resizeEdge === 'bottom') {
        newStartH = startH;
        newEndH = Math.max(newEndH, startH + 0.5);
      }
      // No-op guard: if nothing changed, don't pollute the pending bar.
      // Resize gestures only change time-of-day; the item stays on its
      // source day regardless of where the pointer happens to be hovering.
      const dayChanged = mode === 'move' && hoverDayIso !== dayIso;
      const timeChanged = newStartH !== startH || newEndH !== endH;
      if (!dayChanged && !timeChanged) return;

      // Multi-drag: if the bar is in a multi-selection, delegate the
      // commit to the boot's onMultiDrag. It stages a TIME_EDIT for
      // every selected item, each keeping its own duration.
      if (mode === 'move' && getSelection && onMultiDrag) {
        const sel = getSelection();
        if (sel && sel.size > 1 && sel.has(String(it.id))) {
          const deltaH = newStartH - startH;
          const handled = onMultiDrag({
            leadItemId: it.id,
            item_date: hoverDayIso,
            deltaH,
          });
          if (handled) return;
        }
      }

      const newDetails = Object.assign({}, it.details || {});
      // The onMove handler populated _pendingStart and _pendingEnd with
      // the user's new values (already snapped + clamped). We commit
      // both as the new start_time + end_time, which is the unified
      // shape every timed item type now uses. This also auto-migrates
      // any legacy items that only had a single `time` field.
      newDetails[fields.start] = combineDateHour(hoverDayIso, newStartH);
      if (fields.end && fields.end !== fields.start) newDetails[fields.end] = combineDateHour(hoverDayIso, newEndH);
      // Clear the legacy `time` field once the new shape is in place,
      // so the item doesn't carry two ways of saying the same thing.
      if (newDetails.time && (it.item_type === 'restaurant' || it.item_type === 'transport' || it.item_type === 'transit')) {
        delete newDetails.time;
      }

      // For hotel events, map the drag correctly to the parent hotel's fields:
      // check-in drag → update item_date, check-out drag → update end_date.
      const hotelEvent = bar.dataset.hotelEvent;
      const itemDate = hotelEvent === 'check-out' ? (it.item_date || dayIso) : hoverDayIso;
      const endDate = hotelEvent === 'check-out' ? hoverDayIso : undefined;
      staging.add(timeEditItemOp({
        planId: ctx.planId,
        itemId: it.id,
        item_date: itemDate,
        end_date: endDate,
        details: newDetails,
        title: it.title,
      }));
    }

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  });
}

async function doSave(staging) {
  try {
    await staging.saveAll({ post: apiPost, patch: apiPatch, del: apiDel });
  } catch (e) {
    // The edit bar reads the failedOpIndex / failedError off the engine
    // and shows the failure inline; nothing to do here besides not throw.
  }
}

/* ---------- multi-select + context menu ----------
 *
 * Same UX as the board:
 *   - Plain click        → open the item editor (and clear the selection)
 *   - ⌘ / Ctrl + click   → toggle one item in the multi-select
 *   - Shift + click      → range select (across the timeline's bar sequence)
 *   - Right-click        → add to selection (if not already in it) and
 *                          show the context menu
 *   - Escape             → clear the selection / close the menu
 *   - Delete / Backspace → delete the current selection
 *   - ⌘A                → select every non-hotel item
 *   - ⌘X / ⌘C / ⌘V / ⌘D → cut / copy / paste / duplicate the selection
 *
 * Spanning items (hotels) are not selectable — same as the board. The
 * right-click on a hotel is a no-op so the menu never appears for an
 * object the user can't act on. */

/* True if the item type spans multiple days (e.g. hotel). Such items are
 * treated as the "home base" for the night and are pinned to the bottom
 * of every day they cover, regardless of their sort_key. */
function isSpanningItem(item, settings) {
  const ti = settings.item_types[item.item_type];
  return !!(ti && ti.spans_days && item.end_date && item.item_date && item.end_date > item.item_date);
}

/* Hotels (and other spans) don't participate in multi-select — they're
 * an overnight thing the user moves by editing, not by cut/paste. */
function isSelectableItem(item, settings) {
  if (!item) return false;
  return !isSpanningItem(item, settings);
}

/* ---------- transient toasts ---------- */
// The test shim's `installDom` replaces `globalThis.document.body` between
// boots, so a module-level `document.body.appendChild` would attach to the
// first body only. To survive re-boots we check, on every call, whether
// our cached root is still attached to the *current* body. If not, we
// create a fresh root and attach it.
let _toastsRoot = null;
let _toastsHost = null;        // the body the toastsRoot was attached to
function toastsRoot() {
  const host = (typeof document !== 'undefined' && document.body) || null;
  if (_toastsRoot && _toastsHost === host && _toastsRoot.parentNode) return _toastsRoot;
  const root = el('div', { class: 'toast-stack', 'aria-live': 'polite' });
  if (host) host.appendChild(root);
  _toastsRoot = root;
  _toastsHost = host;
  return root;
}
let toastSeq = 0;
function showToast(text, kind) {
  const id = ++toastSeq;
  const node = el('div', { class: 'toast' + (kind ? ' toast-' + kind : ''), role: 'status', text });
  toastsRoot().appendChild(node);
  setTimeout(() => { if (node.parentNode) node.remove(); }, 3000);
  return id;
}

/* ---------- boot ---------- */

export async function initTimeline(ctx) {
  const root = document.getElementById('timeline');
  if (!root) return;
  clear(root);

  // Plan + items + members in parallel. Members are needed for the item
  // editor's expense form (payer picker / participants). Settings come
  // from the shared module-level cache so we don't refetch.
  let settings, plan, items, members = [];
  try {
    const [, planRes, itemsRes, memRes] = await Promise.all([
      loadSettings().then((s) => { settings = s; }).catch(() => { settings = null; }),
      apiGet(`/api/plans/${ctx.planId}`).catch(() => null),
      apiGet(`/api/plans/${ctx.planId}/items`).catch(() => null),
      apiGet(`/api/plans/${ctx.planId}/members`).catch(() => ({ owner: null, members: [] })),
    ]);
    if (!settings || !planRes || !itemsRes) {
      root.appendChild(renderEmpty('No Internet connection. Please check your connection and try again.'));
      return;
    }
    plan = planRes.plan;
    items = itemsRes.items;
    members = memRes.owner ? [memRes.owner, ...(memRes.members || [])] : (memRes.members || []);
  } catch (e) {
    root.appendChild(renderEmpty('Failed to load: ' + e.message));
    return;
  }

  // Days derived from the latest staged plan. Re-deriving in render() (so
  // a date edit / buffer add re-shapes the columns without a full reload)
  // means we hold `days` in a let rather than const.
  let days = buildDays(plan);
  if (!days.length) {
    root.appendChild(renderEmpty('Set a start and end date for this plan to see the timeline.'));
    return;
  }

  const planBase = plan;
  // We re-derive `days` from the staged plan in render() so buffer days
  // and date edits show up immediately without a full reload. Holding
  // the initial plan here is just for the first staging.basePlan.
  // Staging engine: the same one the board uses, with the server state as
  // the base. Drag/resize on the timeline stage TIME_EDIT ops that show up
  // in the pending bar just like board edits — Save commits, Revert rolls
  // them all back.
  const staging = new Staging({
    baseItems: items,
    basePlan: planBase,
    onChange: () => { render(); },
  });

  // Blocked-action status (e.g. "trim would orphan an item"). Shown in
  // the edit bar's status text.
  let blockError = null;
  function setBlockError(msg) {
    blockError = msg || null;
    renderEditBarCtl();
  }

  // Wire the plan-level chrome (title + dates inline edit) into the
  // shared module. The edit bar (toolbar + pending bar) is rendered
  // separately by renderEditBarCtl.
  const headerCtl = wirePlanHeader({
    plan, staging, ctx,
    onChange: () => { render(); },
  });
  headerCtl.setBlockError(setBlockError);

  function renderHeaderChrome() { headerCtl.repaint(); }

  function renderEditBarCtl() {
    // The "focused day" is the first item in the multi-selection, so
    // Quick add lands on the same day as whatever the user was looking
    // at. Falls back to the first day.
    const sel = selectedItems();
    const focusedDate = (sel[0] && sel[0].item_date) || (days[0] && days[0].date);
    renderEditBar({
      days, settings, staging, ctx,
      setBlockError,
      getFocusedDay: () => focusedDate,
      setFocusedDay: (d) => { focusedDate = d; },
      onCreateItem: (type, date) => createItem(type, date),
      onChange: () => { render(); },
      doSave,
      blockError,
    });
  }

  /* Create a blank item of the given type on the given date. Mirrors
   * the board's behavior: open the item editor immediately so the
   * user can fill in the rest. The board uses its own focusedDay; the
   * timeline uses the date the Quick add button is bound to. */
  function createItem(type, date) {
    const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const op = createBlankItemOp({
      planId: ctx.planId,
      item_type: type,
      item_date: date || (days[0] && days[0].date) || null,
      sessionId,
    });
    staging.add(op);
    const draft = staging.viewItems().find(x => x.id === op._draftId);
    if (draft) {
      openItemEditor(ctx, {
        plan, item: draft, settings, members,
        staging, sessionId,
        onApplied: () => { render(); renderEditBarCtl(); },
      });
    }
  }

  // Multi-select state. Selection is a Set of item ids. lastSelectedId is
  // the anchor for shift-click range selection. We refresh the outlines
  // without re-rendering the whole timeline so the user's focus doesn't
  // bounce while clicking around.
  let selection = new Set();
  let lastSelectedId = null;
  let contextMenuEl = null;

  function isSelected(id) { return selection.has(String(id)); }

  function clearSelection() {
    if (selection.size === 0) return;
    selection = new Set();
    lastSelectedId = null;
    refreshBarOutlines();
  }

  function selectOnly(id) {
    selection = new Set([String(id)]);
    lastSelectedId = String(id);
    refreshBarOutlines();
  }

  function toggleSelect(id) {
    id = String(id);
    if (selection.has(id)) {
      selection.delete(id);
      if (lastSelectedId === id) lastSelectedId = null;
    } else {
      selection.add(id);
      lastSelectedId = id;
    }
    refreshBarOutlines();
  }

  /* Range select across the bar sequence. The timeline lays out timed
   * bars in (day, start time) order. We walk that sequence from `from`
   * to `to` (inclusive) and add every selectable (non-hotel) bar in
   * between. Spanning items (hotels) are skipped — they don't
   * participate in multi-select. */
  function selectRangeAcrossDays(from, to) {
    if (!from || !to) { selectOnly(to || from); return; }
    // Build the visible bar sequence the same way the render does: by
    // (item_date, start time) for timed bars, with hotels last.
    const all = staging.viewItems();
    const ordered = all
      .filter(it => !isSpanningItem(it, settings) || isSelectableItem(it, settings))
      .sort((a, b) => {
        if (a.item_date !== b.item_date) {
          return (a.item_date < b.item_date) ? -1 : 1;
        }
        const wa = itemTimeWindow(a) || { start: 0 };
        const wb = itemTimeWindow(b) || { start: 0 };
        if (wa.start !== wb.start) return wa.start - wb.start;
        return a.id - b.id;
      });
    const ids = ordered.map(it => String(it.id));
    const a = ids.indexOf(String(from));
    const b = ids.indexOf(String(to));
    if (a < 0 || b < 0) { selectOnly(to); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(selection);
    for (let i = lo; i <= hi; i++) {
      const it = ordered[i];
      if (isSelectableItem(it, settings)) next.add(String(it.id));
    }
    selection = next;
    lastSelectedId = String(to);
    refreshBarOutlines();
  }

  /* Walk the DOM, toggling .tl-item-selected on each bar based on the
   * selection set. Spanning items (hotels) are skipped — they never
   * get the outline even if (theoretically) in the selection. */
  function refreshBarOutlines() {
    if (!root) return;
    for (const bar of root.querySelectorAll('.tl-item')) {
      const inSel = selection.has(bar.dataset.itemId);
      const isHotel = bar.classList.contains('tl-item-hotel');
      if (inSel && !isHotel) bar.classList.add('tl-item-selected');
      else bar.classList.remove('tl-item-selected');
    }
  }

  /* Items in the current selection as objects. Skips anything that
   * became a hotel (or got deleted) since the user clicked. */
  function selectedItems() {
    const all = staging.viewItems();
    return all.filter(i => isSelectableItem(i, settings) && selection.has(String(i.id)));
  }

  function batchSessionId() {
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function copySelection() {
    const items = selectedItems();
    if (!items.length) return;
    clipboardSet({ items, action: 'copy' });
  }

  function cutSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const stamped = items.map((it) => Object.assign(serializeItem(it), { _srcId: it.id }));
    clipboardSet({ items: stamped, action: 'cut' });
  }

  /* Paste from the clipboard onto the day the user last focused (or the
   * lead bar's source day if we have one). The board uses a separate
   * "focused day" concept, but the timeline doesn't render that — we
   * infer it from the first selected item, or fall back to day 0. */
  function pasteFromClipboard() {
    const clip = clipboardGet();
    if (!clip || !clip.items.length) return;
    const target = focusDayForClipboard() || (days[0] && days[0].date);
    if (!target) return;
    const sessionId = batchSessionId();
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: target,
      items: clip.items,
      sessionId,
    }));
    if (clip.action === 'cut') {
      for (const src of clip.items) {
        if (src._srcId != null) {
          staging.add(deleteItemOp({ itemId: src._srcId, label: 'Cut', sessionId }));
        }
      }
    }
  }

  function duplicateSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const target = focusDayForClipboard() || (days[0] && days[0].date);
    if (!target) return;
    const sessionId = batchSessionId();
    staging.add(createItemsFromClipOp({
      planId: ctx.planId,
      item_date: target,
      items: items.map(i => Object.assign(serializeItem(i), { _srcId: i.id })),
      sessionId,
    }));
  }

  function deleteSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const sessionId = batchSessionId();
    for (const i of items) {
      staging.add(deleteItemOp({
        itemId: i.id,
        label: items.length === 1 ? `Delete ${i.title || 'item'}` : `Delete ${items.length} items`,
        sessionId,
      }));
    }
    clearSelection();
  }

  /* If the user has a multi-select, the "paste target" is the day of
   * the first selected item. Otherwise we don't have a target — the
   * caller should fall back to a sensible default. */
  function focusDayForClipboard() {
    const sel = selectedItems();
    if (!sel.length) return null;
    return sel[0].item_date || null;
  }

  /* Right-click context menu. The shim doesn't implement
   * getBoundingClientRect or window.innerWidth, so we fall back to
   * the requested coordinates if those are missing. */
  function closeContextMenu() {
    if (contextMenuEl) {
      if (contextMenuEl.remove) contextMenuEl.remove();
      else if (contextMenuEl.parentNode) contextMenuEl.parentNode.removeChild(contextMenuEl);
    }
    contextMenuEl = null;
  }
  function showContextMenu(x, y) {
    closeContextMenu();
    const menu = el('ul', { class: 'context-menu', role: 'menu' });
    const sel = selectedItems();
    const clip = clipboardGet();
    const items = [
      { label: 'Cut',       shortcut: '⌘X', enabled: sel.length > 0, action: () => { cutSelection(); closeContextMenu(); } },
      { label: 'Copy',      shortcut: '⌘C', enabled: sel.length > 0, action: () => { copySelection(); closeContextMenu(); } },
      { label: 'Paste',     shortcut: '⌘V', enabled: !!(clip && clip.items.length), action: () => { pasteFromClipboard(); closeContextMenu(); } },
      { label: 'Duplicate', shortcut: '⌘D', enabled: sel.length > 0, action: () => { duplicateSelection(); closeContextMenu(); } },
      { sep: true },
      { label: 'Delete',    shortcut: 'Del', enabled: sel.length > 0, danger: true,
        action: () => { deleteSelection(); closeContextMenu(); } },
    ];
    for (const it of items) {
      if (it.sep) { menu.appendChild(el('li', { class: 'context-menu-sep' })); continue; }
      const li = el('li', { class: 'context-menu-item' + (it.danger ? ' is-danger' : ''), role: 'menuitem' });
      const btn = el('button', { type: 'button', text: it.label });
      btn.disabled = !it.enabled;
      btn.addEventListener('click', (e) => { e.stopPropagation(); it.action(); });
      li.appendChild(btn);
      if (it.shortcut) li.appendChild(el('span', { class: 'context-menu-shortcut', text: it.shortcut }));
      menu.appendChild(li);
    }
    document.body.appendChild(menu);
    let rectW = 200, rectH = 200;
    try {
      const rect = menu.getBoundingClientRect();
      if (rect) { rectW = rect.width || rectW; rectH = rect.height || rectH; }
    } catch (e) { /* shim: use defaults */ }
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    const px = Math.min(x, vw - rectW - 8);
    const py = Math.min(y, vh - rectH - 8);
    menu.style.left = `${Math.max(8, px)}px`;
    menu.style.top  = `${Math.max(8, py)}px`;
    contextMenuEl = menu;
  }

  function openEditorFor(item) {
    const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    openItemEditor(ctx, {
      plan,
      item,
      settings,
      members,
      staging,
      sessionId,
      onApplied: () => { render(); refreshBarOutlines(); },
    });
  }

  function render() {
    // Re-derive the day list from the latest staged plan (so a date
    // edit, a buffer add, or a pending undo all reshape the columns
    // without needing a full reload).
    days = buildDays(staging.viewPlan());
    clear(root);
    updateScale(root);
    if (ctx.role !== 'viewer') root.classList.add('editable');
    const viewItems = expandHotelEvents(staging.viewItems());

    root.appendChild(renderHourCol());
    const scrollWrap = el('div', { class: 'timeline-scroll' });
    let todayNode = null;
    for (const day of days) {
      try {
        const nowFrac = nowFractionFor(day.date);
        const isToday = nowFrac != null && !day.is_buffer;
        const node = renderDay(day, viewItems, settings, nowFrac,
                               ctx, staging, setBlockError, () => { render(); });
        if (isToday) {
          node.classList.add('day-today');
          todayNode = node;
        }
        node.dataset.day = day.date;     // used by findDayAt during drag
        // Mirror the buffer flag on the section so findDayAt + drop-target
        // styling can branch on it (e.g. to skip the 30% cross-day drag
        // for buffer days if we ever want to).
        if (day.is_buffer) node.dataset.buffer = '1';
        scrollWrap.appendChild(node);
      } catch (e) {
        // Surface render errors in the page rather than silently killing the
        // whole view — without this, a single bad day would leave the timeline
        // looking empty and the user (and me) would have no idea why.
        const fail = el('div', { class: 'day' }, [
          el('div', { class: 'day-head' }, [
            el('div', { class: 'date', text: day.label }),
            el('div', { class: 'sub', text: 'render error: ' + e.message }),
          ]),
        ]);
        scrollWrap.appendChild(fail);
        // also dump the error to the console for the dev tools
        console.error('timeline renderDay failed for', day, e);
      }
    }
    root.appendChild(scrollWrap);

    // Wire drag/resize + click/menu on every bar. Hotels are wired too
    // (for click → editor) but they have no drag/resize handles; only
    // the body-drag is skipped for them by the `:not(.tl-item-hotel)`
    // selector in wireBarDrag.
    if (ctx.role !== 'viewer') {
      const allBars = root.querySelectorAll('.tl-item');
      const draggableBars = root.querySelectorAll('.tl-item:not(.tl-item-hotel)');
      for (const bar of draggableBars) {
        wireBarDrag({ bar, staging, getViewItems: () => staging.viewItems(),
                      getSelection: () => selection, ctx, onMultiDrag });
      }
      for (const bar of allBars) {
        wireBarClick({ bar, ctx,
                       getViewItems: () => staging.viewItems(),
                       onPlainClick: selectOnly,
                       onToggleSelect: toggleSelect,
                       onRangeSelect: (id) => selectRangeAcrossDays(lastSelectedId, id),
                       onContextMenu: showContextMenu,
                       onDblClick: (item) => {
                         if (item._hotelEvent) {
                           const parent = staging.viewItems().find(i => String(i.id) === String(item._hotelId));
                           if (parent) openEditorFor(parent);
                         } else {
                           openEditorFor(item);
                         }
                       } });
      }
    }

    // Selection outlines need a fresh pass after every render — the
    // bars we just mounted don't know which ids are in the selection
    // set unless we tell them.
    refreshBarOutlines();

    // Plan-level chrome (title, dates, toolbar) — the shared module
    // owns the markup, we just trigger the repaint.
    renderHeaderChrome();
    renderEditBarCtl();

    // On small devices, snap the timeline horizontally to today's column.
    if (todayNode && window.matchMedia('(max-width: 640px)').matches) {
      requestAnimationFrame(() => {
        scrollWrap.scrollLeft = todayNode.offsetLeft - scrollWrap.offsetLeft - 16;
      });
    }
  }

  /* Multi-drag: when the user starts dragging a bar that's part of a
   * multi-selection, move every selected item by the same time delta
   * and to the same target day. Each item keeps its own duration.
   * Called from wireBarDrag's onUp. */
  function onMultiDrag({ leadItemId, item_date, deltaH, movedDay }) {
    const items = selectedItems();
    if (items.length <= 1 || !items.find(i => String(i.id) === String(leadItemId))) {
      // Single-item drag — fall back to the per-bar handler the bar's
      // own onUp installed. Nothing to do here.
      return false;
    }
    const sessionId = batchSessionId();
    for (const it of items) {
      const f = TIME_FIELDS[it.item_type];
      if (!f || !f.start) continue;
      const d = it.details || {};
      // For legacy items that only have `time` (restaurant/transport
      // pre-migration), read from that field instead of the new
      // start_time. The new end will be derived from the user's
      // gesture plus the item's existing duration.
      const startSrc = d[f.start] || d.time;
      const startH = timeOfDay(startSrc);
      if (startH == null) continue;
      const newStartH = snapHalfHour(startH + deltaH);
      // Same duration, clamped to the [0, 24] window.
      const endSrc = f.end ? (d[f.end] || d.time) : null;
      const endH = f.end ? timeOfDay(endSrc) : null;
      const newEndH = endH != null ? Math.max(newStartH + 0.5, Math.min(24, endH + deltaH)) : null;
      const newDetails = Object.assign({}, d);
      // Always write start_time and end_time. This both fixes the
      // broken pre-migration items (which only had `time`) and
      // normalizes the data shape for new items.
      newDetails[f.start] = combineDateHour(item_date, newStartH);
      if (f.end && newEndH != null) newDetails[f.end] = combineDateHour(item_date, newEndH);
      // Clear the legacy field if it was there so the item doesn't
      // carry two different ways of saying the same thing.
      if (d.time && (it.item_type === 'restaurant' || it.item_type === 'transport' || it.item_type === 'transit')) {
        delete newDetails.time;
      }
      staging.add(timeEditItemOp({
        planId: ctx.planId,
        itemId: it.id,
        item_date,
        details: newDetails,
        title: it.title,
        sessionId,
      }));
    }
    void movedDay; // kept for future use (per-item day logic)
    return true;
  }

  // ---- Global event wiring (keyboard shortcuts, outside-click clears) ----
  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    if (t.matches) return t.matches('input, textarea, select, [contenteditable]');
    return false;
  }
  function onKeydown(e) {
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); staging.undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); staging.redo(); return; }
      if (k === 's') { e.preventDefault(); doSave(staging); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); cutSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteFromClipboard(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'a') {
        e.preventDefault();
        const all = staging.viewItems();
        const newSel = new Set();
        for (const it of all) {
          if (isSelectableItem(it, settings)) newSel.add(String(it.id));
        }
        selection = newSel;
        lastSelectedId = null;
        refreshBarOutlines();
        return;
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size) { e.preventDefault(); deleteSelection(); return; }
    }
    if (e.key === 'Escape') {
      if (contextMenuEl) { closeContextMenu(); return; }
      if (selection.size) { clearSelection(); return; }
    }
  }

  // Outside-click clears the multi-select and closes the context menu,
  // unless the click is on something that "consumes" it (a bar, a
  // button, the menu itself). The bar's own click handler stops
  // propagation for the same reason the board's does.
  function onDocumentClick(e) {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
    if (!selection.size || !e.target.closest) return;
    const onBar = e.target.closest('.tl-item');
    const onInteract = e.target.closest(
      'button, summary, input, textarea, select, a, label, [contenteditable]'
    );
    if (onBar || onInteract) return;
    clearSelection();
  }

  render();
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('scroll', closeContextMenu, true);

  // ----- beforeunload guard -----
  // Same protection the board has: if the user closes the tab, navigates
  // away, or refreshes with unsaved changes, prompt them. The browser
  // shows a generic dialog ("Changes you made may not be saved") — we
  // can't customize the message, but the prompt is enough to prevent
  // accidental loss. Editor cancels + Revert/Redo don't reach this
  // listener (those are same-page actions), so the prompt only fires
  // when the page is actually going away.
  function onBeforeUnload(e) {
    if (staging && staging.hasPending) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  }
  window.addEventListener('beforeunload', onBeforeUnload);
}

/* ---------- bar click / right-click ---------- */

/* Wire click + right-click handlers on one bar. The drag handler is
 * separate (it owns pointerdown→move→up). Click semantics:
 *   - plain click         → select only
 *   - ⌘ / Ctrl + click    → toggle this bar in the multi-select
 *   - Shift + click       → range select (across the visible bar order)
 *   - double-click        → open detail editor
 *   - right-click         → show the context menu
 *
 * Hotels: plain click does nothing; ⌘ / Ctrl / Shift + click show a
 * toast (can't multi-select spanning items). Double-click opens the
 * editor; right-click shows the context menu.
 *
 * The boot owns the multi-select state and the context-menu renderer;
 * we pass them in as callbacks so this module stays stateless. */
function wireBarClick({ bar, ctx, getViewItems, onPlainClick, onToggleSelect, onRangeSelect, onContextMenu, onDblClick }) {
  if (ctx.role === 'viewer') return;
  const itemId = bar.dataset.itemId;
  if (!itemId) return;
  const isHotel = bar.classList.contains('tl-item-hotel');

  // The bar's data-item-id is the live id (number for server items,
  // string for local drafts). The handlers below resolve back to the
  // staged item so the editor sees the current title.
  // Check-in/check-out hotel event bars carry data-hotel-id pointing to
  // the parent hotel — resolve to that so double-click opens the hotel.
  function findItem() {
    const all = (getViewItems && getViewItems()) || [];
    const isHotelEvent = bar.dataset.hotelEvent;
    const id = isHotelEvent ? bar.dataset.hotelId : itemId;
    return all.find(i => String(i.id) === String(id)) || null;
  }
  bar.addEventListener('click', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (e.detail > 1) return; // part of double-click
    if (e.metaKey || e.ctrlKey) {
      if (isHotel) {
        showToast("Spanning items (e.g. hotels) can't be multi-selected. Drag or open the editor to change dates.", 'warn');
        return;
      }
      e.stopPropagation();
      if (onToggleSelect) onToggleSelect(itemId);
      return;
    }
    if (e.shiftKey) {
      if (isHotel) {
        showToast("Spanning items (e.g. hotels) can't be multi-selected. Drag or open the editor to change dates.", 'warn');
        return;
      }
      e.stopPropagation();
      if (onRangeSelect) onRangeSelect(itemId);
      return;
    }
    // Plain click: select only.
    e.stopPropagation();
    if (!isHotel && onPlainClick) onPlainClick(itemId);
  });

  bar.addEventListener('dblclick', (e) => {
    if (e.button != null && e.button !== 0) return;
    const it = findItem();
    if (it && onDblClick) onDblClick(it);
  });

  bar.addEventListener('contextmenu', (e) => {
    if (ctx.role === 'viewer') return;
    e.preventDefault();
    if (onContextMenu) onContextMenu(e.clientX, e.clientY);
  });
}
