"""Plan-level to-do API behavior.

The to-do list is plan-level: a global entry (``assignee_id`` NULL) is managed
by owner/editor, while an assigned entry belongs to one member and only that
member may toggle it — even when their plan role is viewer. These tests pin
that access matrix, the create/patch/delete validation, archived-plan
read-only behavior, and the SSE events the frontend listens for.
"""
from __future__ import annotations

import pytest


def _client_for(app, username, password="pw12345"):
    c = app.test_client()
    c.post("/auth/login", data={"username": username, "password": password})
    return c


def _create(client, plan_id, title, **extra):
    """POST a to-do; returns the raw response."""
    body = {"title": title}
    body.update(extra)
    return client.post(f"/api/plans/{plan_id}/todos", json=body)


def _make(client, plan_id, title, **extra):
    r = _create(client, plan_id, title, **extra)
    assert r.status_code == 200, r.data
    return r.get_json()["todo"]


@pytest.fixture
def todo_env(app, make_user):
    """A plan owned by Olive with editor Eddie and viewers Vicky + Wendy.

    Each user has their own test client (separate session), so the toggle
    matrix can be exercised without re-logging in.
    """
    owner = make_user(username="olive", display_name="Olive Owner")
    editor = make_user(username="eddie", display_name="Eddie Editor")
    viewer = make_user(username="vicky", display_name="Vicky Viewer")
    viewer2 = make_user(username="wendy", display_name="Wendy Viewer")

    clients = {
        u["username"]: _client_for(app, u["username"])
        for u in (owner, editor, viewer, viewer2)
    }
    owner_client = clients["olive"]
    plan = owner_client.post("/api/plans", json={"title": "Todo Trip"}).get_json()["plan"]
    plan_id = plan["id"]
    for user, role in ((editor, "editor"), (viewer, "viewer"), (viewer2, "viewer")):
        r = owner_client.post(f"/api/plans/{plan_id}/members",
                              json={"user_id": user["id"], "role": role})
        assert r.status_code == 200, r.data

    return {
        "plan_id": plan_id,
        "owner": owner,
        "editor": editor,
        "viewer": viewer,
        "viewer2": viewer2,
        "owner_client": owner_client,
        "editor_client": clients["eddie"],
        "viewer_client": clients["vicky"],
        "viewer2_client": clients["wendy"],
    }


# ------------------------------------------------------------------ create/list
class TestTodoCreateList:
    def test_create_global_and_assigned(self, todo_env):
        owner_client = todo_env["owner_client"]
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]

        created = _make(owner_client, pid, "Book airport transfer")
        assert created["plan_id"] == pid
        assert created["title"] == "Book airport transfer"
        assert created["note"] is None
        assert created["assignee_id"] is None
        assert created["assignee_name"] is None
        assert created["done"] is False
        assert created["done_by"] is None
        assert created["done_at"] is None
        assert created["created_by"] == todo_env["owner"]["id"]

        assigned = _make(owner_client, pid, "Get travel insurance",
                         assignee_id=vicky["id"])
        assert assigned["assignee_id"] == vicky["id"]
        assert assigned["assignee_name"] == "Vicky Viewer"
        assert assigned["done"] is False

    def test_list_returns_global_before_person_by_id(self, todo_env):
        owner_client = todo_env["owner_client"]
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]

        g1 = _make(owner_client, pid, "Group one")
        assigned = _make(owner_client, pid, "Vicky task", assignee_id=vicky["id"])
        g2 = _make(owner_client, pid, "Group two")

        r = owner_client.get(f"/api/plans/{pid}/todos")
        assert r.status_code == 200
        todos = r.get_json()["todos"]
        # With no project rows: globals sort before person entries, each by id.
        # (The full project -> global -> person order is pinned in
        # TestTodoProjectScope.test_project_task_ordering_is_project_first.)
        assert [t["id"] for t in todos] == [g1["id"], g2["id"], assigned["id"]]
        assert [t["title"] for t in todos] == ["Group one", "Group two", "Vicky task"]

    def test_done_is_real_json_boolean(self, todo_env):
        owner_client = todo_env["owner_client"]
        pid = todo_env["plan_id"]
        todo = _make(owner_client, pid, "Toggle me")

        r = owner_client.get(f"/api/plans/{pid}/todos")
        listed = r.get_json()["todos"][0]
        assert listed["done"] is False
        assert isinstance(listed["done"], bool)

        r = owner_client.post(f"/api/todos/{todo['id']}/toggle", json={"done": True})
        assert r.get_json()["todo"]["done"] is True

        r = owner_client.get(f"/api/plans/{pid}/todos")
        assert r.get_json()["todos"][0]["done"] is True

    def test_assignee_name_is_populated_in_list(self, todo_env):
        owner_client = todo_env["owner_client"]
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]
        _make(owner_client, pid, "Vicky task", assignee_id=vicky["id"])

        todo = owner_client.get(f"/api/plans/{pid}/todos").get_json()["todos"][0]
        assert todo["assignee_name"] == "Vicky Viewer"


# ------------------------------------------------------------------ project scope
class TestTodoProjectScope:
    """The project-task list: owner/editor manage it, any member may tick it."""

    def test_create_project_entry(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Book rental car",
                     scope="project")
        assert todo["scope"] == "project"
        assert todo["assignee_id"] is None
        assert todo["assignee_name"] is None

    def test_scope_defaults_to_global_without_assignee(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "No scope given")
        assert todo["scope"] == "global"

    def test_scope_defaults_to_person_with_assignee(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Assigned",
                     assignee_id=todo_env["viewer"]["id"])
        assert todo["scope"] == "person"

    def test_project_entry_requires_no_assignee(self, todo_env):
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "T",
                    scope="project", assignee_id=todo_env["viewer"]["id"])
        assert r.status_code == 400
        assert "assignee" in r.get_json()["error"]

    def test_person_entry_requires_assignee(self, todo_env):
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "T", scope="person")
        assert r.status_code == 400

    def test_invalid_scope_is_400(self, todo_env):
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "T", scope="bogus")
        assert r.status_code == 400

    def test_any_member_may_toggle_project_entry(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Open task", scope="project")

        # A viewer — who cannot tick the global list — can tick a project task.
        r = todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True})
        assert r.status_code == 200
        body = r.get_json()["todo"]
        assert body["done"] is True
        assert body["done_by"] == todo_env["viewer"]["id"]
        assert body["done_by_name"] == "Vicky Viewer"

        # Any other member can untick it too.
        assert todo_env["viewer2_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": False}).status_code == 200
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200

    def test_admin_non_owner_may_toggle_project_but_not_global(self, todo_env, admin_client):
        """An admin who doesn't own the plan resolves to a viewer; viewers may
        tick project tasks (any member may) but not global entries."""
        pid = todo_env["plan_id"]
        project = _make(todo_env["owner_client"], pid, "Open task", scope="project")
        global_ = _make(todo_env["owner_client"], pid, "Shared task")
        assert admin_client.post(
            f"/api/todos/{project['id']}/toggle", json={"done": True}).status_code == 200
        assert admin_client.post(
            f"/api/todos/{global_['id']}/toggle", json={"done": True}).status_code == 403
        # Still cannot manage.
        assert admin_client.post(
            f"/api/plans/{pid}/todos",
            json={"title": "Sneaky", "scope": "project"}).status_code == 403

    def test_viewer_cannot_manage_project_entries(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Open task", scope="project")
        vc = todo_env["viewer_client"]
        assert _create(vc, pid, "Sneaky", scope="project").status_code == 403
        assert vc.patch(f"/api/todos/{todo['id']}",
                        json={"title": "Sneaky"}).status_code == 403
        assert vc.delete(f"/api/todos/{todo['id']}").status_code == 403

    def test_manager_edits_and_deletes_project_entry(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Open task", scope="project")
        r = todo_env["editor_client"].patch(
            f"/api/todos/{todo['id']}", json={"title": "Renamed"})
        assert r.status_code == 200
        assert r.get_json()["todo"]["title"] == "Renamed"
        assert todo_env["editor_client"].delete(
            f"/api/todos/{todo['id']}").status_code == 200

    def test_project_task_ordering_is_project_first(self, todo_env):
        pid = todo_env["plan_id"]
        g = _make(todo_env["owner_client"], pid, "Global")
        v = _make(todo_env["owner_client"], pid, "Vicky", assignee_id=todo_env["viewer"]["id"])
        p = _make(todo_env["owner_client"], pid, "Project", scope="project")
        todos = todo_env["owner_client"].get(f"/api/plans/{pid}/todos").get_json()["todos"]
        assert [t["id"] for t in todos] == [p["id"], g["id"], v["id"]]

    def test_patch_rejects_scope_change(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Project", scope="project")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"scope": "global"})
        assert r.status_code == 400
        assert "scope" in r.get_json()["error"].lower()

    def test_patch_rejects_assignee_on_project_entry(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Project", scope="project")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}",
            json={"assignee_id": todo_env["viewer"]["id"]})
        assert r.status_code == 400

    def test_archived_project_entry_cannot_toggle(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Project", scope="project")
        assert todo_env["owner_client"].patch(
            f"/api/plans/{pid}", json={"status": "archived"}).status_code == 200
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403


# ------------------------------------------------------------------ validation
class TestTodoValidation:
    def test_create_rejects_empty_title(self, todo_env):
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "")
        assert r.status_code == 400
        assert "title" in r.get_json()["error"]

    def test_create_rejects_whitespace_title(self, todo_env):
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "   ")
        assert r.status_code == 400

    def test_create_title_length_boundary(self, todo_env):
        pid = todo_env["plan_id"]
        client = todo_env["owner_client"]
        # Exactly the max is accepted.
        assert _create(client, pid, "x" * 200).status_code == 200
        # One over is rejected.
        r = _create(client, pid, "x" * 201)
        assert r.status_code == 400
        assert "too long" in r.get_json()["error"]

    def test_create_note_length_boundary(self, todo_env):
        pid = todo_env["plan_id"]
        client = todo_env["owner_client"]
        assert _create(client, pid, "T", note="n" * 2000).status_code == 200
        r = _create(client, pid, "T", note="n" * 2001)
        assert r.status_code == 400
        assert "too long" in r.get_json()["error"]

    def test_create_note_omitted_is_null(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "No note")
        assert todo["note"] is None

    def test_create_empty_note_becomes_null(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Blank note",
                     note="")
        assert todo["note"] is None

    def test_create_rejects_non_member_assignee(self, todo_env, make_user):
        outsider = make_user(username="outsider")
        r = _create(todo_env["owner_client"], todo_env["plan_id"], "T",
                    assignee_id=outsider["id"])
        assert r.status_code == 400
        assert "member" in r.get_json()["error"]

    def test_create_accepts_owner_as_assignee(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Mine",
                     assignee_id=todo_env["owner"]["id"])
        assert todo["assignee_id"] == todo_env["owner"]["id"]


# ------------------------------------------------------------------ malformed input
class TestTodoMalformedInput:
    """Bad JSON types must be a 400, never an unhandled 500."""

    def test_create_non_string_title_is_400(self, todo_env):
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos", json={"title": 123})
        assert r.status_code == 400

    def test_create_non_object_body_is_400(self, todo_env):
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos", json=[1, 2, 3])
        assert r.status_code == 400

    def test_create_non_int_assignee_is_400(self, todo_env):
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos",
            json={"title": "T", "assignee_id": [1]})
        assert r.status_code == 400

    def test_create_bool_assignee_is_400(self, todo_env):
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos",
            json={"title": "T", "assignee_id": True})
        assert r.status_code == 400

    def test_create_oversized_assignee_is_400_not_500(self, todo_env):
        """An int beyond SQLite's signed 64-bit range must not crash the bind."""
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos",
            json={"title": "T", "assignee_id": 2 ** 63})
        assert r.status_code == 400
        assert "range" in r.get_json()["error"]

    def test_create_non_string_note_is_400(self, todo_env):
        r = todo_env["owner_client"].post(
            f"/api/plans/{todo_env['plan_id']}/todos",
            json={"title": "T", "note": {"a": 1}})
        assert r.status_code == 400
        assert "note" in r.get_json()["error"]

    def test_patch_non_int_assignee_is_400(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "T")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"assignee_id": {"x": 1}})
        assert r.status_code == 400

    def test_patch_non_object_body_is_400(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "T")
        r = todo_env["owner_client"].patch(f"/api/todos/{todo['id']}", json=[1])
        assert r.status_code == 400

    def test_noop_patch_does_not_publish_event(self, todo_env):
        """A PATCH with no recognized fields must not emit a todo.updated."""
        from backend import sse
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "T")
        plan_id = todo_env["plan_id"]
        q = sse.subscribe(plan_id)
        try:
            r = todo_env["owner_client"].patch(
                f"/api/todos/{todo['id']}", json={"bogus": 1})
            assert r.status_code == 200
            # No event should be queued for a no-op patch.
            import queue as _q
            try:
                ev = q.get_nowait()
            except _q.Empty:
                ev = None
            assert ev is None, f"unexpected event: {ev}"
        finally:
            sse.unsubscribe(plan_id, q)


# ------------------------------------------------------------------ toggle matrix
class TestTodoToggleMatrix:
    def test_global_toggled_by_owner_and_editor_only(self, todo_env, admin_client):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Global")

        assert todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403
        assert admin_client.post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403

    def test_assigned_entry_toggled_only_by_its_assignee(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Vicky task",
                     assignee_id=todo_env["viewer"]["id"])

        # The viewer assignee may toggle their own entry.
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200
        # Owner/editor and other viewers may not.
        assert todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403
        assert todo_env["viewer2_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403

    def test_assigned_to_owner_toggled_only_by_owner(self, todo_env):
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Owner task",
                     assignee_id=todo_env["owner"]["id"])

        assert todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403

    def test_viewer_cannot_create_patch_or_delete(self, todo_env):
        pid = todo_env["plan_id"]
        vc = todo_env["viewer_client"]
        todo = _make(todo_env["owner_client"], pid, "Global")

        assert _create(vc, pid, "Sneaky").status_code == 403
        assert vc.patch(f"/api/todos/{todo['id']}", json={"title": "Sneaky"}).status_code == 403
        assert vc.delete(f"/api/todos/{todo['id']}").status_code == 403

    def test_viewer_assignee_may_toggle_but_not_edit_or_delete_own(self, todo_env):
        """A viewer assigned an entry can toggle it, but that grant is only
        for toggling — editing and deleting still need owner/editor rights."""
        pid = todo_env["plan_id"]
        vc = todo_env["viewer_client"]
        todo = _make(todo_env["owner_client"], pid, "Vicky task",
                     assignee_id=todo_env["viewer"]["id"])

        assert vc.post(f"/api/todos/{todo['id']}/toggle",
                       json={"done": True}).status_code == 200
        assert vc.patch(f"/api/todos/{todo['id']}",
                        json={"title": "Mine now"}).status_code == 403
        assert vc.delete(f"/api/todos/{todo['id']}").status_code == 403

    def test_toggle_true_persists_done_by_and_done_at(self, todo_env):
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]
        todo = _make(todo_env["owner_client"], pid, "Vicky task",
                     assignee_id=vicky["id"])

        r = todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True})
        assert r.status_code == 200
        body = r.get_json()["todo"]
        assert body["done"] is True
        assert body["done_by"] == vicky["id"]
        assert body["done_by_name"] == "Vicky Viewer"
        assert body["done_at"] is not None

        listed = todo_env["owner_client"].get(
            f"/api/plans/{pid}/todos").get_json()["todos"][0]
        assert listed["done"] is True
        assert listed["done_by"] == vicky["id"]
        assert listed["done_at"] == body["done_at"]

    def test_toggle_false_clears_done_by_and_done_at(self, todo_env):
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]
        todo = _make(todo_env["owner_client"], pid, "Vicky task",
                     assignee_id=vicky["id"])

        todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True})
        r = todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": False})
        assert r.status_code == 200
        body = r.get_json()["todo"]
        assert body["done"] is False
        assert body["done_by"] is None
        assert body["done_at"] is None


# ------------------------------------------------------------------ toggle input
class TestTodoToggleInput:
    @pytest.mark.parametrize("payload", [{"done": "true"}, {"done": 1}, {}])
    def test_non_boolean_done_is_400_not_500(self, todo_env, payload):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Global")
        r = todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json=payload)
        assert r.status_code == 400
        assert "boolean" in r.get_json()["error"]

    def test_rejected_toggle_does_not_change_row(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Global")
        todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": "true"})
        listed = todo_env["owner_client"].get(
            f"/api/plans/{todo_env['plan_id']}/todos").get_json()["todos"][0]
        assert listed["done"] is False


# ------------------------------------------------------------------ patch
class TestTodoPatch:
    def test_owner_edits_title_and_note(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Old",
                     note="before")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"title": "New", "note": "after"})
        assert r.status_code == 200
        body = r.get_json()["todo"]
        assert body["title"] == "New"
        assert body["note"] == "after"

    def test_editor_edits_title(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Old")
        r = todo_env["editor_client"].patch(
            f"/api/todos/{todo['id']}", json={"title": "Edited"})
        assert r.status_code == 200
        assert r.get_json()["todo"]["title"] == "Edited"

    def test_patch_rejects_empty_title(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Old")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"title": "   "})
        assert r.status_code == 400

    def test_patch_rejects_done_key(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Global")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"done": True})
        assert r.status_code == 400
        assert "toggle" in r.get_json()["error"]
        # The row is unchanged.
        listed = todo_env["owner_client"].get(
            f"/api/plans/{todo_env['plan_id']}/todos").get_json()["todos"][0]
        assert listed["done"] is False

    def test_patch_reassigns_and_keeps_done(self, todo_env):
        pid = todo_env["plan_id"]
        vicky = todo_env["viewer"]
        wendy = todo_env["viewer2"]
        todo = _make(todo_env["owner_client"], pid, "Reassign me",
                     assignee_id=vicky["id"])
        todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True})

        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"assignee_id": wendy["id"]})
        assert r.status_code == 200
        body = r.get_json()["todo"]
        assert body["assignee_id"] == wendy["id"]
        assert body["assignee_name"] == "Wendy Viewer"
        assert body["done"] is True
        assert body["done_by"] == vicky["id"]

        # The new assignee can now toggle it; the old one cannot.
        assert todo_env["viewer2_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": False}).status_code == 200
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403

    def test_patch_rejects_global_to_assigned(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Global")
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}",
            json={"assignee_id": todo_env["viewer"]["id"]})
        assert r.status_code == 400
        assert "global" in r.get_json()["error"]

    def test_patch_rejects_assigned_to_global(self, todo_env):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Assigned",
                     assignee_id=todo_env["viewer"]["id"])
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"assignee_id": None})
        assert r.status_code == 400
        assert "global" in r.get_json()["error"]

    def test_patch_rejects_non_member_assignee(self, todo_env, make_user):
        outsider = make_user(username="outsider")
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Assigned",
                     assignee_id=todo_env["viewer"]["id"])
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"assignee_id": outsider["id"]})
        assert r.status_code == 400


# ------------------------------------------------------------------ delete
class TestTodoDelete:
    def test_owner_deletes_and_row_is_gone(self, todo_env, db):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Delete me")
        r = todo_env["owner_client"].delete(f"/api/todos/{todo['id']}")
        assert r.status_code == 200
        assert r.get_json()["deleted"] == todo["id"]
        assert db.one("SELECT 1 FROM plan_todos WHERE id = ?", (todo["id"],)) is None

    def test_editor_can_delete(self, todo_env, db):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Delete me")
        r = todo_env["editor_client"].delete(f"/api/todos/{todo['id']}")
        assert r.status_code == 200
        assert db.one("SELECT 1 FROM plan_todos WHERE id = ?", (todo["id"],)) is None

    def test_viewer_cannot_delete(self, todo_env, db):
        todo = _make(todo_env["owner_client"], todo_env["plan_id"], "Keep me")
        r = todo_env["viewer_client"].delete(f"/api/todos/{todo['id']}")
        assert r.status_code == 403
        assert db.one("SELECT 1 FROM plan_todos WHERE id = ?", (todo["id"],)) is not None

    def test_delete_plan_cascades_todos(self, todo_env, db):
        """plan_todos.plan_id cascades, and the app connection enables the
        foreign_keys pragma (the raw migration fixture does not)."""
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Dies with the plan")
        r = todo_env["owner_client"].delete(f"/api/plans/{pid}")
        assert r.status_code == 200
        assert db.one("SELECT 1 FROM plan_todos WHERE id = ?", (todo["id"],)) is None


# ------------------------------------------------------------------ archived plan
class TestTodoArchivedPlan:
    def test_archived_is_read_only_but_readable(self, todo_env):
        pid = todo_env["plan_id"]
        owner_client = todo_env["owner_client"]
        todo = _make(owner_client, pid, "Vicky task",
                     assignee_id=todo_env["viewer"]["id"])

        r = owner_client.patch(f"/api/plans/{pid}", json={"status": "archived"})
        assert r.status_code == 200

        # All writes are 403, including an assigned viewer toggling their own.
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 403
        assert _create(owner_client, pid, "New").status_code == 403
        assert owner_client.patch(
            f"/api/todos/{todo['id']}", json={"title": "Edit"}).status_code == 403
        assert owner_client.delete(f"/api/todos/{todo['id']}").status_code == 403

        # Reads still work for every role.
        assert owner_client.get(f"/api/plans/{pid}/todos").status_code == 200
        assert todo_env["viewer_client"].get(f"/api/plans/{pid}/todos").status_code == 200


# ------------------------------------------------------------------ access
class TestTodoAccess:
    def test_non_member_cannot_list(self, todo_env, app, make_user):
        outsider = make_user(username="outsider")
        c = _client_for(app, outsider["username"])
        assert c.get(f"/api/plans/{todo_env['plan_id']}/todos").status_code == 403

    def test_non_member_cannot_create(self, todo_env, app, make_user):
        outsider = make_user(username="outsider")
        c = _client_for(app, outsider["username"])
        assert _create(c, todo_env["plan_id"], "Sneaky").status_code == 403

    def test_missing_todo_404(self, todo_env):
        owner_client = todo_env["owner_client"]
        assert owner_client.patch(
            "/api/todos/99999", json={"title": "x"}).status_code == 404
        assert owner_client.post(
            "/api/todos/99999/toggle", json={"done": True}).status_code == 404
        assert owner_client.delete("/api/todos/99999").status_code == 404

    def test_unauthenticated_401(self, todo_env, app):
        anon = app.test_client()
        pid = todo_env["plan_id"]
        assert anon.get(f"/api/plans/{pid}/todos").status_code == 401
        assert anon.post(f"/api/plans/{pid}/todos",
                         json={"title": "X"}).status_code == 401
        todo = _make(todo_env["owner_client"], pid, "Global")
        assert anon.post(f"/api/todos/{todo['id']}/toggle",
                         json={"done": True}).status_code == 401


# ------------------------------------------------------------------ member removal
class TestTodoMemberRemoval:
    def test_removed_assignee_row_survives_but_cannot_toggle(self, todo_env, db):
        pid = todo_env["plan_id"]
        editor = todo_env["editor"]
        todo = _make(todo_env["owner_client"], pid, "Eddie task",
                     assignee_id=editor["id"])

        # Editor can toggle while a member.
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True}).status_code == 200

        r = todo_env["owner_client"].delete(f"/api/plans/{pid}/members/{editor['id']}")
        assert r.status_code == 200

        # The row survives with its assignee intact, and the owner can read it.
        row = db.one("SELECT assignee_id FROM plan_todos WHERE id = ?", (todo["id"],))
        assert row is not None
        assert row["assignee_id"] == editor["id"]
        assert todo_env["owner_client"].get(f"/api/plans/{pid}/todos").status_code == 200

        # The now non-member cannot toggle it.
        assert todo_env["editor_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": False}).status_code == 403

        # The owner can reassign it to a current member.
        r = todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}",
            json={"assignee_id": todo_env["viewer"]["id"]})
        assert r.status_code == 200
        assert r.get_json()["todo"]["assignee_id"] == todo_env["viewer"]["id"]
        assert todo_env["viewer_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": False}).status_code == 200


# ------------------------------------------------------------------ page
class TestTodoPage:
    def test_page_renders_for_owner_editor_viewer_and_admin(
            self, todo_env, admin_client):
        pid = todo_env["plan_id"]
        url = f"/plans/{pid}/todos"
        for label, c in (
            ("owner", todo_env["owner_client"]),
            ("editor", todo_env["editor_client"]),
            ("viewer", todo_env["viewer_client"]),
            ("admin", admin_client),
        ):
            r = c.get(url)
            assert r.status_code == 200, label
            html = r.get_data(as_text=True)
            assert "To-dos" in html, label
            assert f'href="/plans/{pid}/todos"' in html, label

    def test_page_marks_todos_nav_active(self, todo_env):
        r = todo_env["viewer_client"].get(f"/plans/{todo_env['plan_id']}/todos")
        html = r.get_data(as_text=True)
        assert 'aria-current="page"' in html
        assert '>To-dos</a>' in html


# ------------------------------------------------------------------ SSE
def teardown_function():
    from backend.sse import _queues, _lock
    with _lock:
        _queues.clear()


class TestTodoSSE:
    def test_create_publishes_event(self, todo_env):
        from backend.sse import subscribe
        pid = todo_env["plan_id"]
        q = subscribe(pid)
        todo = _make(todo_env["owner_client"], pid, "Watch me")
        event = q.get(timeout=1)
        assert event == {"type": "todo.created", "entity_id": todo["id"]}

    def test_toggle_publishes_updated_event(self, todo_env):
        from backend.sse import subscribe
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Watch me")
        q = subscribe(pid)
        todo_env["owner_client"].post(
            f"/api/todos/{todo['id']}/toggle", json={"done": True})
        event = q.get(timeout=1)
        assert event == {"type": "todo.updated", "entity_id": todo["id"]}

    def test_patch_publishes_updated_event(self, todo_env):
        from backend.sse import subscribe
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Watch me")
        q = subscribe(pid)
        todo_env["owner_client"].patch(
            f"/api/todos/{todo['id']}", json={"title": "Renamed"})
        event = q.get(timeout=1)
        assert event == {"type": "todo.updated", "entity_id": todo["id"]}

    def test_delete_publishes_event(self, todo_env):
        from backend.sse import subscribe
        pid = todo_env["plan_id"]
        todo = _make(todo_env["owner_client"], pid, "Watch me")
        q = subscribe(pid)
        todo_env["owner_client"].delete(f"/api/todos/{todo['id']}")
        event = q.get(timeout=1)
        assert event == {"type": "todo.deleted", "entity_id": todo["id"]}
