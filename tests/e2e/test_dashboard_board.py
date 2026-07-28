"""Dashboard behavior: create / edit / delete trips, switch status tabs, and
the board page's add-item / edit / drag-reorder flow.

These tests drive the real frontend (no API shortcuts) so a change in the
JS that breaks the user-visible flow is caught here. Run on both desktop
(mouse + HTML5 drag) and iPhone (touch) where the interaction model differs.

Note: the dashboard's apiGet caches GET responses in IndexedDB, so a
post-mutation re-render can show the stale cached list. Tests that need to
verify a mutation's effect reload the page to bypass the cache (this is
the same F5 a user would hit). The mutation itself is still exercised
through the real UI.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar


def _api_client(server):
    """A urllib opener logged in as admin. Used to set up state faster than
    driving the UI for every test prerequisite."""
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    return opener


def _create_plan_api(server, **body):
    body.setdefault("title", "Trip")
    op = _api_client(server)
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def _clear_cache(p):
    """Clear the dashboard's IndexedDB GET cache so the next navigation
    fetches fresh data. The login fixture pre-loads /dashboard, which caches
    the (pre-test) plan list; tests that create plans via the API then
    navigate need this to see them."""
    p.evaluate("""async () => {
        await new Promise(resolve => {
            const req = indexedDB.deleteDatabase('travelplan-cache');
            req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
        });
    }""")
    p.wait_for_timeout(200)


# ------------------------------------------------------------------ dashboard
def test_dashboard_shows_empty_state(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector("#plans")
    assert p.locator(".empty-state").count() >= 1


def test_create_trip_via_form(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector("#new-trip-toggle")
    p.click("#new-trip-toggle")
    p.wait_for_selector('#new-trip-form:not(.hidden) [name=title]')
    p.fill('#new-trip-form [name=title]', "Japan 2026")
    p.fill('#new-trip-form [name=start_date]', "2026-09-10")
    p.fill('#new-trip-form [name=end_date]', "2026-09-15")
    p.click('#new-trip-form button[type=submit]')
    # The POST clears the GET cache, so the re-render fetches fresh data
    # and the new card appears.
    p.wait_for_selector(".plan-card", timeout=5000)
    titles = [t.text_content() for t in p.locator(".card-title").all()]
    assert "Japan 2026" in titles


def test_create_trip_requires_title(desktop, server):
    p = desktop
    p.goto(server["base_url"] + "/dashboard")
    p.click("#new-trip-toggle")
    before = p.locator(".plan-card").count()
    p.fill('#new-trip-form [name=start_date]', "2026-09-10")
    p.click('#new-trip-form button[type=submit]')
    p.wait_for_timeout(300)
    # HTML5 `required` blocks the submit; no card appears.
    assert p.locator(".plan-card").count() == before


def test_edit_trip_via_modal(desktop, server):
    p = desktop
    _create_plan_api(server, title="Old title")
    _clear_cache(p)
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector(".tab-bar")
    p.click('.tab-btn[data-tab=planning]')
    p.wait_for_selector(".plan-card")
    p.click('.plan-card button:has-text("Edit")')
    p.wait_for_selector('.plan-editor input[name=title]')
    p.fill('.plan-editor input[name=title]', "New title")
    p.click('.plan-editor button[type=submit]')
    # The PATCH clears the cache; the re-render shows the new title.
    p.wait_for_selector('.plan-card:has-text("New title")', timeout=5000)


def test_delete_trip_via_card_button(desktop, server):
    p = desktop
    pid = _create_plan_api(server, title="To delete")
    _clear_cache(p)
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector(".tab-bar")
    p.click('.tab-btn[data-tab=planning]')
    p.wait_for_selector(".plan-card")
    before = p.locator(".plan-card").count()
    assert before >= 1
    p.on("dialog", lambda d: d.accept())
    p.click('.plan-card button:has-text("Delete")')
    p.wait_for_timeout(1500)
    op = _api_client(server)
    req = urllib.request.Request(server["base_url"] + f"/api/plans/{pid}")
    try:
        op.open(req)
        deleted = False
    except urllib.error.HTTPError as e:
        deleted = e.code == 404
    assert deleted, "plan was not deleted server-side"
    p.reload()
    p.click('.tab-btn[data-tab=planning]')
    p.wait_for_selector("#plans")
    assert p.locator(".plan-card").count() < before


def test_status_tab_switch(desktop, server):
    p = desktop
    _create_plan_api(server, title="Planning trip")
    pid = _create_plan_api(server, title="Ongoing trip")
    # Move the second plan to ongoing via the API.
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}",
        data=json.dumps({"status": "ongoing"}).encode(),
        headers={"Content-Type": "application/json"}, method="PATCH"))
    _clear_cache(p)
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector(".tab-bar")
    p.click('.tab-btn[data-tab=planning]')
    p.wait_for_timeout(500)
    titles = [t.text_content() for t in p.locator(".plan-card .card-title").all()]
    assert "Planning trip" in titles
    assert "Ongoing trip" not in titles
    p.click('.tab-btn[data-tab=ongoing]')
    p.wait_for_timeout(500)
    titles = [t.text_content() for t in p.locator(".plan-card .card-title").all()]
    assert "Ongoing trip" in titles
    assert "Planning trip" not in titles


# ------------------------------------------------------------------ board
def test_board_renders_day_columns(desktop, server):
    p = desktop
    pid = _create_plan_api(server, title="Japan 2026",
                            start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".day")
    assert p.locator(".day").count() == 3


def test_board_add_item_via_add_bar(desktop, server):
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10",
                            end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".day")
    p.locator(".add-bar .add-summary").first.click()
    p.wait_for_selector(".add-menu .add-type")
    p.locator(".add-menu .add-type", has_text="Note").first.click()
    p.wait_for_selector(".item-editor .input")
    p.locator(".item-editor .input").first.fill("My note")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    p.click(".pb-save")
    p.wait_for_selector(".card.item", timeout=5000)
    assert "My note" in p.locator(".card.item .card-title").first.text_content()


def test_board_add_hotel_item_with_dates(desktop, server):
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".day")
    p.locator(".add-bar .add-summary").first.click()
    p.locator(".add-menu .add-type", has_text="Hotel").first.click()
    p.wait_for_selector(".item-editor .input")
    p.locator(".item-editor .input").first.fill("Hilton Tokyo")
    # After the when-unification refactor, the editor renders two
    # datetime-local inputs in the "When" block (Check-in / Check-out)
    # for hotels. The day is part of the datetime value.
    when_inputs = p.locator('.item-editor input[type=datetime-local]')
    when_inputs.nth(0).fill("2026-09-10T15:00")
    when_inputs.nth(1).fill("2026-09-12T11:00")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    p.click(".pb-save")
    p.wait_for_selector(".card.item.hotel", timeout=5000)
    assert "Hilton Tokyo" in p.locator(".card.item.hotel .card-title").first.text_content()


def test_board_edit_item_via_click(desktop, server):
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    # Create an item via the API so the editor opens against a real item.
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps({"item_type": "note", "title": "Original",
                        "item_date": "2026-09-10"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    # On desktop the editor opens on double-click (single-click selects).
    p.locator(".card.item").first.dblclick()
    p.wait_for_selector(".item-editor .input")
    p.locator(".item-editor .input").first.fill("Edited")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    p.click(".pb-save")
    p.wait_for_selector('.card.item:has-text("Edited")', timeout=5000)


def test_board_delete_item_via_context_menu(desktop, server):
    """Right-click an item, choose Delete from the context menu, then Save.
    This guards the context-menu + deleteSelection + staging flow that the
    board's right-click UI depends on (HTML5 contextmenu, not touch)."""
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps({"item_type": "note", "title": "Temp",
                        "item_date": "2026-09-10"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    before = p.locator(".card.item").count()
    # Right-click the card to open the context menu.
    p.locator(".card.item").first.click(button="right")
    p.wait_for_selector(".context-menu")
    # Click the "Delete" menu item.
    p.locator('.context-menu button:has-text("Delete")').click()
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    p.click(".pb-save")
    p.wait_for_timeout(1500)
    assert p.locator(".card.item").count() == before - 1


def test_board_context_menu_has_cut_copy_paste(desktop, server):
    """The right-click context menu shows Cut/Copy/Paste/Duplicate/Delete —
    the full set of selection actions the user expects. A regression that
    drops one of these (or breaks the menu rendering) is caught here."""
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps({"item_type": "note", "title": "X",
                        "item_date": "2026-09-10"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    # Select the card first (single click) so the menu actions are enabled.
    p.locator(".card.item").first.click()
    p.locator(".card.item").first.click(button="right")
    p.wait_for_selector(".context-menu")
    labels = [b.text_content() for b in p.locator(".context-menu button").all()]
    for expected in ("Cut", "Copy", "Paste", "Duplicate", "Delete"):
        assert expected in labels, f"missing menu item {expected}: {labels}"


def test_board_drag_item_between_days(desktop, server):
    """Drag a card from day 1 to day 2.

    Regression for a pre-existing bug where the drag handler referenced
    `batchSessionId` without importing it, throwing a ReferenceError
    that silently aborted the move. The earlier version of this test
    was too loose (the assertion `count() >= 1` passed even if the
    drag silently failed, because the card was still on its source
    day). Now we explicitly verify the card is on the target day AND
    no longer on the source day, AND that the edit bar's Save button
    became enabled (i.e. a real op was staged).

    Also pins the test data: the card starts on day 1 with a known
    date, so the assertion can compare against the source day, not
    just `count() >= 1`.
    """
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps({"item_type": "note", "title": "Movable",
                        "item_date": "2026-09-10"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    # Sanity: card is on day 1 (2026-09-10) before the drag.
    assert p.locator('.day-items[data-date="2026-09-10"] .card.item').count() == 1, \
        "sanity: card starts on day 1"
    card = p.locator(".card.item").first
    target_day = p.locator(".day-items").nth(1)
    target_date = target_day.evaluate("el => el.dataset.date")
    assert target_date == "2026-09-11", "sanity: target day is 2026-09-11"
    card.drag_to(target_day)
    p.wait_for_timeout(1500)
    # The card moved to day 2.
    assert p.locator(f'.day-items[data-date="{target_date}"] .card.item').count() == 1, \
        "after drag: card is on the target day"
    # And is no longer on day 1.
    assert p.locator('.day-items[data-date="2026-09-10"] .card.item').count() == 0, \
        "after drag: card is no longer on the source day"
    # A real MOVE_ITEM op was staged (the Save button is enabled).
    assert not p.locator(".pb-save").is_disabled(), \
        "after drag: Save is enabled (a real op was staged)"


def test_board_revert_pending_change(desktop, server):
    p = desktop
    pid = _create_plan_api(server, start_date="2026-09-10", end_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".day")
    p.locator(".add-bar .add-summary").first.click()
    p.locator(".add-menu .add-type", has_text="Note").first.click()
    p.wait_for_selector(".item-editor .input")
    p.locator(".item-editor .input").first.fill("Will revert")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    assert p.locator(".card.item").count() >= 1
    # "Cancel all" discards every pending op (the create + the title edit).
    # Two "Revert" clicks would also work; Cancel all is the user-facing
    # "throw it all away" button.
    p.click('button.pb-btn:has-text("Cancel all")')
    p.wait_for_timeout(500)
    # Accept the confirm() that Cancel all pops up.
    # (Cancel all calls confirm() — handle it via the dialog event.)
    assert p.locator(".card.item").count() == 0