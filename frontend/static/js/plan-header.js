/* plan-header.js — shared header / add-toolbar / buffer helpers for the
 * board and the timeline.
 *
 * Both pages (board = plan.html, timeline = timeline.html) render the
 * same plan header (title + date range) and the same add-toolbar
 * (range +1/-1 day, + Buffer day, Quick add per type). The contract:
 * any change to a header or toolbar element lives in this file, so the
 * two pages can't drift.
 *
 * Each helper takes the page's local state (plan, settings, staging,
 * days, ctx, etc.) as named arguments. Pages call these once at the
 * top of their render path and once again from a planning-op callback
 * (e.g. after a Save+reload).
 */
import { el, clear, fmtDate, loadSettings } from '/static/js/util.js';
import {
  updatePlanTitleOp, updatePlanDatesOp, updatePlanBufferDaysOp,
} from '/static/js/staging.js';

/* ---- date utilities ------------------------------------------------- */

/* Build YYYY-MM-DD from a local Date (avoids UTC off-by-one from toISOString). */
export function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Add `n` days to a YYYY-MM-DD string. Negative n is allowed. */
export function addDaysIso(iso, n) {
  if (!iso) return iso;
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

/* ---- day enumeration (shared by both pages) ------------------------ */

/* Enumerate the plan's day columns, including any buffer days. A buffer
 * day sits at the boundary of the trip range (or outside) and is rendered
 * with a distinct visual marker — it's a planning scratchpad, not part of
 * the trip itself. Returned in chronological order with `is_buffer: true`
 * on the marker entries. The `label` is the full text the day title
 * should show; the render code uses it verbatim. */
export function buildDays(plan) {
  if (!plan || !plan.start_date || !plan.end_date) {
    return [{ date: '', index: 0, label: 'Undated' }];
  }
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const tripStart = new Date(plan.start_date + 'T00:00:00');
  const tripEnd = new Date(plan.end_date + 'T00:00:00');
  const tripDates = new Set();
  for (let d = new Date(tripStart); d <= tripEnd; d.setDate(d.getDate() + 1)) {
    tripDates.add(isoOf(d));
  }
  const bufferDates = (plan.buffer_days || [])
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !tripDates.has(d))
    .sort();
  // Combined list, chronological.
  const all = [...tripDates].concat(bufferDates).sort();
  let dayIndex = 0;
  return all.map((date) => {
    const isBuffer = !tripDates.has(date);
    if (isBuffer) {
      // Buffer days carry no "Day N" or date in their title — they're a
      // planning scratchpad, not part of the trip. The chip on the
      // column is what the user clicks to remove it.
      return { date, is_buffer: true, index: 0, label: 'Buffer' };
    }
    dayIndex += 1;
    return {
      date,
      is_buffer: false,
      index: dayIndex,
      label: `Day ${dayIndex} · ${fmt.format(new Date(date + 'T00:00:00'))}`,
    };
  });
}

/* ---- header: title + dates ---------------------------------------- */

/* Wire the plan header once at boot. The header is the same markup on
 * both pages (plan-title + plan-dates + plan-currency); the date and
 * title become inline-editable for non-viewer roles, and changes are
 * staged (not auto-saved) so the user controls when to commit via the
 * Save button in the pending bar.
 *
 * The `onChange` callback runs after a successful title or date edit so
 * the calling page can repaint derived UI (the toolbar's range buttons
 * depend on the current dates, for example).
 *
 * `setBlockError(msg)` is also returned — pages wire it to their pending
 * bar so a failed dates-edit (range sweeps an item) shows a red
 * "blocked" status, matching the board's existing behavior. */
export function wirePlanHeader({ plan, staging, ctx, onChange }) {
  // Pages override this with their own pending-bar integration via
  // `headerCtl.setBlockError(myFunc)`. The default is a no-op so the
  // shared helper is usable in tests. The listener wired below
  // (datesEl.addEventListener) closes over this binding, so a `let`
  // is required: reassigning the variable must be visible to the
  // listener when it later fires.
  let setBlockError = (msg) => {
    if (msg) console.warn('[plan-header] block:', msg);
  };

  // Repaint helper. Both pages call this from their render path so the
  // header always shows the latest staged plan. Skips repaint if the
  // user is actively editing (an <input> child is present) so we don't
  // steal their focus mid-edit.
  //
  // Crucially, we only touch the DOM when the text actually differs.
  // The server already renders the same strings (via fmt_date / the
  // plan title), so on a clean boot nothing is written — no "flash" of
  // the header changing after first paint. Before this guard, every
  // render() rewrote the text nodes unconditionally, which was visible
  // as the header "blinking" to a different format and back.
  function repaint() {
    const titleEl = document.getElementById('plan-title');
    const datesEl = document.getElementById('plan-dates');
    const v = staging.viewPlan();
    const wantTitle = v.title || '';
    if (titleEl && !titleEl.querySelector('input') && titleEl.textContent.trim() !== wantTitle) {
      titleEl.textContent = wantTitle;
    }
    if (datesEl && !datesEl.querySelector('input')) {
      const wantDates = datesText(v.start_date, v.end_date);
      if (datesEl.textContent.trim() !== wantDates) datesEl.textContent = wantDates;
    }
  }

  const datesEl = document.getElementById('plan-dates');
  if (datesEl) {
    // The server already rendered the formatted dates via `fmt_date()`
    // (injected as a context processor in app.py) so the first paint
    // matches what `paintDates()` would write. We deliberately skip
    // the boot-time `paintDates()` call here — the user would otherwise
    // see a brief "flash" of the server's output replaced by the JS
    // output (even though they should be identical, the rewrite is
    // visible in some browsers and feels like a bug).
    if (ctx.role !== 'viewer') {
      datesEl.classList.add('editable');
      datesEl.title = 'Click to edit trip start and end dates (saves on Save in the bar)';
      datesEl.addEventListener('click', () => beginDatesEdit(datesEl, {
        view: staging.viewPlan(),
        resolveItems: () => staging.viewItems(),
        applyDates: (s, e) => { stageDatesChange({ plan, staging, ctx, start: s, end: e }); },
        onBlock: (msg) => { setBlockError(msg); },
        onDone: () => { repaint(); onChange && onChange(); },
      }));
    }
  }
  const titleEl = document.getElementById('plan-title');
  if (titleEl && ctx.role === 'owner') {
    // Same reasoning as the dates element: the server already rendered
    // the title. We only need to add the click-to-edit affordance and
    // the hover hint, not rewrite the text.
    titleEl.classList.add('editable');
    titleEl.title = 'Click to edit title (saves on click Save in the bar)';
    titleEl.addEventListener('click', () => beginTitleEdit(titleEl, {
      applyTitle: (v) => { staging.add(updatePlanTitleOp({ planId: ctx.planId, title: v })); },
      onDone: () => { repaint(); onChange && onChange(); },
    }));
  }

  // Setters for the page to override callbacks the listeners close over.
  // `setBlockError` is a property that, when set, swaps the variable
  // the listener reads. The listener reads via `getSetBlockError()`
  // inside beginDatesEdit, so the page's `headerCtl.setBlockError(my)`
  // reaches the next commit call.
  return {
    repaint,
    setBlockError(fn) { setBlockError = fn || setBlockError; },
  };
}

/* Wire the plan header on pages WITHOUT a staging engine or pending bar
 * (expenses, share). The inline-edit UI is identical to wirePlanHeader
 * — same inputs, same Enter/Escape/blur behavior, same "don't orphan
 * items" validation — but a successful edit is PATCHed straight to the
 * server. There's no Save button on those pages, so "commit" means
 * "save now". A failed edit shows the error inline in the header (the
 * small .ph-block-msg element), since those pages have no pending bar
 * to surface it in.
 *
 * The plan is fetched fresh (we need `buffer_days` for the validation,
 * which the page template doesn't carry). Items are fetched lazily on
 * the first dates commit — title edits never need them.
 *
 * Usage:
 *   import { wirePlanHeaderDirect } from '/static/js/plan-header.js';
 *   wirePlanHeaderDirect({ planId, role });
 */
export async function wirePlanHeaderDirect({ planId, role }) {
  const { apiGet, apiPatch } = await import('/static/js/api.js');

  let plan;
  try {
    const res = await apiGet(`/api/plans/${planId}`);
    plan = res.plan;
  } catch (e) {
    // If we can't load the plan, leave the header static — better than
    // a broken click handler that throws.
    console.warn('[plan-header] direct wiring skipped:', e);
    return;
  }

  // Items are only needed for the dates-edit validation; fetch on first
  // use so a title-only session doesn't pay for it.
  let _items = null;
  async function resolveItems() {
    if (_items === null) {
      try {
        const res = await apiGet(`/api/plans/${planId}/items`);
        _items = res.items || [];
      } catch (e) {
        _items = [];
      }
    }
    return _items;
  }

  // Inline block message — these pages have no pending bar, so a blocked
  // edit (or a failed save) needs its own little error surface. Lives
  // under the currency line in the header, auto-clears after a while.
  let blockTimer = null;
  function showBlock(msg) {
    const host = document.querySelector('.plan-head-main');
    if (!host) { if (msg) alert(msg); return; }
    let el_ = host.querySelector('.ph-block-msg');
    if (!el_) {
      el_ = document.createElement('p');
      el_.className = 'ph-block-msg';
      el_.setAttribute('role', 'status');
      host.appendChild(el_);
    }
    if (msg) {
      el_.textContent = msg;
      el_.hidden = false;
      if (blockTimer) clearTimeout(blockTimer);
      blockTimer = setTimeout(() => { el_.hidden = true; }, 6000);
    } else {
      el_.hidden = true;
    }
  }

  const datesEl = document.getElementById('plan-dates');
  if (datesEl && role !== 'viewer') {
    datesEl.classList.add('editable');
    datesEl.title = 'Click to edit trip start and end dates (saves immediately)';
    datesEl.addEventListener('click', () => beginDatesEdit(datesEl, {
      view: plan,
      resolveItems,
      applyDates: async (s, e) => {
        const res = await apiPatch(`/api/plans/${planId}`, { start_date: s, end_date: e });
        plan = res.plan;
      },
      onBlock: showBlock,
    }));
  }
  const titleEl = document.getElementById('plan-title');
  if (titleEl && role === 'owner') {
    titleEl.classList.add('editable');
    titleEl.title = 'Click to edit title (saves immediately)';
    titleEl.addEventListener('click', () => beginTitleEdit(titleEl, {
      applyTitle: async (v) => {
        const res = await apiPatch(`/api/plans/${planId}`, { title: v });
        plan = res.plan;
      },
    }));
  }
}

/* The exact string shown in the dates element for a given range. One
 * definition, used by both paintDates() (writes it) and repaint()
 * (compares before writing, so a no-change render touches no DOM). */
function datesText(start, end) {
  if (start && end) return `${fmtDate(start)} → ${fmtDate(end)}`;
  if (start) return fmtDate(start);
  return 'Dates not set';
}

function paintDates(el_, start, end) {
  el_.textContent = datesText(start, end);
}

/* Shared dates-inline-edit UI. The DOM part (two <input type=date> with
 * commit-on-blur / Enter / Escape) is identical on every page; only the
 * commit path differs:
 *   - board/timeline: `applyDates` stages an updatePlanDatesOp (shows in
 *     the pending bar until Save).
 *   - expenses/share: `applyDates` PATCHes the server directly (there's
 *     no pending bar on those pages, so the edit is saved immediately).
 *
 * `view` is the current plan (for input prefill + reset). `resolveItems`
 * returns the item list used by the "don't orphan items" validation —
 * sync or async. `applyDates(s, e)` performs the commit (may be async).
 * `onBlock(msg|null)` surfaces a blocked edit to the user. `onDone`
 * runs after a successful commit so the caller can refresh its view. */
function beginDatesEdit(datesEl, { view, resolveItems, applyDates, onBlock, onDone }) {
  const setBlockError = onBlock || (() => {});
  if (datesEl.querySelector('input')) return;
  const startVal = view.start_date || '';
  const endVal = view.end_date || '';
  const startIn = document.createElement('input');
  startIn.type = 'date'; startIn.className = 'input title-edit'; startIn.value = startVal;
  const sep = document.createElement('span');
  sep.className = 'dates-sep'; sep.textContent = '→';
  const endIn = document.createElement('input');
  endIn.type = 'date'; endIn.className = 'input title-edit'; endIn.value = endVal;
  const wrap = document.createElement('span');
  wrap.className = 'dates-edit-wrap';
  wrap.append(startIn, sep, endIn);
  clear(datesEl);
  datesEl.appendChild(wrap);
  startIn.focus();

  async function commit() {
    const s = startIn.value || null;
    const e = endIn.value || null;
    const changed = s !== (view.start_date || null) || e !== (view.end_date || null);
    if (changed && (!s || !e || s <= e)) {
      // Validate that the proposed new range doesn't sweep any items off
      // the board. Items that would fall outside the new range block the
      // edit. (Spanning items are checked by their item_date only; the
      // end_date is exclusive.) Buffer days live in year 9999 and are
      // exempt — they're managed by the buffer flow, not the date editor.
      const items = (await resolveItems()) || [];
      const wouldLose = items.filter(i =>
        i.item_date && (i.item_date < s || i.item_date > e));
      const bufferSet = new Set(view.buffer_days || []);
      const willCollide = wouldLose.some(i => !bufferSet.has(i.item_date));
      if (willCollide) {
        setBlockError(`New range would leave some item(s) outside the trip. Move or delete them first.`);
        paintDates(datesEl, view.start_date, view.end_date);
        return;
      }
      setBlockError(null);
      try {
        await applyDates(s, e);
      } catch (err) {
        setBlockError(`Couldn't save dates: ${err && err.message ? err.message : err}`);
        paintDates(datesEl, view.start_date, view.end_date);
        return;
      }
      // Success: the caller's onDone refreshes its view (re-render or
      // repaint). We also repaint here so the dates element shows the
      // new range even if the caller forgets.
      paintDates(datesEl, s, e);
      if (onDone) onDone();
    } else {
      paintDates(datesEl, view.start_date, view.end_date);
    }
  }
  function cancel() {
    paintDates(datesEl, view.start_date, view.end_date);
  }
  function onKey(ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  }
  startIn.addEventListener('keydown', onKey);
  endIn.addEventListener('keydown', onKey);
  // Commit on blur of either input, but avoid double-commit when moving
  // focus from start to end: schedule commit on the *next* blur.
  let committed = false;
  const onBlur = () => {
    if (committed) return;
    committed = true;
    // Microtask so the second input's focus has settled; if focus moved
    // between the two inputs, skip committing and let the second input
    // handle it on its own blur.
    setTimeout(() => {
      if (document.activeElement === startIn || document.activeElement === endIn) return;
      commit();
    }, 0);
  };
  startIn.addEventListener('blur', onBlur);
  endIn.addEventListener('blur', onBlur);
}

/* Shared title-inline-edit UI. Same deal as the dates editor: identical
 * DOM on every page, different commit path. `applyTitle(v)` stages or
 * PATCHes depending on the page. On cancel/unchanged the original text
 * is restored. */
function beginTitleEdit(titleEl, { applyTitle, onDone }) {
  if (titleEl.querySelector('input')) return;
  const cur = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-edit input';
  input.value = cur;
  clear(titleEl);
  titleEl.appendChild(input);
  input.focus();
  input.select();

  async function commit() {
    const v = input.value.trim();
    if (v && v !== cur) {
      try {
        await applyTitle(v);
        titleEl.textContent = v;
      } catch (err) {
        titleEl.textContent = cur;
        console.warn('[plan-header] title save failed:', err);
      }
    } else {
      titleEl.textContent = cur;
    }
    if (onDone) onDone();
  }

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      titleEl.textContent = cur;
    }
  });
}

/* ---- range controls (extend/trim 1 day) --------------------------- */

function stageDatesChange({ plan, staging, ctx, start, end }) {
  const view = staging.viewPlan();
  staging.add(updatePlanDatesOp({
    planId: ctx.planId,
    start_date: start,
    end_date: end,
    prev: { start_date: view.start_date, end_date: view.end_date },
  }));
}

function dayHasItems(date, items) {
  return items.some(i => i.item_date === date);
}

/* Extend or trim the trip start by `delta` days. `delta < 0` adds days
 * (extends the start), `delta > 0` removes days (trims). Blocked if
 * trimming would orphan an item; the page's setBlockError surfaces a
 * red "blocked" status in the pending bar. */
function extendStartBy(delta, { plan, staging, ctx, items, setBlockError }) {
  const view = staging.viewPlan();
  if (!view.start_date) return;
  if (delta > 0 && dayHasItems(view.start_date, items)) {
    setBlockError(`Can't trim the start — ${view.start_date} has item(s). Move or delete them first.`);
    return;
  }
  const newStart = addDaysIso(view.start_date, delta);
  if (view.end_date && newStart > view.end_date) return;
  setBlockError(null);
  stageDatesChange({ plan, staging, ctx, start: newStart, end: view.end_date });
}

function extendEndBy(delta, { plan, staging, ctx, items, setBlockError }) {
  const view = staging.viewPlan();
  if (!view.end_date) return;
  if (delta < 0 && dayHasItems(view.end_date, items)) {
    setBlockError(`Can't trim the end — ${view.end_date} has item(s). Move or delete them first.`);
    return;
  }
  const newEnd = addDaysIso(view.end_date, delta);
  if (view.start_date && newEnd < view.start_date) return;
  setBlockError(null);
  stageDatesChange({ plan, staging, ctx, start: view.start_date, end: newEnd });
}

/* ---- buffer day helpers ------------------------------------------ */

/* Buffers always live on a "scratchpad calendar" far away from the trip
 * (year 9999), so they can never collide with a trip date, regardless
 * of how the trip range moves. The dates are internal only — the
 * column header just says "Buffer" (no day number or date). We allocate
 * from the end of the year backward: 9999-12-31, 9999-12-30, ... so
 * each buffer gets a unique, stable date (the table's PK is
 * (plan_id, date)). */
function nextBufferDate(plan) {
  const BUFFER_YEAR = 9999;
  const cap = new Date(BUFFER_YEAR, 11, 31);
  const capIso = isoOf(cap);
  const taken = new Set(plan.buffer_days || []);
  if (!taken.has(capIso)) return capIso;
  let d = cap;
  for (let i = 0; i < 366; i++) {
    d.setDate(d.getDate() - 1);
    const iso = isoOf(d);
    if (!taken.has(iso)) return iso;
  }
  // Pathological case: every day in the buffer year is taken. Fall back
  // to a year-padded counter so the date is still unique.
  return `${BUFFER_YEAR}-12-${String(31 + (plan.buffer_days || []).length).padStart(2, '0')}`;
}

function stageBufferAdd({ plan, staging, ctx }) {
  const view = staging.viewPlan();
  const date = nextBufferDate(view);
  staging.add(updatePlanBufferDaysOp({
    planId: ctx.planId,
    add: [date],
    remove: [],
  }));
}

function stageBufferRemove(date, { plan, staging, ctx, items, setBlockError }) {
  const view = staging.viewPlan();
  if (!(view.buffer_days || []).includes(date)) return;
  // Block if there are items on this buffer day — the user must move
  // or delete them first.
  if (dayHasItems(date, items)) {
    setBlockError(`Can't remove this buffer day — it has item(s). Move or delete them first.`);
    return;
  }
  setBlockError(null);
  staging.add(updatePlanBufferDaysOp({
    planId: ctx.planId,
    add: [],
    remove: [date],
  }));
}

/* ---- toolbar (range + buffer + quick add) -------------------------- */

/* The "Quick add (Day N)" label needs a focused-day notion. Each page
 * has a different way of tracking it: the board sets it when the user
 * clicks a day column, the timeline uses the first item in the
 * multi-selection or the first day. Pages pass a getFocusedDay()
 * function that returns the current focused day's date. */
export function renderPlanToolbar({ days, settings, staging, ctx, setBlockError, getFocusedDay, setFocusedDay, onCreateItem, onChange }) {
  const tb = document.getElementById('add-toolbar');
  if (!tb) return;
  clear(tb);
  if (ctx.role === 'viewer') return;

  // Range controls: extend or trim the trip by 1 day on either side.
  // Owner and editor both get this. Disabled when the relevant edge is
  // unset.
  const view = staging.viewPlan();
  const hasStart = !!view.start_date;
  const hasEnd = !!view.end_date;
  const canTrimStart = hasStart && (!hasEnd || view.start_date < view.end_date);
  const canTrimEnd = hasEnd && (!hasStart || view.start_date < view.end_date);
  const items = staging.viewItems();
  const opts = { plan: view, staging, ctx, items, setBlockError };

  const mkRangeBtn = (text, title, action, onClick, disabled) => el('button', {
    type: 'button', class: 'toolbar-btn toolbar-range', text, title,
    dataset: { action },
    disabled: !!disabled, onclick: onClick,
  });
  // Range controls: the arrow on each button points to the side the
  // affected day lives on — for `+` it's where the new day appears;
  // for `−` it's the side that just lost a day. The mental model is
  // the calendar: extending the start means the trip starts one day
  // earlier (the new day lives to the left of Day 1); extending the
  // end means it ends one day later (the new day lives to the right
  // of the last day); trimming pulls an edge inward.
  //
  // Each trip edge owns a pair of buttons: its extend on the outside,
  // its trim on the inside. The toolbar reads from the outside in.
  //
  //   [‹ +1 day]  [−1 day ›]    |    [‹ −1 day]  [+1 day ›]
  //     extend      trim-star       trim-end      extend
  //     -start                          -end
  const startGroup = el('span', { class: 'toolbar-range-group' }, [
    mkRangeBtn('‹ +1 day', 'Add one day to the start of the trip (new day on the left)', 'extend-start',
               () => { extendStartBy(-1, opts); if (onChange) onChange(); }, !hasStart),
    mkRangeBtn('−1 day ›', 'Remove the first day of the trip', 'trim-start',
               () => { extendStartBy(+1, opts); if (onChange) onChange(); }, !canTrimStart),
  ]);
  const endGroup = el('span', { class: 'toolbar-range-group' }, [
    mkRangeBtn('‹ −1 day', 'Remove the last day of the trip', 'trim-end',
               () => { extendEndBy(-1, opts); if (onChange) onChange(); }, !canTrimEnd),
    mkRangeBtn('+1 day ›', 'Add one day to the end of the trip (new day on the right)', 'extend-end',
               () => { extendEndBy(+1, opts); if (onChange) onChange(); }, !hasEnd),
  ]);
  tb.appendChild(startGroup);
  tb.appendChild(endGroup);

  // Buffer day control: one click adds a new buffer column. The date is
  // derived (no picker) — see nextBufferDate() for the algorithm.
  tb.appendChild(makeBufferAddButton());

  // Quick add — type picker. The label is the focused day (per page).
  const focusedDay = getFocusedDay ? getFocusedDay() : (days[0] && days[0].date);
  const focused = days.find(d => d.date === focusedDay) || days[0];
  tb.appendChild(el('span', { class: 'toolbar-label', text: `Quick add${focused && focused.index ? ` (Day ${focused.index})` : ''}:` }));
  for (const [type, ti] of Object.entries(settings.item_types)) {
    const b = el('button', { class: 'toolbar-btn', text: ti.label, title: `Add ${ti.label}` });
    b.type = 'button';
    b.addEventListener('click', () => {
      if (setFocusedDay) setFocusedDay(focusedDay);
      if (onCreateItem) onCreateItem(type, focusedDay);
    });
    tb.appendChild(b);
  }
}

/* "Buffer day" button: a single click adds a new buffer day. The date
 * is derived automatically — never ask the user. The column header
 * just says "Buffer" (no day or date). */
export function makeBufferAddButton({ plan, staging, ctx, onChange } = {}) {
  const btn = el('button', {
    type: 'button', class: 'toolbar-btn toolbar-range',
    text: '+ Buffer day',
    title: 'Add a buffer day to the board (planning scratchpad for items you\'re not sure about)',
  });
  btn.addEventListener('click', () => {
    stageBufferAdd({ plan: staging.viewPlan(), staging, ctx });
    if (onChange) onChange();
  });
  return btn;
}

/* Per-day action chip. Buffer days get a close (×) button in the title
 * row to remove the buffer marker. Trip days don't get a chip. */
export function makeDayActions(day, { ctx, staging, setBlockError, onChange } = {}) {
  if (ctx && ctx.role === 'viewer') return null;
  if (!day || !day.date || !day.is_buffer) return null;
  const btn = el('button', {
    type: 'button',
    class: 'day-action day-action-close',
    title: 'Remove this buffer day',
    text: '×',
    'aria-label': 'Remove this buffer day',
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    stageBufferRemove(day.date, { plan: staging.viewPlan(), staging, ctx, items: staging.viewItems(), setBlockError });
    if (onChange) onChange();
  });
  return btn;
}

/* Default exports for the lower-level helpers pages may want to call
 * directly (e.g. when a custom day-click handler wants to remove a
 * buffer that the user clicked). */
export {
  extendStartBy, extendEndBy,
  stageBufferAdd, stageBufferRemove, nextBufferDate,
};
