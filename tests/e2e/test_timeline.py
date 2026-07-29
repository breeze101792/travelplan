"""Timeline: day columns, item bars, quick-add, Cancel all, and responsive layout.

Covers the timeline page on both desktop (1280×800, mouse) and iPhone
(390×664, touch) viewports. Verifies the 24-hour schedule renders correctly,
items appear as timeline bars, quick-add works, and Cancel all rolls back
pending changes. Touch interactions (tap to edit) are tested on iPhone.
"""
import urllib.request, json, urllib.parse, http.cookiejar


def _api_client(server):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "alice", "password": server["alice"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    return opener


def _create_plan_api(server, title="Timeline test",
                     start_date="2026-09-10", end_date="2026-09-12"):
    op = _api_client(server)
    body = json.dumps({
        "title": title,
        "start_date": start_date, "end_date": end_date,
        "base_currency": "USD",
    }).encode()
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def _create_item(server, pid, **body):
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))


# ------------------------------------------------------------------ desktop


def test_timeline_desktop_day_columns_render(desktop, server):
    """The timeline renders a column for each day of the plan."""
    p = desktop
    pid = _create_plan_api(server)
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    assert p.locator(".day").count() == 3, \
        "3 day columns rendered for 3-day trip"


def test_timeline_desktop_item_bar_visible(desktop, server):
    """A timed item appears as a .tl-item bar in the correct day column."""
    p = desktop
    pid = _create_plan_api(server)
    _create_item(server, pid, item_type="activity", title="Morning hike",
                 item_date="2026-09-10",
                 details={"when": {"start_at": "2026-09-10T09:00",
                                   "end_at": "2026-09-10T11:00"}})
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".tl-item")
    titles = p.locator(".tl-item .tl-item-label").all_text_contents()
    assert any("Morning hike" in t for t in titles), \
        f"timeline shows 'Morning hike': {titles}"


def test_timeline_desktop_quick_add_and_cancel_all(desktop, server):
    """Quick-add a note via the editor, verify it shows as a tl-item, then
    Cancel all — the item disappears."""
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    p.locator(".qa-summary").first.click()
    p.wait_for_selector(".qa-item", timeout=5000)
    p.locator(".qa-item", has_text="Note").first.click()
    p.wait_for_selector(".item-editor .input", timeout=10000)
    p.locator(".item-editor .input").first.fill("Will revert")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    assert p.locator(".tl-item").count() >= 1, \
        "sanity: the new note shows up as a tl-item on the timeline"
    p.click('button.pb-btn:has-text("Cancel all")')
    p.wait_for_timeout(500)
    assert p.locator(".tl-item").count() == 0, \
        "after Cancel all the timeline has no items"


def test_timeline_desktop_edit_bar_visible(desktop, server):
    """The edit bar (pending-changes bar) is visible for the owner."""
    p = desktop
    pid = _create_plan_api(server)
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector("#edit-bar")
    bar = p.locator("#edit-bar")
    assert not bar.is_hidden(), "edit bar is visible for owner"


def test_timeline_desktop_untimed_items_as_chips(desktop, server):
    """Untimed items (notes) render as chips below the 24-hour grid."""
    p = desktop
    pid = _create_plan_api(server)
    _create_item(server, pid, item_type="note", title="Chip note",
                 item_date="2026-09-10")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".tl-untimed")
    chip_titles = p.locator(".tl-untimed .tl-item-label").all_text_contents()
    assert any("Chip note" in t for t in chip_titles), \
        f"untimed chip shows 'Chip note': {chip_titles}"


# ------------------------------------------------------------------ iPhone


def test_timeline_iphone_narrow_columns(iphone, server):
    """On an iPhone-size viewport the timeline renders day columns (possibly
    scrollable) with the correct count."""
    p = iphone
    pid = _create_plan_api(server)
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    assert p.locator(".day").count() == 3, \
        "iPhone: 3 day columns rendered"


def test_timeline_iphone_quick_add_on_touch(iphone, server):
    """Quick-add a note via the editor on iPhone (tap-based interaction)."""
    p = iphone
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    p.locator(".qa-summary").first.tap()
    p.wait_for_selector(".qa-item", timeout=5000)
    p.locator(".qa-item", has_text="Note").first.tap()
    p.wait_for_selector(".item-editor .input", timeout=10000)
    p.locator(".item-editor .input").first.fill("iPhone note")
    p.tap('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    assert p.locator(".tl-item").count() >= 1, \
        "iPhone: tl-item visible after quick-add"
