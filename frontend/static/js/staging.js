/* staging.js — local pending-changes engine for the plan board.
 *
 * Concept: every mutation on the page (item create/update, drag/drop reorder,
 * drag/drop image upload, attachment add/delete, expense add, plan title edit)
 * is staged as an "op" that mutates the in-memory view. Nothing reaches the
 * server until the user clicks Save. Revert/Redo walk a pointer through the op
 * list; the view is always derived from base + ops[0..pointer].
 *
 * Op shape:
 *   {
 *     id, kind, label, sessionId?,          // metadata
 *     apply(items, base, ctx?) -> items,    // pure: produces a new items list
 *     planApply(plan, ctx?) -> plan | null, // optional: produces a new plan
 *     execute(api, base, ctx?) -> result,   // server-side; only on Save
 *   }
 *
 * The view (`viewItems()` / `viewPlan()`) folds `apply` over all ops from 0
 * to pointer-1 — no execute needed, so undo = pointer-- and redo = pointer++.
 *
 * `execute` is called only from `saveAll()`. Each op knows how to do its own
 * server work and returns a result the engine can post-process. For ops that
 * bundle sub-actions (e.g. SAVE_ITEM = create item + upload attachments + add
 * expense), the op's execute runs them in order and aggregates their results
 * into a single return value.
 */

const _LOCAL_ID = (() => { let n = 0; return () => `_-${++n}`; })();

/* ---------- pure view helpers used by the apply fns ---------- */

function patchItem(items, id, patch) {
  return items.map(it => String(it.id) === String(id) ? Object.assign({}, it, patch) : it);
}
function removeItem(items, id) {
  return items.filter(it => String(it.id) !== String(id));
}
function appendItem(items, item) { return items.concat([item]); }

function reorderForMove(items, moveId, targetDate, beforeId, afterId) {
  const it = items.find(x => String(x.id) === String(moveId));
  if (!it) return items;
  const others = items.filter(x => String(x.id) !== String(moveId));
  const updated = Object.assign({}, it, { item_date: targetDate || null });
  const targetDayItems = others
    .filter(x => (x.item_date || '') === (targetDate || ''))
    .sort((a, b) => (a.sort_key - b.sort_key) || (a.id - b.id));
  let insertIdx = targetDayItems.length;
  if (beforeId) {
    const i = targetDayItems.findIndex(x => String(x.id) === String(beforeId));
    if (i >= 0) insertIdx = i;
  } else if (afterId) {
    const i = targetDayItems.findIndex(x => String(x.id) === String(afterId));
    if (i >= 0) insertIdx = i + 1;
    else insertIdx = targetDayItems.length;
  }
  targetDayItems.splice(insertIdx, 0, updated);
  const otherDays = others.filter(x => (x.item_date || '') !== (targetDate || ''));
  return otherDays.concat(targetDayItems);
}

function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// True if the id refers to a not-yet-saved local item (our synthetic ids
// start with '_-'). Used by per-item ops to skip API calls that would 404
// because the item doesn't exist on the server yet. The work those calls
// would have done is already encoded in the item's local state and gets
// applied by the upcoming CREATE.
function isLocalId(id) { return typeof id === 'string' && id.startsWith('_'); }

// Replace the date part of a 'YYYY-MM-DDTHH:MM' string with ``newDate``,
// keeping the time-of-day unchanged. Used when a move changes an item's
// date so the ``when`` object (the single source of truth for dates) stays
// in sync with the item_date / end_date columns — the same reconciliation
// the backend's move_item performs.
function shiftDate(s, newDate) {
  const m = String(s).match(/T(\d{2}:\d{2})/);
  if (!m) return `${newDate}T00:00`;
  return `${newDate}T${m[1]}`;
}

// Merge one AI edit into an item, returning a new item. An edit is a partial
// {item_id, title?, details?, when?, geocodes?}. Shared by the single-edit
// editor flow (ai-extract.js) and the grouped multi-edit op below so both
// apply an edit identically: a new ``when`` updates the item_date / end_date
// columns (the backend treats ``when`` as the source of truth), and geocodes
// replace the prior list.
export function mergedItemForEdit(item, edit) {
  const next = Object.assign({}, item);
  if (edit.title) next.title = edit.title;
  if (edit.details) next.details = Object.assign({}, item.details || {}, edit.details);
  if (edit.when && edit.when.start_at) {
    next.details = Object.assign({}, next.details || {});
    next.details.when = edit.when;
    next.item_date = edit.when.start_at.slice(0, 10);
    if (edit.when.end_at) next.end_date = edit.when.end_at.slice(0, 10);
  }
  if (edit.geocodes && edit.geocodes.length) next.geocodes = edit.geocodes.slice();
  return next;
}

/* ---------- op factories ----------
 *
 * Each factory returns a fresh op object with a stable `kind`, a human `label`
 * (shown in the bar status), an optional `sessionId`, and the apply/execute
 * functions capturing the data at stage time.
 */

export function createBlankItemOp({ planId, item_type, item_date, end_date, sessionId }) {
  const localId = _LOCAL_ID();
  const draft = {
    id: localId,
    plan_id: planId,
    item_type,
    title: '(Untitled)',
    item_date: item_date || null,
    end_date: end_date || null,
    sort_key: 9999,           // large so it sorts to the end of its day
    status: 'planned',
    details: {},
    attachments: [],
    isLocal: true,
    isNew: true,
  };
  return {
    id: null, kind: 'CREATE_BLANK_ITEM', label: `Add ${item_type}`,
    sessionId, _draftId: localId,
    apply(items) { return appendItem(items, draft); },
    planApply() { return null; },
    async execute() { return null; },        // the editor's SAVE_ITEM does the real create
  };
}

export function saveItemOp({ planId, item, isNew, sideEffects, sessionId }) {
  // `item` is a snapshot of the form state (title, item_date, end_date?,
  // status, details, is_backup). `sideEffects` is an array of pre-built ops
  // (link add, image upload, expense add, delete attachment) that target this
  // item; their execute() is called sequentially after the create/patch.
  const localId = item.id;             // may be local ('_-N') or real
  const label = isNew ? `Create ${item.item_type}` : `Edit ${item.title || 'item'}`;
  // Capture the local attachment ids for the bundled sub-effects so the apply
  // function can swap them for the real ones after execute returns.
  const subLocalAttachmentIds = sideEffects
    .filter(s => s.kind === 'UPLOAD_IMAGE' || s.kind === 'ADD_LINK')
    .map(s => s._localAttachmentId);
  return {
    id: null, kind: 'SAVE_ITEM', label, sessionId,
    apply(items, _base, ctx) {
      const result = (ctx && ctx.result) || {};
      // Build the local attachments from each sub so they're included in the
      // snap (and thus visible during re-derivation from a fresh base).
      const localAttachments = sideEffects
        .map(sub => (sub && sub._initialAttachment) ? sub._initialAttachment : null)
        .filter(Boolean);
      let working = items;
      if (isNew) {
        const realId = result.newItemId || localId;
        const prev = items.find(it => String(it.id) === String(localId));
        const prevAtts = (prev && prev.attachments) || [];
        const snapAtts = (item.attachments || prevAtts).concat(localAttachments);
        const snap = Object.assign({}, item, {
          id: realId, isLocal: true, isNew: true,
          attachments: snapAtts,
        });
        working = items.map(it => String(it.id) === String(localId) ? snap : it);
      } else {
        const prev = items.find(it => String(it.id) === String(localId));
        const priorIsLocal = prev ? !!prev.isLocal : false;
        const prevAtts = (prev && prev.attachments) || [];
        const updated = Object.assign({}, item, {
          isLocal: priorIsLocal,
          attachments: (item.attachments || prevAtts).concat(localAttachments),
        });
        working = patchItem(items, localId, updated);
      }
      // Apply each side-effect so it can remap its local attachment to the
      // real server attachment (when ctx.result is available).
      for (const sub of sideEffects) {
        const next = sub.apply(working, _base, ctx);
        if (next) working = next;
      }
      return working;
    },
    planApply() { return null; },
    async execute(api) {
      let realId;
      const updatedAttachments = [];
      if (isNew) {
        const body = {
          item_type: item.item_type,
          title: item.title || '(Untitled)',
          item_date: item.item_date || null,
          end_date: item.end_date || null,
          status: item.status || 'planned',
          details: item.details || {},
          geocodes: item.geocodes || [],
        };
        const res = await api.post(`/api/plans/${planId}/items`, body);
        realId = res.item.id;
      } else {
        const body = {
          title: item.title,
          item_date: item.item_date || null,
          end_date: item.end_date || null,
          status: item.status || 'planned',
          details: item.details || {},
          geocodes: item.geocodes || [],
        };
        const res = await api.patch(`/api/items/${localId}`, body);
        realId = res.item.id;
      }
      // Run each side-effect with the real id available. Each sub returns
      // {updatedAttachments: [{localAttachmentId, attachment}], itemId}
      // (for image/link) or just {itemId} (for delete/expense). Collect the
      // attachment remaps so the apply can swap local ids for real ones.
      for (const sub of sideEffects) {
        const subCtx = { itemId: realId };
        const r = await sub.execute(api, null, subCtx);
        if (r && r.updatedAttachments) {
          for (const u of r.updatedAttachments) updatedAttachments.push(u);
        }
      }
      return { newItemId: realId, oldItemId: localId, isNew, updatedAttachments };
    },
  };
}

export function updateItemOp({ planId, item, sessionId }) {
  return {
    id: null, kind: 'UPDATE_ITEM', label: `Edit ${item.title || 'item'}`, sessionId,
    apply(items) { return patchItem(items, item.id, Object.assign({}, item)); },
    planApply() { return null; },
    async execute(api) {
      if (isLocalId(item.id)) {
        // Local item — its create + this update will be performed by the
        // bundled SAVE_ITEM op when the user Applies. Skip the standalone
        // PATCH to avoid a 404.
        return { skipped: true };
      }
      const body = {
        title: item.title,
        item_date: item.item_date || null,
        end_date: item.end_date || null,
        status: item.status || 'planned',
        details: item.details || {},
      };
      const res = await api.patch(`/api/items/${item.id}`, body);
      return { updatedItem: res.item };
    },
  };
}

/* Apply a batch of AI edits to existing items as one grouped op. A single op
 * means one pending-change entry and one Revert for the whole batch — the AI
 * reply's "Apply all" button stages exactly this. Each edit is a partial
 * {item_id, title?, details?, when?, geocodes?}; execute PATCHes every target
 * and returns the server-updated items so the engine keeps its base in sync
 * (later replies may edit the same item again). */
export function applyEditsOp({ planId, edits, label, sessionId }) {
  const list = (edits || []).filter(e => e && e.item_id != null);
  const opLabel = label || (list.length === 1
    ? `Edit ${list[0].title || 'item'}`
    : `Edit ${list.length} items`);
  return {
    id: null, kind: 'APPLY_EDITS', label: opLabel, sessionId,
    apply(items) {
      let working = items;
      for (const ed of list) {
        const it = working.find(x => String(x.id) === String(ed.item_id));
        if (!it) continue;
        working = patchItem(working, ed.item_id, mergedItemForEdit(it, ed));
      }
      return working;
    },
    planApply() { return null; },
    async execute(api, _base) {
      // PATCH the final merged state once per edited item. `_base.items` is
      // this save's full view (all pending ops folded in), so repeated edits
      // to the same item collapse into one PATCH with nothing clobbered, and
      // an item removed by another pending op is simply skipped.
      const viewItems = (_base && _base.items) || [];
      const seen = new Set();
      const updatedItems = [];
      for (const ed of list) {
        const key = String(ed.item_id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (isLocalId(ed.item_id)) continue;
        const cur = viewItems.find(x => String(x.id) === key);
        if (!cur) continue;
        const body = {
          title: cur.title,
          item_date: cur.item_date || null,
          end_date: cur.end_date || null,
          status: cur.status || 'planned',
          details: cur.details || {},
          geocodes: cur.geocodes || [],
        };
        const res = await api.patch(`/api/items/${ed.item_id}`, body);
        if (res && res.item) updatedItems.push(res.item);
      }
      return { updatedItems };
    },
  };
}

/* Staged time/date edit from the timeline (drag to move time, drag across
 * day columns to change date, drag top/bottom edge to resize start/end).
 * The label summarizes what the user did so the pending bar reads naturally
 * ("Move Lunch 14:00→15:30", "Resize Train 09:00→10:00"). The op bundles
 * the new item_date + details into one PATCH so the server sees the whole
 * change in one request. */
export function timeEditItemOp({ planId, itemId, item_date, end_date, details, title, sessionId }) {
  const label = title || 'item';
  return {
    id: null, kind: 'TIME_EDIT', label: `Reschedule ${label}`, sessionId,
    apply(items) {
      const it = items.find(x => String(x.id) === String(itemId));
      if (!it) return items;
      const next = Object.assign({}, it, {
        item_date: item_date || null,
        details: details ? Object.assign({}, details) : (it.details || {}),
      });
      if (end_date !== undefined) next.end_date = end_date;
      return patchItem(items, itemId, next);
    },
    planApply() { return null; },
    async execute(api, _base) {
      if (isLocalId(itemId)) {
        return { skipped: true };
      }
      const body = {
        item_date: item_date || null,
        details: details || {},
      };
      if (end_date !== undefined) body.end_date = end_date;
      const baseItem = _base?.baseItems?.find(i => i.id === itemId);
      if (baseItem?.updated_at) body.expected_updated_at = baseItem.updated_at;
      const res = await api.patch(`/api/items/${itemId}`, body);
      return { updatedItem: res.item };
    },
  };
}

export function updatePlanTitleOp({ planId, title, sessionId }) {
  return {
    id: null, kind: 'UPDATE_PLAN_TITLE', label: 'Rename plan', sessionId,
    apply() { return null; },
    planApply(plan) { return Object.assign({}, plan, { title }); },
    async execute(api, _base) {
      const body = { title };
      if (_base?.basePlan?.updated_at) body.expected_updated_at = _base.basePlan.updated_at;
      const res = await api.patch(`/api/plans/${planId}`, body);
      return { plan: res.plan };
    },
  };
}

/* Update the plan's trip date range. The caller must pass the *full* new
 * range (both start_date and end_date), even if only one changed, so the op
 * is always a complete snapshot. The label is derived from what actually
 * differs from the previous view. */
export function updatePlanDatesOp({ planId, start_date, end_date, prev, sessionId }) {
  prev = prev || {};
  const startChanged = prev.start_date !== start_date;
  const endChanged = prev.end_date !== end_date;
  let label = 'Change trip dates';
  if (startChanged && endChanged) label = 'Change trip dates';
  else if (startChanged) label = start_date && (!prev.start_date || start_date < prev.start_date)
    ? 'Extend trip start' : 'Change trip start';
  else if (endChanged) label = end_date && (!prev.end_date || end_date > prev.end_date)
    ? 'Extend trip end' : 'Change trip end';
  return {
    id: null, kind: 'UPDATE_PLAN_DATES', label, sessionId,
    apply() { return null; },
    planApply(plan) { return Object.assign({}, plan, { start_date, end_date }); },
    async execute(api, _base) {
      const body = { start_date, end_date };
      if (_base?.basePlan?.updated_at) body.expected_updated_at = _base.basePlan.updated_at;
      const res = await api.patch(`/api/plans/${planId}`, body);
      return { plan: res.plan };
    },
  };
}

/* Update per-day custom label. Staged so Save must be clicked to persist
 * the label on the server. */
export function updateDayMetaOp({ planId, date, label, sessionId }) {
  return {
    id: null, kind: 'UPDATE_DAY_META', label: 'Rename day', sessionId,
    apply() { return null; },
    planApply(plan) {
      const meta = Object.assign({}, plan.day_meta || {});
      const cur = Object.assign({}, meta[date] || {});
      if (label !== undefined) cur.label = label;
      if (Object.keys(cur).length === 0) {
        delete meta[date];
      } else {
        meta[date] = cur;
      }
      return Object.assign({}, plan, { day_meta: meta });
    },
    async execute(api) {
      await api.patch(`/api/plans/${planId}`, {
        day_meta_set: [{ date, label }],
      });
    },
  };
}

/* Toggle buffer days. `add` and `remove` are arrays of ISO dates. The op
 * bundles both directions into one PATCH (cheaper than two round trips and
 * the server is idempotent). */
export function updatePlanBufferDaysOp({ planId, add, remove, sessionId }) {
  add = add || [];
  remove = remove || [];
  const total = add.length + remove.length;
  const label = total === 1
    ? (add.length ? 'Add buffer day' : 'Remove buffer day')
    : `Toggle ${total} buffer day${total === 1 ? '' : 's'}`;
  return {
    id: null, kind: 'UPDATE_PLAN_BUFFER_DAYS', label, sessionId,
    apply() { return null; },
    planApply(plan) {
      // Reflect the new state in the local plan so the next render uses it.
      const cur = new Set(plan.buffer_days || []);
      for (const d of remove) cur.delete(d);
      for (const d of add) cur.add(d);
      const next = Object.assign({}, plan, { buffer_days: [...cur].sort() });
      return next;
    },
    async execute(api, _base) {
      const body = {};
      if (add.length) body.buffer_days_add = add;
      if (remove.length) body.buffer_days_remove = remove;
      if (_base?.basePlan?.updated_at) body.expected_updated_at = _base.basePlan.updated_at;
      const res = await api.patch(`/api/plans/${planId}`, body);
      return { plan: res.plan };
    },
  };
}

/* Delete an item. Local (not-yet-saved) items are simply dropped from the
 * view. The execute call is skipped for local ids. */
export function deleteItemOp({ itemId, label, sessionId }) {
  return {
    id: null, kind: 'DELETE_ITEM', label: label || 'Delete item', sessionId,
    apply(items) { return removeItem(items, itemId); },
    planApply() { return null; },
    async execute(api) {
      if (typeof itemId === 'string' && itemId.startsWith('_')) {
        return { skipped: true };
      }
      await api.del(`/api/items/${itemId}`);
      return { deleted: Number(itemId) };
    },
  };
}

/* Bulk-create items from a clipboard payload (paste or duplicate). The
 * op pre-builds the apply() result so the new items show on the board
 * immediately, and on Save it posts each one and attaches any links.
 *
 * `items` is an array of plain objects produced by serializeItem():
 *   { item_type, title, details, status, item_date, end_date, links[] }
 * and (optionally) `_srcId` for cut-paste bookkeeping (not sent to the
 * server). */
export function createItemsFromClipOp({ planId, item_date, items, sessionId }) {
  // Build the local drafts up-front so apply() can insert them right away.
  const drafts = items.map((src) => {
    const id = _LOCAL_ID();
    return {
      id, plan_id: planId,
      item_type: src.item_type,
      title: src.title || '(Untitled)',
      item_date: item_date,
      end_date: src.end_date || null,
      sort_key: 9999,
      status: src.status || 'planned',
      details: src.details ? Object.assign({}, src.details) : {},
      attachments: (src.links || []).map((lnk) => ({
        id: _LOCAL_ID(),
        item_id: id,
        kind: 'link',
        value: lnk.value,
        caption: lnk.caption || '',
        isLocal: true,
      })),
      isLocal: true,
      isNew: true,
    };
  });
  const label = items.length === 1
    ? `Add ${items[0].item_type || 'item'}`
    : `Add ${items.length} items`;
  return {
    id: null, kind: 'CREATE_ITEMS_FROM_CLIP', label, sessionId,
    _draftIds: drafts.map(d => d.id),
    apply(items, _base, ctx) {
      // First pass: no server result yet — insert the local drafts.
      if (!ctx || !ctx.result) return items.concat(drafts);
      // Second pass: after the server has run, swap local ids for real
      // ones and remap each draft's local attachments to the server's.
      const created = (ctx.result && ctx.result.created) || [];
      const byDraft = new Map(created.map(c => [c.draftId, c]));
      const newItems = items.map((it) => {
        const c = byDraft.get(String(it.id));
        if (!c) return it;
        const attachmentMap = new Map((c.attachmentMap || []).map(p => [p.localId, p.serverId]));
        const atts = (it.attachments || []).map(a => {
          const serverId = attachmentMap.get(a.id);
          if (serverId == null) return a;
          const updated = Object.assign({}, a, { id: serverId });
          delete updated.isLocal;
          return updated;
        });
        return Object.assign({}, it, {
          id: c.newId, isLocal: false, isNew: false, attachments: atts,
        });
      });
      return newItems;
    },
    planApply() { return null; },
    async execute(api) {
      const created = [];
      for (let i = 0; i < items.length; i++) {
        const src = items[i];
        const draft = drafts[i];
        const body = {
          item_type: src.item_type,
          title: src.title || '(Untitled)',
          item_date: item_date,
          end_date: src.end_date || null,
          status: src.status || 'planned',
          details: src.details || {},
        };
        const res = await api.post(`/api/plans/${planId}/items`, body);
        const newId = res.item.id;
        // Attach any links; record the {localAttId, serverAttId} pairs so
        // the apply function can swap them out after save.
        const attachmentMap = [];
        for (const lnk of (src.links || [])) {
          try {
            const att = await api.post(`/api/items/${newId}/attachments`,
                                       { kind: 'link', value: lnk.value, caption: lnk.caption || '' });
            const localAtt = (draft.attachments || []).find(
              a => a.value === lnk.value && (a.caption || '') === (lnk.caption || '')
            );
            if (localAtt) attachmentMap.push({ localId: localAtt.id, serverId: att.attachment.id });
          } catch (e) { /* best-effort */ }
        }
        created.push({ draftId: draft.id, newId, attachmentMap });
      }
      return { created };
    },
  };
}

/* Stage a batch of complete AI-suggested items as one grouped op. Unlike the
 * blank-draft editor flow, every item here is already valid (callers run the
 * required-field check first), so execute POSTs them directly. One op means
 * the pending bar shows a single change and one Revert rolls the whole batch
 * back; per-item dates and geocodes are carried through. */
export function addItemsFromExtractionOp({ planId, items, sessionId }) {
  const drafts = items.map((src) => {
    const id = _LOCAL_ID();
    return {
      id, plan_id: planId,
      item_type: src.item_type,
      title: src.title || '(Untitled)',
      item_date: src.item_date || null,
      end_date: src.end_date || null,
      sort_key: 9999,
      status: src.status || 'planned',
      details: src.details ? Object.assign({}, src.details) : {},
      geocodes: (src.geocodes || []).map(g => Object.assign({}, g)),
      attachments: [],
      isLocal: true,
      isNew: true,
    };
  });
  const label = items.length === 1
    ? `Add ${items[0].item_type || 'item'}`
    : `Add ${items.length} items`;
  return {
    id: null, kind: 'ADD_EXTRACTION_ITEMS', label, sessionId,
    _draftIds: drafts.map(d => d.id),
    apply(list, _base, ctx) {
      // First pass: no server result yet — insert the local drafts.
      if (!ctx || !ctx.result) return list.concat(drafts);
      // Second pass: swap each draft's local id for the server id. The commit
      // starts from the pre-op base (which never saw the first-pass drafts), so
      // re-attach every created item, using the values the view settled on
      // (a sibling drag may have rescheduled it after the draft was inserted).
      const created = (ctx.result && ctx.result.created) || [];
      const byDraft = new Map(created.map(c => [String(c.draftId), c]));
      const mapped = list.map((it) => {
        const c = byDraft.get(String(it.id));
        if (!c) return it;
        return Object.assign({}, c.item || it, { id: c.newId, isLocal: false, isNew: false });
      });
      for (const c of created) {
        if (mapped.some(it => String(it.id) === String(c.newId))) continue;
        mapped.push(Object.assign({}, c.item || {}, { id: c.newId, isLocal: false, isNew: false }));
      }
      return mapped;
    },
    planApply() { return null; },
    async execute(api, _base) {
      // POST the drafts that are still in the save's view, using their current
      // field values. A draft removed by a sibling delete op is absent from the
      // view and is skipped; a draft rescheduled by a sibling op is POSTed with
      // its new date. The returned `item` lets the commit pass re-attach the
      // settled values (including the server's sort fields) instead of the
      // stale draft snapshot.
      const viewItems = (_base && _base.items) || [];
      const created = [];
      for (const draft of drafts) {
        const cur = viewItems.find(x => String(x.id) === String(draft.id));
        if (!cur) continue;
        const body = {
          item_type: cur.item_type,
          title: cur.title || '(Untitled)',
          item_date: cur.item_date || null,
          end_date: cur.end_date || null,
          status: cur.status || 'planned',
          details: cur.details || {},
          geocodes: cur.geocodes || [],
        };
        const res = await api.post(`/api/plans/${planId}/items`, body);
        created.push({ draftId: draft.id, newId: res.item.id, item: Object.assign({}, cur, res.item) });
      }
      return { created };
    },
  };
}

export function moveItemOp({ itemId, item_date, before_id, after_id, end_date, sessionId }) {
  return {
    id: null, kind: 'MOVE_ITEM', label: 'Move item', sessionId,
    apply(items) {
      const it = items.find(x => String(x.id) === String(itemId));
      if (!it) return items;
      const spansDays = it.end_date && it.item_date && it.end_date > it.item_date;
      const patch = { item_date: item_date || null };
      if (spansDays && end_date) patch.end_date = end_date;
      // The ``when`` object is the single source of truth for dates, so a
      // move must shift it too — otherwise the timeline (which reads
      // details.when) and the server's reconciliation would keep the old
      // date. Preserve the existing times and only move the date parts.
      const details = it.details ? Object.assign({}, it.details) : {};
      const when = details.when ? Object.assign({}, details.when) : {};
      if (when.start_at) when.start_at = shiftDate(when.start_at, item_date || it.item_date);
      // end_at lives on the same day as start_at for single-date items, so
      // it follows item_date; spanning items shift it to the new end_date.
      if (when.end_at) when.end_at = shiftDate(when.end_at, end_date || item_date || it.item_date);
      if (Object.keys(when).length) details.when = when;
      patch.details = details;
      const moved = reorderForMove(
        items.map(x => String(x.id) === String(itemId) ? Object.assign({}, x, patch) : x),
        itemId, item_date, before_id, after_id);
      return moved;
    },
    planApply() { return null; },
    async execute(api) {
      // If the item is still local (not yet on the server), the move is
      // already encoded in the draft's item_date/end_date, which the
      // upcoming CREATE will use. Skip the move call to avoid a 404.
      if (typeof itemId === 'string' && itemId.startsWith('_')) {
        return { skipped: true };
      }
      const body = {
        item_date: item_date || null,
        before_id: before_id || null,
        after_id: after_id || null,
      };
      if (end_date) body.end_date = end_date;
      const res = await api.post(`/api/items/${itemId}/move`, body);
      return { updatedItem: res.item };
    },
  };
}

export function uploadImageOp({ itemId, file, previewUrl, caption, sessionId }) {
  const localAttachmentId = _LOCAL_ID();
  const initial = {
    id: localAttachmentId,
    item_id: itemId,
    kind: 'image',
    value: previewUrl,
    caption: caption || file.name,
    isLocal: true,
  };
  return {
    id: null, kind: 'UPLOAD_IMAGE', label: `Upload ${file.name}`,
    sessionId, _localAttachmentId: localAttachmentId, _initialAttachment: initial,
    apply(items, _base, ctx) {
      // Find the target item: prefer one that already contains our local
      // attachment id (handles id remapping after save), otherwise fall back
      // to the captured itemId (used on first application during view).
      let targetItem = items.find(x => (x.attachments || []).some(a => a.id === localAttachmentId));
      if (!targetItem) targetItem = items.find(x => String(x.id) === String(itemId));
      if (!targetItem) return items;
      const cur = (targetItem.attachments || []).slice();
      if (ctx && ctx.result && ctx.result.updatedAttachments) {
        const real = ctx.result.updatedAttachments.find(u => u.localAttachmentId === localAttachmentId);
        if (real) {
          const realAtt = Object.assign({}, real.attachment, { isLocal: true });
          const localIdx = cur.findIndex(a => a.id === localAttachmentId);
          if (localIdx >= 0) cur[localIdx] = realAtt;
          else cur.push(realAtt);
          return patchItem(items, targetItem.id, { attachments: cur });
        }
      }
      const localIdx = cur.findIndex(a => a.id === localAttachmentId);
      if (localIdx >= 0) return items;
      cur.push({
        id: localAttachmentId,
        item_id: targetItem.id,
        kind: 'image',
        value: previewUrl,
        caption: caption || file.name,
        isLocal: true,
      });
      return patchItem(items, targetItem.id, { attachments: cur });
    },
    planApply() { return null; },
    async execute(api, _base, ctx) {
      // When bundled inside SAVE_ITEM.execute, ctx.itemId is the real id
      // (just created). When standalone on the board, the captured itemId
      // is the real id. Skip only if BOTH indicate a local id (which means
      // the op was mis-staged — e.g. dropped onto a draft, where the
      // itinerary should have opened the editor instead).
      const targetId = (ctx && ctx.itemId) || itemId;
      if (isLocalId(targetId)) return { skipped: true };
      const res = await api.upload(`/api/items/${targetId}/upload`, file);
      return { updatedAttachments: [{ localAttachmentId, attachment: res.attachment }], itemId: targetId };
    },
  };
}

export function addLinkOp({ itemId, url, caption, sessionId }) {
  const localAttachmentId = _LOCAL_ID();
  const initial = {
    id: localAttachmentId,
    item_id: itemId,
    kind: 'link',
    value: url,
    caption: caption || '',
    isLocal: true,
  };
  return {
    id: null, kind: 'ADD_LINK', label: `Add link ${trunc(url, 28)}`,
    sessionId, _localAttachmentId: localAttachmentId, _initialAttachment: initial,
    apply(items, _base, ctx) {
      let targetItem = items.find(x => (x.attachments || []).some(a => a.id === localAttachmentId));
      if (!targetItem) targetItem = items.find(x => String(x.id) === String(itemId));
      if (!targetItem) return items;
      const cur = (targetItem.attachments || []).slice();
      if (ctx && ctx.result && ctx.result.updatedAttachments) {
        const real = ctx.result.updatedAttachments.find(u => u.localAttachmentId === localAttachmentId);
        if (real) {
          const realAtt = Object.assign({}, real.attachment, { isLocal: true });
          const localIdx = cur.findIndex(a => a.id === localAttachmentId);
          if (localIdx >= 0) cur[localIdx] = realAtt;
          else cur.push(realAtt);
          return patchItem(items, targetItem.id, { attachments: cur });
        }
      }
      const localIdx = cur.findIndex(a => a.id === localAttachmentId);
      if (localIdx >= 0) return items;
      cur.push({
        id: localAttachmentId,
        item_id: targetItem.id,
        kind: 'link',
        value: url,
        caption: caption || '',
        isLocal: true,
      });
      return patchItem(items, targetItem.id, { attachments: cur });
    },
    planApply() { return null; },
    async execute(api, _base, ctx) {
      const targetId = (ctx && ctx.itemId) || itemId;
      if (isLocalId(targetId)) return { skipped: true };
      const res = await api.post(`/api/items/${targetId}/attachments`,
        { kind: 'link', value: url, caption: caption || undefined });
      return { updatedAttachments: [{ localAttachmentId, attachment: res.attachment }], itemId: targetId };
    },
  };
}

export function updateAttachmentOp({ itemId, attachmentId, value, caption, sessionId }) {
  return {
    id: null, kind: 'UPDATE_ATTACHMENT', label: 'Edit link', sessionId,
    apply(items) {
      const it = items.find(x => String(x.id) === String(itemId));
      if (!it) return items;
      const next = (it.attachments || []).map(a =>
        String(a.id) === String(attachmentId)
          ? Object.assign({}, a, { value: value || a.value, caption: caption !== undefined ? caption : a.caption })
          : a
      );
      return patchItem(items, itemId, { attachments: next });
    },
    planApply() { return null; },
    async execute(api) {
      const body = { value, caption };
      if (caption === undefined) delete body.caption;
      const res = await api.patch(`/api/attachments/${attachmentId}`, body);
      return { itemId, updatedAttachments: [{ localAttachmentId: null, attachment: res.attachment }] };
    },
  };
}

export function deleteAttachmentOp({ itemId, attachmentId, sessionId }) {
  return {
    id: null, kind: 'DELETE_ATTACHMENT', label: 'Delete attachment', sessionId,
    apply(items) {
      const it = items.find(x => String(x.id) === String(itemId));
      if (!it) return items;
      const next = (it.attachments || []).filter(a => String(a.id) !== String(attachmentId));
      return patchItem(items, itemId, { attachments: next });
    },
    planApply() { return null; },
    async execute(api) {
      await api.del(`/api/attachments/${attachmentId}`);
      return { itemId };
    },
  };
}

export function addExpenseOp({ planId, itemId, description, currency, amountCents, payerId, participantIds, sessionId }) {
  return {
    id: null, kind: 'ADD_EXPENSE', label: `Add expense ${currency} ${(amountCents / 100).toFixed(2)}`, sessionId,
    apply() { return null; },
    planApply() { return null; },
    async execute(api, _base, ctx) {
      const targetItemId = (ctx && ctx.itemId) || itemId;
      if (isLocalId(targetItemId)) return { skipped: true };
      const amount = (amountCents / 100).toFixed(2);
      await api.post(`/api/plans/${planId}/expenses`, {
        item_id: targetItemId,
        description: description || '',
        currency,
        amount,
        split_method: 'EQUAL',
        payers: [{ user_id: payerId, amount }],
        participants: participantIds,
      });
      return { itemId: targetItemId };
    },
  };
}

/* ---------- the Staging engine ---------- */

export class Staging {
  /**
   * @param {object} opts
   * @param {Array}   opts.baseItems   last server-confirmed items
   * @param {object}  opts.basePlan    last server-confirmed plan
   * @param {function} opts.onChange   called whenever the view changes
   */
  constructor({ baseItems, basePlan, onChange }) {
    this.base = { items: baseItems || [], plan: basePlan || {} };
    this.ops = [];
    this.pointer = 0;
    this.subscribers = new Set();
    if (onChange) this.subscribers.add(onChange);
    this.sessionOps = new Map();      // sessionId -> [op indices in this.ops]
    this.failedOpIndex = -1;
    this.failedError = null;
    this.saving = false;
  }

  subscribe(cb) { this.subscribers.add(cb); return () => this.subscribers.delete(cb); }
  _notify() { for (const cb of this.subscribers) { try { cb(this); } catch (e) { console.error(e); } } }

  get pendingCount() { return this.pointer; }
  get redoCount() { return this.ops.length - this.pointer; }
  get canUndo() { return this.pointer > 0; }
  get canRedo() { return this.pointer < this.ops.length; }
  get hasPending() { return this.pointer > 0; }

  /** View of items with all applied ops folded in. */
  viewItems() {
    let items = this.base.items;
    for (let i = 0; i < this.pointer; i++) {
      const next = this.ops[i].apply(items, this.base);
      if (next) items = next;
    }
    return items;
  }

  /** View of the plan with title updates applied. */
  viewPlan() {
    let plan = this.base.plan;
    for (let i = 0; i < this.pointer; i++) {
      const next = this.ops[i].planApply(plan);
      if (next) plan = next;
    }
    return plan;
  }

  /** Push a new op. Truncates any redoable tail. */
  add(op) {
    if (this.saving) return;
    if (this.pointer < this.ops.length) {
      // Truncate the redoable tail. We must also clean up sessionOps:
      // any index >= pointer is about to be gone, so remove those. The
      // indices < pointer (the live history) keep their tracking.
      //
      // Earlier code did `sessionOps.clear()` here, which was a bug:
      // if an earlier op belonged to a still-active session (e.g. the
      // editor's first saveItemOp), that session's tracking was wiped
      // even though its op survived. The next `discardSession()` for
      // that session would then leave the op behind, so the editor's
      // Cancel button failed to roll back its first edit.
      const cutPoint = this.pointer;
      this.ops.length = cutPoint;
      for (const [sid, idxs] of this.sessionOps) {
        const surviving = idxs.filter(i => i < cutPoint);
        if (surviving.length) {
          this.sessionOps.set(sid, surviving);
        } else {
          this.sessionOps.delete(sid);
        }
      }
    }
    op.id = this.ops.length + 1;
    const idx = this.ops.length;
    this.ops.push(op);
    this.pointer = this.ops.length;
    if (op.sessionId) {
      if (!this.sessionOps.has(op.sessionId)) this.sessionOps.set(op.sessionId, []);
      this.sessionOps.get(op.sessionId).push(idx);
    }
    this.failedOpIndex = -1;
    this.failedError = null;
    this._notify();
  }

  undo() {
    if (!this.canUndo) return;
    this.pointer--;
    this.failedOpIndex = -1;
    this.failedError = null;
    this._notify();
  }

  redo() {
    if (!this.canRedo) return;
    this.pointer++;
    this.failedOpIndex = -1;
    this.failedError = null;
    this._notify();
  }

  /**
   * Discard all ops belonging to a session (e.g. when the user clicks Cancel
   * in the item editor). The intent is "undo everything I did in this session
   * and rewind past any non-session work that came after it."
   */
  discardSession(sessionId) {
    if (!this.sessionOps.has(sessionId)) return;
    const idxs = this.sessionOps.get(sessionId);
    const minIdx = Math.min(...idxs);
    if (this.pointer > minIdx) this.pointer = minIdx;
    this.ops.splice(minIdx, this.ops.length - minIdx);
    this.sessionOps.delete(sessionId);
    this.failedOpIndex = -1;
    this.failedError = null;
    this._notify();
  }

  /**
   * Replay pending ops against the server. On success, base is replaced with
   * the merged live state and the op list clears. On error, halts and marks
   * the failing op (pointer stays so the user can Revert or retry).
   * @param {object} api {post, patch, del, upload} (typically api.js)
   * @param {function} [onProgress] (i, total) => void
   */
  async saveAll(api, onProgress) {
    if (this.saving) return;
    this.saving = true;
    this.failedOpIndex = -1;
    this.failedError = null;
    this._lastResults = [];          // results[i] = execute return of ops[i]
    this._notify();
    try {
      for (let i = 0; i < this.pointer; i++) {
        const op = this.ops[i];
        if (onProgress) onProgress(i + 1, this.pointer);
        try {
          const result = await op.execute(api, { items: this.viewItems(), plan: this.viewPlan(), baseItems: this.base.items, basePlan: this.base.plan });
          this._lastResults[i] = result || null;
          // Keep the base in sync so the next op for the same item sees
          // the fresh updated_at (avoids a version-conflict 409 when
          // multiple ops target the same item, e.g. two hotel-event drags
          // before a single Save).
          if (result && result.updatedItem) {
            const ui = result.updatedItem;
            const idx = this.base.items.findIndex(x => String(x.id) === String(ui.id));
            if (idx >= 0) this.base.items[idx] = Object.assign({}, this.base.items[idx], ui);
          }
          // Ops that PATCH several items at once (APPLY_EDITS) return an array.
          if (result && result.updatedItems) {
            for (const ui of result.updatedItems) {
              const idx = this.base.items.findIndex(x => String(x.id) === String(ui.id));
              if (idx >= 0) this.base.items[idx] = Object.assign({}, this.base.items[idx], ui);
            }
          }
        } catch (e) {
          this.failedOpIndex = i;
          this.failedError = (e && e.message) || String(e);
          this._notify();
          throw e;
        }
      }
      this._commitFromLive();
    } finally {
      this.saving = false;
      this._notify();
    }
  }

  /** After a successful save, merge the local view into base and clear ops. */
  _commitFromLive() {
    let items = this.base.items;
    for (let i = 0; i < this.pointer; i++) {
      const next = this.ops[i].apply(items, this.base, { result: this._lastResults[i] });
      if (next) items = next;
    }
    let plan = this.base.plan;
    for (let i = 0; i < this.pointer; i++) {
      const next = this.ops[i].planApply(plan);
      if (next) plan = next;
    }
    // Strip any remaining local flags so the view doesn't show "unsaved" markers.
    items = items.map(it => {
      const cleaned = Object.assign({}, it, { isLocal: undefined, isNew: undefined });
      delete cleaned.isLocal; delete cleaned.isNew;
      cleaned.attachments = (it.attachments || []).map(a => {
        const ca = Object.assign({}, a, { isLocal: undefined });
        delete ca.isLocal;
        return ca;
      });
      return cleaned;
    });
    this.base = { items, plan };
    this.ops = [];
    this.pointer = 0;
    this.sessionOps.clear();
    this.failedOpIndex = -1;
    this.failedError = null;
  }
}
