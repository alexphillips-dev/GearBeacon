#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting GearBeacon V0.1.10 in local-only MOCK MODE..."
MOCK_MODE=1 GEARBEACON_ACCESS_MODE=local GEARBEACON_BIND_HOST=127.0.0.1 node --no-warnings backend/dist/index.js
