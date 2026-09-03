#!/usr/bin/env bash
# mcp.sh — launch the TravelPlan MCP server for opencode (or any MCP client).
#
# Resolves the same per-host venv as start.sh, installs the MCP dependency
# if it's missing, then runs the server over stdio. opencode's MCP config
# points at this script so the command is stable across machines.
set -euo pipefail
cd "$(dirname "$0")"

# ---- pick a Python interpreter (prefer the per-host venv, fall back) ----
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for cand in ".venv_$(hostname)/bin/python" ".venv/bin/python" "python3"; do
    if [[ -x "$cand" ]]; then PYTHON="$cand"; break; fi
  done
fi
if [[ -z "$PYTHON" ]]; then
  echo "!! no python found. Set PYTHON=/path/to/python" >&2
  exit 1
fi

# ---- ensure the mcp dependency is present ----
if ! "$PYTHON" -c "import mcp" >/dev/null 2>&1; then
  echo ">> installing MCP dependency" >&2
  "$PYTHON" -m pip install -q -r backend/requirements-mcp.txt
fi

exec "$PYTHON" -m backend.mcp_server
