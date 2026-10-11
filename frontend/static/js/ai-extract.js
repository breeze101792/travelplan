/* ai-extract.js — turn AI-suggested items into pre-filled item editors.
 *
 * The AI chat widget gets back {reply, items, edits} from
 * /api/plans/<id>/ai/chat. This helper stages a blank item for each
 * suggestion (or patches an existing item for each edit), and opens the item
 * editor pre-filled — the same flow the board/timeline use for their
 * Quick-add buttons. The user reviews and clicks Apply; nothing reaches the
 * server until the global Save bar.
 */
import { createBlankItemOp, applyEditsOp, addItemsFromExtractionOp, mergedItemForEdit } from '/static/js/staging.js';
import { openItemEditor } from '/static/js/item-editor.js';

// A unique session id tags every op an extraction stages, so the editor's
// Cancel can discard exactly that session's work.
function newSessionId() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Client-side mirror of the server's required-field check
// (backend/blueprints/items.py:_validate_required). Returns null when the
// suggestion is complete, else a human message. Used to decide whether an
// AI-suggested item can be staged directly or must go through the editor.
export function suggestionError(ext, settings) {
  const title = (ext.title || '').trim();
  if (!title) return 'title required';
  const details = Object.assign({}, ext.details || {});
  const when = ext.when || details.when;
  if (!when || !when.start_at) return 'start time required';
  if (!when.end_at) return 'end time required';
  const spec = (settings && settings.item_types && settings.item_types[ext.item_type]) || {};
  for (const f of spec.fields || []) {
    if (!f.required) continue;
    const v = details[f.key];
    if (v == null || String(v).trim() === '') return `${f.label || f.key} required`;
  }
  return null;
}

// Shape a suggestion into the item fields the batch-create op expects.
function extToItem(ext) {
  const details = Object.assign({}, ext.details || {});
  const when = ext.when || details.when;
  if (when && when.start_at) details.when = when;
  return {
    item_type: ext.item_type,
    title: ext.title,
    item_date: ext.item_date || (when && when.start_at ? when.start_at.slice(0, 10) : null),
    end_date: ext.end_date || (when && when.end_at ? when.end_at.slice(0, 10) : null),
    status: 'planned',
    details,
    geocodes: ext.geocodes || [],
  };
}

export function createItemFromExtraction({ ctx, staging, plan, settings, members, onApplied, onClose }, ext) {
  if (!ext || !ext.item_type) return;
  const sessionId = newSessionId();
  const op = createBlankItemOp({
    planId: ctx.planId,
    item_type: ext.item_type,
    item_date: ext.item_date || null,
    end_date: ext.end_date || null,
    sessionId,
  });
  staging.add(op);
  const draft = staging.viewItems().find(x => x.id === op._draftId);
  if (!draft) return;

  // Patch the draft with the extracted fields so the editor opens pre-filled.
  draft.title = ext.title || draft.title;
  draft.details = Object.assign({}, ext.details || {});
  if (ext.when && ext.when.start_at) draft.details.when = ext.when;
  draft.item_date = ext.item_date || draft.item_date;
  draft.end_date = ext.end_date || draft.end_date;
  if (ext.geocodes && ext.geocodes.length) draft.geocodes = ext.geocodes.slice();

  openItemEditor(ctx, {
    plan, item: draft, settings, members,
    staging, sessionId,
    onApplied,
    onClose,
  });
}

export function editItemFromExtraction({ ctx, staging, plan, settings, members, onApplied, onClose }, edit) {
  if (!edit || edit.item_id == null) return;
  const item = staging.viewItems().find(x => String(x.id) === String(edit.item_id));
  if (!item) return;
  const sessionId = newSessionId();

  // Patch the existing item with the edited fields so the editor opens
  // pre-filled. The user reviews and clicks Apply; the SAVE_ITEM op PATCHes
  // the existing item (isNew is false because the id is a real server id).
  // Write the merged fields back onto the live view item so the board
  // reflects them while the editor is open.
  Object.assign(item, mergedItemForEdit(item, edit));

  openItemEditor(ctx, {
    plan, item, settings, members,
    staging, sessionId,
    onApplied,
    onClose,
  });
}

/* Add a batch of AI-suggested items at once, without opening an editor per
 * item. Complete suggestions are staged as one grouped op (one pending change);
 * the first incomplete one is opened in the editor so its required fields can
 * be filled in — a direct POST would be rejected on Save. Returns the split of
 * {staged, invalid} so the caller can mark the applied rows. Only the items
 * passed in are added. */
export function addItemsFromExtraction({ ctx, staging, plan, settings, members, onApplied, onClose }, exts) {
  const list = (exts || []).filter(e => e && e.item_type);
  if (!list.length) return { staged: [], invalid: [] };
  if (staging.saving) return { staged: [], invalid: list };

  const staged = [];
  const invalid = [];
  for (const ext of list) (suggestionError(ext, settings) ? invalid : staged).push(ext);

  if (staged.length) {
    staging.add(addItemsFromExtractionOp({
      planId: ctx.planId, items: staged.map(extToItem), sessionId: newSessionId(),
    }));
    if (onApplied) onApplied();
  }
  if (invalid.length) {
    createItemFromExtraction({ ctx, staging, plan, settings, members, onApplied, onClose }, invalid[0]);
  }
  return { staged, invalid };
}

/* Apply a whole batch of AI edits from one reply at once, without opening an
 * editor per item. The edits are staged as a single grouped op so the pending
 * bar shows one change and one Revert rolls the whole batch back; Save still
 * commits them to the server. Only the edits passed in are applied — callers
 * pass the current reply's edits, never the whole chat history. */
export function applyEditsFromExtraction({ ctx, staging, onApplied }, edits) {
  const list = (edits || []).filter(e => e && e.item_id != null);
  if (!list.length) return false;
  if (staging.saving) return false;
  const sessionId = newSessionId();
  staging.add(applyEditsOp({
    planId: ctx.planId, edits: list, sessionId,
    label: `AI: apply ${list.length} edit${list.length === 1 ? '' : 's'}`,
  }));
  if (onApplied) onApplied();
  return true;
}
