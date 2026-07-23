#!/usr/bin/env bash
# start.sh — set up the Python environment and run TravelPlan.
#
# Usage:
#   ./start.sh [PORT]             Start the server on PORT (default 5050)
#   PORT=8080 ./start.sh          Set the port via environment instead
#   DEBUG=1 ./start.sh            Enable Flask debug + auto-reload (local dev only)
#   ./start.sh --no-test          Skip self-tests (quick dev start)
#   ./start.sh -h|--help          Show this help message
#
# First run: open the printed URL in a browser and create the admin account.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

usage() {
  cat <<'EOF'
TravelPlan — start the server.

Usage:
  ./start.sh [PORT]            Start on PORT (default 5050)
  PORT=8080 ./start.sh          Start on port 8080 via env var
  DEBUG=1 ./start.sh [PORT]     Enable auto-reload/debug (local dev only)
  ./start.sh --no-test [PORT]   Skip self-tests (quick dev start)
  ./start.sh -h | --help        Show this help message

Arguments / environment:
  PORT     Port to listen on (1-65535). Positional arg wins over the env var.
           Env: PORT   Default: 5050
  HOST     Bind address.          Env: HOST  Default: 0.0.0.0  (all interfaces,
           so friends on the same network can reach it)
  DEBUG    Set to 1 to enable the Flask debugger + auto-reload. Off by default
           because the debugger is unsafe to expose on a shared network.
  NO_TEST  Set to 1 to skip self-tests (alias for --no-test).

Data lives under ./data/ (SQLite DB, uploads, config). It is created on first
run and is gitignored. Stop the server with Ctrl-C.

Examples:
  ./start.sh                   # http://0.0.0.0:5050
  ./start.sh 8080              # http://0.0.0.0:8080
  PORT=9000 ./start.sh         # http://0.0.0.0:9000
  DEBUG=1 ./start.sh 5050      # dev mode with auto-reload
  ./start.sh --no-test         # skip tests, start fast
  NO_TEST=1 ./start.sh         # same via env var
EOF
}

# ---- parse args ----
NO_TEST="${NO_TEST:-0}"
PORT="${PORT:-5050}"
while [[ $# -ge 1 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-test) NO_TEST=1 ;;
    --) shift; [[ $# -ge 1 ]] && PORT="$1" ;;
    -*) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
    *) PORT="$1" ;;
  esac
  shift
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: '$PORT' (expected 1-65535)" >&2
  exit 2
fi

HOST="${HOST:-0.0.0.0}"
DEBUG_VAL="${DEBUG:-0}"

# ---- Python environment ----
# Per-host venv so the same checkout works across machines without
# collisions. Override with VENV_DIR=/path/to/venv if you need to pin it.
VENV_DIR="${VENV_DIR:-.venv_$(hostname)}"
if [[ ! -d "$VENV_DIR" ]]; then
  echo ">> creating virtualenv (${VENV_DIR})"
  python3 -m venv "$VENV_DIR"
fi
# some installs ship a venv without pip; bootstrap it
if ! "$VENV_DIR/bin/python" -m pip --version >/dev/null 2>&1; then
  "$VENV_DIR/bin/python" -m ensurepip --upgrade >/dev/null
fi
if ! "$VENV_DIR/bin/python" -c "import flask" >/dev/null 2>&1; then
  echo ">> installing dependencies (flask)"
  "$VENV_DIR/bin/python" -m pip install -q -r backend/requirements.txt
fi

# ---- self-tests (run quietly; surface output only on failure) ----
if [[ "$NO_TEST" == "1" ]]; then
  echo ">> self-tests skipped (NO_TEST=1)"
else
  echo ">> running expense engine self-tests"
if ! out=$("$VENV_DIR/bin/python" -m backend.expense 2>&1); then
  echo "!! self-tests FAILED:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

# Backend auth tests (login, self-serve settings, admin user management).
echo ">> running auth tests"
if ! out=$("$VENV_DIR/bin/python" -m backend.tests 2>&1); then
  echo "!! auth tests FAILED:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

# Frontend test fixtures (DOM shim + page execution under node). Best effort:
# skipped when node is not installed (run.sh exits 0 in that case), but a real
# test failure aborts startup just like the backend self-tests above.
if [[ -f frontend/tests/run.sh ]]; then
  echo ">> running frontend tests"
  if ! out=$(bash frontend/tests/run.sh 2>&1); then
    echo "!! frontend tests FAILED:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
fi
fi

# ---- start ----
cat <<EOF
>> TravelPlan starting
   URL:    http://${HOST}:${PORT}
   Data:   ${ROOT}/data
   Venv:   ${ROOT}/${VENV_DIR}
   Debug:  ${DEBUG_VAL}    (DEBUG=1 for auto-reload)
   Tip:    first run? open the URL and create the admin account.
           stop with Ctrl-C.
EOF
PORT="$PORT" HOST="$HOST" DEBUG="$DEBUG_VAL" exec "$VENV_DIR/bin/python" -m backend.app