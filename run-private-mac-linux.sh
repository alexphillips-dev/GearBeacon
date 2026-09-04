#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting GearBeacon V1.7 as a private authenticated server..."
echo "First run: use the one-time setup token printed below in the dashboard."
GEARBEACON_ACCESS_MODE=private GEARBEACON_BIND_HOST=0.0.0.0 node --no-warnings backend/dist/index.js
