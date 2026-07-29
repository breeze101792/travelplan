"""Edit bar visibility across SPA navigation.

The edit bar should only be visible on editing pages (board, timeline, map)
and hidden on read-only pages (overview, navigation, expenses, members).
Verifies that navigating between these pages via SPA (clicking nav links)
correctly toggles the edit bar visibility — particularly the reported bug
where navigating from map to members and back left the edit bar stuck visible.
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


def _create_plan(server, title="Edit bar test", start="2026-09-10", end="2026-09-12"):
    op = _api_client(server)
    r = op.open(urllib.request.Request(
        server["base_url"] + "/api/plans",
        data=json.dumps({"title": title, "start_date": start,
                         "end_date": end}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    return json.loads(r.read())["plan"]["id"]


# ------------------------------------------------------------------ desktop


def test_edit_bar_visible_on_edit_pages(desktop, server):
    p = desktop
    pid = _create_plan(server)
    for name in ("board", "timeline", "map"):
        url = server["base_url"] + f"/plans/{pid}"
        if name != "board":
            url += f"/{name}"
        p.goto(url)
        p.wait_for_selector("#edit-bar")
        assert not p.locator("#edit-bar").is_hidden(), \
            f"edit bar should be visible on {name}"


def test_edit_bar_hidden_on_non_edit_pages(desktop, server):
    p = desktop
    pid = _create_plan(server)
    for name in ("overview", "navigation", "expenses", "members"):
        p.goto(server["base_url"] + f"/plans/{pid}/{name}")
        p.wait_for_selector("#edit-bar")
        assert p.locator("#edit-bar").is_hidden(), \
            f"edit bar should be hidden on {name}"


def test_edit_bar_hides_on_spa_nav_from_map_to_members(desktop, server):
    """The reported bug: map → members → map should toggle edit bar."""
    p = desktop
    pid = _create_plan(server)

    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-list")
    assert not p.locator("#edit-bar").is_hidden(), \
        "edit bar visible on map"

    p.click('a.pn-link:has-text("Members")')
    p.wait_for_selector("#members-root")
    assert p.locator("#edit-bar").is_hidden(), \
        "edit bar hidden on members"

    p.click('a.pn-link:has-text("Map")')
    p.wait_for_selector(".day-list")
    assert not p.locator("#edit-bar").is_hidden(), \
        "edit bar visible again on map"


def test_edit_bar_hides_on_spa_nav_from_map_to_all_non_edit(desktop, server):
    """SPA nav from map to each non-edit page hides the edit bar."""
    p = desktop
    pid = _create_plan(server)

    p.goto(server["base_url"] + f"/plans/{pid}/map")
    p.wait_for_selector(".day-list")
    assert not p.locator("#edit-bar").is_hidden()

    NAV_LABELS = {"overview": "Overview", "navigation": "Navigate",
                  "expenses": "Expenses", "members": "Members"}
    WAIT_FOR = {"overview": ".overview-page", "navigation": "#nav-day-bar",
                "expenses": "#expense-ledger", "members": "#members-root"}

    for page, label in NAV_LABELS.items():
        p.click(f'a.pn-link:has-text("{label}")')
        p.wait_for_selector(WAIT_FOR[page])
        assert p.locator("#edit-bar").is_hidden(), \
            f"edit bar hidden on {page}"

        p.click('a.pn-link:has-text("Map")')
        p.wait_for_selector(".day-list")
        assert not p.locator("#edit-bar").is_hidden(), \
            f"edit bar visible back on map after {page}"
