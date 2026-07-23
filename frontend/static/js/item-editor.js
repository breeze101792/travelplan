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
import { el, clear } from '/static/js/util.js';
import {
  saveItemOp, uploadImageOp, addLinkOp, deleteAttachmentOp, addExpenseOp,
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

  // geolocation picker (for all types except note)
  if (item.item_type !== 'note') {
    const locSection = el('div', { class: 'geo-section' });
    colMain.appendChild(el('hr', { class: 'geo-sep' }));

    if (!readOnly) {
      colMain.appendChild(el('label', { class: 'field', text: 'Map locations' }));

      const geoListEl = el('div', { class: 'geo-list' });
      const addBtn = el('button', { type: 'button', class: 'btn geo-add-btn', text: '+ Add location' });

      function renderGeoList() {
        clear(geoListEl);
        for (let i = 0; i < selectedGeocodes.length; i++) {
          const g = selectedGeocodes[i];
          const row = el('div', { class: 'geo-list-row' });
          row.appendChild(el('span', { class: 'geo-pin', text: '\uD83D\uDCCD' }));
          row.appendChild(el('span', { class: 'geo-label', text: g.label }));
          row.appendChild(el('span', {
            class: 'geo-coords',
            text: `(${g.lat.toFixed(4)}, ${g.lng.toFixed(4)})`,
          }));
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button'; removeBtn.className = 'btn btn-ghost geo-remove';
          removeBtn.textContent = '\u2715';
          removeBtn.addEventListener('click', () => {
            selectedGeocodes.splice(i, 1);
            renderGeoList();
          });
          row.appendChild(removeBtn);
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
      // read-only: show all existing locations
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
    colMain.appendChild(locSection);
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
    // Place check-in / check-out on the same row — they are short date
    // inputs and almost always edited together.
    colSide.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field-group' }, [dateInput]),
      el('div', { class: 'field-group' }, [
        el('label', { class: 'field', text: 'End (checkout)' }),
        endInput,
      ]),
    ]));
  } else {
    colSide.appendChild(dateInput);
  }

  // attachments (right col)
  colSide.appendChild(el('h4', { class: 'section-title', text: 'Attachments' }));
  const attList = el('div', { class: 'att-list' });
  colSide.appendChild(attList);
  renderAttachments();

  if (!readOnly) {
    // add-link row
    const linkUrl = document.createElement('input');
    linkUrl.type = 'url'; linkUrl.className = 'input'; linkUrl.placeholder = 'https://link';
    const linkCap = document.createElement('input');
    linkCap.type = 'text'; linkCap.className = 'input'; linkCap.placeholder = 'Caption';
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button'; linkBtn.className = 'btn'; linkBtn.textContent = 'Add link';
    linkBtn.addEventListener('click', () => {
      const v = linkUrl.value.trim();
      if (!v) return;
      // Add to the editor's local attachment list; the sub-op is built
      // lazily on Apply, capturing the local id.
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
      linkUrl.value = ''; linkCap.value = '';
      renderAttachments();
    });
    const linkRow = el('div', { class: 'link-row' }, [linkUrl, linkCap, linkBtn]);
    colSide.appendChild(linkRow);

    // file upload input
    const fileLabel = el('label', { class: 'file-label', text: 'Upload image: ' });
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'image/*';
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) {
        const f = fileInput.files[0];
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
        fileInput.value = '';
        renderAttachments();
      }
    });
    fileLabel.appendChild(fileInput);
    colSide.appendChild(fileLabel);

    // compact expense form (right col, below attachments)
    colSide.appendChild(el('h4', { class: 'section-title', text: 'Add expense for this item' }));
    const expenseSection = renderExpenseForm();
    colSide.appendChild(expenseSection);
  }

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
    // Clean up the legacy `time` field for restaurant/transport once the
    // new start_time + end_time shape is in place — otherwise the item
    // would carry two ways of saying the same thing.
    if (details.start_time && (item.item_type === 'restaurant' || item.item_type === 'transport')) {
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

  function renderExpenseForm() {
    const wrap = el('div', { class: 'expense-mini' });
    const descInput = document.createElement('input');
    descInput.type = 'text'; descInput.className = 'input';
    descInput.value = item.title || ''; descInput.placeholder = 'Description';

    const amtInput = document.createElement('input');
    amtInput.type = 'number'; amtInput.step = '0.01'; amtInput.min = '0';
    amtInput.className = 'input'; amtInput.placeholder = 'Amount';

    const curSel = document.createElement('select');
    for (const c of settings.base_currencies) {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (c === plan.base_currency) o.selected = true;
      curSel.appendChild(o);
    }

    const payerSel = document.createElement('select');
    for (const m of members) {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.display_name || m.username;
      payerSel.appendChild(o);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.textContent = 'Add expense';
    const statusMsg = el('p', { class: 'muted' });
    const queuedList = el('ul', { class: 'queued-list' });

    function refreshList() {
      clear(queuedList);
      pendingExpenses.forEach((e, idx) => {
        const li = el('li', { class: 'queued-row' }, [
          el('span', { text: `${e.currency} ${(e.amountCents / 100).toFixed(2)} for ${e.description}` }),
          el('button', {
            type: 'button', class: 'btn btn-ghost att-del', text: 'Remove',
            onclick: () => { pendingExpenses.splice(idx, 1); refreshList(); },
          }),
        ]);
        queuedList.appendChild(li);
      });
    }

    addBtn.addEventListener('click', () => {
      const amt = amtInput.value.trim();
      if (!amt) { statusMsg.textContent = 'Enter an amount.'; return; }
      const cents = Math.round(parseFloat(amt) * 100);
      if (!isFinite(cents) || cents <= 0) { statusMsg.textContent = 'Enter a positive amount.'; return; }
      pendingExpenses.push({
        description: descInput.value.trim() || item.title || '',
        currency: curSel.value,
        amountCents: cents,
        payerId: Number(payerSel.value),
        participantIds: members.map((m) => m.id),
      });
      statusMsg.textContent = 'Expense queued.';
      amtInput.value = '';
      refreshList();
    });

    wrap.appendChild(el('div', { class: 'row' }, [descInput]));
    wrap.appendChild(el('div', { class: 'row' }, [amtInput, curSel, payerSel, addBtn]));
    wrap.appendChild(statusMsg);
    wrap.appendChild(queuedList);
    return wrap;
  }
}

/* Open a popup modal for searching a location via Photon geocoding API.
 * Calls onSelect({ label, lat, lng }) when the user picks a result. */
function openGeoSearchPopup(onSelect) {
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'geo-popup' });
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
  modal.appendChild(body);

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

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  searchInput.focus();
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
