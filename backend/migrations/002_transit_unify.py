"""002: Unify flight / train / transport item types into a single 'transit' type.

Was an inline migration inside init_db() before the migration framework
existed. The original schema had separate 'flight' and 'train' types and
a generic 'transport' for everything else (bus, ferry, taxi, rental car).
All three are now a single 'transit' type; the 'mode' field
(Flight/Train/Bus/Ferry/Taxi/Rental car) carries the sub-type at entry
time.

This migration:
  - Renames flight.airline → provider, flight.flight_no → ref_no
  - Renames train.train_no → ref_no
  - For old 'transport': migrates time → depart_time, synthesizes
    arrive_time = depart_time + 1h when missing
  - Sets item_type = 'transit' for all three
"""
import json
from datetime import datetime, timedelta

id = "002_transit_unify"

def run(conn):
    cur = conn.execute(
        "SELECT id, item_type, details FROM items WHERE item_type IN ('flight','train','transport')"
    )
    rows = cur.fetchall()
    for row in rows:
        item_id, old_type, raw_details = row
        details = json.loads(raw_details) if raw_details else {}
        if old_type == 'flight':
            if details.get('airline'):
                details['provider'] = details.pop('airline')
            if details.get('flight_no'):
                details['ref_no'] = details.pop('flight_no')
            details.pop('airline', None)
            details.pop('flight_no', None)
        elif old_type == 'train':
            if details.get('train_no'):
                details['ref_no'] = details.pop('train_no')
            details.pop('train_no', None)
        elif old_type == 'transport':
            if details.get('time') and not details.get('depart_time'):
                details['depart_time'] = details.pop('time')
            if details.get('depart_time') and not details.get('arrive_time'):
                try:
                    dt = datetime.fromisoformat(details['depart_time'])
                    details['arrive_time'] = (dt + timedelta(hours=1)).isoformat()
                except Exception:
                    pass
        conn.execute(
            "UPDATE items SET item_type = 'transit', details = ? WHERE id = ?",
            (json.dumps(details), item_id),
        )
