"""Navigation page: day bar, schedule rendering, day navigation, and touch swipe.

Uses Playwright with both `desktop` (Chromium 1280×800, mouse) and `iphone`
(Chromium, iPhone 14 profile 390×664, touch) fixtures. Verifies the
day-by-day itinerary view renders correctly on both viewports.
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


def _create_plan(server, title="Nav trip", start="2026-09-10", end="2026-09-12"):
    op = _api_client(server)
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans",
        data=json.dumps({"title": title, "start_date": start,
                         "end_date": end}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


def _create_item(server, pid, **body):
    op = _api_client(server)
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))


# ------------------------------------------------------------------ desktop


def test_nav_desktop_day_bar_renders(desktop, server):
    """The day bar shows a select with the correct day options and navigation
    buttons."""
    p = desktop
    pid = _create_plan(server)
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector("#nav-day-bar")
    opts = p.locator("#nav-day-bar option").all()
    assert len(opts) == 3, f"expected 3 day options, got {len(opts)}"
    # Day buttons are present.
    assert p.locator(".nav-day-arrow").count() == 2, \
        "prev/next arrow buttons present"
    assert p.locator(".nav-day-today").count() == 1, \
        "today button present"


def test_nav_desktop_schedule_shows_items(desktop, server):
    """The schedule renders items for the selected day."""
    p = desktop
    pid = _create_plan(server)
    _create_item(server, pid, item_type="activity", title="Morning walk",
                 item_date="2026-09-10",
                 details={"when": {"start_at": "2026-09-10T09:00",
                                   "end_at": "2026-09-10T10:30"}})
    _create_item(server, pid, item_type="note", title="Shopping list",
                 item_date="2026-09-11")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-card")
    cards = p.locator(".nav-card-title").all_text_contents()
    # Day 1 should be selected by default and show the activity.
    has_morning = any("Morning walk" in t for t in cards)
    assert has_morning, f"expected 'Morning walk' in day 1 cards: {cards}"


def test_nav_desktop_prev_next_day(desktop, server):
    """Clicking the prev/next buttons changes the selected day and updates
    the schedule."""
    p = desktop
    pid = _create_plan(server)
    _create_item(server, pid, item_type="note", title="Day 1 note",
                 item_date="2026-09-10")
    _create_item(server, pid, item_type="note", title="Day 2 note",
                 item_date="2026-09-11")
    _create_item(server, pid, item_type="note", title="Day 3 note",
                 item_date="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-card")
    # Click next twice to reach day 3.
    next_btn = p.locator(".nav-day-arrow").nth(1)
    next_btn.click()
    p.wait_for_timeout(300)
    next_btn.click()
    p.wait_for_timeout(300)
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("Day 3 note" in t for t in cards), \
        f"expected 'Day 3 note' after 2 next clicks: {cards}"
    # Click prev to go back to day 2.
    prev_btn = p.locator(".nav-day-arrow").first
    prev_btn.click()
    p.wait_for_timeout(300)
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("Day 2 note" in t for t in cards), \
        f"expected 'Day 2 note' after prev: {cards}"


def test_nav_desktop_hotel_banner(desktop, server):
    """A hotel item renders as a banner with check-in/out information."""
    p = desktop
    pid = _create_plan(server)
    _create_item(server, pid, item_type="hotel", title="Kyoto Hotel",
                 item_date="2026-09-10", end_date="2026-09-12",
                 details={"when": {"start_at": "2026-09-10T15:00",
                                   "end_at": "2026-09-12T11:00"}})
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-hotel-banner")
    banner = p.locator(".nav-hotel-banner").first
    assert "Kyoto Hotel" in banner.text_content(), \
        "hotel banner shows hotel name"
    assert "Check-in" in banner.text_content() or \
           "Check-out" in banner.text_content() or \
           "Overnight" in banner.text_content(), \
        "hotel banner shows stay info"


def test_nav_desktop_empty_day_message(desktop, server):
    """A day with no items shows an empty-state message."""
    p = desktop
    pid = _create_plan(server)
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector("#nav-content")
    assert "Nothing planned" in p.text_content("#nav-content"), \
        "empty day shows placeholder"


def test_nav_desktop_untimed_items_section(desktop, server):
    """Untimed items (notes) render in a 'Notes' section below timed items."""
    p = desktop
    pid = _create_plan(server)
    _create_item(server, pid, item_type="activity", title="Timed item",
                 item_date="2026-09-10",
                 details={"when": {"start_at": "2026-09-10T10:00",
                                   "end_at": "2026-09-10T11:00"}})
    _create_item(server, pid, item_type="note", title="An untimed note",
                 item_date="2026-09-10")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-section-divider")
    dividers = p.locator(".nav-section-divider").all_text_contents()
    assert any("Notes" in d for d in dividers), \
        f"expected 'Notes' section divider: {dividers}"
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("An untimed note" in t for t in cards), \
        "untimed note card visible"


# ------------------------------------------------------------------ iPhone


def test_nav_iphone_day_bar_narrow(iphone, server):
    """On an iPhone-size viewport the day bar still renders with correct
    options."""
    p = iphone
    pid = _create_plan(server)
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector("#nav-day-bar")
    opts = p.locator("#nav-day-bar option").all()
    assert len(opts) == 3, f"iPhone: expected 3 day options, got {len(opts)}"


def test_nav_iphone_schedule_renders(iphone, server):
    """The schedule renders items on a narrow viewport."""
    p = iphone
    pid = _create_plan(server)
    _create_item(server, pid, item_type="note", title="iPhone note",
                 item_date="2026-09-10")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-card")
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("iPhone note" in t for t in cards), \
        "iPhone: note card visible"


def test_nav_iphone_swipe_changes_day(iphone, server):
    """A horizontal swipe on the navigation page changes the selected day."""
    p = iphone
    pid = _create_plan(server)
    _create_item(server, pid, item_type="note", title="Swipe day 1",
                 item_date="2026-09-10")
    _create_item(server, pid, item_type="note", title="Swipe day 2",
                 item_date="2026-09-11")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-card")
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("Swipe day 1" in t for t in cards), \
        "iPhone: starts on day 1"
    # Swipe left on #nav-page to go to next day.
    nav_page = p.locator("#nav-page")
    box = nav_page.bounding_box()
    assert box is not None, "nav-page has bounding box"
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    p.mouse.move(cx, cy)
    p.mouse.down()
    p.mouse.move(cx - 150, cy, steps=10)
    p.mouse.up()
    p.wait_for_timeout(500)
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("Swipe day 2" in t for t in cards), \
        f"iPhone: after swipe left, day 2 item visible: {cards}"
    # Swipe right to go back to day 1.
    p.mouse.move(cx, cy)
    p.mouse.down()
    p.mouse.move(cx + 150, cy, steps=10)
    p.mouse.up()
    p.wait_for_timeout(500)
    cards = p.locator(".nav-card-title").all_text_contents()
    assert any("Swipe day 1" in t for t in cards), \
        f"iPhone: after swipe right, day 1 item visible: {cards}"
