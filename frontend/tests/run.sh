#!/usr/bin/env bash
# run.sh — run the frontend test fixtures (staging engine + page execution).
#
# These are plain ES-module tests executed by node; there is no test
# framework or npm install. node is located via $NODE, then PATH; if node is
# not available the suite is SKIPPED (exit 0) so machines without node can
# still run ./start.sh — set NODE=/path/to/node to force a failure in that
# case.
#
# Usage:
#   ./run.sh            # from frontend/tests/, or bash frontend/tests/run.sh
#   NODE=/usr/bin/node ./run.sh
set -uo pipefail
cd "$(dirname "$0")"

NODE_BIN="${NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=node
  else
    echo "skip: node not found — frontend tests need node (set NODE=/path/to/node)"
    exit 0
  fi
fi

overall=0
for t in *.test.mjs; do
  echo "== $t"
  if ! "$NODE_BIN" --import ./register.mjs "$t"; then
    overall=1
  fi
done
exit $overall
