"""Seed the database with fake data for testing.

Run:  python -m backend.seed

If an admin already exists, it only resets all user passwords to "traveler"
without touching any existing data. Otherwise it inserts the full fake
dataset (admin + three members, trips, items, expenses, etc.). Printed
credentials let you log in and click around.
"""
from __future__ import annotations

import json
import sqlite3
import struct
import sys
import zlib
from pathlib import Path

from .app import create_app
from . import db as db_mod
from .auth import hash_password
from . import expense as ex

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
UPLOADS = DATA / "uploads"
DB_PATH = DATA / "travelplan.db"


# ---------------------------------------------------------------- tiny PNG
def make_png(path: Path, rgb: tuple[int, int, int], w: int = 160, h: int = 100) -> None:
    def chunk(typ: bytes, data: bytes) -> bytes:
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


# ---------------------------------------------------------------- seed
def seed() -> None:
    app = create_app()
    with app.app_context():
        db = db_mod.get_db()

        def user(username, display, role="member"):
            db.execute(
                "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)",
                (username, hash_password("traveler"), display, role),
            )
            db.commit()
            return db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()[0]

        admin = user("admin", "Admin", "admin")
        alice = user("alice", "Alice Wang")
        bob = user("bob", "Bob Garcia")
        carol = user("carol", "Carol Singh")
        members = {"admin": admin, "alice": alice, "bob": bob, "carol": carol}

        # image attachments
        img = {}
        for name, color in (("hotel", (99, 102, 241)),
                            ("flight", (14, 165, 233)),
                            ("lagoon", (45, 212, 191)),
                            ("ramen", (244, 114, 182))):
            fn = f"seed-{name}.png"
            make_png(UPLOADS / fn, color)
            img[name] = fn

        def add_image(item_id, key, caption=""):
            db.execute(
                "INSERT INTO attachments (item_id, kind, value, caption) VALUES (?, 'image', ?, ?)",
                (item_id, img[key], caption),
            )

        def add_link(item_id, url, caption=""):
            db.execute(
                "INSERT INTO attachments (item_id, kind, value, caption) VALUES (?, 'link', ?, ?)",
                (item_id, url, caption),
            )

        def item(plan_id, itype, title, date, end=None, status="planned", details=None):
            max_key = db.execute(
                "SELECT COALESCE(MAX(sort_key), 0) FROM items WHERE plan_id = ? AND item_date IS ?",
                (plan_id, date),
            ).fetchone()[0]
            cur = db.execute(
                """INSERT INTO items (plan_id, item_type, title, item_date, end_date, sort_key, status, details, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (plan_id, itype, title, date, end, max_key + 1.0, status,
                 json.dumps(details or {}), admin),
            )
            db.commit()
            return cur.lastrowid

        def share(plan_id, uid, role="editor"):
            db.execute("INSERT OR IGNORE INTO plan_members (plan_id, user_id, role) VALUES (?, ?, ?)",
                       (plan_id, uid, role))
            db.commit()

        def rate(plan_id, currency, r):
            db.execute(
                """INSERT INTO plan_rates (plan_id, currency, rate, updated_at)
                   VALUES (?, ?, ?, datetime('now'))
                   ON CONFLICT(plan_id, currency) DO UPDATE SET rate=excluded.rate, updated_at=datetime('now')""",
                (plan_id, currency, r))
            db.commit()

        def payment(plan_id, frm, to, cents, currency, note=""):
            db.execute(
                "INSERT INTO payments (plan_id, from_user_id, to_user_id, amount_cents, currency, note) VALUES (?, ?, ?, ?, ?, ?)",
                (plan_id, frm, to, cents, currency, note))
            db.commit()

        # =========================================================== Plan 1: Japan 2026 (JPY)
        p1 = db.execute(
            """INSERT INTO plans (title, description, owner_id, start_date, end_date, base_currency)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Japan 2026", "Tokyo + Kyoto with friends. Cherry-blossom season is over but the food isn't.",
             admin, "2026-07-01", "2026-07-07", "JPY"),
        ).lastrowid
        db.commit()
        share(p1, alice, "editor")
        share(p1, bob, "editor")

        h1 = item(p1, "hotel", "Shinjuku Granvia Hotel", "2026-07-01", end="2026-07-05", status="confirmed",
                  details={"hotel_name": "Shinjuku Granvia", "address": "3-1 Nishishinjuku, Tokyo",
                           "check_in_time": "15:00", "check_out_time": "11:00",
                           "booking_ref": "BK-88210", "price": "72000", "currency": "JPY",
                           "link": "https://example.com/granvia", "note": "4 nights, breakfast included"})
        add_image(h1, "hotel", "hotel lobby")
        add_link(h1, "https://example.com/granvia", "booking")

        f1 = item(p1, "transit", "JL 005 LAX -> NRT", "2026-07-01", status="confirmed",
                  details={"mode": "Flight", "provider": "JAL", "ref_no": "JL005", "from": "LAX", "to": "NRT",
                           "depart_time": "2026-07-01T11:30", "arrive_time": "2026-07-02T15:45",
                           "confirmation": "JAL-7H9XQ", "price": "820", "currency": "USD",
                           "link": "https://example.com/jal005"})
        add_image(f1, "flight", "boarding pass")

        t1 = item(p1, "transit", "Airport limo bus to Shinjuku", "2026-07-02",
                  details={"mode": "Bus", "from": "NRT", "to": "Shinjuku",
                           "depart_time": "2026-07-02T16:30", "arrive_time": "2026-07-02T17:30",
                           "price": "1300", "currency": "JPY"})

        rest1 = item(p1, "restaurant", "Ichiran Ramen Shibuya", "2026-07-02",
                     details={"name": "Ichiran", "address": "Shibuya, Tokyo",
                              "time": "2026-07-02T19:00", "party_size": 3,
                              "link": "https://example.com/ichiran"})
        add_image(rest1, "ramen", "tonkotsu")

        tk1 = item(p1, "ticket", "TeamLab Planets", "2026-07-03", status="confirmed",
                   details={"name": "TeamLab Planets", "venue": "Toyosu, Tokyo",
                            "start_time": "2026-07-03T10:00", "end_time": "2026-07-03T12:30",
                            "qty": 2, "price": "3200", "currency": "JPY",
                            "link": "https://example.com/teamlab"})

        tr1 = item(p1, "transit", "Shinkansen Tokyo -> Kyoto", "2026-07-04", status="confirmed",
                   details={"mode": "Train", "provider": "JR Central", "ref_no": "Nozomi 7",
                            "from": "Tokyo", "to": "Kyoto",
                            "depart_time": "2026-07-04T08:00", "arrive_time": "2026-07-04T10:15",
                            "seat": "12-A/B/C", "price": "14000", "currency": "JPY"})

        act1 = item(p1, "activity", "Fushimi Inari shrine hike", "2026-07-05",
                    details={"name": "Fushimi Inari Taisha", "location": "Kyoto",
                             "start_time": "2026-07-05T07:00", "end_time": "2026-07-05T11:00"})

        note1 = item(p1, "note", "Keep passport handy for hotel check-in", "2026-07-01",
                     details={"text": "Hotels ask for the passport at check-in."})

        # expenses (JPY base)
        ex.create_expense(p1, "Hotel (4 nights)", "JPY", 72000, "EQUAL",
                          [(admin, 72000)], [admin, alice, bob], item_id=h1, created_by=admin, decimals=0)
        ex.create_expense(p1, "Flights LAX-NRT", "USD", 82000, "SHARES",
                          [(alice, 82000)], [(admin, 1), (alice, 1), (bob, 1)], item_id=f1, created_by=alice, decimals=2)
        ex.create_expense(p1, "Dinner at Ichiran", "JPY", 3900, "EQUAL",
                          [(bob, 3900)], [admin, alice, bob], item_id=rest1, created_by=bob, decimals=0)
        ex.create_expense(p1, "TeamLab tickets", "JPY", 6400, "EXACT",
                          [(admin, 6400)], [(admin, 3200), (alice, 3200)], item_id=tk1, created_by=admin, decimals=0)
        ex.create_expense(p1, "Shinkansen", "JPY", 42000, "PERCENTAGE",
                          [(alice, 42000)], [(alice, 4000), (bob, 3000), (admin, 3000)], item_id=tr1, created_by=alice, decimals=0)
        ex.create_expense(p1, "Airport limo bus", "JPY", 3900, "EQUAL",
                          [(admin, 3900)], [admin, alice, bob], item_id=t1, created_by=admin, decimals=0)
        rate(p1, "USD", 150.0)  # 1 USD = 150 JPY
        payment(p1, alice, admin, 5000, "JPY", "partial settle")

        # =========================================================== Plan 2: Iceland Ring Road (EUR)
        p2 = db.execute(
            """INSERT INTO plans (title, description, owner_id, start_date, end_date, base_currency)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Iceland Ring Road", "7 days driving the Ring Road. Bring a raincoat.",
             admin, "2026-08-10", "2026-08-16", "EUR"),
        ).lastrowid
        db.commit()
        share(p2, alice, "editor")
        share(p2, carol, "viewer")

        h2 = item(p2, "hotel", "Kex Hostel Reykjavik", "2026-08-10", end="2026-08-13", status="confirmed",
                  details={"hotel_name": "Kex Hostel", "address": "Skubar 28, Reykjavik",
                           "check_in_time": "14:00", "check_out_time": "10:00",
                           "booking_ref": "HX-44012", "price": "540", "currency": "EUR",
                           "link": "https://example.com/kex"})
        add_image(h2, "hotel", "hostel")
        act2 = item(p2, "activity", "Blue Lagoon", "2026-08-10", status="confirmed",
                    details={"name": "Blue Lagoon", "location": "Grindavik",
                             "start_time": "2026-08-10T16:00", "end_time": "2026-08-10T19:00",
                             "price": "90", "currency": "EUR", "link": "https://example.com/bluelagoon"})
        add_image(act2, "lagoon", "geothermal pool")
        t2 = item(p2, "transit", "Rental car (Dacia Duster)", "2026-08-11",
                  details={"mode": "Rental car", "from": "KEF", "to": "Ring Road",
                           "depart_time": "2026-08-11T09:00", "arrive_time": "2026-08-11T09:30",
                           "price": "420", "currency": "EUR"})
        tk2 = item(p2, "ticket", "Glacier hike Vatnajokull", "2026-08-13", status="planned",
                   details={"name": "Glacier hike", "venue": "Skaftafell",
                            "start_time": "2026-08-13T10:00", "end_time": "2026-08-13T14:00",
                            "qty": 3, "price": "150", "currency": "EUR"})
        rest2 = item(p2, "restaurant", "Dillon whiskey bar", "2026-08-12",
                     details={"name": "Dillon", "address": "Reykjavik", "time": "2026-08-12T21:00", "party_size": 3})
        note2 = item(p2, "note", "Fuel up before the highland detour", "2026-08-14",
                     details={"text": "Gas stations get sparse east of Egilsstadir."})

        ex.create_expense(p2, "Kex Hostel (3 nights)", "EUR", 54000, "EQUAL",
                          [(admin, 54000)], [admin, alice, carol], item_id=h2, created_by=admin, decimals=2)
        ex.create_expense(p2, "Petrol", "ISK", 240000, "EQUAL",
                          [(alice, 240000)], [admin, alice], item_id=t2, created_by=alice, decimals=0)
        ex.create_expense(p2, "Blue Lagoon entry", "EUR", 18000, "SHARES",
                          [(carol, 18000)], [(carol, 1), (alice, 1)], item_id=act2, created_by=carol, decimals=2)
        ex.create_expense(p2, "Glacier hike", "EUR", 45000, "EQUAL",
                          [(admin, 45000)], [admin, alice, carol], item_id=tk2, created_by=admin, decimals=2)
        ex.create_expense(p2, "Dillon drinks", "EUR", 7800, "PERCENTAGE",
                          [(alice, 7800)], [(admin, 4000), (alice, 3000), (carol, 3000)], item_id=rest2, created_by=alice, decimals=2)
        rate(p2, "ISK", 0.0066)  # 1 ISK = 0.0066 EUR
        payment(p2, admin, carol, 2000, "EUR", "thanks for the lagoon")

        # =========================================================== Plan 3: Beijing 2026 (CNY)
        p3 = db.execute(
            """INSERT INTO plans (title, description, owner_id, start_date, end_date, base_currency)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Beijing 2026", "Forbidden City, Great Wall, Peking duck. Five days in the capital.",
             admin, "2026-09-10", "2026-09-15", "CNY"),
        ).lastrowid
        db.commit()
        share(p3, alice, "editor")

        h3 = item(p3, "hotel", "王府井饭店 Wangfujing Hotel", "2026-09-10", end="2026-09-15", status="confirmed",
                  details={"hotel_name": "Wangfujing Hotel", "address": "88 Wangfujing Dajie, Dongcheng, Beijing",
                           "check_in_time": "14:00", "check_out_time": "12:00",
                           "booking_ref": "WH-30187", "price": "4500", "currency": "CNY",
                           "link": "https://example.com/wangfujing", "note": "5 nights, breakfast included"})
        add_image(h3, "hotel", "hotel lobby")

        f3 = item(p3, "transit", "CA 985 SFO -> PEK", "2026-09-10", status="confirmed",
                  details={"mode": "Flight", "provider": "Air China", "ref_no": "CA985",
                           "from": "SFO", "to": "PEK",
                           "depart_time": "2026-09-10T13:00", "arrive_time": "2026-09-11T17:00",
                           "confirmation": "CA-9F4K2", "price": "700", "currency": "USD",
                           "link": "https://example.com/ca985"})
        add_image(f3, "flight", "boarding pass")

        t3 = item(p3, "transit", "DiDi from PEK to hotel", "2026-09-11",
                  details={"mode": "Taxi", "from": "PEK", "to": "Wangfujing",
                           "depart_time": "2026-09-11T17:30", "arrive_time": "2026-09-11T18:00",
                           "price": "200", "currency": "CNY"})

        rest3 = item(p3, "restaurant", "全聚德烤鸭 Quanjude (Wangfujing)", "2026-09-11",
                     details={"name": "Quanjude", "address": "9 Wangfujing Dajie, Beijing",
                              "time": "2026-09-11T19:00", "party_size": 2,
                              "link": "https://example.com/quanjude"})

        act3 = item(p3, "activity", "故宫 Forbidden City", "2026-09-11",
                    details={"name": "Forbidden City", "location": "Dongcheng, Beijing",
                             "start_time": "2026-09-11T09:00", "end_time": "2026-09-11T13:00"})

        act4 = item(p3, "activity", "慕田峪长城 Great Wall (Mutianyu)", "2026-09-12", status="confirmed",
                    details={"name": "Mutianyu Great Wall", "location": "Huairou, Beijing",
                             "start_time": "2026-09-12T08:00", "end_time": "2026-09-12T16:00",
                             "price": "180", "currency": "CNY",
                             "link": "https://example.com/mutianyu"})

        tk3 = item(p3, "ticket", "天坛 Temple of Heaven", "2026-09-13",
                   details={"name": "Temple of Heaven", "venue": "Tiantan, Dongcheng",
                            "start_time": "2026-09-13T09:00", "end_time": "2026-09-13T11:00",
                            "qty": 2, "price": "70", "currency": "CNY",
                            "link": "https://example.com/tiantan"})

        note3 = item(p3, "note", "24小时内到酒店登记 Register at hotel within 24h", "2026-09-10",
                     details={"text": "Foreign visitors must register their passport at the hotel within 24 hours of arrival."})

        ex.create_expense(p3, "Wangfujing Hotel (5 nights)", "CNY", 450000, "EQUAL",
                          [(admin, 450000)], [admin, alice], item_id=h3, created_by=admin, decimals=2)
        ex.create_expense(p3, "Flights SFO-PEK", "USD", 140000, "SHARES",
                          [(alice, 140000)], [(admin, 1), (alice, 1)], item_id=f3, created_by=alice, decimals=2)
        ex.create_expense(p3, "Forbidden City tickets", "CNY", 12000, "EXACT",
                          [(admin, 12000)], [(admin, 8000), (alice, 4000)], item_id=act3, created_by=admin, decimals=2)
        ex.create_expense(p3, "Quanjude dinner", "CNY", 48000, "PERCENTAGE",
                          [(alice, 48000)], [(admin, 5000), (alice, 5000)], item_id=rest3, created_by=alice, decimals=2)
        rate(p3, "USD", 7.2)  # 1 USD = 7.2 CNY
        payment(p3, alice, admin, 20000, "CNY", "settle duck")

        # =========================================================== Plan 4: Tokyo 1-Day Test
        p4 = db.execute(
            """INSERT INTO plans (title, description, owner_id, start_date, end_date, base_currency)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Tokyo 1-Day Test", "3 quick stops for map testing.",
             admin, "2026-07-03", "2026-07-03", "JPY"),
        ).lastrowid
        db.commit()

        item(p4, "activity", "Tokyo Tower", "2026-07-03",
             details={"name": "Tokyo Tower", "location": "Minato, Tokyo",
                      "start_time": "2026-07-03T10:00", "end_time": "2026-07-03T11:30"})

        item(p4, "activity", "Meiji Shrine", "2026-07-03",
             details={"name": "Meiji Shrine", "location": "Shibuya, Tokyo",
                      "start_time": "2026-07-03T13:00", "end_time": "2026-07-03T14:00"})

        item(p4, "activity", "Shibuya Crossing", "2026-07-03",
             details={"name": "Shibuya Crossing", "location": "Shibuya, Tokyo",
                      "start_time": "2026-07-03T15:00", "end_time": "2026-07-03T15:30"})

    print("\nSeeded fake data. Login credentials (password for ALL accounts): traveler")
    print("  admin  / traveler   (admin — owns all three trips)")
    print("  alice  / traveler   (editor on all three trips)")
    print("  bob    / traveler   (editor on Japan 2026)")
    print("  carol  / traveler   (viewer on Iceland Ring Road)")
    print("\nTrips:")
    print("  Japan 2026          base JPY  (expenses in JPY + USD)")
    print("  Iceland Ring Road   base EUR  (expenses in EUR + ISK)")
    print("  Beijing 2026        base CNY  (expenses in CNY + USD; rate 1 USD = 7.2 CNY)")
    print("  Tokyo 1-Day Test    base JPY  (3 stops for map testing)")
    print("\nOpen http://127.0.0.1:5000 and sign in as admin.\n")


def main(argv):
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            has_admin = conn.execute(
                "SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone()
            if has_admin:
                pw = hash_password("traveler")
                conn.execute("UPDATE users SET password_hash = ?", (pw,))
                conn.commit()
                conn.close()
                print(">> reset all user passwords to: traveler")
                print()
                print("  admin  / traveler")
                print("  alice  / traveler")
                print("  bob    / traveler")
                print("  carol  / traveler")
                return
            conn.close()
        except Exception:
            pass

    print(">> seeding fresh database")
    db_mod.init_db()
    seed()


if __name__ == "__main__":
    main(sys.argv[1:])