"""Item API behavior: CRUD, drag-and-drop move, link attachments, image
upload rejection, and access control via plan sharing.
"""
from __future__ import annotations

import io
import json

import pytest


@pytest.fixture
def plan_id(member_client, make_plan):
    return make_plan(start_date="2026-07-01", end_date="2026-07-03")["id"]


# ------------------------------------------------------------------ create/list
class TestItemCreate:
    def test_create_item_happy_path(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "hotel", "title": "Hilton",
            "item_date": "2026-07-01", "end_date": "2026-07-02",
            "details": {"hotel_name": "Hilton", "address": "Tokyo",
                        "when": {"start_at": "2026-07-01T15:00",
                                 "end_at": "2026-07-02T11:00"}},
        })
        assert r.status_code == 200
        item = r.get_json()["item"]
        assert item["title"] == "Hilton"
        assert item["item_type"] == "hotel"
        assert item["status"] == "planned"
        assert item["details"]["hotel_name"] == "Hilton"
        assert item["details"]["when"]["start_at"] == "2026-07-01T15:00"
        assert item["details"]["when"]["end_at"] == "2026-07-02T11:00"

    def test_create_derives_item_date_from_when(self, member_client, plan_id):
        """The when object is the source of truth — item_date is computed from it."""
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "activity", "title": "Hike",
            "details": {"when": {"start_at": "2026-08-15T09:00",
                                  "end_at": "2026-08-15T12:00"}},
        })
        assert r.status_code == 200
        item = r.get_json()["item"]
        assert item["item_date"] == "2026-08-15"
        assert item["details"]["when"]["start_at"] == "2026-08-15T09:00"

    def test_create_accepts_when_with_only_start(self, member_client, plan_id):
        """When only start_at is given, the server defaults end_at to start+1h.

        Schedule items always have a duration; an end-less schedule
        item has no useful meaning (a bar with no length on the
        timeline). The default is enough to keep the UI sensible, and
        the user can adjust it in the editor.
        """
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "Reminder",
            "details": {"when": {"start_at": "2026-08-15T08:00"}, "text": "hi"},
        })
        assert r.status_code == 200
        item = r.get_json()["item"]
        assert item["details"]["when"]["start_at"] == "2026-08-15T08:00"
        assert item["details"]["when"]["end_at"] == "2026-08-15T09:00"

    def test_create_strips_when_when_empty(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "Plain",
            "details": {"when": {}, "text": "hi"},
        })
        item = r.get_json()["item"]
        assert "when" not in item["details"]

    def test_create_when_end_at_explicit_is_preserved(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "activity", "title": "Hike",
            "details": {"when": {"start_at": "2026-08-15T09:00",
                                  "end_at": "2026-08-15T13:00"}}},
        )
        assert r.status_code == 200
        item = r.get_json()["item"]
        assert item["details"]["when"]["end_at"] == "2026-08-15T13:00"

    def test_create_item_rejects_bad_type(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "unknown", "title": "X",
        })
        assert r.status_code == 400

    def test_create_item_rejects_missing_title(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "",
        })
        assert r.status_code == 400

    def test_create_item_all_types(self, member_client, plan_id):
        for t in ("hotel", "transit", "restaurant", "activity", "note"):
            r = member_client.post(f"/api/plans/{plan_id}/items", json={
                "item_type": t, "title": t.title(),
            })
            assert r.status_code == 200, f"{t}: {r.data}"
            assert r.get_json()["item"]["item_type"] == t

    def test_create_item_with_status(self, member_client, plan_id):
        r = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T", "status": "confirmed",
        })
        assert r.get_json()["item"]["status"] == "confirmed"

    def test_list_items_returns_all(self, member_client, plan_id):
        for i in range(3):
            member_client.post(f"/api/plans/{plan_id}/items", json={
                "item_type": "note", "title": f"item {i}"})
        r = member_client.get(f"/api/plans/{plan_id}/items")
        assert r.status_code == 200
        assert len(r.get_json()["items"]) == 3


# ------------------------------------------------------------------ patch/delete
class TestItemPatchDelete:
    def test_patch_title_and_details(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "Old"}).get_json()["item"]
        r = member_client.patch(f"/api/items/{item['id']}", json={
            "title": "New", "details": {"note": "updated"}})
        assert r.status_code == 200
        it = r.get_json()["item"]
        assert it["title"] == "New"
        assert it["details"]["note"] == "updated"

    def test_patch_status_validates(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.patch(f"/api/items/{item['id']}", json={"status": "done"})
        assert r.status_code == 200
        assert r.get_json()["item"]["status"] == "done"
        r = member_client.patch(f"/api/items/{item['id']}", json={"status": "garbage"})
        # Bad status is silently ignored (only valid statuses are written).
        assert r.status_code == 200

    def test_patch_dates(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T", "item_date": "2026-07-01"}).get_json()["item"]
        r = member_client.patch(f"/api/items/{item['id']}", json={
            "item_date": "2026-07-02", "end_date": "2026-07-03"})
        assert r.status_code == 200
        it = r.get_json()["item"]
        assert it["item_date"] == "2026-07-02"
        assert it["end_date"] == "2026-07-03"

    def test_patch_when_derives_date(self, member_client, plan_id):
        """Sending a new ``when`` should update item_date and end_date."""
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "activity", "title": "A",
            "details": {"when": {"start_at": "2026-07-01T09:00",
                                 "end_at": "2026-07-01T11:00"}},
        }).get_json()["item"]
        assert item["item_date"] == "2026-07-01"
        r = member_client.patch(f"/api/items/{item['id']}", json={
            "details": {"when": {"start_at": "2026-08-15T14:00",
                                 "end_at": "2026-08-15T16:00"}},
        })
        assert r.status_code == 200
        it = r.get_json()["item"]
        assert it["item_date"] == "2026-08-15"
        assert it["details"]["when"]["start_at"] == "2026-08-15T14:00"

    def test_patch_when_with_only_start(self, member_client, plan_id):
        """When PATCHing a when object, end_at defaults to start_at + 1h."""
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "N",
            "details": {"when": {"start_at": "2026-07-01T08:00"}},
        }).get_json()["item"]
        r = member_client.patch(f"/api/items/{item['id']}", json={
            "details": {"when": {"start_at": "2026-07-02T09:00"}, "text": "ok"},
        })
        assert r.status_code == 200
        it = r.get_json()["item"]
        assert it["details"]["when"]["start_at"] == "2026-07-02T09:00"
        assert it["details"]["when"]["end_at"] == "2026-07-02T10:00"

    def test_delete_item(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.delete(f"/api/items/{item['id']}")
        assert r.status_code == 200
        items = member_client.get(f"/api/plans/{plan_id}/items").get_json()["items"]
        assert all(i["id"] != item["id"] for i in items)

    def test_patch_missing_item_404(self, member_client):
        assert member_client.patch("/api/items/99999",
                                   json={"title": "x"}).status_code == 404

    def test_delete_missing_item_404(self, member_client):
        assert member_client.delete("/api/items/99999").status_code == 404


# ------------------------------------------------------------------ move (drag/drop)
class TestItemMove:
    def test_move_to_end_of_day(self, member_client, plan_id):
        a = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "A", "item_date": "2026-07-01"}).get_json()["item"]
        b = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "B", "item_date": "2026-07-01"}).get_json()["item"]
        # Move A to after B (no before_id) — should land after B.
        r = member_client.post(f"/api/items/{a['id']}/move", json={
            "item_date": "2026-07-01", "after_id": b["id"]})
        assert r.status_code == 200
        # Re-list and verify order.
        items = member_client.get(f"/api/plans/{plan_id}/items").get_json()["items"]
        ordered = [i for i in items if i["item_date"] == "2026-07-01"]
        assert [i["title"] for i in ordered] == ["B", "A"]

    def test_move_between_days(self, member_client, plan_id):
        a = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "A", "item_date": "2026-07-01"}).get_json()["item"]
        r = member_client.post(f"/api/items/{a['id']}/move", json={
            "item_date": "2026-07-02"})
        assert r.status_code == 200
        assert r.get_json()["item"]["item_date"] == "2026-07-02"

    def test_move_before_specific_item(self, member_client, plan_id):
        a = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "A", "item_date": "2026-07-01"}).get_json()["item"]
        b = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "B", "item_date": "2026-07-01"}).get_json()["item"]
        # Move A to before B (after_id=None, before_id=b).
        r = member_client.post(f"/api/items/{a['id']}/move", json={
            "item_date": "2026-07-01", "before_id": b["id"]})
        assert r.status_code == 200
        items = member_client.get(f"/api/plans/{plan_id}/items").get_json()["items"]
        ordered = [i for i in items if i["item_date"] == "2026-07-01"]
        assert [i["title"] for i in ordered] == ["A", "B"]


# ------------------------------------------------------------------ attachments
class TestAttachments:
    def test_add_link_attachment(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": "https://example.com/page",
            "caption": "info"})
        assert r.status_code == 200
        att = r.get_json()["attachment"]
        assert att["kind"] == "link"
        assert att["value"] == "https://example.com/page"
        assert att["caption"] == "info"

    def test_add_link_rejects_non_http(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": "ftp://x"})
        assert r.status_code == 400

    def test_add_attachment_rejects_missing_value(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": ""})
        assert r.status_code == 400

    def test_add_attachment_rejects_bad_kind(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "file", "value": "x"})
        assert r.status_code == 400

    def test_update_attachment(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        att = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": "https://a.com"}).get_json()["attachment"]
        r = member_client.patch(f"/api/attachments/{att['id']}", json={
            "value": "https://b.com", "caption": "new"})
        assert r.status_code == 200
        a = r.get_json()["attachment"]
        assert a["value"] == "https://b.com"
        assert a["caption"] == "new"

    def test_update_attachment_rejects_non_http(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        att = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": "https://a.com"}).get_json()["attachment"]
        r = member_client.patch(f"/api/attachments/{att['id']}", json={"value": "ftp://x"})
        assert r.status_code == 400

    def test_delete_attachment(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        att = member_client.post(f"/api/items/{item['id']}/attachments", json={
            "kind": "link", "value": "https://a.com"}).get_json()["attachment"]
        r = member_client.delete(f"/api/attachments/{att['id']}")
        assert r.status_code == 200
        # Fetching the item again confirms the attachment is gone.
        item2 = member_client.get(f"/api/plans/{plan_id}/items").get_json()["items"][0]
        assert all(a["id"] != att["id"] for a in item2["attachments"])


# ------------------------------------------------------------------ uploads
class TestUploads:
    PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8

    def _png(self, name="x.png"):
        return (io.BytesIO(self.PNG_HEADER), name)

    def test_upload_image_creates_attachment(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/upload",
                              data={"file": self._png()},
                              content_type="multipart/form-data")
        assert r.status_code == 200
        att = r.get_json()["attachment"]
        assert att["kind"] == "image"
        assert att["value"].endswith(".png")
        assert att["url"].startswith("/uploads/")
        # File is actually served.
        r2 = member_client.get(att["url"])
        assert r2.status_code == 200
        assert r2.data.startswith(self.PNG_HEADER)

    def test_upload_rejects_no_file(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/upload",
                              data={}, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_upload_rejects_bad_extension(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/upload",
                              data={"file": self._png("evil.txt")},
                              content_type="multipart/form-data")
        assert r.status_code == 400

    def test_upload_rejects_non_image_content(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        # Right extension, wrong magic bytes.
        r = member_client.post(f"/api/items/{item['id']}/upload",
                              data={"file": (io.BytesIO(b"not an image"), "fake.png")},
                              content_type="multipart/form-data")
        assert r.status_code == 400

    def test_upload_path_traversal_blocked(self, member_client, plan_id):
        item = member_client.post(f"/api/plans/{plan_id}/items", json={
            "item_type": "note", "title": "T"}).get_json()["item"]
        r = member_client.post(f"/api/items/{item['id']}/upload",
                              data={"file": self._png("../evil.png")},
                              content_type="multipart/form-data")
        # The extension survives; the stored filename is uuid-based, and
        # serving via /uploads/.. is blocked by secure_filename.
        assert r.status_code == 200
        # Path traversal in the GET is rejected.
        assert member_client.get("/uploads/..%2F..%2Fetc%2Fpasswd").status_code in (404, 400)


# ------------------------------------------------------------------ access control
class TestItemAccessControl:
    def test_viewer_cannot_create(self, app, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "viewer"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.post(f"/api/plans/{p['id']}/items", json={
            "item_type": "note", "title": "X"})
        assert r.status_code == 403

    def test_editor_can_create(self, app, member_client, make_plan, make_user):
        p = make_plan()
        bob_id = make_user(username="bob2")["id"]
        member_client.post(f"/api/plans/{p['id']}/members",
                           json={"user_id": bob_id, "role": "editor"})
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "bob2", "password": "pw12345"})
        r = c2.post(f"/api/plans/{p['id']}/items", json={
            "item_type": "note", "title": "X"})
        assert r.status_code == 200

    def test_non_member_cannot_list(self, app, member_client, make_plan, make_user):
        p = make_plan()
        member_client.post(f"/api/plans/{p['id']}/items", json={
            "item_type": "note", "title": "T"})
        make_user(username="carol2")
        c2 = app.test_client()
        c2.post("/auth/login", data={"username": "carol2", "password": "pw12345"})
        assert c2.get(f"/api/plans/{p['id']}/items").status_code == 403

    def test_anon_cannot_list(self, app, member_client, make_plan):
        p = make_plan()
        c = app.test_client()
        c.get("/auth/logout")
        assert c.get(f"/api/plans/{p['id']}/items").status_code == 401