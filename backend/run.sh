#!/usr/bin/env bash
# Thin wrapper around the project-root start.sh (kept for backward compat).
# Set up the env and start the server. See: ./start.sh --help
exec "$(dirname "$0")/../start.sh" "$@"