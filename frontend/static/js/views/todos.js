import { apiGet, apiPost, apiPatch, apiDel } from '/static/js/api.js';
import { el, clear } from '/static/js/util.js';
import { wirePlanHeaderDirect } from '/static/js/plan-header.js';
import { onSSEEvent } from '/static/js/plan-store.js';

const MANAGE_ROLES = ['owner', 'editor'];
const PROJECT_SCOPE = 'project';
const PROJECT_TITLE = 'Trip tasks';
const GLOBAL_SCOPE = 'global';
const GLOBAL_TITLE = 'Everyone';
const PERSON_SCOPE = 'person';
const REMOVED_TITLE_SUFFIX = ' (removed)';
const REMOVED_FALLBACK_NAME = 'Removed member';
const SSE_DEBOUNCE_MS = 250;
// Must match TODO_TITLE_MAX_LENGTH / TODO_NOTE_MAX_LENGTH in the backend.
const TITLE_MAX_LENGTH = 200;
const NOTE_MAX_LENGTH = 2000;
const NO_TODOS_TEXT = 'No to-dos yet.';
const ADD_PLACEHOLDER = 'Add a to-do...';
const NOTE_PLACEHOLDER = 'Note (optional)';
const TITLE_LABEL = 'To-do title';
const NOTE_LABEL = 'Note';
const TARGET_LABEL = 'Who is this for?';
const EDIT_TITLE_LABEL = 'Edit to-do title';
const DELETE_CONFIRM = 'Delete this to-do?';

/* Map the add bar's target select value to the create body's scope fields.
 * 'project'/'global' select a list directly; 'person:<id>' targets a member. */
export function targetToBody(value) {
  if (value.startsWith(PERSON_SCOPE + ':')) {
    return { scope: PERSON_SCOPE, assignee_id: Number(value.slice(PERSON_SCOPE.length + 1)) };
  }
  return { scope: value };
}

/* The row's scope, tolerating rows saved before the scope column existed. */
function scopeOf(todo) {
  if (todo.scope === PROJECT_SCOPE || todo.scope === GLOBAL_SCOPE || todo.scope === PERSON_SCOPE) {
    return todo.scope;
  }
  return todo.assignee_id == null ? GLOBAL_SCOPE : PERSON_SCOPE;
}

/* Target-select value for a member id, e.g. 'person:42'. Normalises the id so
 * a stored string id and a select option compare equal. */
function personTarget(id) {
  return PERSON_SCOPE + ':' + Number(id);
}

/* The target-select value that represents a row's current scope+assignee. */
export function targetValueOf(todo) {
  const scope = scopeOf(todo);
  return scope === PERSON_SCOPE ? personTarget(todo.assignee_id) : scope;
}

function byId(a, b) {
  return a.id - b.id;
}

function entriesOrder(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  return a.id - b.id;
}

function entryFor(todo, canToggle, canEdit, canDelete, isRemovedAssignee) {
  return Object.assign({}, todo, { canToggle, canEdit, canDelete, isRemovedAssignee });
}

function statsOf(entries) {
  return { done: entries.filter(e => e.done).length, total: entries.length };
}

function sectionFor(key, scope, title, entries) {
  return Object.assign({ key, scope, title, entries }, statsOf(entries));
}

/* Build the page's sections without touching the DOM. Order: project tasks
 * (any member ticks), then the global list (owner/editor tick), then one
 * section per assignee that has entries, ordered by display name. */
export function sectionsFor(todos, members, userId, role, readOnly) {
  const manager = MANAGE_ROLES.includes(role) && !readOnly;
  const memberById = new Map((members || []).map(m => [m.id, m]));

  const projects = [];
  const globals = [];
  const groups = new Map();
  for (const todo of todos || []) {
    const scope = scopeOf(todo);
    if (scope === PROJECT_SCOPE) {
      projects.push(todo);
      continue;
    }
    if (scope === GLOBAL_SCOPE) {
      globals.push(todo);
      continue;
    }
    if (!groups.has(todo.assignee_id)) groups.set(todo.assignee_id, []);
    groups.get(todo.assignee_id).push(todo);
  }

  const projectEntries = projects.sort(byId)
    .map(t => entryFor(t, !readOnly, manager, manager, false));
  const globalEntries = globals.sort(byId)
    .map(t => entryFor(t, manager, manager, manager, false));
  const sections = [
    sectionFor(PROJECT_SCOPE, PROJECT_SCOPE, PROJECT_TITLE, projectEntries),
    sectionFor(GLOBAL_SCOPE, GLOBAL_SCOPE, GLOBAL_TITLE, globalEntries),
  ];

  // Only assignees with entries get a section; the single add bar at the
  // top of the page is how a task reaches a member who has none yet.
  const memberSections = [];
  for (const [assigneeId, entries] of groups) {
    const member = memberById.get(assigneeId);
    const removed = !member;
    const name = member
      ? (member.display_name || member.username || REMOVED_FALLBACK_NAME)
      : ((entries[0] && entries[0].assignee_name) || REMOVED_FALLBACK_NAME);
    const decorated = entries.map(t => entryFor(
      t,
      !removed && t.assignee_id === userId && !readOnly,
      manager,
      manager,
      removed,
    )).sort(entriesOrder);
    memberSections.push({
      name,
      section: sectionFor(String(assigneeId), PERSON_SCOPE,
        removed ? name + REMOVED_TITLE_SUFFIX : name, decorated),
    });
  }
  memberSections.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  for (const ms of memberSections) sections.push(ms.section);
  return sections;
}

export async function init(container, ctx) {
  const root = document.createElement('div');
  root.id = 'todos-root';
  root.className = 'pt-page';
  container.appendChild(root);

  wirePlanHeaderDirect(ctx);

  let members = [];
  let canManage = false;
  let sseTimer = null;
  const unsubscribeSSE = onSSEEvent((e) => {
    if (!e || !e.type || !e.type.startsWith('todo.')) return;
    if (sseTimer) clearTimeout(sseTimer);
    sseTimer = setTimeout(() => { load().catch(() => {}); }, SSE_DEBOUNCE_MS);
  });

  async function load() {
    const [todosData, membersData, planData] = await Promise.all([
      apiGet(`/api/plans/${ctx.planId}/todos`, { forceRefresh: true }),
      apiGet(`/api/plans/${ctx.planId}/members`, { forceRefresh: true }),
      apiGet(`/api/plans/${ctx.planId}`, { forceRefresh: true }),
    ]);
    const todos = (todosData && todosData.todos) || [];
    const owner = membersData && membersData.owner;
    members = owner ? [owner, ...(membersData.members || [])] : ((membersData && membersData.members) || []);
    const readOnly = !!(planData && planData.plan && planData.plan.status === 'archived');
    canManage = MANAGE_ROLES.includes(ctx.role) && !readOnly;
    render(sectionsFor(todos, members, ctx.userId, ctx.role, readOnly));
  }

  function render(sections) {
    clear(root);
    // One create form for the whole page; the sections below are list-only.
    if (canManage) root.append(renderAddBar());
    for (const section of sections) root.append(renderSection(section));
  }

  function renderSection(section) {
    const card = el('section', { class: 'pt-section' }, [
      el('div', { class: 'pt-section-head' }, [
        el('h2', { class: 'pt-section-title', text: section.title }),
        el('span', { class: 'pt-progress', text: section.done + '/' + section.total }),
      ]),
    ]);

    if (section.entries.length === 0) {
      card.append(el('p', { class: 'pt-empty', text: NO_TODOS_TEXT }));
    } else {
      const list = el('ul', { class: 'pt-list' });
      for (const entry of section.entries) list.append(renderEntry(entry));
      card.append(list);
    }
    return card;
  }

  function renderEntry(todo) {
    const classes = ['pt-item'];
    if (todo.done) classes.push('pt-done');
    if (todo.isRemovedAssignee) classes.push('pt-removed');
    const li = el('li', { class: classes.join(' ') });

    const box = el('input', {
      type: 'checkbox',
      class: 'pt-check',
      checked: todo.done,
      disabled: !todo.canToggle,
      'aria-label': todo.title,
    });
    box.addEventListener('change', () => toggleTodo(todo, box.checked));
    li.append(box);

    const body = el('div', { class: 'pt-item-body' });
    body.append(el('span', { class: 'pt-item-title', text: todo.title }));
    if (todo.note) body.append(el('p', { class: 'pt-item-note', text: todo.note }));
    // A project task is open to any member, so show who ticked it off.
    if (scopeOf(todo) === PROJECT_SCOPE && todo.done && todo.done_by_name) {
      body.append(el('p', { class: 'pt-item-meta', text: 'Done by ' + todo.done_by_name }));
    }
    li.append(body);

    if (todo.canEdit || todo.canDelete) {
      const actions = el('div', { class: 'pt-item-actions' });
      if (todo.canEdit) {
        const editBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Edit' });
        editBtn.addEventListener('click', () => startEdit(li, todo));
        actions.append(editBtn);
      }
      if (todo.canDelete) {
        const delBtn = el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete' });
        delBtn.addEventListener('click', () => deleteTodo(todo));
        actions.append(delBtn);
      }
      li.append(actions);
    }
    return li;
  }

  function startEdit(li, todo) {
    clear(li);
    const titleIn = el('input', {
      class: 'pt-input', type: 'text',
      value: todo.title, maxlength: TITLE_MAX_LENGTH,
      'aria-label': EDIT_TITLE_LABEL,
    });
    const noteIn = el('input', {
      class: 'pt-input', type: 'text',
      placeholder: NOTE_PLACEHOLDER, value: todo.note || '',
      maxlength: NOTE_MAX_LENGTH, 'aria-label': NOTE_LABEL,
    });
    const currentTarget = targetValueOf(todo);
    // A person entry whose assignee left the plan keeps a removed option so
    // the stored value still round-trips.
    const removed = scopeOf(todo) === PERSON_SCOPE
        && !members.some(m => m.id === todo.assignee_id)
      ? { id: todo.assignee_id, name: todo.assignee_name }
      : null;
    const targetSel = buildTargetSelect(currentTarget, removed);
    const cancelBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => load());
    const controls = [titleIn, noteIn, targetSel];
    controls.push(el('div', { class: 'pt-item-actions' }, [
      el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Save' }),
      cancelBtn,
    ]));

    const form = el('form', { class: 'pt-edit-row', onsubmit: async (ev) => {
      ev.preventDefault();
      const title = titleIn.value.trim();
      if (!title) return;
      const payload = { title, note: noteIn.value.trim() || null };
      // Send the target only when it changed: re-sending an unchanged removed
      // assignee would fail the backend's membership check.
      if (targetSel.value !== currentTarget) {
        Object.assign(payload, targetToBody(targetSel.value));
      }
      try {
        await apiPatch(`/api/todos/${todo.id}`, payload);
        await load();
      } catch (e) { alert(e.message); await load(); }
    }}, controls);
    li.append(form);
  }

  /* The single create form for the page. Its target select picks the scope:
   * 'project', 'global', or 'person:<userId>'. */
  function renderAddBar() {
    const titleIn = el('input', {
      class: 'pt-input', type: 'text', placeholder: ADD_PLACEHOLDER,
      maxlength: TITLE_MAX_LENGTH, 'aria-label': TITLE_LABEL,
    });
    const noteIn = el('input', {
      class: 'pt-input', type: 'text', placeholder: NOTE_PLACEHOLDER,
      maxlength: NOTE_MAX_LENGTH, 'aria-label': NOTE_LABEL,
    });
    const targetSel = buildTargetSelect(PROJECT_SCOPE, null);

    return el('form', { class: 'pt-add-bar', onsubmit: async (ev) => {
      ev.preventDefault();
      const title = titleIn.value.trim();
      if (!title) return;
      const body = Object.assign(
        { title, note: noteIn.value.trim() || null },
        targetToBody(targetSel.value),
      );
      try {
        await apiPost(`/api/plans/${ctx.planId}/todos`, body);
        await load();
      } catch (e) { alert(e.message); await load(); }
    }}, [
      titleIn,
      noteIn,
      targetSel,
      el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Add' }),
    ]);
  }

  /* The one target select shared by the add bar and the edit row: the two
   * shared lists plus one option per member. A removed assignee gets a
   * trailing option (marked removed) so an unchanged value round-trips. */
  function buildTargetSelect(selected, removedAssignee) {
    const sel = el('select', { class: 'pt-assignee-select', 'aria-label': TARGET_LABEL });
    sel.append(el('option', { value: PROJECT_SCOPE, text: PROJECT_TITLE }));
    sel.append(el('option', { value: GLOBAL_SCOPE, text: GLOBAL_TITLE }));
    for (const m of members) {
      sel.append(el('option', {
        value: personTarget(m.id),
        text: (m.display_name || m.username) + ' (' + m.username + ')',
      }));
    }
    if (removedAssignee) {
      sel.append(el('option', {
        value: personTarget(removedAssignee.id),
        text: (removedAssignee.name || REMOVED_FALLBACK_NAME) + REMOVED_TITLE_SUFFIX,
      }));
    }
    sel.value = selected;
    return sel;
  }

  async function toggleTodo(todo, target) {
    try {
      await apiPost(`/api/todos/${todo.id}/toggle`, { done: target });
      await load();
    } catch (e) {
      alert(e.message);
      await load();
    }
  }

  async function deleteTodo(todo) {
    if (!confirm(DELETE_CONFIRM)) return;
    try {
      await apiDel(`/api/todos/${todo.id}`);
      await load();
    } catch (e) {
      alert(e.message);
      await load();
    }
  }

  await load().catch(e => {
    clear(root);
    root.append(el('div', { class: 'error-msg', text: 'Failed to load: ' + e.message }));
  });

  return () => {
    if (sseTimer) clearTimeout(sseTimer);
    unsubscribeSSE();
    container.innerHTML = '';
  };
}
