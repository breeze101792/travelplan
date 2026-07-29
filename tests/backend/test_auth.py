"""Auth behavior: first-run setup, login/logout, self-serve settings, and
admin member management. Covers the user-visible flows — the things a
regression in `backend/auth.py` or `backend/blueprints/auth.py` would
silently break.
"""
from __future__ import annotations


# ---------------------------------------------------------------- setup
class TestSetup:
    def test_first_visit_redirects_to_setup(self, fresh_app):
        c = fresh_app.test_client()
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/setup" in r.headers["Location"]

    def test_setup_page_renders_when_no_admin(self, fresh_app):
        r = fresh_app.test_client().get("/auth/setup")
        assert r.status_code == 200
        assert b"Create admin account" in r.data

    def test_setup_creates_admin_then_redirects_to_login(self, fresh_app):
        c = fresh_app.test_client()
        r = c.post("/auth/setup", data={
            "username": "root", "password": "rootpw1234",
            "display_name": "Root",
        }, follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/login" in r.headers["Location"]
        # The admin now exists; a second setup attempt bounces to login.
        r = c.get("/auth/setup", follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/login" in r.headers["Location"]

    def test_setup_rejects_short_password(self, fresh_app):
        c = fresh_app.test_client()
        r = c.post("/auth/setup", data={
            "username": "root", "password": "short", "display_name": "Root",
        })
        assert r.status_code == 200
        assert b"at least 8" in r.data
        # No admin was created.
        r = c.get("/", follow_redirects=False)
        assert "/auth/setup" in r.headers["Location"]

    def test_setup_rejects_duplicate_username(self, app):
        # An admin already exists in the `app` fixture; hitting setup on a
        # fresh app where we manually create the same name should 200 with an
        # error. We use fresh_app to bypass the redirect-to-login guard.
        c = app.test_client()
        # Admin exists -> setup redirects; we cannot test duplicate via setup
        # without bypassing the guard. Test the underlying IntegrityError
        # path via the members page instead (covered in TestMembers).
        assert c.get("/auth/setup", follow_redirects=False).status_code == 302


# ---------------------------------------------------------------- login
class TestLogin:
    def test_login_page_renders(self, client):
        r = client.get("/auth/login")
        assert r.status_code == 200
        assert b"Sign in" in r.data

    def test_login_redirects_to_dashboard_on_success(self, client, login):
        r = login("alice")
        assert r.status_code == 302
        assert r.headers["Location"].endswith("/dashboard")

    def test_login_already_logged_in_redirects_to_dashboard(self, client, login):
        login("alice")
        r = client.get("/auth/login", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["Location"].endswith("/dashboard")

    def test_login_rejects_wrong_password(self, client):
        r = client.post("/auth/login", data={
            "username": "alice", "password": "WRONG",
        })
        assert r.status_code == 200
        assert b"Invalid username or password" in r.data

    def test_login_rejects_unknown_user(self, client):
        r = client.post("/auth/login", data={
            "username": "nobody", "password": "pw12345",
        })
        assert r.status_code == 200
        assert b"Invalid username or password" in r.data

    def test_login_redirects_to_next_when_safe(self, client):
        r = client.post(
            "/auth/login?next=/auth/settings",
            data={"username": "alice", "password": "pw12345"},
            follow_redirects=False,
        )
        assert r.status_code == 302
        assert "/auth/settings" in r.headers["Location"]

    def test_login_ignores_unsafe_next(self, client):
        r = client.post(
            "/auth/login?next=//evil.com/x",
            data={"username": "alice", "password": "pw12345"},
            follow_redirects=False,
        )
        assert r.status_code == 302
        assert r.headers["Location"].endswith("/dashboard")


# ---------------------------------------------------------------- logout
class TestLogout:
    def test_logout_clears_session_and_redirects_to_login(self, client, login):
        login("alice")
        r = client.get("/auth/logout", follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/login" in r.headers["Location"]
        # After logout, the dashboard is protected.
        r = client.get("/dashboard", follow_redirects=False)
        assert r.status_code == 302
        assert "/auth/login" in r.headers["Location"]


# ---------------------------------------------------------------- api/me
class TestApiMe:
    def test_anonymous_401(self, fresh_app):
        r = fresh_app.test_client().get("/api/me")
        assert r.status_code == 401
        assert r.get_json()["user"] is None

    def test_authenticated_returns_current_user(self, client, login):
        login("alice")
        r = client.get("/api/me")
        assert r.status_code == 200
        u = r.get_json()["user"]
        assert u["username"] == "alice"
        assert u["role"] == "member"


# ---------------------------------------------------------------- settings
class TestSettings:
    def test_anon_redirected_to_login(self, client):
        r = client.get("/auth/settings")
        assert r.status_code == 302
        assert "/auth/login" in r.headers["Location"]

    def test_settings_page_renders_for_member(self, client, login):
        login("alice")
        r = client.get("/auth/settings")
        assert r.status_code == 200
        assert b"Your account" in r.data
        # Member management UI is on the members page, not here.
        assert b"Create member" not in r.data

    def test_settings_page_for_admin_links_members_page(self, client, login):
        login("admin")
        r = client.get("/auth/settings")
        assert r.status_code == 200
        assert b"/auth/members" in r.data

    def test_change_display_name_updates_session_and_db(self, client, login, db):
        login("alice")
        r = client.post("/auth/settings/profile",
                        data={"display_name": "Alice (renamed)"},
                        follow_redirects=False)
        assert r.status_code == 302
        # The page reflects the new name and so does the topbar.
        r = client.get("/auth/settings")
        assert b"Alice (renamed)" in r.data
        assert b'Alice (renamed)' in r.data
        assert b'user-dropdown-trigger' in r.data
        row = db.one("SELECT display_name FROM users WHERE username='alice'")
        assert row["display_name"] == "Alice (renamed)"

    def test_change_display_name_rejects_blank(self, client, login):
        login("alice")
        r = client.post("/auth/settings/profile",
                        data={"display_name": "  "},
                        follow_redirects=False)
        assert r.status_code == 302
        assert "error=" in r.headers["Location"]

    def test_change_password_happy_path(self, client, login):
        login("alice")
        r = client.post("/auth/settings/password", data={
            "current_password": "pw12345",
            "new_password": "newsecret1",
            "confirm_password": "newsecret1",
        }, follow_redirects=False)
        assert r.status_code == 302
        client.get("/auth/logout")
        # Old password rejected, new accepted.
        assert client.post("/auth/login", data={
            "username": "alice", "password": "pw12345"}).status_code == 200
        assert client.post("/auth/login", data={
            "username": "alice", "password": "newsecret1"},
            follow_redirects=False).status_code == 302

    def test_change_password_rejects_wrong_current(self, client, login):
        login("alice")
        r = client.post("/auth/settings/password", data={
            "current_password": "WRONG",
            "new_password": "newsecret1",
            "confirm_password": "newsecret1",
        }, follow_redirects=False)
        assert r.status_code == 302
        assert "error=" in r.headers["Location"]
        # Old password still works.
        client.get("/auth/logout")
        assert client.post("/auth/login", data={
            "username": "alice", "password": "pw12345"},
            follow_redirects=False).status_code == 302

    def test_change_password_rejects_short_new(self, client, login):
        login("alice")
        r = client.post("/auth/settings/password", data={
            "current_password": "pw12345",
            "new_password": "short",
            "confirm_password": "short",
        }, follow_redirects=False)
        assert r.status_code == 302
        assert "error=" in r.headers["Location"]

    def test_change_password_rejects_mismatched_confirm(self, client, login):
        login("alice")
        r = client.post("/auth/settings/password", data={
            "current_password": "pw12345",
            "new_password": "newsecret1",
            "confirm_password": "DIFFERENT",
        }, follow_redirects=False)
        assert r.status_code == 302
        assert "error=" in r.headers["Location"]


# ---------------------------------------------------------------- members (admin)
class TestMembers:
    def test_members_page_admin_only(self, client, login):
        # Member -> 403.
        login("alice")
        assert client.get("/auth/members").status_code == 403
        # Admin -> 200.
        client.get("/auth/logout")
        login("admin")
        r = client.get("/auth/members")
        assert r.status_code == 200
        assert b"Existing accounts" in r.data or b"Create member" in r.data

    def test_admin_creates_member_via_members_page(self, client, login):
        login("admin")
        r = client.post("/auth/members", data={
            "username": "carol", "password": "carolpw1234",
            "display_name": "Carol",
        }, follow_redirects=False)
        assert r.status_code == 302
        # New member can log in.
        client.get("/auth/logout")
        assert client.post("/auth/login", data={
            "username": "carol", "password": "carolpw1234"},
            follow_redirects=False).status_code == 302

    def test_admin_create_member_rejects_short_password(self, client, login):
        login("admin")
        r = client.post("/auth/members", data={
            "username": "dave", "password": "short", "display_name": "Dave",
        })
        assert r.status_code == 200
        assert b"at least 8" in r.data

    def test_admin_create_member_rejects_duplicate(self, client, login):
        login("admin")
        r = client.post("/auth/members", data={
            "username": "alice", "password": "alicepw1234",
            "display_name": "Alice 2",
        })
        assert r.status_code == 200
        assert b"taken" in r.data

    def test_admin_deletes_member(self, client, login, db):
        login("admin")
        carol_id = db.one("SELECT id FROM users WHERE username='bob'")["id"]
        r = client.post("/auth/members", data={
            "action": "delete", "member_id": str(carol_id),
        }, follow_redirects=False)
        assert r.status_code == 302
        assert db.one("SELECT 1 FROM users WHERE id=?", (carol_id,)) is None

    def test_admin_edit_member_password(self, client, login, db):
        login("admin")
        alice_id = db.one("SELECT id FROM users WHERE username='alice'")["id"]
        r = client.post("/auth/members/edit", data={
            "user_id": str(alice_id),
            "display_name": "Alice (admin reset)",
            "new_password": "aliceadminpw1",
        }, follow_redirects=False)
        assert r.status_code == 302
        client.get("/auth/logout")
        # New password works, old doesn't.
        assert client.post("/auth/login", data={
            "username": "alice", "password": "aliceadminpw1"},
            follow_redirects=False).status_code == 302
        client.get("/auth/logout")
        assert client.post("/auth/login", data={
            "username": "alice", "password": "pw12345"}).status_code == 200

    def test_admin_edit_blank_fields_is_noop(self, client, login, db):
        login("admin")
        alice_id = db.one("SELECT id FROM users WHERE username='alice'")["id"]
        r = client.post("/auth/members/edit", data={
            "user_id": str(alice_id), "display_name": "", "new_password": "",
        }, follow_redirects=False)
        assert r.status_code == 302
        # Password unchanged.
        client.get("/auth/logout")
        assert client.post("/auth/login", data={
            "username": "alice", "password": "pw12345"},
            follow_redirects=False).status_code == 302

    def test_admin_edit_rejects_short_password(self, client, login, db):
        login("admin")
        alice_id = db.one("SELECT id FROM users WHERE username='alice'")["id"]
        r = client.post("/auth/members/edit", data={
            "user_id": str(alice_id), "display_name": "x", "new_password": "short",
        }, follow_redirects=False)
        assert r.status_code == 302
        assert "error=" in r.headers["Location"]

    def test_member_cannot_edit(self, client, login, db):
        login("alice")
        admin_id = db.one("SELECT id FROM users WHERE username='admin'")["id"]
        r = client.post("/auth/members/edit", data={
            "user_id": str(admin_id), "display_name": "hacker",
            "new_password": "hackerpw1",
        })
        assert r.status_code == 403

    def test_api_members_lists_only_member_accounts(self, client, login):
        login("admin")
        r = client.get("/api/members")
        assert r.status_code == 200
        names = [m["username"] for m in r.get_json()["members"]]
        assert "alice" in names and "bob" in names
        assert "admin" not in names