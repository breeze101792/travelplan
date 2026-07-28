"""001: Add the plans.status column.

Was an inline ALTER TABLE inside init_db() before the migration framework
existed. Status drives the dashboard's Planning / Ongoing / Archived
filtering. The CHECK constraint mirrors the one in schema.sql.
"""
id = "001_plans_status"

def run(conn):
    try:
        conn.execute(
            "ALTER TABLE plans ADD COLUMN status TEXT NOT NULL "
            "DEFAULT 'planning' CHECK (status IN ('planning','ongoing','archived'))"
        )
    except Exception:
        # Column already exists — idempotent.
        pass
