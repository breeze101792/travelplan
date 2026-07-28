"""003: Clean up legacy fields in items.details.

Was an inline migration inside init_db() before the migration framework
existed. Walks every item and:
  - Moves details.link into the attachments table (kind='link')
  - Renames details.venue → location for activity items
  - Migrates details.time → details.start_time for restaurant items
  - Removes legacy qty / price (they were dropped from the schema)
"""
import json

id = "003_details_cleanup"

def run(conn):
    cur = conn.execute("SELECT id, item_type, details FROM items")
    rows = cur.fetchall()
    for row in rows:
        item_id, item_type, raw_details = row
        details = json.loads(raw_details) if raw_details else {}
        changed = False
        # Move link to attachments
        link = details.pop('link', None)
        if link:
            existing = conn.execute(
                "SELECT id FROM attachments WHERE item_id = ? AND kind = 'link' AND value = ?",
                (item_id, link),
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO attachments (item_id, kind, value, caption) "
                    "VALUES (?, 'link', ?, ?)",
                    (item_id, link, details.get('name') or details.get('hotel_name') or ''),
                )
            changed = True
        # Rename venue to location for activity items
        if item_type == 'activity' and 'venue' in details:
            details['location'] = details.pop('venue')
            changed = True
        # Convert legacy time to start_time for restaurant
        if item_type == 'restaurant' and 'time' in details and not details.get('start_time'):
            details['start_time'] = details.pop('time')
            changed = True
        # Remove legacy fields that no longer belong
        for legacy_field in ('qty', 'price'):
            if legacy_field in details:
                del details[legacy_field]
                changed = True
        if changed:
            conn.execute(
                "UPDATE items SET details = ? WHERE id = ?",
                (json.dumps(details) if details else None, item_id),
            )
