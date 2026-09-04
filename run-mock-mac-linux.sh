#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting GearBeacon V1.4 in MOCK MODE..."
MOCK_MODE=1 node --no-warnings backend/dist/index.js
