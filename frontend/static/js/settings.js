/* settings.js — page-local interactivity for /auth/settings.
 *
 * Currently just toggles the inline Edit row beneath each member table row.
 * Plain ESM, no build step. The page is server-rendered (Jinja); this only
 * handles the per-row Edit reveal/hide.
 */
export function initSettings() {
  // Edit -> show the row beneath the user.
  for (const btn of document.querySelectorAll('[data-action="edit-user"]')) {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-user-id');
      const row = document.getElementById('edit-row-' + id);
      if (row) row.hidden = false;
      btn.disabled = true;
      // Focus the first field in the revealed form for keyboard flow.
      const firstInput = row && row.querySelector('input[name="display_name"]');
      if (firstInput) firstInput.focus();
    });
  }
  // Cancel -> hide the row; re-enable the Edit button.
  for (const btn of document.querySelectorAll('[data-action="cancel-edit"]')) {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-user-id');
      const row = document.getElementById('edit-row-' + id);
      if (row) row.hidden = true;
      const editBtn = document.querySelector(
        '[data-action="edit-user"][data-user-id="' + id + '"]');
      if (editBtn) editBtn.disabled = false;
    });
  }
}
