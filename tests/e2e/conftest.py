"""Shared Playwright fixtures for TravelPlan E2E tests.

Each test session runs against a single throwaway Flask app on a random port
(temp data dir, seeded with an admin + a couple of member accounts). Two
browser contexts are exposed:

  - ``desktop``  -> Chromium 1280x800, mouse + keyboard (no touch)
  - ``iphone``   -> Playwright's "iPhone 14" device profile (390x664, touch)

Both fixtures auto-log in to a fresh page so each test starts already
authenticated as the seeded admin unless the test opts out via
``@pytest.mark.setup`` (the first-run setup flow is tested unauthenticated).

The Flask app runs in a background subprocess (not the test process) so the
test client's requests go through the real WSGI server, exercise the service
worker, the staged JS modules, and the actual HTTP boundary — the same code
path a browser hits in production.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest


# Resolve the chromium binary once. On NixOS Playwright's bundled node won't
# run, so we point the Python client at a system chromium via $CHROMIUM or
# the well-known nix store path. Outside NixOS, set CHROMIUM=/path/to/chrome
# or leave it unset to use Playwright's bundled chromium.
def _chromium_path() -> str | None:
    p = os.environ.get("CHROMIUM")
    if p:
        return p
    for cand in (
        "/nix/store/wjs8nzn73dd8kqkg1sl06071syl2hxxh-chromium-150.0.7871.186/bin/chromium",
    ):
        if Path(cand).exists():
            return cand
    return None


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_for(url: str, timeout: float = 30.0) -> None:
    import urllib.request
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception as e:
            last = e
            time.sleep(0.3)
    raise RuntimeError(f"server did not come up at {url}: {last}")


@pytest.fixture(scope="session")
def server():
    """Start the Flask app on a free port with a temp data dir, seed users,
    and yield (base_url, admin_credentials). Tears down on session end."""
    from playwright.sync_api import sync_playwright  # noqa: F401  (ensures pw importable)
    project_root = Path(__file__).resolve().parent.parent.parent
    tmp = Path(tempfile.mkdtemp(prefix="tp_e2e_"))
    data_dir = tmp / "data"
    uploads = data_dir / "uploads"
    config_dir = data_dir / "config"
    for d in (data_dir, uploads, config_dir):
        d.mkdir(parents=True, exist_ok=True)

    # Use the project's Python (the venv running pytest) to start the app.
    python = sys.executable
    port = _free_port()
    env = os.environ.copy()
    env["DATA_DIR_OVERRIDE"] = str(data_dir)  # not used by app, but informational
    # The app reads backend.db.DATA_DIR (module global). Patch it via a tiny
    # sitecustomize trick: run a wrapper that sets the data dir before import.
    wrapper = tmp / "run_server.py"
    wrapper.write_text(f"""
import sys, os
from pathlib import Path
sys.path.insert(0, {str(project_root)!r})
from backend import db as db_mod
from backend import auth as auth_mod
db_mod.DATA_DIR = Path({str(data_dir)!r})
db_mod.DB_PATH = Path({str(data_dir / 'travelplan.db')!r})
auth_mod.SECRET_KEY_FILE = Path({str(config_dir / 'secret_key')!r})
from backend.app import app
app.run(host='127.0.0.1', port={port}, debug=False, use_reloader=False, threaded=True)
""")
    proc = subprocess.Popen(
        [python, str(wrapper)],
        cwd=str(project_root),
        env=env,
        stdout=open("/tmp/travelplan-e2e-server.log", "wb"),
        stderr=subprocess.STDOUT,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        try:
            _wait_for(base_url + "/auth/login")
        except Exception:
            # Surface the server's stdout to help diagnose startup failures.
            import select
            out = b""
            while select.select([proc.stdout], [], [], 0)[0]:
                out += proc.stdout.read1(8192)
            raise RuntimeError(
                f"server did not come up at {base_url}. stdout:\n"
                + out.decode(errors="replace"))
        # Seed admin via the /auth/setup form (one-shot, no admin exists yet).
        import urllib.request, urllib.parse
        data = urllib.parse.urlencode({
            "username": "admin", "password": "travelplan1",
            "display_name": "Admin",
        }).encode()
        urllib.request.urlopen(
            urllib.request.Request(base_url + "/auth/setup", data=data,
                                   method="POST"))
        # Create members via direct DB insert (avoid going through the members
        # page form for speed). We use a tiny script in the same process.
        seed_script = tmp / "seed.py"
        seed_script.write_text(f"""
import sys; sys.path.insert(0, {str(project_root)!r})
import sqlite3
from backend.auth import hash_password
conn = sqlite3.connect({str(data_dir / 'travelplan.db')!r})
for u, role in [('alice', 'member'), ('bob', 'member')]:
    conn.execute(
        "INSERT INTO users (username, password_hash, display_name, role) "
        "VALUES (?, ?, ?, ?)",
        (u, hash_password('travelplan1'), u.title(), role))
conn.commit()
conn.close()
""")
        subprocess.run([python, str(seed_script)], check=True,
                       env=env, capture_output=True)

        yield {
            "base_url": base_url,
            "admin": {"username": "admin", "password": "travelplan1"},
            "alice": {"username": "alice", "password": "travelplan1"},
            "bob": {"username": "bob", "password": "travelplan1"},
            "tmp": tmp,
        }
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def desktop(server):
    """A desktop Chromium browser context (1280x800, no touch), logged in
    as admin. Yields a fresh page per test."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        launch_kwargs = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        cpath = _chromium_path()
        if cpath:
            launch_kwargs["executable_path"] = cpath
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        # Log in as admin before yielding.
        _login(page, server["base_url"], "admin", server["admin"]["password"])
        try:
            yield page
        finally:
            ctx.close()
            browser.close()


@pytest.fixture
def iphone(server):
    """An iPhone 14 Chromium context (390x664, touch), logged in as admin."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        launch_kwargs = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        cpath = _chromium_path()
        if cpath:
            launch_kwargs["executable_path"] = cpath
        browser = p.chromium.launch(**launch_kwargs)
        iphone_cfg = p.devices["iPhone 14"]
        ctx = browser.new_context(**iphone_cfg)
        page = ctx.new_page()
        _login(page, server["base_url"], "admin", server["admin"]["password"])
        try:
            yield page
        finally:
            ctx.close()
            browser.close()


@pytest.fixture
def fresh_page(server):
    """A desktop page that's NOT logged in (for testing setup/login flows)."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        launch_kwargs = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        cpath = _chromium_path()
        if cpath:
            launch_kwargs["executable_path"] = cpath
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        try:
            yield page
        finally:
            ctx.close()
            browser.close()


def _login(page, base_url, username, password):
    # The Flask dev server can briefly stall (it's single-threaded; a slow
    # request holds the DB lock). Retry the login navigation a few times
    # before giving up, so a transiently-slow server doesn't fail the test.
    import time
    last_err = None
    for attempt in range(3):
        try:
            page.goto(base_url + "/auth/login", timeout=15000)
            page.wait_for_selector("#username", timeout=10000)
            page.fill("#username", username)
            page.fill("#password", password)
            page.click('button[type=submit]')
            page.wait_for_load_state("networkidle")
            if "/dashboard" in page.url:
                return
            try:
                err = page.locator(".error-msg").text_content(timeout=1000)
            except Exception:
                err = "<no error-msg>"
            raise AssertionError(
                f"login as {username!r} did not reach /dashboard "
                f"(url={page.url}, error={err!r})")
        except Exception as e:
            last_err = e
            time.sleep(1)
    raise AssertionError(f"login failed after 3 attempts: {last_err}")