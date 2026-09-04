#!/usr/bin/env sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /opt/gearbeacon
install -d -m 0700 /var/lib/gearbeacon
install -m 0755 "$SOURCE_DIR/gearbeacon" /opt/gearbeacon/gearbeacon
cp -R "$SOURCE_DIR/web" /opt/gearbeacon/web
install -m 0644 "$SOURCE_DIR/release-manifest.json" /opt/gearbeacon/release-manifest.json
printf '%s\n' '[Unit]' 'Description=GearBeacon private stock monitor' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=simple' 'User=gearbeacon' 'Group=gearbeacon' 'Environment=GEARBEACON_DATA_DIR=/var/lib/gearbeacon' 'Environment=GEARBEACON_ACCESS_MODE=private' 'Environment=GEARBEACON_BIND_HOST=0.0.0.0' 'ExecStart=/opt/gearbeacon/gearbeacon' 'Restart=on-failure' 'RestartSec=5' 'NoNewPrivileges=true' 'PrivateTmp=true' 'ProtectSystem=strict' 'ReadWritePaths=/var/lib/gearbeacon' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/gearbeacon.service
id gearbeacon >/dev/null 2>&1 || useradd --system --home-dir /var/lib/gearbeacon --shell /usr/sbin/nologin gearbeacon
chown -R gearbeacon:gearbeacon /var/lib/gearbeacon /opt/gearbeacon
systemctl daemon-reload
systemctl enable --now gearbeacon
echo 'GearBeacon installed. Run journalctl -u gearbeacon to see the one-time setup token.'
