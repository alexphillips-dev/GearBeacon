#!/usr/bin/env sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
systemctl disable --now gearbeacon 2>/dev/null || true
rm -f /etc/systemd/system/gearbeacon.service
systemctl daemon-reload
rm -rf /opt/gearbeacon
if [ "${1:-}" = '--remove-data' ]; then rm -rf /var/lib/gearbeacon; echo 'GearBeacon and its data were removed.'; else echo 'GearBeacon removed; data preserved in /var/lib/gearbeacon.'; fi
