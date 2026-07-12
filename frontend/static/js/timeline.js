/* timeline.js — 24-hour timeline view of a plan.
 *
 * initTimeline({ planId, role })
 *
 * Renders each day as a vertical lane (0:00 at top → 24:00 at bottom) and
 * draws each timed item as a bar positioned by its start/end time-of-day.
 * Hotels appear as a thin band on every day in their date range. Items with
 * no time (notes) appear as a chip strip below the day. Overlapping bars in
 * the same day are stacked side-by-side so nothing hides another item.
 *
 * Data sources (same as the board):
 *   GET /api/plans/<id>            - plan (title, dates, base_currency)
 *   GET /api/plans/<id>/items      - items; each has item_type, item_date,
 *                                    end_date, details (JSON of type-specific
 *                                    fields with time-of-day)
 */
import { apiGet } from '/static/js/api.js';
import { el, clear, loadSettings } from '/static/js/util.js';

const HOUR_PX = 36;   // kept in sync with --tl-h in timeline.css

/* ---------- helpers ---------- */

// YYYY-MM-DD in local time (avoids toISOString's UTC off-by-one).
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Enumerate day objects from the plan's date range (same shape as itinerary.js).
function buildDays(plan) {
  if (!plan.start_date || !plan.end_date) return [];
  const days = [];
  const d = new Date(plan.start_date + 'T00:00:00');
  const end = new Date(plan.end_date + 'T00:00:00');
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  for (let i = 0; d <= end; i++) {
    days.push({ date: isoOf(d), index: i, label: fmt.format(new Date(d)) });
    d.setDate(d.getDate() + 1);
  }
  return days;
}

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
const TIME_FIELDS = {
  flight:     { start: 'depart_time', end: 'arrive_time', label: 'flight' },
  train:      { start: 'depart_time', end: 'arrive_time', label: 'train' },
  ticket:     { start: 'start_time',  end: 'end_time'    },
  restaurant: { start: 'time' },
  activity:   { start: 'start_time',  end: 'end_time'    },
  transport:  { start: 'time' },
};

// For a given item, return { start: hours, end: hours } on the item's date,
// or null if no time info is available.
function itemTimeWindow(item) {
  const d = item.details || {};
  if (item.item_type === 'hotel') {
    // Hotels are handled by renderHotelStays() below, not as a single bar.
    return null;
  }
  const f = TIME_FIELDS[item.item_type];
  if (!f) return null;
  const start = timeOfDay(d[f.start]);
  if (start == null) return null;
  let end = f.end ? timeOfDay(d[f.end]) : null;
  if (end == null) end = start + 1; // 1-hour default for a "time" field
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
// Algorithm: sort by start, then by descending duration. For each bar, find
// the lowest column index whose previous occupant ends at or before the new
// bar's start; if none, append a new column. This is the standard interval
// graph-coloring / strip-packing approach.
function assignColumns(intervals) {
  // intervals: [{start, end}], returns same array augmented with .col
  const sorted = intervals.slice().sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const cols = []; // cols[i] = end of the rightmost bar in column i
  for (const it of sorted) {
    let placed = -1;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i] <= it.start) { placed = i; break; }
    }
    if (placed === -1) { placed = cols.length; cols.push(it.end); }
    else cols[placed] = it.end;
    it.col = placed;
  }
  // Total columns for the day = cols.length (or 1 if empty).
  for (const it of sorted) {
    it.totalCols = cols.length || 1;
  }
  return sorted;
}

/* ---------- rendering ---------- */

// Build one .tl-item bar positioned in the day column. Shared by every item
// type (hotels, flights, etc.) so they all share the same visual language.
function makeBar({ kind, top, end, totalCols, col, title, time, titleText }) {
  const w = totalCols || 1;
  const left = 22 + (col / w) * (100 - 22 - 4) + '%';
  const width = (1 / w) * (100 - 22 - 4) + '%';
  const topPx = top * HOUR_PX;
  const height = Math.max(20, (end - top) * HOUR_PX);
  return el('div', {
    class: `tl-item ${kind}` + (w > 1 ? ' multi' : ''),
    style: `top:${topPx}px; height:${height}px; left:${left}; width:calc(${width} - 2px);`,
    title: titleText,
  }, [
    el('div', { class: 'tl-item-title', text: title || kind }),
    time ? el('div', { class: 'tl-item-time', text: time }) : null,
  ]);
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

function renderDay(day, items, settings, nowFraction) {
  const sec = el('section', { class: 'day' });
  sec.appendChild(el('div', { class: 'day-head' }, [
    el('div', { class: 'date', text: day.index ? `Day ${day.index} · ${day.label}` : day.label }),
  ]));

  const grid = el('div', { class: 'day-grid' });
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
    grid.appendChild(el('div', { class: 'now-line', style: `top: ${nowFraction * 24 * HOUR_PX}px;` }));
  }

  // Hotel stays: every night the trip is in the hotel, draw ONE compact bar
  // pinned to 23:00→24:00 at the bottom of the day (the "you'll be sleeping
  // here" indicator). Hotels are an overnight thing — they should never fight
  // for daytime space with flights, activities, or meals. The label on the
  // bar says what's happening that night: check-in time on the first night,
  // check-out time on the last night, "night N of M" in the middle.
  const HOTEL_TOP = 23;  // 23:00
  const HOTEL_END = 24;  // 24:00
  const tiHotel = settings.item_types.hotel || { label: 'Hotel' };
  const hotelsHere = items.filter((i) => i.item_type === 'hotel' && hotelPosition(i, day.date));
  for (const h of hotelsHere) {
    const d = h.details || {};
    const position = hotelPosition(h, day.date);  // 'first' | 'middle' | 'last' | 'only'
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
    }));
  }

  // Timed bars: collect intervals, stack, draw. Hotels are handled above
  // (each night draws its own bar/segment), so we skip them here.
  const timed = [];
  for (const it of items) {
    if (it.item_type === 'hotel') continue;
    if (it.item_date !== day.date) continue;
    const w = itemTimeWindow(it);
    if (!w) continue;
    timed.push({ item: it, start: w.start, end: w.end });
  }
  const stacked = assignColumns(timed);
  for (const s of stacked) {
    const it = s.item;
    const ti = settings.item_types[it.item_type] || { label: it.item_type };
    const d = it.details || {};
    const f = TIME_FIELDS[it.item_type] || {};
    const startTxt = f.start ? (d[f.start] || '').replace('T', ' ') : '';
    const endTxt   = f.end   ? (d[f.end]   || '').replace('T', ' ') : '';
    const w = s.totalCols || 1;
    const left = 22 + (s.col / w) * (100 - 22 - 4) + '%';  // skip the "hour-label gutter"
    const width = (1 / w) * (100 - 22 - 4) + '%';
    const top = s.start * HOUR_PX;
    const height = Math.max(20, (s.end - s.start) * HOUR_PX);

    grid.appendChild(makeBar({
      kind: it.item_type,
      top: s.start, end: s.end, totalCols: s.totalCols, col: s.col,
      title: it.title || ti.label,
      time: startTxt + (endTxt ? ' → ' + endTxt.split(' ').pop() : ''),
      titleText: `${ti.label}: ${it.title}` + (startTxt ? ` (${startTxt}${endTxt ? ' – ' + endTxt : ''})` : ''),
    }));
  }

  // No-time items (notes, or anything else without a time field) as chips.
  // The strip is a sibling of the grid, both inside `sec` (the day column).
  // (Don't use grid.parentElement here — the grid isn't attached yet, so its
  // parent is null and appending to it throws.)
  const untimed = items.filter((it) => it.item_type !== 'hotel' && it.item_date === day.date && itemTimeWindow(it) === null);
  sec.appendChild(grid);
  if (untimed.length) {
    const strip = el('div', { class: 'tl-untimed' });
    for (const it of untimed) {
      const ti = settings.item_types[it.item_type] || { label: it.item_type };
      strip.appendChild(el('span', { class: 'chip', title: it.title, text: `${ti.label}: ${it.title}` }));
    }
    sec.appendChild(strip);
  } else {
    // keep a small placeholder so the day has a consistent footer
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

/* ---------- boot ---------- */

export async function initTimeline(ctx) {
  const root = document.getElementById('timeline');
  if (!root) return;
  clear(root);

  // Plan + items in parallel (members aren't needed for the timeline view).
  let settings, plan, items;
  try {
    const [, planRes, itemsRes] = await Promise.all([
      loadSettings().then((s) => { settings = s; }),
      apiGet(`/api/plans/${ctx.planId}`),
      apiGet(`/api/plans/${ctx.planId}/items`),
    ]);
    plan = planRes.plan;
    items = itemsRes.items;
  } catch (e) {
    root.appendChild(renderEmpty('Failed to load: ' + e.message));
    return;
  }

  const days = buildDays(plan);
  if (!days.length) {
    root.appendChild(renderEmpty('Set a start and end date for this plan to see the timeline.'));
    return;
  }

  root.appendChild(renderHourCol());
  for (const day of days) {
    try {
      root.appendChild(renderDay(day, items, settings, nowFractionFor(day.date)));
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
      root.appendChild(fail);
      // also dump the error to the console for the dev tools
      console.error('timeline renderDay failed for', day, e);
    }
  }
}
