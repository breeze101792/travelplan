#!/usr/bin/env bash
# run-tests.sh — run the TravelPlan test suites.
#
# Usage:
#   ./tests/run-tests.sh                # backend pytest + frontend node tests
#   ./tests/run-tests.sh --e2e          # also run Playwright browser tests (slow)
#   ./tests/run-tests.sh --backend     # only backend pytest
#   ./tests/run-tests.sh --frontend    # only frontend node tests
#   ./tests/run-tests.sh -h|--help     # this message
#
# Backend tests (tests/backend/) run under pytest and cover every blueprint:
# auth, plans, items, uploads, expenses, util. ~150 tests, a few seconds.
#
# Frontend tests (frontend/tests/) are plain ES-module tests run by node —
# the staging engine, itinerary/timeline page execution, and fmtDate parity
# with the server. Skipped automatically when node is not installed.
#
# E2E tests (tests/e2e/) drive a real Chromium browser via Playwright against
# a throwaway Flask server, on desktop (1280x800) and iPhone 14 (390x664,
# touch). Covers the user-visible flows: setup, login, dashboard create/
# edit/delete, board add/edit/drag/revert items, context menu, expenses,
# members, settings. ~40 tests, ~1 minute. Needs chromium; on NixOS set
# CHROMIUM=/nix/store/.../bin/chromium (the script tries a default path).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
}

RUN_BACKEND=1
RUN_FRONTEND=1
RUN_E2E=0
while [[ $# -ge 1 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --e2e) RUN_E2E=1 ;;
    --backend) RUN_FRONTEND=0; RUN_E2E=0 ;;
    --frontend) RUN_BACKEND=0; RUN_E2E=0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ---- pick a Python interpreter (prefer the per-host venv, fall back to python3) ----
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for cand in ".venv_$(hostname)/bin/python" ".venv/bin/python" "python3"; do
    if [[ -x "$cand" ]] && "$cand" -c "import flask, pytest" >/dev/null 2>&1; then
      PYTHON="$cand"; break
    fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  echo "!! no python with flask+pytest found. Install deps or set PYTHON=/path/to/python" >&2
  exit 1
fi
echo ">> using python: $PYTHON"

EXIT=0

# ---- backend pytest ----
if [[ "$RUN_BACKEND" == "1" ]]; then
  echo ">> running backend tests (pytest)"
  if ! "$PYTHON" -m pytest tests/backend -c pytest.ini -q; then
    EXIT=1
  fi
fi

# ---- frontend node tests ----
if [[ "$RUN_FRONTEND" == "1" ]]; then
  echo ">> running frontend tests (node)"
  if ! bash frontend/tests/run.sh; then
    EXIT=1
  fi
fi

# ---- e2e playwright ----
if [[ "$RUN_E2E" == "1" ]]; then
  echo ">> running e2e tests (playwright)"
  # Playwright's bundled node is broken on NixOS; the conftest points the
  # Python client at a system chromium. Set CHROMIUM if it's not found
  # automatically.
  if ! "$PYTHON" -c "import playwright" >/dev/null 2>&1; then
    echo "!! playwright not installed in $PYTHON — run: $PYTHON -m pip install playwright" >&2
    EXIT=1
  else
    if ! LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" "$PYTHON" -m pytest tests/e2e -c pytest-e2e.ini -q; then
      EXIT=1
    fi
  fi
fi

if [[ "$EXIT" == "0" ]]; then
  echo ">> all tests passed"
else
  echo "!! some tests FAILED" >&2
fi
exit $EXIT