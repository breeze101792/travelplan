/* dragdrop.js — native HTML5 drag-and-drop for the board.
 *
 * NOTE: native DnD is desktop-only. On touch devices the item editor provides
 * an <input type=file> fallback for image uploads (no reorder on touch).
 *
 * enableDragDrop(boardEl, { onMove, onUpload })
 *   onMove(itemId, { item_date, before_id, after_id })  — reorder/move a card
 *   onUpload(itemId, file)                              — attach an image file
 */
export function enableDragDrop(boardEl, { onMove, onUpload }) {
  if (!boardEl) return;
  let dragItemId = null;

  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card.item');
    if (!card) return;
    dragItemId = card.dataset.itemId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragItemId);
    card.classList.add('dragging');
  });

  boardEl.addEventListener('dragend', (e) => {
    const card = e.target.closest('.card.item');
    if (card) card.classList.remove('dragging');
    boardEl.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    dragItemId = null;
  });

  boardEl.addEventListener('dragover', (e) => {
    const box = e.target.closest('.day-items');
    if (!box) return;
    e.preventDefault();
    box.classList.add('drag-over');
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move';
  });

  boardEl.addEventListener('dragleave', (e) => {
    const box = e.target.closest('.day-items');
    if (box && !box.contains(e.relatedTarget)) box.classList.remove('drag-over');
  });

  boardEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const box = e.target.closest('.day-items');
    if (box) box.classList.remove('drag-over');
    if (!box) return;

    // --- file drop: attach image to the card under the cursor (or the last card) ---
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      if (!onUpload) return;
      const cards = [...box.querySelectorAll('.card.item')];
      let target = cards.find((c) => (c.offsetTop + c.offsetHeight / 2) > e.clientY) || null;
      if (!target && cards.length) target = cards[cards.length - 1];
      if (!target) return;
      const itemId = target.dataset.itemId;
      for (const f of e.dataTransfer.files) {
        if (f.type.startsWith('image/')) await onUpload(itemId, f);
      }
      return;
    }

    // --- reorder / move between days ---
    if (!onMove || !dragItemId) return;
    const targetDate = box.dataset.date || '';
    // Exclude the dragged card from insertion-point math (it's still in the DOM).
    const cards = [...box.querySelectorAll('.card.item')].filter((c) => c.dataset.itemId !== dragItemId);
    const beforeCard = cards.find((c) => (c.offsetTop + c.offsetHeight / 2) > e.clientY) || null;
    const beforeId = beforeCard ? beforeCard.dataset.itemId : null;
    let afterId = null;
    if (beforeCard) {
      const idx = cards.indexOf(beforeCard);
      afterId = idx > 0 ? cards[idx - 1].dataset.itemId : null;
    } else if (cards.length) {
      afterId = cards[cards.length - 1].dataset.itemId;
    }
    await onMove(dragItemId, { item_date: targetDate, before_id: beforeId, after_id: afterId });
  });
}