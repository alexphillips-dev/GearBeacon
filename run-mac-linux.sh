#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "Starting GearBeacon V1.4..."
node --no-warnings backend/dist/index.js
