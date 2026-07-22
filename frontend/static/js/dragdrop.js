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
  let touchState = null;

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
    if (!onMove || !dragItemId) return;
    const targetDate = box.dataset.date || '';
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

  /* ---------- touch support (long-press to drag) ---------- */
  boardEl.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.card.item');
    if (!card) return;
    const t = e.touches[0];
    touchState = {
      card, itemId: card.dataset.itemId, ghost: null,
      startX: t.clientX, startY: t.clientY, active: false,
      timer: setTimeout(() => {
        touchState.active = true;
        card.classList.add('dragging');
        const ghost = card.cloneNode(true);
        ghost.style.position = 'fixed';
        ghost.style.width = card.offsetWidth + 'px';
        ghost.style.opacity = '0.85';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '9999';
        ghost.style.transform = 'scale(0.95)';
        ghost.style.borderRadius = '0.9rem';
        ghost.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
        document.body.appendChild(ghost);
        touchState.ghost = ghost;
        positionTouchGhost(t);
      }, 500),
    };
  }, { passive: true });

  function positionTouchGhost(t) {
    if (!touchState || !touchState.ghost) return;
    touchState.ghost.style.left = (t.clientX - touchState.ghost.offsetWidth / 2) + 'px';
    touchState.ghost.style.top = (t.clientY - 20) + 'px';
  }

  boardEl.addEventListener('touchmove', (e) => {
    if (!touchState) return;
    const t = e.touches[0];
    if (touchState.active) {
      e.preventDefault();
      positionTouchGhost(t);
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const box = el && el.closest('.day-items');
      boardEl.querySelectorAll('.day-items.drag-over').forEach((n) => {
        if (n !== box) n.classList.remove('drag-over');
      });
      if (box) box.classList.add('drag-over');
      return;
    }
    const dx = Math.abs(t.clientX - touchState.startX);
    const dy = Math.abs(t.clientY - touchState.startY);
    if (dx > 12 || dy > 12) {
      clearTimeout(touchState.timer);
      touchState = null;
    }
  }, { passive: false });

  boardEl.addEventListener('touchend', async (e) => {
    if (!touchState) return;
    if (!touchState.active) {
      clearTimeout(touchState.timer);
      touchState = null;
      return;
    }
    e.preventDefault();
    if (touchState.ghost) { touchState.ghost.remove(); }
    if (touchState.card) { touchState.card.classList.remove('dragging'); }
    boardEl.querySelectorAll('.day-items.drag-over').forEach((n) => n.classList.remove('drag-over'));

    const t = e.changedTouches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const box = el && el.closest('.day-items');
    if (box && onMove) {
      const targetDate = box.dataset.date || '';
      const cards = [...box.querySelectorAll('.card.item')].filter((c) => c.dataset.itemId !== touchState.itemId);
      const beforeCard = cards.find((c) => (c.offsetTop + c.offsetHeight / 2) > t.clientY) || null;
      const beforeId = beforeCard ? beforeCard.dataset.itemId : null;
      let afterId = null;
      if (beforeCard) {
        const idx = cards.indexOf(beforeCard);
        afterId = idx > 0 ? cards[idx - 1].dataset.itemId : null;
      } else if (cards.length) {
        afterId = cards[cards.length - 1].dataset.itemId;
      }
      await onMove(touchState.itemId, { item_date: targetDate, before_id: beforeId, after_id: afterId });
    }
    touchState = null;
  }, { passive: false });
}