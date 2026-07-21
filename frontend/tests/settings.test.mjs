/* settings.test.mjs — exercises the small page-local JS for /auth/settings
 * (initSettings: the Edit/Cancel reveal under each member row).
 *
 * The page itself is server-rendered by Jinja; its form behaviour is
 * covered end-to-end by backend/tests/test_auth.py. This fixture is the
 * frontend-side guard against breaking the per-row Edit toggle.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { installDom } from './lib/dom-shim.mjs';

const docs = installDom({ ids: [] });

/* Build a small slice of the rendered settings page: a table with two
 * user rows, each followed by a hidden Edit form row. The structure
 * matches settings.html's loop. */
function buildFixture() {
  // Wipe body children but keep document listeners.
  docs.body = docs.createElement('body');
  // Manually re-attach (installDom created the original; we replace it).
  globalThis.document = docs;

  const table = docs.createElement('table');
  const tbody = docs.createElement('tbody');
  table.appendChild(tbody);

  for (const [id, name, display] of [[1, 'admin', 'Admin'], [2, 'alice', 'Alice']]) {
    const row = docs.createElement('tr');
    row.dataset.userRow = String(id);
    const btn = docs.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.dataset.action = 'edit-user';
    btn.dataset.userId = String(id);
    btn.textContent = 'Edit';
    row.appendChild(btn);
    tbody.appendChild(row);

    const editRow = docs.createElement('tr');
    editRow.id = 'edit-row-' + id;
    editRow.dataset.editRow = String(id);
    editRow.hidden = true;
    const td = docs.createElement('td');
    const displayInput = docs.createElement('input');
    displayInput.name = 'display_name';
    displayInput.value = display;
    const cancelBtn = docs.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.dataset.action = 'cancel-edit';
    cancelBtn.dataset.userId = String(id);
    cancelBtn.textContent = 'Cancel';
    td.appendChild(displayInput);
    td.appendChild(cancelBtn);
    editRow.appendChild(td);
    tbody.appendChild(editRow);
  }
  docs.body.appendChild(table);
}

/* ---------- Edit reveals the matching row and disables the button ---------- */
{
  buildFixture();
  const { initSettings } = await import('/static/js/settings.js');
  initSettings();

  const editBtns = docs.body.querySelectorAll('button[data-action="edit-user"]');
  eq(editBtns.length, 2, 'two Edit buttons rendered');

  // Click Edit on user 1.
  const btn1 = editBtns[0];
  const row1 = docs.getElementById('edit-row-1');
  const row2 = docs.getElementById('edit-row-2');
  eq(row1.hidden, true, 'row 1 starts hidden');
  eq(row2.hidden, true, 'row 2 starts hidden');

  btn1.dispatch('click', { target: btn1, preventDefault() {}, stopPropagation() {} });
  eq(row1.hidden, false, 'row 1 revealed after Edit click');
  eq(row2.hidden, true, 'row 2 still hidden');
  eq(btn1.disabled, true, 'Edit button disabled after click');
}

/* ---------- Cancel hides the row and re-enables the Edit button ---------- */
{
  buildFixture();
  const { initSettings } = await import('/static/js/settings.js');
  initSettings();

  const btn1 = docs.body.querySelector('button[data-action="edit-user"][data-user-id="1"]');
  const cancelBtn1 = docs.body.querySelector('button[data-action="cancel-edit"][data-user-id="1"]');
  const row1 = docs.getElementById('edit-row-1');

  btn1.dispatch('click', { target: btn1, preventDefault() {}, stopPropagation() {} });
  eq(row1.hidden, false, 'revealed before cancel');

  cancelBtn1.dispatch('click', { target: cancelBtn1, preventDefault() {}, stopPropagation() {} });
  eq(row1.hidden, true, 'row 1 hidden after Cancel');
  eq(btn1.disabled, false, 'Edit button re-enabled after Cancel');
}

/* ---------- Editing one row does not affect the other ---------- */
{
  buildFixture();
  const { initSettings } = await import('/static/js/settings.js');
  initSettings();

  const editBtn1 = docs.body.querySelector('button[data-action="edit-user"][data-user-id="1"]');
  const editBtn2 = docs.body.querySelector('button[data-action="edit-user"][data-user-id="2"]');
  const row1 = docs.getElementById('edit-row-1');
  const row2 = docs.getElementById('edit-row-2');

  editBtn1.dispatch('click', { target: editBtn1, preventDefault() {}, stopPropagation() {} });
  editBtn2.dispatch('click', { target: editBtn2, preventDefault() {}, stopPropagation() {} });
  eq(row1.hidden, false, 'row 1 revealed');
  eq(row2.hidden, false, 'row 2 also revealed');
  eq(editBtn1.disabled, true, 'Edit 1 disabled');
  eq(editBtn2.disabled, true, 'Edit 2 disabled');
}

summary('settings.test.mjs');
