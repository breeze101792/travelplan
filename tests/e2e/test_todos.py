"""Plan-level To-dos page E2E.

Covers the To-dos tab rendered by ``frontend/static/js/views/todos.js``
(``.pt-`` classes) against the ``backend/blueprints/todos.py`` API:

  * owner can navigate via the SPA nav link and via a direct deep link,
    add a global entry, and the entry survives a reload;
  * owner can assign an entry to a member, which renders under a section
    titled with that member's display name and shows the right progress;
  * the project-task list sits first and any member can tick a project task,
    while a viewer still cannot tick the global list;
  * an assignee on a viewer role can tick (and only tick) their own entry,
    and the tick survives a reload;
  * a non-manager sees no add row, no Edit/Delete actions, and a disabled
    global checkbox, while their own assigned checkbox stays enabled;
  * an archived plan renders the lists read-only;
  * a fresh plan shows the empty state plus the manager's global add row;
  * the iPhone (touch) context can tap an assigned checkbox and it toggles
    exactly once.

Prerequisites (plan, sharing, entries) are created through the JSON API so
the tests stay fast and deterministic; the user-visible flows themselves are
driven through the real UI.

The login fixtures preload ``/dashboard``, which caches GET responses in
IndexedDB, so tests that create state via the API clear that cache before
navigating (``_clear_cache``) — the same F5 a user would hit.
"""
from __future__ import annotations

import http.cookiejar
import json
import urllib.parse
import urllib.request


def _api_client(server, username="alice"):
    """A urllib opener logged in as ``username``. Used to set up state faster
    than driving the UI for every test prerequisite."""
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": username, "password": server[username]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    return opener


def _create_plan_api(server, owner="admin", **body):
    body.setdefault("title", "Trip")
    op = _api_client(server, owner)
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def _member(server, username):
    """Look up a seeded member account (id + display_name) via the API."""
    op = _api_client(server, "admin")
    r = op.open(server["base_url"] + "/api/members")
    return next(m for m in json.loads(r.read())["members"]
                if m["username"] == username)


def _share_plan(server, pid, username, role="viewer", owner="admin"):
    """Add a seeded member to the plan with an explicit role so the test's
    permissions are deterministic."""
    uid = _member(server, username)["id"]
    op = _api_client(server, owner)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/members",
        data=json.dumps({"user_id": uid, "role": role}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))


def _create_todo_api(server, pid, title, assignee_id=None, note=None,
                     scope=None, actor="admin"):
    body = {"title": title, "note": note, "assignee_id": assignee_id}
    if scope is not None:
        body["scope"] = scope
    op = _api_client(server, actor)
    r = op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/todos",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["todo"]["id"]


def _archive_plan(server, pid, owner="admin"):
    op = _api_client(server, owner)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}",
        data=json.dumps({"status": "archived"}).encode(),
        headers={"Content-Type": "application/json"}, method="PATCH"))


def _clear_cache(p):
    """Clear the IndexedDB GET cache so the next navigation fetches fresh
    data. The login fixture preloads /dashboard, which caches the plan list."""
    p.evaluate("""async () => {
        await new Promise(resolve => {
            const req = indexedDB.deleteDatabase('travelplan-cache');
            req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
        });
    }""")
    p.wait_for_timeout(200)


def _wait_rendered(p, timeout=15000):
    """Wait until todos.js has finished its first ``load()`` and rendered at
    least one section. ``#todos-root`` is appended before the async fetch
    resolves, so asserting item counts right after it appears can race a
    still-empty root."""
    p.locator("#todos-root").wait_for(state="attached")
    p.locator(".pt-section").first.wait_for(state="visible", timeout=timeout)


def _section(p, title):
    """The ``.pt-section`` whose title matches ``title`` exactly."""
    return p.locator(".pt-section").filter(
        has=p.locator(".pt-section-title", has_text=title))


def _wait_section_progress(p, title, progress, timeout=10000):
    """Wait until the section titled ``title`` shows ``done/total``."""
    p.wait_for_function(
        """([title, progress]) => {
            const sections = [...document.querySelectorAll('.pt-section')];
            const s = sections.find(el =>
                el.querySelector('.pt-section-title')?.textContent.trim() === title);
            return !!s && s.querySelector('.pt-progress')?.textContent.trim() === progress;
        }""",
        arg=[title, progress], timeout=timeout)


# ------------------------------------------------------------------ central add bar
def test_todos_single_add_bar_targets_every_scope(admin_desktop, server):
    """There is exactly one create form, at the top, with no form inside any
    section, and its target select adds to each of the three lists."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Central add trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)

    # Exactly one form on the page, first in the root, and it is the add bar.
    layout = p.evaluate("""() => {
        const root = document.getElementById('todos-root');
        const bar = root.querySelector('.pt-add-bar');
        return {
            forms: root.querySelectorAll('form').length,
            sectionsWithForms: [...root.querySelectorAll('.pt-section')]
                .filter(s => s.querySelector('form')).length,
            barFirst: root.firstElementChild === bar,
            defaultTarget: bar.querySelector('.pt-assignee-select').value,
        };
    }""")
    assert layout["forms"] == 1, f"exactly one form on the page (got {layout['forms']})"
    assert layout["sectionsWithForms"] == 0, \
        "sections are list-only (no add form inside them)"
    assert layout["barFirst"], "the add bar is the first element on the page"
    assert layout["defaultTarget"] == "project", "the target defaults to Trip tasks"

    # One add bar, three destinations.
    _add_todo(p, server, "Book rental car", target_scope="project")
    _add_todo(p, server, "Group shopping", target_scope="global")
    _add_todo(p, server, "Pack passport", target_scope="person", username="alice")

    todos = _todos_api(server, pid)
    by_title = {t["title"]: t for t in todos}
    assert by_title["Book rental car"]["scope"] == "project"
    assert by_title["Group shopping"]["scope"] == "global"
    assert by_title["Pack passport"]["scope"] == "person"
    assert by_title["Pack passport"]["assignee_id"] == alice["id"]

    # Each landed in its own section, and the bar is still the only form.
    assert _section(p, "Trip tasks").locator(".pt-item").count() == 1
    assert _section(p, "Everyone").locator(".pt-item").count() == 1
    assert _section(p, alice["display_name"]).locator(".pt-item").count() == 1
    assert p.locator(".pt-add-bar").count() == 1, "still one add bar"


def _todos_api(server, pid, actor="admin"):
    """List a plan's to-dos through the API."""
    op = _api_client(server, actor)
    r = op.open(server["base_url"] + f"/api/plans/{pid}/todos")
    return json.loads(r.read())["todos"]


def test_todos_add_bar_hidden_for_viewer(desktop, server):
    """A viewer gets no create form anywhere on the page."""
    p = desktop
    pid = _create_plan_api(server, owner="admin", title="Viewer add trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Group shopping")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    assert p.locator(".pt-add-bar").count() == 0, "viewer sees no add bar"
    assert p.locator(".pt-section form").count() == 0, "no forms for a viewer"


# ------------------------------------------------------------------ desktop owner
def test_todos_owner_nav_link_renders(admin_desktop, server):
    """Clicking the plan-nav 'To-dos' link loads the view through the SPA
    router and marks the link as the current page."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Owner nav trip")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector("#plan-view")
    link = p.locator(".pn-link", has_text="To-dos")
    assert link.count() >= 1, "To-dos nav link is present"
    link.first.scroll_into_view_if_needed()
    link.first.click()
    p.wait_for_function(
        f"() => location.pathname === '/plans/{pid}/todos'", timeout=20000)
    _wait_rendered(p, timeout=20000)
    assert p.locator("#todos-root.pt-page").count() == 1, \
        "#todos-root renders with the .pt-page class"
    assert p.url.endswith(f"/plans/{pid}/todos"), \
        f"SPA nav updates the URL: {p.url}"
    assert link.first.get_attribute("aria-current") == "page", \
        "To-dos link is marked current"


def _add_todo(p, server, title, target_scope="project", username=None):
    """Add a to-do through the single page-level add bar. ``target_scope`` is
    'project' | 'global' | 'person'; a person target needs ``username``."""
    bar = p.locator(".pt-add-bar")
    assert bar.count() == 1, "exactly one create form on the page"
    bar.locator(".pt-input").first.fill(title)
    value = target_scope
    if target_scope == "person":
        value = f"person:{_member(server, username)['id']}"
    bar.locator(".pt-assignee-select").select_option(value)
    bar.locator('button:has-text("Add")').click()
    p.wait_for_selector(f'.pt-item:has-text("{title}")', timeout=10000)


def test_todos_owner_deep_link_add_global_persists(admin_desktop, server):
    """A direct deep link renders, the owner adds a global entry via the single
    add bar, and the entry persists across a full reload."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Owner add trip")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    assert p.locator("#todos-root.pt-page").count() == 1, "deep link renders"
    assert p.locator(".pt-add-bar").count() == 1, "owner sees one add bar"
    _add_todo(p, server, "Book flights", target_scope="global")
    # Reload: the entry is server-side state, not just in-memory DOM.
    p.reload()
    _wait_rendered(p)
    p.wait_for_selector('.pt-item:has-text("Book flights")', timeout=10000)
    assert p.locator('.pt-item:has-text("Book flights")').count() == 1, \
        "global entry persists after reload"


def test_todos_assigned_entry_progress(admin_desktop, server):
    """The owner assigns an entry to alice via the single add bar; it renders
    under her section with a 0/1 progress counter."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Assign trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    _add_todo(p, server, "Pack bags", target_scope="person", username="alice")
    alice_section = _section(p, alice["display_name"])
    assert alice_section.count() == 1, \
        f"section titled with the assignee's display name: {alice['display_name']}"
    assert alice_section.locator(".pt-progress").text_content() == "0/1", \
        "assigned section starts at 0/1"
    assert "Pack bags" in alice_section.locator(".pt-item-title").first.text_content()


# ------------------------------------------------------------------ viewer
def test_todos_viewer_assignee_toggles_own(desktop, server):
    """alice, on a viewer role, can tick her own prep entry; the tick and the
    1/1 progress survive a reload."""
    p = desktop
    pid = _create_plan_api(server, owner="admin", title="Viewer toggle trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Pack passport", assignee_id=alice["id"])
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    alice_section = _section(p, alice["display_name"])
    check = alice_section.locator(".pt-check").first
    assert check.is_enabled(), "assignee may tick their own entry"
    assert check.is_checked() is False, "starts unticked"
    check.click()
    _wait_section_progress(p, alice["display_name"], "1/1")
    p.reload()
    _wait_rendered(p)
    alice_section = _section(p, alice["display_name"])
    assert alice_section.locator(".pt-check").first.is_checked(), \
        "tick persists after reload"
    assert alice_section.locator(".pt-progress").text_content() == "1/1", \
        "progress persists after reload"


def test_todos_viewer_cannot_manage(desktop, server):
    """A viewer sees the lists read-only: no add row, no Edit/Delete actions,
    and a disabled global checkbox, while their own assigned checkbox is
    enabled."""
    p = desktop
    pid = _create_plan_api(server, owner="admin", title="Viewer readonly trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Group shopping")
    _create_todo_api(server, pid, "Pack passport", assignee_id=alice["id"])
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    assert p.locator(".pt-item").count() == 2, "both entries render"
    assert p.locator(".pt-add-bar").count() == 0, \
        "viewer sees no add controls"
    assert p.locator('.pt-item-actions button:has-text("Edit")').count() == 0, \
        "viewer sees no Edit buttons"
    assert p.locator('.pt-item-actions button:has-text("Delete")').count() == 0, \
        "viewer sees no Delete buttons"
    global_check = _section(p, "Everyone").locator(".pt-check").first
    own_check = _section(p, alice["display_name"]).locator(".pt-check").first
    assert global_check.is_disabled(), \
        "viewer cannot tick the global entry"
    assert own_check.is_enabled(), \
        "viewer can tick their own assigned entry"


def test_todos_archived_read_only(admin_desktop, server):
    """An archived plan renders its lists but exposes no management controls
    and disables every checkbox — even for the owner."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Archived trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Group shopping")
    _create_todo_api(server, pid, "Pack passport", assignee_id=alice["id"])
    _archive_plan(server, pid)
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    assert p.locator(".pt-item").count() == 2, "lists render on an archived plan"
    assert p.locator(".pt-add-bar").count() == 0, \
        "archived plan has no add controls"
    checks = p.locator(".pt-check")
    assert checks.count() == 2
    for i in range(checks.count()):
        assert checks.nth(i).is_disabled(), \
            f"checkbox {i} is disabled on an archived plan"


def test_todos_empty_state(admin_desktop, server):
    """A fresh plan shows the empty-state message and, for a manager, the
    single page-level add bar."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Empty trip")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)
    assert p.locator(".pt-empty").count() >= 1, "empty state is visible"
    assert "No to-dos yet." in p.locator(".pt-empty").first.text_content()
    # Exactly one create form, and its target select offers every scope.
    assert p.locator(".pt-add-bar").count() == 1, \
        "manager sees one add bar on an empty plan"
    options = p.locator(".pt-add-bar .pt-assignee-select option").all_text_contents()
    assert "Trip tasks" in options and "Everyone" in options, \
        f"the target select lists all scopes: {options}"


# ------------------------------------------------------------------ project tasks
def test_todos_project_task_any_viewer_can_tick(admin_desktop, server):
    """The project-task list sits first, and any member — including a viewer
    who cannot tick the global list — can check a project task off. The
    manager controls add/edit/delete."""
    p = admin_desktop
    pid = _create_plan_api(server, owner="admin", title="Project tasks trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Book rental car", scope="project")
    _create_todo_api(server, pid, "Group shopping")
    _create_todo_api(server, pid, "Pack passport", assignee_id=alice["id"])

    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)

    # The project section is the first section on the page.
    first_title = p.locator(".pt-section-title").first.text_content()
    assert first_title == "Trip tasks", \
        f"project section renders first (got {first_title!r})"

    # The manager has the single add bar, defaulting to the project list.
    assert p.locator(".pt-add-bar").count() == 1, "manager sees the add bar"
    assert p.locator(".pt-add-bar .pt-assignee-select").input_value() == "project", \
        "the target select defaults to Trip tasks"

    # Switch to alice's session: she may tick the project task, not the global.
    _logout_and_login(p, server, "alice")
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}/todos")
    _wait_rendered(p)

    project_check = _section(p, "Trip tasks").locator(".pt-check").first
    global_check = _section(p, "Everyone").locator(".pt-check").first
    assert project_check.is_enabled(), \
        "any member can tick a project task"
    assert global_check.is_disabled(), \
        "a viewer still cannot tick the global entry"

    project_check.click()
    _wait_section_progress(p, "Trip tasks", "1/1")
    p.reload()
    _wait_rendered(p)
    assert _section(p, "Trip tasks").locator(".pt-check").first.is_checked(), \
        "the project tick persists after reload"
    # The completed project task shows who ticked it.
    assert "Done by" in _section(p, "Trip tasks").locator(".pt-item-meta").first.text_content()


def _logout_and_login(p, server, username):
    """Drop the current session and log in as ``username`` via the UI."""
    p.context.clear_cookies()
    p.goto(server["base_url"] + "/auth/login")
    p.fill('input[name="username"]', username)
    p.fill('input[name="password"]', server[username]["password"])
    p.click('button[type="submit"]')
    p.wait_for_load_state("networkidle")


# ------------------------------------------------------------------ iPhone
def test_todos_iphone_tap_assigned_once(iphone, server):
    """On iPhone the nav link and page render, and tapping the assignee's own
    checkbox toggles exactly once and persists across a reload."""
    p = iphone
    pid = _create_plan_api(server, owner="admin", title="iPhone todos trip")
    alice = _member(server, "alice")
    _share_plan(server, pid, "alice", role="viewer")
    _create_todo_api(server, pid, "Pack passport", assignee_id=alice["id"])
    _clear_cache(p)
    p.goto(server["base_url"] + f"/plans/{pid}")
    link = p.locator(".pn-link", has_text="To-dos")
    assert link.count() >= 1, "To-dos nav link renders on iPhone"
    # On a narrow viewport the plan nav is a horizontal scroll container
    # (base.css: overflow-x:auto; flex-wrap:nowrap), so the To-dos link can
    # sit outside the 390px viewport. Scroll it in before tapping.
    link.first.scroll_into_view_if_needed()
    link.first.tap()
    p.wait_for_function(
        f"() => location.pathname === '/plans/{pid}/todos'", timeout=20000)
    _wait_rendered(p, timeout=20000)
    assert p.locator("#todos-root.pt-page").count() == 1, ".pt-page renders"
    toggles = []

    def _on_request(req):
        if "/toggle" in req.url:
            toggles.append(req.url)

    p.on("request", _on_request)
    check = _section(p, alice["display_name"]).locator(".pt-check").first
    assert check.is_enabled(), "assignee can tick their own entry on iPhone"
    check.tap()
    _wait_section_progress(p, alice["display_name"], "1/1")
    assert len(toggles) == 1, f"tap toggles exactly once (got {len(toggles)})"
    p.reload()
    _wait_rendered(p)
    assert _section(p, alice["display_name"]).locator(".pt-check").first.is_checked(), \
        "tap persists after reload"
    assert _section(p, alice["display_name"]).locator(".pt-progress").text_content() == "1/1"
    assert len(toggles) == 1, "reload does not re-toggle"
