"""Timeline: Cancel all in the pending bar rolls back every pending change.

Mirrors test_board_revert_pending_change for the board. Verifies the
"throw it all away" button on the timeline page also drops every
in-memory change (a freshly-created local item, in this case).

A prior bug: the Quick add dropdown's button click ran a `setFocusedDay`
callback that assigned to a `const` in timeline.js, throwing "Assignment
to constant variable" and silently aborting before the item was ever
staged. Fixed by `let focusedDate` (the bar's setFocusedDay callback
updates it on each Quick add).

A separate regression for "drag a bar then Cancel all" is covered at
the staging-engine level in timeline.test.mjs (the shim can't drive
the real pointer events needed to reproduce the bar's drag commit
end-to-end, but the underlying contract — viewItems() returns the
base when pointer=0 and the base wasn't mutated by the drag — is
fully tested there).
"""
import urllib.request, json, urllib.parse, http.cookiejar


def _api_client(server):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    return opener


def _create_plan_api(server, start_date, end_date):
    op = _api_client(server)
    body = json.dumps({
        "title": "Timeline cancel test",
        "start_date": start_date, "end_date": end_date,
        "base_currency": "USD",
    }).encode()
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def test_timeline_cancel_all_rolls_back(desktop, server):
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    # Add a note via the editor. Timeline's Quick add uses `qa-summary` /
    # `qa-item` (the board uses `add-bar` / `add-menu`).
    p.locator(".qa-summary").first.click()
    p.wait_for_selector(".qa-item", timeout=5000)
    p.locator(".qa-item", has_text="Note").first.click()
    p.wait_for_selector(".item-editor .input", timeout=10000)
    p.locator(".item-editor .input").first.fill("Will revert")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    # The timeline renders schedule items as `.tl-item` (not the board's
    # `.card.item`). The new local note is now visible as a tl-item.
    assert p.locator(".tl-item").count() >= 1, \
        "sanity: the new note shows up as a tl-item on the timeline"
    # Cancel all — every pending op rewinds, the new item disappears.
    p.click('button.pb-btn:has-text("Cancel all")')
    p.wait_for_timeout(500)
    assert p.locator(".tl-item").count() == 0, \
        "after Cancel all the timeline has no items"
