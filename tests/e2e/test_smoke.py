"""Smoke test: confirm the server fixture boots and login works."""
from __future__ import annotations


def test_server_boots(server):
    assert server["base_url"].startswith("http://127.0.0.1:")


def test_desktop_login_lands_on_dashboard(desktop, server):
    desktop.goto(server["base_url"] + "/dashboard")
    assert "Your trips" in desktop.locator("h1").text_content()
    # Topbar shows the logged-in user's display name.
    me_text = desktop.locator(".topbar .me").text_content()
    assert me_text and "alice" in me_text.lower()


def test_iphone_context_is_touch(iphone):
    # navigator.maxTouchPoints > 0 on iPhone 14 profile.
    is_touch = iphone.evaluate("navigator.maxTouchPoints > 0")
    assert is_touch is True
    # Viewport width is the iPhone 14 width (390 css px).
    assert iphone.viewport_size["width"] == 390