#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
launchctl bootout system /Library/LaunchDaemons/com.gearbeacon.server.plist 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.gearbeacon.server.plist
rm -rf /usr/local/lib/gearbeacon
if [ "${1:-}" = '--remove-data' ]; then rm -rf '/Library/Application Support/GearBeacon'; echo 'GearBeacon and its data were removed.'; else echo 'GearBeacon removed; data preserved in /Library/Application Support/GearBeacon.'; fi
