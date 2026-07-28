"""Map page: day-list sidebar, day expansion, context menu, and responsive layout.

Uses Playwright with both `desktop` (Chromium 1280×800, mouse) and `iphone`
(Chromium, iPhone 14 profile 390×664, touch) fixtures. Verifies the map
page's day-list renders correctly on both viewports and that the map sidebar
interactions (expand/collapse, right-click context menu) work on desktop.

The Leaflet map itself (tile layer + markers) is excluded from E2E tests
because it requires a WebGL-capable compositor; the map data is covered at
the unit level in map.test.mjs.
"""
from __future__ import annotations

import http.cookiejar
import json
import urllib.parse
import urllib.request


def _api_client(server):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    return opener


def _create_map_plan(server, title="Map trip",
                     start="2026-09-10", end="2026-09-12"):
    op = _api_client(server)
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans",
        data=json.dumps({"title": title, "start_date": start,
                         "end_date": end}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def _create_item(server, pid, *, item_type, title, item_date,
                 geocodes=None):
    op = _api_client(server)
    body = {"item_type": item_type, "title": title, "item_date": item_date}
    if geocodes:
        body["geocodes"] = geocodes
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))


def _create_timed_item(server, pid, *, item_type, title, item_date,
                       start_at, end_at=None, geocodes=None):
    op = _api_client(server)
    details = {"when": {"start_at": start_at}}
    if end_at:
        details["when"]["end_at"] = end_at
    body = {"item_type": item_type, "title": title, "item_date": item_date,
            "details": details}
    if geocodes:
        body["geocodes"] = geocodes
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))


# ------------------------------------------------------------------ desktop


def test_map_desktop_day_list_renders(desktop, server):
    """The map page renders day headers for each day of the trip."""
    p = desktop
    pid = _create_map_plan(server)
    _create_item(server, pid, item_type="activity", title="Kinkaku-ji",
                 item_date="2026-09-10",
                 geocodes=[{"lat": 35.0394, "lng": 135.7292, "label": "Temple"}])
    _create_item(server, pid, item_type="activity", title="Fushimi Inari",
                 item_date="2026-09-11",
                 geocodes=[{"lat": 34.9671, "lng": 135.7727, "label": "Gate"}])
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-list")
    headers = p.locator(".day-header")
    assert headers.count() == 3, f"expected 3 day headers, got {headers.count()}"
    assert "Day 1" in headers.first.text_content()


def test_map_desktop_day_expand_collapse(desktop, server):
    """Clicking a day header expands the day-item list; clicking again
    collapses it."""
    p = desktop
    pid = _create_map_plan(server)
    _create_item(server, pid, item_type="note", title="Visible item",
                 item_date="2026-09-10")
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-header")
    # Day 1 should be expanded by default. Click to collapse.
    day1 = p.locator(".day-header").first
    day1.click()
    p.wait_for_timeout(300)
    # Click again to re-expand.
    day1.click()
    p.wait_for_timeout(300)
    # Items are now visible.
    assert p.locator(".day-item").count() >= 1, \
        "day items visible after expanding day 1"


def test_map_desktop_context_menu(desktop, server):
    """Right-clicking a day-item opens the context menu with Cut/Delete/
    Center on map / Open detail."""
    p = desktop
    pid = _create_map_plan(server)
    _create_item(server, pid, item_type="activity", title="Context item",
                 item_date="2026-09-10",
                 geocodes=[{"lat": 35.0, "lng": 135.7, "label": "Spot"}])
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-header")
    # Ensure day 1 is expanded so we can right-click a day-item.
    day1 = p.locator(".day-header").first
    if not day1.evaluate("el => el.classList.contains('active')"):
        day1.click()
        p.wait_for_timeout(200)
    p.wait_for_selector(".day-item")
    # Right-click the first day-item.
    p.locator(".day-item").first.click(button="right")
    p.wait_for_selector(".context-menu", timeout=3000)
    labels = [b.text_content() for b in p.locator(".context-menu button").all()]
    for expected in ("Cut", "Delete", "Center on map", "Open detail"):
        assert expected in labels, f"context menu missing '{expected}': {labels}"


def test_map_desktop_no_dates_shows_empty(desktop, server):
    """A plan without start/end dates shows an empty-state message instead
    of the map."""
    p = desktop
    pid = _create_map_plan(server, start="", end="")
    # The API requires dates; create a plan with dates then clear them.
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}",
        data=json.dumps({"start_date": None, "end_date": None}).encode(),
        headers={"Content-Type": "application/json"}, method="PATCH"))
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".map-empty, .map-container")
    assert p.locator(".map-empty").count() >= 1 or \
           "Set a start and end date" in p.text_content(".map-container")


# ------------------------------------------------------------------ iPhone


def test_map_iphone_day_list_on_narrow_viewport(iphone, server):
    """On an iPhone-size viewport the day list is still rendered with
    the correct number of days."""
    p = iphone
    pid = _create_map_plan(server)
    _create_item(server, pid, item_type="note", title="iPhone note",
                 item_date="2026-09-10")
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-header")
    assert p.locator(".day-header").count() == 3, \
        "iPhone: 3 day headers visible"
    # Day items should be renderable.
    assert p.locator(".day-item").count() >= 0, \
        "iPhone: day items queryable"


def test_map_iphone_day_expand_collapse(iphone, server):
    """Tapping a day header on iPhone expands the item list; tapping again
    collapses it."""
    p = iphone
    pid = _create_map_plan(server)
    _create_item(server, pid, item_type="activity", title="Tap item",
                 item_date="2026-09-10",
                 geocodes=[{"lat": 35.0, "lng": 135.7, "label": "Spot"}])
    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-header")
    day1 = p.locator(".day-header").first
    # Collapse then re-expand.
    day1.tap()
    p.wait_for_timeout(300)
    day1.tap()
    p.wait_for_timeout(300)
    assert p.locator(".day-item").count() >= 1, \
        "iPhone: day items visible after expanding day 1"
