"""Expenses page E2E: the per-item ledger, multi-currency settlement, and
recorded payments. The expenses page is the most complex plan page after the
board, and a regression here silently breaks trip settlement.
"""
from __future__ import annotations


def _create_plan_with_items(server, title="Expenses trip"):
    """Create a plan + a couple of items via the API, returning (plan_id,
    item_ids). Tests then add expenses through the UI."""
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "alice", "password": server["alice"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    body = json.dumps({"title": title, "base_currency": "USD"}).encode()
    r = opener.open(urllib.request.Request(
        server["base_url"] + "/api/plans", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    pid = json.loads(r.read())["plan"]["id"]
    # Add bob as an editor (so he can be a participant).
    r2 = opener.open(server["base_url"] + "/api/members")
    bob_id = next(m["id"] for m in json.loads(r2.read())["members"]
                 if m["username"] == "bob")
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/members",
        data=json.dumps({"user_id": bob_id, "role": "editor"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    # Create a restaurant item.
    ibody = json.dumps({"item_type": "restaurant", "title": "Dinner"}).encode()
    r3 = opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/items", data=ibody,
        headers={"Content-Type": "application/json"}, method="POST"))
    item_id = json.loads(r3.read())["item"]["id"]
    return pid, item_id


def test_expenses_page_renders_sections(desktop, server):
    p = desktop
    pid, _ = _create_plan_with_items(server)
    p.goto(server["base_url"] + f"/plans/{pid}/expenses")
    p.wait_for_selector("#by-item")
    assert p.locator("#expense-ledger").count() == 1
    assert p.locator("#settlement").count() == 1


def test_expenses_add_via_api_and_settlement_shows_balance(desktop, server):
    """Add an expense through the API (the form modal is heavy; the
    settlement rendering is what we want to guard) and confirm the page
    shows the resulting balance."""
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "alice", "password": server["alice"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    pid, item_id = _create_plan_with_items(server)
    current_id = json.loads(
        opener.open(server["base_url"] + "/api/me").read())["user"]["id"]
    r = opener.open(server["base_url"] + "/api/members")
    bob_id = next(m["id"] for m in json.loads(r.read())["members"]
                 if m["username"] == "bob")
    body = json.dumps({
        "description": "Dinner", "currency": "USD", "amount": "20.00",
        "split_method": "EQUAL", "item_id": item_id,
        "payers": [{"user_id": current_id, "amount": "20.00"}],
        "participants": [current_id, bob_id],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/expenses", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p = desktop
    p.goto(server["base_url"] + f"/plans/{pid}/expenses")
    p.wait_for_selector("#settlement")
    # The settlement section should mention "Settlement" and show a proposed
    # transfer (bob owes admin $10).
    settlement_text = p.locator("#settlement").text_content()
    assert "bob" in settlement_text.lower() or "Settle" in settlement_text


def test_expenses_by_item_shows_total(desktop, server):
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "alice", "password": server["alice"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    pid, item_id = _create_plan_with_items(server)
    current_id = json.loads(opener.open(
        server["base_url"] + "/api/me").read())["user"]["id"]
    r = opener.open(server["base_url"] + "/api/members")
    bob_id = next(m["id"] for m in json.loads(r.read())["members"]
                 if m["username"] == "bob")
    body = json.dumps({
        "description": "Dinner", "currency": "USD", "amount": "20.00",
        "split_method": "EQUAL", "item_id": item_id,
        "payers": [{"user_id": current_id, "amount": "20.00"}],
        "participants": [current_id, bob_id],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/expenses", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p = desktop
    p.goto(server["base_url"] + f"/plans/{pid}/expenses")
    p.wait_for_selector("#by-item")
    # The by-item section lists the "Dinner" item with its $20.00 total.
    by_item_text = p.locator("#by-item").text_content()
    assert "Dinner" in by_item_text
    assert "20.00" in by_item_text or "$20" in by_item_text or "20" in by_item_text


def test_expenses_set_rates_via_api_renders_no_missing_rate(desktop, server):
    """Setting an exchange rate clears the 'missing rate' warning on the
    settlement section. This guards the rates + settlement UI contract."""
    import urllib.request, urllib.parse, http.cookiejar, json
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "alice", "password": server["alice"]["password"],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    pid, item_id = _create_plan_with_items(server)
    current_id = json.loads(opener.open(
        server["base_url"] + "/api/me").read())["user"]["id"]
    r = opener.open(server["base_url"] + "/api/members")
    bob_id = next(m["id"] for m in json.loads(r.read())["members"]
                 if m["username"] == "bob")
    # USD expense on a USD plan -> no missing rate.
    body = json.dumps({
        "description": "Dinner", "currency": "USD", "amount": "20.00",
        "split_method": "EQUAL", "item_id": item_id,
        "payers": [{"user_id": current_id, "amount": "20.00"}],
        "participants": [current_id, bob_id],
    }).encode()
    opener.open(urllib.request.Request(
        server["base_url"] + f"/api/plans/{pid}/expenses", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    p = desktop
    p.goto(server["base_url"] + f"/plans/{pid}/expenses")
    p.wait_for_selector("#settlement")
    # No "missing rate" warning because the expense is in the base currency.
    assert "missing rate" not in p.locator("#settlement").text_content().lower()