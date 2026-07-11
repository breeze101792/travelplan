#!/usr/bin/env bash
# seed.sh — populate the database with fake data for testing.
#
# WARNING: with --reset (the default for this convenience wrapper) this WIPES
# the existing database and uploads, then inserts a known fake dataset
# (2 trips, members, items, expenses in 4 currencies, attachments, rates).
#
# Usage:
#   ./seed.sh             wipe & reseed fake data
#   ./seed.sh --reset     same (explicit)
#   ./seed.sh --no-reset  seed only if no admin exists yet (won't clobber)
#
# All seeded accounts use the password: password
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d ".venv" ]]; then
  echo ">> creating .venv"; python3 -m venv .venv
fi
if ! .venv/bin/python -c "import flask" >/dev/null 2>&1; then
  .venv/bin/python -m pip install -q -r backend/requirements.txt
fi

if [[ $# -eq 0 ]]; then
  # default: convenient wipe-and-reseed for testing
  exec .venv/bin/python -m backend.seed --reset
fi
exec .venv/bin/python -m backend.seed "$@"