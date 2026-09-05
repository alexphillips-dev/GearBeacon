#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting GearBeacon V1.0.0 in local-only mode..."
GEARBEACON_ACCESS_MODE=local GEARBEACON_BIND_HOST=127.0.0.1 node --no-warnings backend/dist/index.js
