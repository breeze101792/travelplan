/* todos.test.mjs — unit tests for the plan-level to-do view's pure logic.
 *
 * Run:  node --import ./register.mjs todos.test.mjs   (from frontend/tests/)
 * or:   ./run.sh                                       (runs everything)
 *
 * Covers sectionsFor(): the three scopes (project / global / person),
 * grouping, ordering, per-role/per-assignee permission flags,
 * removed-assignee handling, and done/total counts. The function is pure
 * (no DOM, no fetch) so no fetch-stub is needed.
 */
import { assert, eq, summary } from './lib/t.mjs';
import { sectionsFor, targetToBody, targetValueOf } from '/static/js/views/todos.js';

const OWNER = { id: 1, username: 'ada', display_name: 'Ada', role: 'owner' };
const BOB = { id: 2, username: 'bob', display_name: 'bob', role: 'editor' };
const CARA = { id: 3, username: 'cara', display_name: 'Cara', role: 'viewer' };
const MEMBERS = [OWNER, BOB, CARA];

/* scope defaults from the assignee, matching the pre-scope-column rows. */
function todo(id, assignee_id, extra) {
  return Object.assign({
    id, plan_id: 1, title: 'T' + id, note: null, assignee_id,
    scope: assignee_id == null ? 'global' : 'person',
    assignee_name: null, done: false, done_by: null, done_at: null,
    created_by: 1, created_at: '', updated_at: '',
  }, extra);
}

function eqArr(actual, expected, msg) {
  eq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

function sec(sections, key) {
  return sections.find(s => s.key === key);
}

function entryIds(section) {
  return section.entries.map(e => e.id);
}

// ---------- section layout ----------

{
  const sections = sectionsFor([], MEMBERS, CARA.id, 'viewer', false);
  eqArr(sections.map(s => s.key), ['project', 'global'],
    'no entries: only the project and global sections');
  eq(sec(sections, 'project').total, 0, 'empty project section has zero total');
  eq(sec(sections, 'global').total, 0, 'empty global section has zero total');
}

{
  // The add form is central now, so sections only carry assignees with
  // entries — for every role, including managers.
  const sections = sectionsFor([todo(1, BOB.id)], MEMBERS, OWNER.id, 'owner', false);
  eqArr(sections.map(s => s.key), ['project', 'global', String(BOB.id)],
    'a manager sees only the assignee with entries (single add bar)');
}

// ---------- grouping + ordering ----------

{
  const todos = [
    todo(3, null), todo(1, null),           // globals, out of order
    todo(5, CARA.id), todo(4, BOB.id), todo(2, BOB.id),
    todo(7, null, { scope: 'project' }), todo(6, null, { scope: 'project' }),
  ];
  const sections = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);

  eqArr(sections.map(s => s.key),
    ['project', 'global', String(BOB.id), String(CARA.id)],
    'project first, then global, then assignees ordered by display_name');
  eqArr(entryIds(sec(sections, 'project')), [6, 7], 'project entries sorted by id');
  eqArr(entryIds(sec(sections, 'global')), [1, 3], 'global entries sorted by id ascending');
  eqArr(entryIds(sec(sections, String(BOB.id))), [2, 4],
    'member entries sorted by id when all unchecked');
  eqArr(entryIds(sec(sections, String(CARA.id))), [5], 'each assignee gets its own section');
}

{
  const todos = [todo(1, null), todo(2, null, { done: true }), todo(3, null)];
  const sections = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);
  eqArr(entryIds(sec(sections, 'global')), [1, 2, 3],
    'global entries stay id-ordered regardless of done (per spec)');
  eq(sec(sections, 'global').done, 1, 'done count');
  eq(sec(sections, 'global').total, 3, 'total count');
}

{
  const todos = [todo(1, BOB.id), todo(2, BOB.id, { done: true }), todo(3, BOB.id)];
  const sections = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);
  eqArr(entryIds(sec(sections, String(BOB.id))), [1, 3, 2],
    'member entries: unchecked first, then checked, then by id');
}

// ---------- permissions: project ----------

{
  const todos = [todo(1, null, { scope: 'project' })];

  const owner = sec(sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false), 'project').entries[0];
  eq(owner.canToggle, true, 'owner can toggle a project task');
  eq(owner.canEdit, true, 'owner can edit a project task');
  eq(owner.canDelete, true, 'owner can delete a project task');

  const viewer = sec(sectionsFor(todos, MEMBERS, CARA.id, 'viewer', false), 'project').entries[0];
  eq(viewer.canToggle, true, 'a viewer may tick a project task (anyone can do it)');
  eq(viewer.canEdit, false, 'a viewer cannot edit a project task');
  eq(viewer.canDelete, false, 'a viewer cannot delete a project task');

  const archived = sec(sectionsFor(todos, MEMBERS, OWNER.id, 'owner', true), 'project').entries[0];
  eq(archived.canToggle, false, 'archived plan: project task not toggleable');
  eq(archived.canEdit, false, 'archived plan: project task not editable');
  eq(archived.canDelete, false, 'archived plan: project task not deletable');
}

// ---------- permissions: global ----------

{
  const todos = [todo(1, null)];

  const owner = sec(sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false), 'global').entries[0];
  eq(owner.canToggle, true, 'owner can toggle global');
  eq(owner.canEdit, true, 'owner can edit global');
  eq(owner.canDelete, true, 'owner can delete global');

  const editor = sec(sectionsFor(todos, MEMBERS, BOB.id, 'editor', false), 'global').entries[0];
  eq(editor.canToggle, true, 'editor can toggle global');

  const viewer = sec(sectionsFor(todos, MEMBERS, CARA.id, 'viewer', false), 'global').entries[0];
  eq(viewer.canToggle, false, 'viewer cannot toggle global');
  eq(viewer.canEdit, false, 'viewer cannot edit global');
  eq(viewer.canDelete, false, 'viewer cannot delete global');

  const archived = sec(sectionsFor(todos, MEMBERS, OWNER.id, 'owner', true), 'global').entries[0];
  eq(archived.canToggle, false, 'archived plan: global not toggleable');
  eq(archived.canEdit, false, 'archived plan: global not editable');
  eq(archived.canDelete, false, 'archived plan: global not deletable');
}

// ---------- permissions: assigned entries ----------

{
  const todos = [todo(1, BOB.id), todo(2, CARA.id)];
  const bobOf = s => sec(s, String(BOB.id));
  const caraOf = s => sec(s, String(CARA.id));

  const asBob = sectionsFor(todos, MEMBERS, BOB.id, 'editor', false);
  eq(bobOf(asBob).entries[0].canToggle, true, 'assignee can toggle their own entry');
  eq(bobOf(asBob).entries[0].canEdit, true, 'editor-assignee can edit their own entry');

  const asCara = sectionsFor(todos, MEMBERS, CARA.id, 'viewer', false);
  eq(caraOf(asCara).entries[0].canToggle, true,
    'a viewer may toggle an entry assigned to them');
  eq(caraOf(asCara).entries[0].canEdit, false, 'a viewer-assignee cannot edit');

  const asOwner = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);
  eq(bobOf(asOwner).entries[0].canToggle, false,
    "owner cannot toggle someone else's assigned entry");
  eq(bobOf(asOwner).entries[0].canEdit, true, 'owner may edit/reassign an assigned entry');
  eq(bobOf(asOwner).entries[0].canDelete, true, 'owner may delete an assigned entry');

  const archived = sectionsFor(todos, MEMBERS, BOB.id, 'editor', true);
  eq(bobOf(archived).entries[0].canToggle, false, 'archived plan: assignee cannot toggle');
  eq(bobOf(archived).entries[0].canEdit, false, 'archived plan: manager cannot edit');
}

// ---------- removed assignee ----------

{
  const todos = [todo(1, 99, { assignee_name: 'Dana' }), todo(2, 99, { assignee_name: 'Dana' })];
  const sections = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);

  // The removed assignee's section exists alongside the manager's per-member
  // sections; assert by key rather than by count.
  const removed = sec(sections, '99');
  assert(removed, 'removed assignee still produces a section');
  eq(removed.title, 'Dana (removed)', 'removed title uses stored assignee_name');
  eq(removed.entries[0].isRemovedAssignee, true, 'entry flagged as removed');
  eq(removed.entries[0].canToggle, false, "nobody can toggle a removed assignee's entry");
  eq(removed.entries[0].canEdit, true, 'manager can still edit a removed assignee\'s entry');
  eq(removed.entries[0].canDelete, true, 'manager can still delete a removed assignee\'s entry');

  const asRemoved = sectionsFor(todos, MEMBERS, 99, 'viewer', false);
  eq(sec(asRemoved, '99').entries[0].canToggle, false,
    'removed member cannot toggle even if userId matches');
}

{
  const todos = [todo(1, 99)];
  const sections = sectionsFor(todos, MEMBERS, OWNER.id, 'owner', false);
  eq(sec(sections, '99').title, 'Removed member (removed)',
    'removed title falls back when assignee_name is missing');
}

// ---------- add-bar target -> create body ----------

{
  eqArr(targetToBody('project'), { scope: 'project' },
    "the 'Trip tasks' target maps to scope project");
  eqArr(targetToBody('global'), { scope: 'global' },
    "the 'Everyone' target maps to scope global");
  eqArr(targetToBody('person:42'), { scope: 'person', assignee_id: 42 },
    'a person target carries the assignee id as a number');
  eqArr(targetToBody('person:007'), { scope: 'person', assignee_id: 7 },
    'a person id with leading zeros is normalised to a number');
}

// ---------- row -> target-select value ----------

{
  eq(targetValueOf(todo(1, null, { scope: 'project' })), 'project',
    'a project row maps to the project target');
  eq(targetValueOf(todo(1, null, { scope: 'global' })), 'global',
    'a global row maps to the global target');
  eq(targetValueOf(todo(1, 42, { scope: 'person', assignee_id: 42 })), 'person:42',
    'a person row maps to its assignee target');
  eq(targetValueOf(todo(1, '007', { scope: 'person', assignee_id: '007' })), 'person:7',
    'a leading-zero assignee id is normalised');
}

// ---------- pre-scope rows (no scope column) ----------

{
  const legacy = todo(1, null);
  delete legacy.scope;
  const sections = sectionsFor([legacy], MEMBERS, OWNER.id, 'owner', false);
  eq(sec(sections, 'global').entries[0].canToggle, true,
    'a row without a scope column is treated as global');
  assert(sec(sections, 'project').total === 0, 'legacy row does not become a project task');
}

summary('todos');
