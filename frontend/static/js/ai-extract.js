/* ai-extract.js — turn AI-suggested items into pre-filled item editors.
 *
 * The AI chat widget gets back {reply, items, edits} from
 * /api/plans/<id>/ai/chat. This helper stages a blank item for each
 * suggestion (or patches an existing item for each edit), and opens the item
 * editor pre-filled — the same flow the board/timeline use for their
 * Quick-add buttons. The user reviews and clicks Apply; nothing reaches the
 * server until the global Save bar.
 */
import { createBlankItemOp } from '/static/js/staging.js';
import { openItemEditor } from '/static/js/item-editor.js';

export function createItemFromExtraction({ ctx, staging, plan, settings, members, onApplied, onClose }, ext) {
  if (!ext || !ext.item_type) return;
  const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
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
  const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Patch the existing item with the edited fields so the editor opens
  // pre-filled. The user reviews and clicks Apply; the SAVE_ITEM op PATCHes
  // the existing item (isNew is false because the id is a real server id).
  if (edit.title) item.title = edit.title;
  if (edit.details) item.details = Object.assign({}, item.details || {}, edit.details);
  if (edit.when && edit.when.start_at) {
    item.details = Object.assign({}, item.details || {});
    item.details.when = edit.when;
    item.item_date = edit.when.start_at.slice(0, 10);
    if (edit.when.end_at) item.end_date = edit.when.end_at.slice(0, 10);
  }
  if (edit.geocodes && edit.geocodes.length) item.geocodes = edit.geocodes.slice();

  openItemEditor(ctx, {
    plan, item, settings, members,
    staging, sessionId,
    onApplied,
    onClose,
  });
}
