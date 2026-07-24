/* item-editor.js — modal editor for a single itinerary item.
 *
 * In the new staged model, the editor's "Apply" button stages a SAVE_ITEM op
 * (composite: create-or-patch + bundled sub-effects for new attachments,
 * uploaded images, and a new expense). Nothing reaches the server until the
 * user clicks the global Save button in the pending bar.
 *
 * "Cancel" discards the entire session: any DELETE_ATTACHMENT op the user
 * staged, plus the CREATE_BLANK_ITEM op (if the editor was opened for a new
 * item), plus the SAVE_ITEM op (if Apply was already clicked).
 *
 * openItemEditor(ctx, { plan, item, settings, members, staging, sessionId, onApplied })
 *   ctx        = { planId, role }
 *   item       = the current view of the item (may have pending changes)
 *   members    = [{ id, username, display_name, role }]
 *   staging    = the Staging engine
 *   sessionId  = unique id for this editor session (for Cancel-discard)
 *   onApplied  = callback invoked after a successful Apply
 */
import { apiGet } from '/static/js/api.js';
import { el, clear } from '/static/js/util.js';
import { openExpenseFormModal } from '/static/js/expense-form.js';
import {
  saveItemOp, uploadImageOp, addLinkOp, deleteAttachmentOp, addExpenseOp, updateAttachmentOp,
} from '/static/js/staging.js';

export function openItemEditor(ctx, { plan, item, settings, members, staging, sessionId, onApplied, onClose }) {
  const ti = settings.item_types[item.item_type] || { label: item.item_type, fields: [] };
  const readOnly = ctx.role === 'viewer';
  const isNew = !!item.isNew || (typeof item.id === 'string' && item.id.startsWith('_-'));
  // Local in-editor state. The user can add attachments, upload images, and
  // add an expense here; they are bundled into the SAVE_ITEM op on Apply.
  // Existing attachments (with real ids) are also tracked here so we can
  // detect deletes and stage DELETE_ATTACHMENT ops for them.
  let pendingSubEffects = [];      // sub-ops to bundle into SAVE_ITEM (new link/image/expense)
  // Track the "current" attachment list for the editor: starts with the
  // item's attachments, mutated by Add Link / Upload / Delete.
  let attachments = (item.attachments || []).slice().map(a => Object.assign({}, a));
  // Files queued for upload (kept in editor until Apply so a Cancel discards them).
  let pendingFiles = [];           // { file, previewUrl, caption, kind: 'image' }
  let selectedGeocodes = [];
  if (item.geocodes && item.geocodes.length > 0) {
    selectedGeocodes = item.geocodes.slice();
  }

  /* ----- structure ----- */
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal item-editor' });
  backdrop.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h3', { text: ti.label + (readOnly ? ' (read-only)' : '') }),
    el('button', { class: 'modal-close', text: '×', onclick: onCancel }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  // Two columns: type-specific fields on the left, status/dates/attachments/expense
  // on the right. Falls back to a single column on narrow screens (CSS handles it).
  const grid = el('div', { class: 'ie-grid' });
  const colMain = el('div', { class: 'ie-col' });
  const colSide = el('div', { class: 'ie-col' });
  body.appendChild(grid);
  grid.appendChild(colMain);
  grid.appendChild(colSide);

  // title (left col)
  colMain.appendChild(el('label', { class: 'field', text: 'Title' }));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'input';
  titleInput.value = item.title || '';
  if (readOnly) titleInput.disabled = true;
  colMain.appendChild(titleInput);

  // "This is a backup" checkbox
  const isBackup = !!(item.details && item.details.is_backup);
  const backupLabel = document.createElement('label');
  backupLabel.className = 'checkbox-line';
  const backupInput = document.createElement('input');
  backupInput.type = 'checkbox';
  backupInput.checked = isBackup;
  if (readOnly) backupInput.disabled = true;
  backupLabel.appendChild(backupInput);
  backupLabel.appendChild(document.createTextNode(' This is a backup / alternative plan (shown after the main item on the timeline)'));
  colMain.appendChild(backupLabel);

  // type-specific fields (left col), grouped into rows when the type
  // declares a `rows` layout. A row of length > 1 places its inputs side by
  // side (flex 1 each); single-element rows render full-width. Falls back
  // to one-field-per-row for types that don't declare `rows`.
  const fieldInputs = {};
  const fieldByKey = {};
  for (const f of (ti.fields || [])) fieldByKey[f.key] = f;
  const rowLayout = (ti.rows && ti.rows.length)
    ? ti.rows
    : (ti.fields || []).map(f => [f.key]);
  for (const rowKeys of rowLayout) {
    const rowKeysFiltered = rowKeys.filter(k => fieldByKey[k]);
    if (!rowKeysFiltered.length) continue;
    const rowEl = el('div', { class: 'field-row' });
    for (const k of rowKeysFiltered) {
      const f = fieldByKey[k];
      const grp = el('div', { class: 'field-group' });
      grp.appendChild(el('label', { class: 'field', text: f.label }));
      const inp = makeFieldInput(f, item.details, settings, plan);
      if (readOnly) inp.disabled = true;
      fieldInputs[f.key] = inp;
      grp.appendChild(inp);
      rowEl.appendChild(grp);
    }
    colMain.appendChild(rowEl);
  }

  // status + dates (right col)
  colSide.appendChild(el('label', { class: 'field', text: 'Status' }));
  const statusSel = document.createElement('select');
  statusSel.className = 'input';
  for (const s of ['planned', 'confirmed', 'done']) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    if (item.status === s) o.selected = true;
    statusSel.appendChild(o);
  }
  if (readOnly) statusSel.disabled = true;
  colSide.appendChild(statusSel);

  colSide.appendChild(el('label', { class: 'field', text: ti.spans_days ? 'Dates' : 'Date' }));
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'input';
  dateInput.value = item.item_date || '';
  if (readOnly) dateInput.disabled = true;

  let endInput = null;
  if (ti.spans_days) {
    endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.className = 'input';
    endInput.value = item.end_date || '';
    if (readOnly) endInput.disabled = true;
    const isHotel = item.item_type === 'hotel';
    colSide.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field-group' }, [
        el('label', { class: 'field', text: isHotel ? 'Check-in' : 'Start' }),
        dateInput,
      ]),
      el('div', { class: 'field-group' }, [
        el('label', { class: 'field', text: isHotel ? 'Check-out' : 'End' }),
        endInput,
      ]),
    ]));
  } else {
    colSide.appendChild(dateInput);
  }

  // todo list (right col, after dates)
  const todos = (item.details && item.details.todos) || [];
  const todoSection = el('div', { class: 'todo-section' });
  const todoHeader = el('div', { class: 'todo-header' });
  todoHeader.appendChild(el('span', { class: 'todo-header-title', text: 'To-do list' }));
  todoSection.appendChild(todoHeader);

  const todoBody = el('div', { class: 'todo-body' });
  const todoList = el('ul', { class: 'todo-list' });
  todoBody.appendChild(todoList);
  todoSection.appendChild(todoBody);

  if (!readOnly) {
    const addTodoRow = el('div', { class: 'todo-add-row' });
    const todoInput = document.createElement('input');
    todoInput.type = 'text'; todoInput.className = 'input'; todoInput.placeholder = 'Add a to-do...';
    const addTodoBtn = document.createElement('button');
    addTodoBtn.type = 'button'; addTodoBtn.className = 'btn'; addTodoBtn.textContent = 'Add';
    addTodoBtn.addEventListener('click', () => {
      const text = todoInput.value.trim();
      if (!text) return;
      todos.push({ text, done: false });
      todoInput.value = '';
      renderTodos();
    });
    todoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTodoBtn.click();
    });
    addTodoRow.append(todoInput, addTodoBtn);
    todoSection.appendChild(addTodoRow);
  }

  function renderTodos() {
    clear(todoList);
    const sorted = [...todos].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return 0;
    });
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const li = el('li', { class: 'todo-item' });
      const dragHandle = el('span', { class: 'todo-drag', text: '\u2630\uFE0E' });
      dragHandle.title = 'Drag to reorder';
      dragHandle.draggable = true;
      dragHandle.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', i);
        li.classList.add('dragging');
      });
      dragHandle.addEventListener('dragend', () => {
        li.classList.remove('dragging');
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove('drag-over');
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(fromIdx) || fromIdx === i) return;
        const item = sorted[fromIdx];
        const realFrom = todos.indexOf(item);
        const realTo = todos.indexOf(t);
        if (realFrom === -1 || realTo === -1) return;
        todos.splice(realFrom, 1);
        todos.splice(realTo, 0, item);
        renderTodos();
      });
      li.appendChild(dragHandle);
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!t.done;
      cb.addEventListener('change', () => {
        t.done = cb.checked;
        renderTodos();
      });
      const span = document.createElement('span');
      span.textContent = t.text;
      span.className = t.done ? 'todo-done' : '';
      li.append(cb, span);
      if (!readOnly) {
        const actions = el('span', { class: 'todo-actions' });
        const editBtn = el('button', { type: 'button', class: 'btn btn-ghost att-del', text: '\u270E' });
        editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => {
          const newText = prompt('Edit to-do:', t.text);
          if (newText && newText.trim()) {
            t.text = newText.trim();
            renderTodos();
          }
        });
        actions.appendChild(editBtn);
        const delBtn = el('button', { type: 'button', class: 'btn btn-ghost att-del', text: '\u2715' });
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', () => {
          const idx = todos.indexOf(t);
          if (idx !== -1) todos.splice(idx, 1);
          renderTodos();
        });
        actions.appendChild(delBtn);
        li.appendChild(actions);
      }
      todoList.appendChild(li);
    }
  }
  renderTodos();
  colSide.appendChild(todoSection);

  // attachments (right col)
  colSide.appendChild(el('h4', { class: 'section-title', text: 'Attachments / Links' }));
  const attList = el('div', { class: 'att-list' });
  colSide.appendChild(attList);
  renderAttachments();

  if (!readOnly) {
    const addAttBtn = document.createElement('button');
    addAttBtn.type = 'button'; addAttBtn.className = 'btn';
    addAttBtn.textContent = 'Add attachment';
    addAttBtn.addEventListener('click', () => {
      openAttachmentModal({
        item,
        attachments,
        pendingFiles,
        onAttachmentsChanged: () => renderAttachments(),
      });
    });
    colSide.appendChild(addAttBtn);

    // expense button — keep inside !readOnly; heading + existing list are shared
  }

  // Expenses section (shown for all roles)
  colSide.appendChild(el('h4', { class: 'section-title', text: 'Expenses' }));

  // Existing (server-saved) expenses for this item
  const existingList = el('ul', { class: 'existing-expenses' });
  colSide.appendChild(existingList);

  async function loadExistingExpenses() {
    const isRealItem = typeof item.id === 'number' || !(String(item.id).startsWith('_'));
    if (!isRealItem) return;
    try {
      const res = await apiGet(`/api/items/${item.id}/expenses`);
      const exps = res.expenses || [];
      clear(existingList);
      if (!exps.length) {
        existingList.appendChild(el('p', { class: 'muted', text: 'No expenses yet.' }));
        return;
      }
      for (const exp of exps) {
        const payerNames = (exp.payers || []).map(p => {
          const u = members.find(m => m.id === p.user_id);
          return u ? (u.display_name || u.username) : `user ${p.user_id}`;
        }).join(', ');
        const li = el('li', { class: 'existing-expense-row' }, [
          el('span', { class: 'expense-desc', text: exp.description || '—' }),
          el('span', { class: 'expense-amount', text: `${exp.currency} ${(exp.total_cents / 100).toFixed(2)}` }),
          el('span', { class: 'expense-payer', text: payerNames ? `Paid by ${payerNames}` : '' }),
        ]);
        existingList.appendChild(li);
      }
    } catch (e) {
      /* non-fatal */
    }
  }

  if (!readOnly) {
    const openExpenseBtn = document.createElement('button');
    openExpenseBtn.type = 'button'; openExpenseBtn.className = 'btn';
    openExpenseBtn.textContent = 'Add expense';
    openExpenseBtn.addEventListener('click', () => {
      const currencies = settings.base_currencies || [plan.base_currency];
      openExpenseFormModal({
        members,
        currencies,
        baseCurrency: plan.base_currency,
        currentUser: members[0],
        itemId: item.id,
        onSubmit: (body) => {
          const payerId = body.payers[0]?.user_id || members[0].id;
          const participantIds = body.participants ||
            (body.split_data || []).map(sd => sd.user_id) ||
            members.map(m => m.id);
          const cents = Math.round(parseFloat(body.amount) * 100);
          pendingExpenses.push({
            description: body.description || item.title || '',
            currency: body.currency,
            amountCents: cents,
            payerId,
            participantIds,
          });
          refreshQueuedList();
          return Promise.resolve();
        },
      });
    });
    colSide.appendChild(openExpenseBtn);
    const statusMsg = el('p', { class: 'muted' });
    colSide.appendChild(statusMsg);
    const queuedList = el('ul', { class: 'queued-list' });
    colSide.appendChild(queuedList);

    function refreshQueuedList() {
      clear(queuedList);
      pendingExpenses.forEach((e, idx) => {
        const li = el('li', { class: 'queued-row' }, [
          el('span', { text: `${e.currency} ${(e.amountCents / 100).toFixed(2)} for ${e.description}` }),
          el('button', {
            type: 'button', class: 'btn btn-ghost att-del', text: 'Remove',
            onclick: () => { pendingExpenses.splice(idx, 1); refreshQueuedList(); },
          }),
        ]);
        queuedList.appendChild(li);
      });
    }
  }

  // Kick off the fetch for existing expenses (non-blocking)
  loadExistingExpenses();

  // geolocation picker (right col, last)
  const locSection = el('div', { class: 'geo-section' });
  colSide.appendChild(el('hr', { class: 'geo-sep' }));

  if (!readOnly) {
    colSide.appendChild(el('label', { class: 'field', text: 'Map locations' }));

    const geoListEl = el('div', { class: 'geo-list' });
    const addBtn = el('button', { type: 'button', class: 'btn geo-add-btn', text: '+ Add location' });

    function renderGeoList() {
      clear(geoListEl);
      for (let i = 0; i < selectedGeocodes.length; i++) {
        const g = selectedGeocodes[i];
        const row = el('div', { class: 'geo-list-row', draggable: true });
        row.dataset.geoIndex = i;
        row.title = 'Drag to reorder \u00B7 Double-click to view on map';

        const dragHandle = el('span', { class: 'geo-drag', text: '\u2630\uFE0E' });
        row.appendChild(dragHandle);
        row.appendChild(el('span', { class: 'geo-pin', text: '\uD83D\uDCCD' }));
        row.appendChild(el('span', { class: 'geo-label', text: g.label }));
        row.appendChild(el('span', {
          class: 'geo-coords',
          text: `(${g.lat.toFixed(4)}, ${g.lng.toFixed(4)})`,
        }));

        row.addEventListener('dblclick', () => openGeoMapPopup(g, (lat, lng) => {
          g.lat = lat;
          g.lng = lng;
          renderGeoList();
        }));

        const removeBtn = el('button', { type: 'button', class: 'btn btn-ghost geo-remove', text: '\u2715', title: 'Remove' });
        removeBtn.addEventListener('click', () => {
          selectedGeocodes.splice(i, 1);
          renderGeoList();
        });
        row.appendChild(removeBtn);

        // Drag reorder
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', String(i));
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          geoListEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drag-over');
          const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (isNaN(fromIdx) || fromIdx === i) return;
          const [moved] = selectedGeocodes.splice(fromIdx, 1);
          selectedGeocodes.splice(i, 0, moved);
          renderGeoList();
        });

        geoListEl.appendChild(row);
      }
    }

    addBtn.addEventListener('click', () => {
      openGeoSearchPopup((result) => {
        selectedGeocodes.push(result);
        renderGeoList();
      });
    });

    locSection.appendChild(geoListEl);
    locSection.appendChild(addBtn);
    renderGeoList();
  } else {
    if (selectedGeocodes.length > 0) {
      for (const g of selectedGeocodes) {
        const info = el('div', { class: 'geo-readonly' });
        info.appendChild(el('span', { text: '\uD83D\uDCCD ' + g.label }));
        info.appendChild(el('span', {
          class: 'geo-coords',
          text: `(${g.lat.toFixed(4)}, ${g.lng.toFixed(4)})`,
        }));
        locSection.appendChild(info);
      }
    }
  }
  colSide.appendChild(locSection);

  // footer
  const footer = el('div', { class: 'modal-footer' });
  if (readOnly) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'btn'; closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', onCancel);
    footer.appendChild(closeBtn);
  } else {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', onCancel);
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button'; applyBtn.className = 'btn btn-primary';
    applyBtn.textContent = 'Apply';
    applyBtn.title = 'Apply changes to the staging area. Click Save in the top bar to commit.';
    applyBtn.addEventListener('click', onApply);
    footer.append(cancelBtn, applyBtn);
  }
  modal.appendChild(footer);

  // allow dropping an image file directly onto the modal to add it
  modal.addEventListener('dragover', (e) => {
    if (!readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  modal.addEventListener('drop', (e) => {
    if (readOnly || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (!f.type.startsWith('image/')) continue;
      const previewUrl = URL.createObjectURL(f);
      const localId = '__pending__' + Math.random().toString(36).slice(2, 10);
      pendingFiles.push({ file: f, previewUrl });
      attachments.push({
        id: localId,
        item_id: item.id,
        kind: 'image',
        value: previewUrl,
        caption: f.name,
        isLocal: true,
        _pendingFileIdx: pendingFiles.length - 1,
      });
    }
    renderAttachments();
  });

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) onCancel(); });

  /* ----- handlers ----- */

  function onCancel() {
    // Discard the entire session: any ops staged during this editor session
    // (including a CREATE_BLANK_ITEM from the global Add button, a
    // DELETE_ATTACHMENT for a removed attachment, or a SAVE_ITEM if Apply
    // was already clicked) are removed. The user can re-open the editor
    // for the same item to start over.
    staging.discardSession(sessionId);
    // Clean up any object URLs we created (for staged image previews).
    for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    // Tell the caller we're closing so it can update any surrounding state
    // (e.g. suppress a click that would otherwise clear multi-select).
    if (onClose) onClose();
    backdrop.remove();
    if (onApplied) onApplied();
  }

  function onApply() {
    // Build the snapshot from the form.
    const details = Object.assign({}, item.details || {});
    for (const [k, inp] of Object.entries(fieldInputs)) {
      const v = inp.value;
      if (v !== null && v !== undefined && String(v).trim() !== '') details[k] = v;
      else delete details[k];
    }
    details.is_backup = !!backupInput.checked;
    if (todos.length) {
      details.todos = todos;
    } else {
      delete details.todos;
    }
    // Clean up the legacy `time` field for restaurant/transport once the
    // new start_time + end_time shape is in place — otherwise the item
    // would carry two ways of saying the same thing.
    if (details.start_time && (item.item_type === 'restaurant' || item.item_type === 'transport' || item.item_type === 'transit')) {
      delete details.time;
    }
    const snapshot = {
      id: item.id,
      item_type: item.item_type,
      title: titleInput.value.trim() || item.title || '(Untitled)',
      item_date: dateInput.value || null,
      end_date: endInput ? (endInput.value || null) : (item.end_date || null),
      status: statusSel.value,
      details,
      geocodes: selectedGeocodes,
      // Include the up-to-date attachment list so the staged view shows the
      // editor's additions and the SAVE_ITEM.apply re-derives correctly.
      attachments: attachments.slice(),
    };
    // For non-new items, also propagate the type (the backend may need it
    // for some fields, but PATCH currently doesn't accept it; safe to omit).
    // Detect edited existing attachments (mutated in-place by openLinkEditModal).
    for (const att of attachments) {
      if (att.id && !att.isLocal) {
        const orig = (item.attachments || []).find(a => String(a.id) === String(att.id));
        if (orig && (orig.value !== att.value || orig.caption !== att.caption)) {
          pendingSubEffects.push(updateAttachmentOp({
            itemId: item.id, attachmentId: att.id, value: att.value, caption: att.caption, sessionId,
          }));
        }
      }
    }
    // Build the bundled sub-effects: new links, new image uploads, new expense.
    // DELETE_ATTACHMENT ops are staged directly when the user clicks Delete,
    // not bundled here.
    for (const att of attachments) {
      if (att.isLocal && att._pendingUrl) {
        pendingSubEffects.push(addLinkOp({
          itemId: item.id, url: att._pendingUrl, caption: att._pendingCaption,
          sessionId,
        }));
      } else if (att.isLocal && att._pendingFileIdx != null) {
        const f = pendingFiles[att._pendingFileIdx];
        if (f) {
          pendingSubEffects.push(uploadImageOp({
            itemId: item.id, file: f.file, previewUrl: f.previewUrl,
            caption: f.file.name, sessionId,
          }));
        }
      }
    }
    if (pendingExpenses.length) {
      for (const e of pendingExpenses) {
        pendingSubEffects.push(addExpenseOp({
          planId: ctx.planId, itemId: item.id,
          description: e.description,
          currency: e.currency,
          amountCents: e.amountCents,
          payerId: e.payerId,
          participantIds: e.participantIds,
          sessionId,
        }));
      }
    }
    staging.add(saveItemOp({
      planId: ctx.planId,
      item: snapshot,
      isNew,
      sideEffects: pendingSubEffects,
      sessionId,
    }));
    if (onClose) onClose();
    backdrop.remove();
    if (onApplied) onApplied();
  }

  function renderAttachments() {
    clear(attList);
    if (!attachments.length) {
      attList.appendChild(el('p', { class: 'muted', text: 'No attachments.' }));
      return;
    }
    for (const a of attachments) {
      const row = el('div', { class: 'att-row' });
      const meta = el('div', { class: 'att-meta' });
      if (a.kind === 'image') {
        const im = document.createElement('img');
        // Local (pending-upload) attachments carry a blob: preview URL;
        // server attachments a filename under /uploads/.
        im.src = a.isLocal ? a.value : `/uploads/${a.value}`;
        im.className = 'att-thumb'; im.alt = a.caption || '';
        row.appendChild(im);
        meta.appendChild(el('span', {
          class: 'att-caption',
          text: a.caption || '(image, no caption)',
        }));
      } else {
        const ael = document.createElement('a');
        ael.href = a.value; ael.target = '_blank'; ael.rel = 'noopener';
        ael.textContent = a.caption || a.value; ael.className = 'att-link';
        meta.appendChild(ael);
      }
      row.appendChild(meta);
      if (!readOnly) {
        if (a.kind !== 'image') {
          const editBtn = document.createElement('button');
          editBtn.type = 'button'; editBtn.className = 'btn btn-ghost att-del'; editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => openLinkEditModal(a, () => renderAttachments()));
          row.appendChild(editBtn);
        }
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'btn btn-ghost att-del'; del.textContent = 'Delete';
        del.addEventListener('click', () => {
          // Remove from the editor's local list.
          attachments = attachments.filter((x) => x.id !== a.id);
          // If this is an existing attachment (real id), stage a DELETE op
          // immediately so the view reflects the removal. If it's a pending
          // (local) attachment, just remove from the list — no op needed.
          if (!a.isLocal && typeof a.id === 'number') {
            staging.add(deleteAttachmentOp({
              itemId: item.id, attachmentId: a.id, sessionId,
            }));
          }
          renderAttachments();
        });
        row.appendChild(del);
      }
      attList.appendChild(row);
    }
  }

  // The expense form queues pending expenses (added on Apply, discarded on
  // Cancel). Multiple expenses can be queued; each is bundled into the
  // SAVE_ITEM op as a separate sub-effect.
  let pendingExpenses = [];
}

/* Open a small modal to edit the name and URL of a link attachment. */
function openLinkEditModal(attachment, onSaved) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal expense-modal' });
  backdrop.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h3', { text: 'Edit link' }),
    el('button', { type: 'button', class: 'modal-close', text: '\u00d7',
      onclick: () => backdrop.remove() }),
  ]));

  const body = el('div', { class: 'modal-body' });
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'input'; nameInput.value = attachment.caption || '';
  const urlInput = document.createElement('input');
  urlInput.type = 'url'; urlInput.className = 'input'; urlInput.value = attachment.value || '';

  body.appendChild(el('label', { class: 'field', text: 'Name' }));
  body.appendChild(nameInput);
  body.appendChild(el('label', { class: 'field', text: 'Link' }));
  body.appendChild(urlInput);
  modal.appendChild(body);

  const footer = el('div', { class: 'modal-footer' }, [
    el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel',
      onclick: () => backdrop.remove() }),
    el('button', { type: 'button', class: 'btn btn-primary', text: 'Save',
      onclick: () => {
        const v = urlInput.value.trim();
        if (!v) return;
        attachment.value = v;
        attachment.caption = nameInput.value.trim();
        if (attachment.isLocal) {
          attachment._pendingUrl = v;
          attachment._pendingCaption = nameInput.value.trim();
        }
        backdrop.remove();
        if (onSaved) onSaved();
      }}),
  ]);
  modal.appendChild(footer);

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
}

/* Open a modal for adding an attachment — either a URL link or an image upload. */
function openAttachmentModal({ item, attachments, pendingFiles, onAttachmentsChanged }) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal expense-modal' });
  backdrop.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h3', { text: 'Add attachment' }),
    el('button', { type: 'button', class: 'modal-close', text: '\u00d7',
      onclick: () => backdrop.remove() }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  const tabRow = el('div', { class: 'att-tab-row' });
  const linkTab = el('button', { type: 'button', class: 'btn att-tab att-tab-active', text: 'Link' });
  const uploadTab = el('button', { type: 'button', class: 'btn att-tab', text: 'Upload image' });
  tabRow.append(linkTab, uploadTab);
  body.appendChild(tabRow);

  const linkPanel = el('div', { class: 'att-panel' });
  const uploadPanel = el('div', { class: 'att-panel', style: 'display:none' });
  body.appendChild(linkPanel);
  body.appendChild(uploadPanel);

  // --- Link panel ---
  const linkUrl = document.createElement('input');
  linkUrl.type = 'url'; linkUrl.className = 'input'; linkUrl.placeholder = 'https://link';
  const linkCap = document.createElement('input');
  linkCap.type = 'text'; linkCap.className = 'input'; linkCap.placeholder = 'Caption';
  linkPanel.appendChild(el('label', { class: 'field', text: 'URL' }));
  linkPanel.appendChild(linkUrl);
  linkPanel.appendChild(el('label', { class: 'field', text: 'Caption' }));
  linkPanel.appendChild(linkCap);

  // --- Upload panel ---
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*';
  fileInput.className = 'input';
  uploadPanel.appendChild(el('label', { class: 'field', text: 'Select image' }));
  uploadPanel.appendChild(fileInput);

  // --- Tab switching ---
  function activateTab(tab) {
    [linkTab, uploadTab].forEach(t => t.classList.remove('att-tab-active'));
    tab.classList.add('att-tab-active');
    linkPanel.style.display = tab === linkTab ? '' : 'none';
    uploadPanel.style.display = tab === uploadTab ? '' : 'none';
  }
  linkTab.addEventListener('click', () => activateTab(linkTab));
  uploadTab.addEventListener('click', () => activateTab(uploadTab));

  const msg = el('p', { class: 'muted' });
  body.appendChild(msg);

  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add';

  addBtn.addEventListener('click', () => {
    if (linkTab.classList.contains('att-tab-active')) {
      const v = linkUrl.value.trim();
      if (!v) { msg.textContent = 'Enter a URL.'; return; }
      const localId = '__pending__' + Math.random().toString(36).slice(2, 10);
      attachments.push({
        id: localId,
        item_id: item.id,
        kind: 'link',
        value: v,
        caption: linkCap.value.trim() || '',
        isLocal: true,
        _pendingUrl: v,
        _pendingCaption: linkCap.value.trim(),
      });
    } else {
      const f = fileInput.files && fileInput.files[0];
      if (!f) { msg.textContent = 'Select an image file.'; return; }
      const previewUrl = URL.createObjectURL(f);
      const localId = '__pending__' + Math.random().toString(36).slice(2, 10);
      pendingFiles.push({ file: f, previewUrl });
      attachments.push({
        id: localId,
        item_id: item.id,
        kind: 'image',
        value: previewUrl,
        caption: f.name,
        isLocal: true,
        _pendingFileIdx: pendingFiles.length - 1,
      });
    }
    backdrop.remove();
    if (onAttachmentsChanged) onAttachmentsChanged();
  });

  const footer = el('div', { class: 'modal-footer' });
  footer.appendChild(el('button', { type: 'button', class: 'btn btn-ghost',
    text: 'Cancel', onclick: () => backdrop.remove() }));
  footer.appendChild(addBtn);
  modal.appendChild(footer);

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
}

/* Open a popup modal for searching a location via Photon geocoding API.
 * Calls onSelect({ label, lat, lng }) when the user picks a result. */
function openGeoSearchPopup(onSelect) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'geo-popup geo-popup-wide' });
  backdrop.appendChild(modal);

  const header = el('div', { class: 'geo-popup-header' });
  header.appendChild(el('h3', { text: 'Search location' }));
  const closeBtn = el('button', { type: 'button', class: 'modal-close', text: '\u00d7' });
  closeBtn.addEventListener('click', () => backdrop.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = el('div', { class: 'geo-popup-body' });
  const searchRow = el('div', { class: 'geo-search-row' });
  const searchInput = document.createElement('input');
  searchInput.type = 'text'; searchInput.className = 'input';
  searchInput.placeholder = 'Search for a location\u2026';
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button'; searchBtn.className = 'btn';
  searchBtn.textContent = 'Search';
  searchRow.append(searchInput, searchBtn);
  body.appendChild(searchRow);

  const resultsEl = el('div', { class: 'geo-results' });
  body.appendChild(resultsEl);

  const mapContainer = el('div', { class: 'geo-search-map' });
  body.appendChild(mapContainer);
  modal.appendChild(body);

  let map = null;
  let marker = null;

  function ensureMap() {
    if (map) return;
    loadLeaflet(() => {
      map = L.map(mapContainer).setView([35.6762, 139.6503], 3);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      map.on('click', (e) => {
        const { lat, lng } = e.latlng;
        if (marker) map.removeLayer(marker);
        marker = L.marker([lat, lng]).addTo(map);
        // Reverse geocode
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
          .then(r => r.json())
          .then(data => {
            const label = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            marker.bindPopup(label).openPopup();
            marker._label = label;
            marker._lat = lat;
            marker._lng = lng;
          })
          .catch(() => {
            marker._label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
          });
      });
      setTimeout(() => map.invalidateSize(), 100);
    });
  }

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    clear(resultsEl);
    resultsEl.textContent = 'Searching\u2026';
    try {
      const res = await fetch(
        `https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      clear(resultsEl);
      for (const feat of (data.features || [])) {
        const coords = feat.geometry && feat.geometry.coordinates;
        if (!coords || coords.length < 2) continue;
        const parts = [];
        if (feat.properties.name) parts.push(feat.properties.name);
        if (feat.properties.city) parts.push(feat.properties.city);
        if (feat.properties.country) parts.push(feat.properties.country);
        const label = parts.join(', ');
        const item = el('div', { class: 'geo-result' });
        item.textContent = label;
        item.addEventListener('click', () => {
          onSelect({ label, lat: coords[1], lng: coords[0] });
          backdrop.remove();
        });
        resultsEl.appendChild(item);
      }
      if (!resultsEl.children.length) {
        resultsEl.textContent = 'No results found.';
      }
    } catch (e) {
      resultsEl.textContent = 'Search failed.';
    }
  }

  // Confirm button for map selection
  const confirmRow = el('div', { class: 'geo-confirm-row' });
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button'; confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Select map location';
  confirmBtn.addEventListener('click', () => {
    if (marker && marker._label) {
      onSelect({ label: marker._label, lat: marker._lat, lng: marker._lng });
      backdrop.remove();
    }
  });
  confirmRow.appendChild(confirmBtn);
  body.appendChild(confirmRow);

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  searchInput.focus();
  ensureMap();
}

function loadLeaflet(callback) {
  if (typeof L !== 'undefined') { callback(); return; }
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(link);
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  script.onload = callback;
  document.body.appendChild(script);
}

/* Open a popup with a Leaflet map showing a pin at the given coordinates.
   Marker is draggable. Footer has map links + an update button to save
   the new marker position back to the geocode. */
export function openGeoMapPopup(geocode, onUpdate) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'geo-map-popup' });
  backdrop.appendChild(modal);

  const header = el('div', { class: 'geo-popup-header' });
  header.appendChild(el('h3', { text: geocode.label }));
  const closeBtn = el('button', { type: 'button', class: 'modal-close', text: '\u00d7' });
  closeBtn.addEventListener('click', () => backdrop.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const mapContainer = el('div', { class: 'geo-map-container' });
  modal.appendChild(mapContainer);

  const footer = el('div', { class: 'geo-map-footer' });
  const label = encodeURIComponent(geocode.label || '');

  const gLink = el('a', { class: 'geo-map-footer-link gl', href: `https://www.google.com/maps?q=${geocode.lat},${geocode.lng}`, target: '_blank', rel: 'noopener', text: 'Google Maps' });
  const aLink = el('a', { class: 'geo-map-footer-link al', href: `https://maps.apple.com/?ll=${geocode.lat},${geocode.lng}&q=${label}`, target: '_blank', rel: 'noopener', text: 'Apple Maps' });
  const oLink = el('a', { class: 'geo-map-footer-link ol', href: `https://www.openstreetmap.org/?mlat=${geocode.lat}&mlon=${geocode.lng}&zoom=15`, target: '_blank', rel: 'noopener', text: 'OSM' });

  const updateBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '\u2714 Update position' });
  updateBtn.disabled = true;

  footer.append(gLink, aLink, oLink, updateBtn);
  modal.appendChild(footer);

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  loadLeaflet(() => {
    const map = L.map(mapContainer).setView([geocode.lat, geocode.lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const marker = L.marker([geocode.lat, geocode.lng], { draggable: true }).addTo(map)
      .bindPopup(geocode.label)
      .openPopup();

    let moved = false;
    marker.on('dragend', () => {
      moved = true;
      updateBtn.disabled = false;
    });

    updateBtn.addEventListener('click', () => {
      if (!moved) return;
      const pos = marker.getLatLng();
      if (onUpdate) onUpdate(pos.lat, pos.lng);
      backdrop.remove();
    });

    setTimeout(() => map.invalidateSize(), 100);
  });
}

/* Build the right <input>/<select>/<textarea> for a type-specific field.
 * `plan` is used to pre-fill a currency field with the plan's base currency
 * when the item doesn't already have one — a value the app already knows.
 *
 * Backward-compat: types whose settings.json used to define a single
 * `time` field (restaurant, transport) now define `start_time` and
 * `end_time`. Items saved under the old shape still only have `time`.
 * For these legacy items, the editor pre-fills the new start_time input
 * with the legacy value and the new end_time with `time + 1h` so the
 * user sees their old data plus a sensible default duration. The next
 * Apply commits both fields in the new shape. */
export function makeFieldInput(f, details, settings, plan) {
  let val = details && details[f.key] != null ? details[f.key] : '';
  if (!val && f.key === 'start_time' && details && details.time) {
    val = details.time;
  } else if (!val && f.key === 'end_time' && details && details.time) {
    // Default the end to start + 1h. If the legacy `time` somehow
    // already encodes an end-time like 19:00 the user can adjust.
    const t = String(details.time);
    const m = t.match(/T?(\d{1,2}):(\d{2})/);
    if (m) {
      let h = Number(m[1]) + 1;
      const datePart = t.match(/^([^T]+)/);
      const dateStr = datePart ? datePart[1] : '';
      if (h > 23) h = 23; // clamp; we can't go past midnight
      val = `${dateStr}T${String(h).padStart(2, '0')}:${m[2]}`;
    }
  }
  if (f.type === 'textarea') {
    const t = document.createElement('textarea');
    t.className = 'input'; t.rows = 2; t.value = val;
    return t;
  }
  if (f.type === 'currency') {
    const s = document.createElement('select');
    s.className = 'input';
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '—'; s.appendChild(blank);
    const preferred = val || (plan && plan.base_currency) || '';
    for (const c of settings.base_currencies) {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (c === preferred) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }
  if (f.type === 'select') {
    const s = document.createElement('select');
    s.className = 'input';
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '—'; s.appendChild(blank);
    for (const opt of (f.options || [])) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === val) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }
  const inp = document.createElement('input');
  inp.className = 'input';
  switch (f.type) {
    case 'url': inp.type = 'url'; break;
    case 'number': inp.type = 'number'; break;
    case 'time': inp.type = 'time'; break;
    case 'datetime-local': inp.type = 'datetime-local'; break;
    case 'money': inp.type = 'number'; inp.step = '0.01'; inp.min = '0'; break;
    default: inp.type = 'text';
  }
  inp.value = val != null ? val : '';
  return inp;
}
