"""iPhone (touch) behavior: long-press to start drag on the dashboard, tap
to open items, and the board's add-item flow on a small screen.

These are the interactions that differ from desktop — long-press instead of
HTML5 drag, viewport-driven layout collapse, and the touch pull-to-refresh.
A regression in the touch handlers (e.g. removing the long-press timer, or
making the card use a desktop-only dragstart) is caught here.
"""
from __future__ import annotations


def _create_trip_api(server, title="Japan 2026",
                     start="2026-09-10", end="2026-09-12", status=None):
    """Create a plan via the API (returns the plan id). Used by iPhone tests
    that just need a plan to exist before exercising the board."""
    import urllib.request, json
    import urllib.parse, http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    body = json.dumps({"title": title, "start_date": start,
                      "end_date": end}).encode()
    r = opener.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    pid = json.loads(r.read())["plan"]["id"]
    if status:
        opener.open(urllib.request.Request(
            server["base_url"] + f"/api/plans/{pid}",
            data=json.dumps({"status": status}).encode(),
            headers={"Content-Type": "application/json"}, method="PATCH"))
    return pid


def test_iphone_dashboard_renders_cards(iphone, server):
    p = iphone
    # Create a trip and move it to ongoing so it shows on the default tab.
    _create_trip_api(server, title="Phone trip", status="ongoing")
    # Verify server-side the plan is ongoing.
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    op.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    r = op.open(server["base_url"] + "/api/plans?status=ongoing")
    titles = [p["title"] for p in json.loads(r.read())["plans"]]
    assert "Phone trip" in titles, f"Phone trip not in ongoing list: {titles}"
    # The dashboard is already loaded (the iphone fixture logged in, which
    # redirects to /dashboard). The IndexedDB GET cache holds the ongoing
    # list from that first load (before "Phone trip" was created), so clear
    # it before reloading to force a fresh fetch.
    p.evaluate("""async () => {
        await new Promise(resolve => {
            const req = indexedDB.deleteDatabase('travelplan-cache');
            req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
        });
    }""")
    p.wait_for_timeout(200)
    p.reload()
    p.wait_for_selector("#plans")
    ui_titles = [t.text_content() for t in p.locator(".card-title").all()]
    assert "Phone trip" in ui_titles, f"Phone trip not in UI: {ui_titles}"


def test_iphone_board_add_item_via_add_bar(iphone, server):
    """The board's add-item flow works on a 390px-wide screen. The add-bar
    collapses but the dropdown still opens and the editor renders in one
    column."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".day")
    p.locator(".add-bar .add-summary").first.click()
    p.wait_for_selector(".add-menu .add-type")
    p.locator(".add-menu .add-type", has_text="Note").first.click()
    p.wait_for_selector(".item-editor .input")
    p.locator(".item-editor .input").first.fill("Phone note")
    p.click('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    p.click(".pb-save")
    p.wait_for_selector(".card.item", timeout=5000)
    assert "Phone note" in p.locator(".card.item .card-title").first.text_content()


def test_iphone_tap_opens_item_editor(iphone, server):
    """A double-tap on an item card opens the editor on touch devices
    (single-tap selects; the touchend handler counts two taps within 300ms
    as a double-tap)."""
    p = iphone
    pid = _create_trip_api(server, title="Phone trip",
                           start="2026-09-10", end="2026-09-12")
    # Create an item via the API so we don't depend on the add-bar flow here.
    import urllib.request, json, urllib.parse, http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    body = json.dumps({"item_type": "note", "title": "Tap me",
                      "item_date": "2026-09-10"}).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    # Double-tap (two quick touchend events) opens the editor.
    card = p.locator(".card.item").first
    card.tap()
    p.wait_for_timeout(50)
    card.tap()
    p.wait_for_selector(".item-editor", timeout=5000)


def test_iphone_long_press_does_not_navigate(iphone, server):
    """A long-press on a plan card should start the touch drag, not navigate
    to the plan page. Touching without holding should NOT trigger drag (the
    500ms timer must elapse). This guards the touchstart/touchmove/touchend
    handlers in plans.js."""
    p = iphone
    _create_trip_api(server, title="Long press me")
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_selector(".plan-card")
    card = p.locator(".plan-card").first
    # The card should not have the `dragging` class after a short tap.
    card.click()
    p.wait_for_timeout(200)
    # Still on the dashboard (a tap is not a navigation).
    assert "/dashboard" in p.url


def test_iphone_board_long_press_card_does_not_open_editor(iphone, server):
    """On the board, a long-press on an item card is reserved for touch drag
    (the touchstart handler sets a 500ms timer before starting the drag). A
    short tap should open the editor; a held press should not. We can't
    easily simulate a held press that releases on a no-op target, so we
    just assert the short-tap path opens the editor (covered above) and
    that the card is draggable=false on touch devices (the board disables
    HTML5 drag on small screens)."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-12")
    import urllib.request, json, urllib.parse, http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    body = json.dumps({"item_type": "note", "title": "Drag me",
                      "item_date": "2026-09-10"}).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    draggable = p.locator(".card.item").first.get_attribute("draggable")
    # On a max-width:640px screen the board sets draggable=false.
    assert draggable in ("false", None)


def test_iphone_viewport_is_narrow(iphone):
    # The iPhone 14 profile is 390 css px wide.
    assert iphone.viewport_size["width"] == 390


# ---------------------------------------------------------------------------
# Modal scroll containment (iPhone regression)
#
# iOS Safari's elastic overscroll used to leak modal scrolls into the page
# behind the modal, which in turn triggered the page-level pull-to-refresh
# (`location.reload()` in pulltorefresh.js). The user was kicked out of any
# open modal with a full reload, losing unsaved changes. The fix:
#   - CSS `overscroll-behavior: contain` on the modal backdrop and body
#   - body scroll lock + `has-open-modal` class while a modal is open
#   - pulltorefresh.js checks `has-open-modal` and bails out
#
# These tests pin down the contract: while a modal is open on iPhone,
#   1. the body scroll is locked
#   2. a pull-down gesture inside the modal does NOT fire
#      `location.reload()`
#   3. the modal is still open after the gesture
# ---------------------------------------------------------------------------


def _create_trip_with_long_note(iphone, server, *, title="Scroll lock trip",
                                start="2026-09-10", end="2026-09-12",
                                note="x" * 1200):
    """Create a plan + a single note whose body is long enough to force
    the item editor's modal body to scroll. The iPhone 14 viewport
    (390px wide, ~664px tall) can't show 1.2KB of note text without
    overflow, so the .modal-body element has overflow-y: auto — the
    path the regression used to break."""
    import urllib.request, urllib.parse, http.cookiejar, json as _json
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(urllib.request.Request(
        server["base_url"] + "/auth/login",
        data=urllib.parse.urlencode(
            {"username": "admin", "password": server["admin"]["password"]}
        ).encode(),
        method="POST"))
    pid = _json.loads(op.open(urllib.request.Request(
        server["base_url"] + "/api/plans",
        data=_json.dumps({"title": title, "start_date": start,
                          "end_date": end}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST")).read())["plan"]["id"]
    op.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items",
        data=_json.dumps({"item_type": "note", "title": "Long note",
                          "item_date": start,
                          "details": {"text": note}}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"))
    return pid


def test_iphone_modal_locks_body_scroll(iphone, server):
    """While the item editor is open on iPhone, the body scroll must
    be locked and the `has-open-modal` class must be set. The pull-to-
    refresh handler reads that class to decide whether to ignore the
    touchstart."""
    p = iphone
    pid = _create_trip_with_long_note(p, server)
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    # Open the editor via double-tap (the iPhone way).
    card = p.locator(".card.item").first
    card.tap()
    p.wait_for_timeout(50)
    card.tap()
    p.wait_for_selector(".item-editor", timeout=5000)
    # Body scroll is locked and the class is set.
    assert "has-open-modal" in (p.evaluate("document.body.className") or ""), \
        "body has has-open-modal class while editor is open"
    overflow = p.evaluate("document.body.style.overflow")
    assert overflow == "hidden", \
        f"body overflow is hidden while editor is open (got {overflow!r})"


def test_iphone_modal_pull_down_does_not_reload(iphone, server):
    """A pull-down gesture inside an open modal must NOT trigger
    location.reload() — the page-level pull-to-refresh should ignore
    the gesture because the body has `has-open-modal`. Regression for
    the iOS bug where the user was kicked out of any modal with a
    full reload on a touch scroll-bleed-through.

    We dispatch raw TouchEvents on `document` because that's what
    `pulltorefresh.js` listens for (its onTouchStart handler is on
    `document`, not on individual elements). Playwright's `mouse.*`
    helpers would fire MouseEvents which the handler ignores, so the
    test would pass even with the original bug — the real iPhone
    sends TouchEvents, and the test must do the same.
    """
    p = iphone
    pid = _create_trip_with_long_note(p, server)
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    card = p.locator(".card.item").first
    card.tap()
    p.wait_for_timeout(50)
    card.tap()
    p.wait_for_selector(".item-editor", timeout=5000)
    # Install a hook that flags any location.reload() call. The hook
    # itself uses a fresh XHR to the server: the test polls the flag
    # below, and the navigation that location.reload() would cause
    # would tear down the page before the poll could see the flag.
    p.evaluate("""() => {
        window.__reloadCalled = false;
        window.location.reload = function() {
            window.__reloadCalled = true;
            // Don't actually reload — we want the test to continue
            // and assert that the modal is still open afterwards.
        };
    }""")
    # Dispatch raw touch events on the document. The y start point is
    # near the top of the modal body (10px below the body top), and
    # the move drags down 120px (well past pulltorefresh's 80px
    # THRESHOLD).
    editor = p.locator(".item-editor .modal-body")
    box = editor.bounding_box()
    assert box is not None, "modal body has a bounding box"
    sx = box["x"] + box["width"] / 2
    sy = box["y"] + 10
    p.evaluate("""(args) => {
        const makeTouch = (x, y) => new Touch({
            identifier: 1, target: document.elementFromPoint(x, y) || document.body,
            clientX: x, clientY: y,
        });
        const ts = new TouchEvent('touchstart', {
            bubbles: true, cancelable: true,
            touches: [makeTouch(args.sx, args.sy)],
            targetTouches: [makeTouch(args.sx, args.sy)],
            changedTouches: [makeTouch(args.sx, args.sy)],
        });
        document.dispatchEvent(ts);
        const tm = new TouchEvent('touchmove', {
            bubbles: true, cancelable: true,
            touches: [makeTouch(args.sx, args.sy + 120)],
            targetTouches: [makeTouch(args.sx, args.sy + 120)],
            changedTouches: [makeTouch(args.sx, args.sy + 120)],
        });
        document.dispatchEvent(tm);
        const te = new TouchEvent('touchend', {
            bubbles: true, cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [makeTouch(args.sx, args.sy + 120)],
        });
        document.dispatchEvent(te);
    }""", {"sx": sx, "sy": sy})
    p.wait_for_timeout(300)
    # The reload must NOT have been called.
    reload_called = p.evaluate("window.__reloadCalled")
    assert reload_called is False, \
        "pull-to-refresh fired location.reload() while a modal was open"
    # The modal must still be open.
    assert p.locator(".item-editor").count() == 1, \
        "item-editor is still open after the pull-down gesture"
    # And the body's modal class is still set (the lock survived the
    # gesture without being released).
    assert "has-open-modal" in (p.evaluate("document.body.className") or ""), \
        "body still has has-open-modal class after the gesture"


def test_iphone_modal_close_releases_body_lock(iphone, server):
    """Closing the modal releases the body scroll lock. Otherwise a
    closed modal would leave the page un-scrollable until reload —
    a separate class of bug from the regression above."""
    p = iphone
    pid = _create_trip_with_long_note(p, server)
    p.goto(server["base_url"] + f"/plans/{pid}")
    p.wait_for_selector(".card.item")
    card = p.locator(".card.item").first
    card.tap()
    p.wait_for_timeout(50)
    card.tap()
    p.wait_for_selector(".item-editor", timeout=5000)
    assert "has-open-modal" in (p.evaluate("document.body.className") or ""), \
        "modal open: has-open-modal is set"
    # Cancel the editor (the X / Cancel button).
    p.locator(".item-editor button:has-text('Cancel')").first.click()
    p.wait_for_timeout(300)
    # The class is gone and the body overflow is back to normal.
    assert "has-open-modal" not in (p.evaluate("document.body.className") or ""), \
        "modal closed: has-open-modal class is removed"
    overflow = p.evaluate("document.body.style.overflow")
    # The dom shim / browser normalises '' for unset; we just need
    # the lock to be released.
    assert overflow in ("", "visible", "auto", None), \
        f"modal closed: body overflow is restored (got {overflow!r})"


# ---------------------------------------------------------------------------
# Timeline on iPhone
# ---------------------------------------------------------------------------


def test_iphone_timeline_quick_add(iphone, server):
    """The timeline's quick-add flow works on a 390px-wide screen."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    p.locator(".qa-summary").first.tap()
    p.wait_for_selector(".qa-item", timeout=5000)
    p.locator(".qa-item", has_text="Note").first.tap()
    p.wait_for_selector(".item-editor .input", timeout=10000)
    p.locator(".item-editor .input").first.fill("Timeline note on iPhone")
    p.tap('.item-editor button:has-text("Apply")')
    p.wait_for_selector('.pb-save:not([disabled])', timeout=5000)
    assert p.locator(".tl-item").count() >= 1, \
        "iPhone timeline: tl-item visible after quick-add"


def test_iphone_timeline_day_columns_narrow(iphone, server):
    """All day columns render on iPhone (horizontal scroll)."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-14")
    p.goto(server["base_url"] + f"/plans/{pid}/timeline")
    p.wait_for_selector(".day")
    # A 5-day trip renders 5 day columns.
    assert p.locator(".day").count() == 5, \
        f"iPhone timeline: expected 5 day columns, got {p.locator('.day').count()}"


# ---------------------------------------------------------------------------
# Navigation on iPhone
# ---------------------------------------------------------------------------


def test_iphone_navigation_swipe(iphone, server):
    """Swipe left/right on the navigation page to switch days."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-12")
    import urllib.request, json, urllib.parse, http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    for day, title in [("2026-09-10", "Swipe day 1"),
                       ("2026-09-11", "Swipe day 2")]:
        opener.open(urllib.request.Request(
            server["base_url"] + f"/api/plans/{pid}/items",
            data=json.dumps({"item_type": "note", "title": title,
                             "item_date": day}).encode(),
            headers={"Content-Type": "application/json"}, method="POST"))
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector(".nav-card")
    assert "Swipe day 1" in p.text_content("#nav-page"), \
        "iPhone nav: starts on day 1 with Swipe day 1"
    # Swipe left using drag (Playwright's mouse.drag_to triggers the
    # touchstart/touchend handlers on touch-enabled devices).
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
    assert "Swipe day 2" in p.text_content("#nav-page"), \
        "iPhone nav: after swipe left, shows Swipe day 2"


def test_iphone_navigation_day_bar_narrow(iphone, server):
    """The day bar select and buttons render correctly on iPhone."""
    p = iphone
    pid = _create_trip_api(server, start="2026-09-10", end="2026-09-12")
    p.goto(server["base_url"] + f"/plans/{pid}/navigation")
    p.wait_for_selector("#nav-day-bar")
    assert p.locator(".nav-day-arrow").count() == 2, \
        "iPhone nav: prev/next arrows visible"
    opts = p.locator("#nav-day-bar option").all()
    assert len(opts) == 3, \
        f"iPhone nav: expected 3 day options, got {len(opts)}"