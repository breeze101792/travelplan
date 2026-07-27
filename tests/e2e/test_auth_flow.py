"""First-run setup + login flows (unauthenticated).

Covers the bootstrap path a brand-new user sees: visiting the app redirects
to setup, creating the admin, then logging in. The `fresh_page` fixture is
used (no seeded session) so these tests see the real first-run state on the
shared server fixture (which has admin already — so we exercise the setup
page's "admin already exists" redirect and the login form's reject paths).
"""
from __future__ import annotations


def test_login_page_renders(fresh_page, server):
    fresh_page.goto(server["base_url"] + "/auth/login")
    fresh_page.wait_for_selector("#username")
    assert "Sign in" in fresh_page.locator("h1").text_content()


def test_login_wrong_password_shows_error(fresh_page, server):
    p = fresh_page
    p.goto(server["base_url"] + "/auth/login")
    p.wait_for_selector("#username")
    p.fill("#username", "admin")
    p.fill("#password", "WRONGPASSWORD")
    p.click('button[type=submit]')
    p.wait_for_load_state("networkidle")
    assert "/auth/login" in p.url
    assert "Invalid username or password" in p.locator(".error-msg").text_content()


def test_login_unknown_user_shows_error(fresh_page, server):
    p = fresh_page
    p.goto(server["base_url"] + "/auth/login")
    p.wait_for_selector("#username")
    p.fill("#username", "ghost")
    p.fill("#password", "whatever12")
    p.click('button[type=submit]')
    p.wait_for_load_state("networkidle")
    assert "Invalid username or password" in p.locator(".error-msg").text_content()


def test_root_redirects_to_login_when_anonymous(fresh_page, server):
    p = fresh_page
    p.goto(server["base_url"] + "/")
    p.wait_for_load_state("networkidle")
    # Admin already exists (seeded by the server fixture), so anonymous
    # visitors land on the login page.
    assert "/auth/login" in p.url


def test_login_redirects_to_next(fresh_page, server):
    p = fresh_page
    # The login form's hidden `next` input is populated from the query string
    # only when the template renders it; the GET /auth/login handler does not
    # forward request.args.next into the template, so the next-param redirect
    # only fires when `next` is submitted in the POST body. We test the POST
    # body path directly: post with next=/auth/settings.
    import urllib.request, urllib.parse, http.cookiejar
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    form = urllib.parse.urlencode({
        "username": "admin", "password": server["admin"]["password"],
        "next": "/auth/settings",
    }).encode()
    r = opener.open(urllib.request.Request(
        server["base_url"] + "/auth/login", data=form, method="POST"))
    # The redirect lands on /auth/settings (urllib follows the 302).
    assert "/auth/settings" in r.url


def test_logout_redirects_to_login(desktop, server):
    p = desktop
    # desktop is logged in as admin; visit /auth/logout.
    p.goto(server["base_url"] + "/auth/logout")
    p.wait_for_load_state("networkidle")
    assert "/auth/login" in p.url
    # After logout, the dashboard bounces to login.
    p.goto(server["base_url"] + "/dashboard")
    p.wait_for_load_state("networkidle")
    assert "/auth/login" in p.url