/* ai-extract.js — turn AI-suggested items into pre-filled item editors.
 *
 * The AI chat widget gets back {reply, items} from /api/plans/<id>/ai/chat.
 * This helper stages a blank item for each suggestion, patches the draft with
 * the extracted fields, and opens the item editor pre-filled — the same flow
 * the board/timeline use for their Quick-add buttons. The user reviews and
 * clicks Apply; nothing reaches the server until the global Save bar.
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

  openItemEditor(ctx, {
    plan, item: draft, settings, members,
    staging, sessionId,
    onApplied,
    onClose,
  });
}
