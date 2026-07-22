#!/usr/bin/env bash
# seed.sh — seed or reset passwords for the database.
#
# If an admin already exists, all user passwords are reset to "traveler"
# without touching any existing data. Otherwise the full fake dataset is
# inserted.
#
# Usage:
#   ./seed.sh             seed or reset passwords (safe to run anytime)
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d ".venv" ]]; then
  echo ">> creating .venv"; python3 -m venv .venv
fi
if ! .venv/bin/python -c "import flask" >/dev/null 2>&1; then
  .venv/bin/python -m pip install -q -r backend/requirements.txt
fi

exec .venv/bin/python -m backend.seed "$@"