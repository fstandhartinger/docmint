#!/usr/bin/env bash
# Runs the API against the real database with the local .env. Never committed.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
exec "$@"
