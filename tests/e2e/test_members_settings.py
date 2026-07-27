"""Members page + Settings page E2E. The members page is owner-only and lets
the owner add/remove members and change their roles; the settings page is
self-serve (display name + password). Both are driven through the real UI
so a template/form regression breaks loudly.
"""
from __future__ import annotations


def _create_plan(server, title="Shared trip"):
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    body = json.dumps({"title": title}).encode()
    r = opener.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    return r.read()["plan"]["id"] if False else json.loads(r.read())["plan"]["id"]


def test_members_page_renders_for_owner(desktop, server):
    p = desktop
    pid = _create_plan(server)
    p.goto(server["base_url"] + f"/plans/{pid}/members")
    p.wait_for_selector("#members-root")
    assert "Shared with" in p.locator(".card-title").first.text_content()
    # Owner row shows "Transfer ownership" button.
    assert p.locator('button:has-text("Transfer ownership")').count() >= 1


def test_members_add_member(desktop, server):
    p = desktop
    pid = _create_plan(server)
    p.goto(server["base_url"] + f"/plans/{pid}/members")
    p.wait_for_selector("#members-root")
    # The "Add member" form has a member <select> and a role <select>.
    # Pick the first available member and submit.
    p.select_option('select[name=user_id]', index=1)
    p.click('button:has-text("Add to plan")')
    p.wait_for_timeout(800)
    # Reload and confirm the new member appears in the "Shared with" table.
    p.reload()
    p.wait_for_selector("table")
    table_text = p.locator("table").first.text_content()
    assert "alice" in table_text or "bob" in table_text


def test_members_change_role(desktop, server):
    p = desktop
    pid = _create_plan(server)
    # Add alice as editor via the API first.
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    r = opener.open(server["base_url"] + "/api/members")
    alice_id = next(m["id"] for m in json.loads(r.read())["members"]
                   if m["username"] == "alice")
    body = json.dumps({"user_id": alice_id, "role": "editor"}).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/members", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    # Load the members page and change alice's role to viewer via the UI.
    p.goto(server["base_url"] + f"/plans/{pid}/members")
    p.wait_for_selector("table")
    role_sel = p.locator("tbody select[name=role]").first
    role_sel.select_option("viewer")
    # Wait for the apiPatch to settle.
    p.wait_for_timeout(1000)
    # Verify server-side the role changed.
    r2 = opener.open(server["base_url"] + f"/api/plans/{pid}/members")
    members = json.loads(r2.read())["members"]
    alice_role = next(m["role"] for m in members if m["id"] == alice_id)
    assert alice_role == "viewer"


def test_members_remove_member(desktop, server):
    p = desktop
    pid = _create_plan(server)
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    r = opener.open(server["base_url"] + "/api/members")
    alice_id = next(m["id"] for m in json.loads(r.read())["members"]
                   if m["username"] == "alice")
    body = json.dumps({"user_id": alice_id, "role": "editor"}).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/members", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}/members")
    p.wait_for_selector("table")
    before_rows = p.locator("tbody tr").count()
    p.on("dialog", lambda d: d.accept())
    p.click('tbody button:has-text("Remove")')
    p.wait_for_timeout(800)
    p.reload()
    p.wait_for_selector("table")
    after_rows = p.locator("tbody tr").count()
    assert after_rows == before_rows - 1


# ------------------------------------------------------------------ settings
def test_settings_page_renders(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/auth/settings")
    assert "Your account" in p.locator(".card-title").first.text_content()
    # The display-name input is pre-filled with the current name.
    assert p.locator("#display_name").input_value() == "Admin"


def test_settings_change_display_name(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/auth/settings")
    original = p.locator("#display_name").input_value()
    p.fill("#display_name", "Admin Renamed")
    p.click('form[action="/auth/settings/profile"] button[type=submit]')
    p.wait_for_load_state("networkidle")
    # The page reloads with the new name in the input and the topbar.
    assert p.locator("#display_name").input_value() == "Admin Renamed"
    assert p.locator(".topbar .me").text_content() == "Admin Renamed"
    # Revert so the rest of the session's topbar assertions still match.
    p.fill("#display_name", original)
    p.click('form[action="/auth/settings/profile"] button[type=submit]')
    p.wait_for_load_state("networkidle")


def test_settings_change_password(desktop, server):
    # The admin's password is shared across the whole session (other tests
    # depend on it), so we change it and then change it back. This still
    # exercises the full POST path + the notice on success.
    p = desktop
    p.goto(server["base_url"] + "/auth/settings")
    old_pw = server["admin"]["password"]
    new_pw = "newtravelplan1"
    p.fill("#current_password", old_pw)
    p.fill("#new_password", new_pw)
    p.fill("#confirm_password", new_pw)
    p.click('form[action="/auth/settings/password"] button[type=submit]')
    p.wait_for_load_state("networkidle")
    assert p.locator(".notice").count() >= 1
    # Revert so the rest of the session's login still works.
    p.fill("#current_password", new_pw)
    p.fill("#new_password", old_pw)
    p.fill("#confirm_password", old_pw)
    p.click('form[action="/auth/settings/password"] button[type=submit]')
    p.wait_for_load_state("networkidle")


def test_settings_change_password_rejects_mismatch(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/auth/settings")
    p.fill("#current_password", server["admin"]["password"])
    p.fill("#new_password", "newtravelplan1")
    p.fill("#confirm_password", "DIFFERENT")
    p.click('form[action="/auth/settings/password"] button[type=submit]')
    p.wait_for_load_state("networkidle")
    # An error appears.
    assert p.locator(".error-msg").count() >= 1


def test_settings_change_password_rejects_wrong_current(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/auth/settings")
    p.fill("#current_password", "WRONGPASSWORD")
    p.fill("#new_password", "newtravelplan1")
    p.fill("#confirm_password", "newtravelplan1")
    p.click('form[action="/auth/settings/password"] button[type=submit]')
    p.wait_for_load_state("networkidle")
    assert p.locator(".error-msg").count() >= 1