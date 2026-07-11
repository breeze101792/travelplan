/* item-editor.js — modal editor for a single itinerary item.
 *
 * openItemEditor(ctx, { plan, item, settings, members, onSave })
 *   ctx      = { planId, role }
 *   members  = [{ id, username, display_name, role }] (owner + shared) for the expense form
 *   onSave   = async callback (board re-render) invoked after save / expense add
 */
import { apiPost, apiPatch, apiUpload, apiDel } from '/static/js/api.js';
import { el, clear } from '/static/js/util.js';

export function openItemEditor(ctx, { plan, item, settings, members, onSave }) {
  const ti = settings.item_types[item.item_type] || { label: item.item_type, fields: [] };
  const readOnly = ctx.role === 'viewer';
  let attachments = (item.attachments || []).slice();

  /* ----- structure ----- */
  const backdrop = el('div', { class: 'modal-backdrop editor-backdrop' });
  const modal = el('div', { class: 'modal item-editor' });
  backdrop.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h3', { text: ti.label + (readOnly ? ' (read-only)' : '') }),
    el('button', { class: 'modal-close', text: '×', onclick: close }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  // title
  body.appendChild(el('label', { class: 'field', text: 'Title' }));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'input';
  titleInput.value = item.title || '';
  if (readOnly) titleInput.disabled = true;
  body.appendChild(titleInput);

  // type-specific fields
  const fieldInputs = {};
  for (const f of (ti.fields || [])) {
    body.appendChild(el('label', { class: 'field', text: f.label }));
    const inp = makeFieldInput(f, item.details, settings, plan);
    if (readOnly) inp.disabled = true;
    fieldInputs[f.key] = inp;
    body.appendChild(inp);
  }

  // status
  body.appendChild(el('label', { class: 'field', text: 'Status' }));
  const statusSel = document.createElement('select');
  for (const s of ['planned', 'confirmed', 'done']) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    if (item.status === s) o.selected = true;
    statusSel.appendChild(o);
  }
  if (readOnly) statusSel.disabled = true;
  body.appendChild(statusSel);

  // dates
  body.appendChild(el('label', { class: 'field', text: 'Date' }));
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'input';
  dateInput.value = item.item_date || '';
  if (readOnly) dateInput.disabled = true;
  body.appendChild(dateInput);

  let endInput = null;
  if (ti.spans_days) {
    body.appendChild(el('label', { class: 'field', text: 'End date (checkout)' }));
    endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.className = 'input';
    endInput.value = item.end_date || '';
    if (readOnly) endInput.disabled = true;
    body.appendChild(endInput);
  }

  // attachments
  body.appendChild(el('h4', { class: 'section-title', text: 'Attachments' }));
  const attList = el('div', { class: 'att-list' });
  body.appendChild(attList);
  renderAttachments();

  if (!readOnly) {
    // add-link row
    const linkUrl = document.createElement('input');
    linkUrl.type = 'url'; linkUrl.className = 'input'; linkUrl.placeholder = 'https://link';
    const linkCap = document.createElement('input');
    linkCap.type = 'text'; linkCap.className = 'input'; linkCap.placeholder = 'Caption';
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button'; linkBtn.className = 'btn'; linkBtn.textContent = 'Add link';
    linkBtn.addEventListener('click', async () => {
      const v = linkUrl.value.trim();
      if (!v) return;
      try {
        const res = await apiPost(`/api/items/${item.id}/attachments`,
          { kind: 'link', value: v, caption: linkCap.value.trim() || undefined });
        attachments.push(res.attachment);
        linkUrl.value = ''; linkCap.value = '';
        renderAttachments();
      } catch (e) { alert(e.message); }
    });
    const linkRow = el('div', { class: 'link-row' }, [linkUrl, linkCap, linkBtn]);
    body.appendChild(linkRow);

    // file upload input (also the touch fallback for drag/drop)
    const fileLabel = el('label', { class: 'file-label', text: 'Upload image: ' });
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'image/*';
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) uploadFile(fileInput.files[0]);
      fileInput.value = '';
    });
    fileLabel.appendChild(fileInput);
    body.appendChild(fileLabel);

    // compact expense form
    body.appendChild(el('h4', { class: 'section-title', text: 'Add expense for this item' }));
    body.appendChild(renderExpenseForm());
  }

  // footer
  const footer = el('div', { class: 'modal-footer' });
  if (readOnly) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'btn'; closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    footer.appendChild(closeBtn);
  } else {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'btn btn-primary'; saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', save);
    footer.append(cancelBtn, saveBtn);
  }
  modal.appendChild(footer);

  // allow dropping an image file directly onto the modal to upload it
  modal.addEventListener('dragover', (e) => {
    if (!readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  modal.addEventListener('drop', (e) => {
    if (readOnly || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) uploadFile(f);
  });

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  /* ----- handlers ----- */

  function close() { backdrop.remove(); }

  async function uploadFile(file) {
    try {
      const res = await apiUpload(`/api/items/${item.id}/upload`, file);
      attachments.push(res.attachment);
      renderAttachments();
    } catch (e) { alert(e.message); }
  }

  function renderAttachments() {
    clear(attList);
    if (!attachments.length) {
      attList.appendChild(el('p', { class: 'muted', text: 'No attachments.' }));
      return;
    }
    for (const a of attachments) {
      const row = el('div', { class: 'att-row' });
      if (a.kind === 'image') {
        const im = document.createElement('img');
        im.src = `/uploads/${a.value}`; im.className = 'att-thumb'; im.alt = a.caption || '';
        row.appendChild(im);
      } else {
        const ael = document.createElement('a');
        ael.href = a.value; ael.target = '_blank'; ael.rel = 'noopener';
        ael.textContent = a.caption || a.value; ael.className = 'att-link';
        row.appendChild(ael);
      }
      if (!readOnly) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'btn btn-ghost att-del'; del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          try {
            await apiDel(`/api/attachments/${a.id}`);
            attachments = attachments.filter((x) => x.id !== a.id);
            renderAttachments();
          } catch (e) { alert(e.message); }
        });
        row.appendChild(del);
      }
      attList.appendChild(row);
    }
  }

  async function save() {
    const details = {};
    for (const [k, inp] of Object.entries(fieldInputs)) {
      const v = inp.value;
      if (v !== null && v !== undefined && String(v).trim() !== '') details[k] = v;
    }
    const body = {
      title: titleInput.value.trim() || item.title,
      item_date: dateInput.value || null,
      status: statusSel.value,
      details,
    };
    if (endInput) body.end_date = endInput.value || null;
    try {
      await apiPatch(`/api/items/${item.id}`, body);
      close();
      if (onSave) await onSave();
    } catch (e) { alert(e.message); }
  }

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

    addBtn.addEventListener('click', async () => {
      const amt = amtInput.value.trim();
      if (!amt) { statusMsg.textContent = 'Enter an amount.'; return; }
      const payerId = Number(payerSel.value);
      const participants = members.map((m) => m.id);
      try {
        await apiPost(`/api/plans/${ctx.planId}/expenses`, {
          item_id: item.id,
          description: descInput.value.trim() || item.title,
          currency: curSel.value,
          amount: amt,
          split_method: 'EQUAL',
          payers: [{ user_id: payerId, amount: amt }],
          participants,
        });
        statusMsg.textContent = 'Expense added.';
        amtInput.value = '';
        if (onSave) await onSave();
      } catch (e) { statusMsg.textContent = e.message; }
    });

    wrap.appendChild(el('div', { class: 'row' }, [descInput]));
    wrap.appendChild(el('div', { class: 'row' }, [amtInput, curSel, payerSel, addBtn]));
    wrap.appendChild(statusMsg);
    return wrap;
  }
}

/* Build the right <input>/<select>/<textarea> for a type-specific field.
 * `plan` is used to pre-fill a currency field with the plan's base currency
 * when the item doesn't already have one — a value the app already knows. */
function makeFieldInput(f, details, settings, plan) {
  const val = details && details[f.key] != null ? details[f.key] : '';
  if (f.type === 'textarea') {
    const t = document.createElement('textarea');
    t.className = 'input'; t.rows = 2; t.value = val;
    return t;
  }
  if (f.type === 'currency') {
    const s = document.createElement('select');
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