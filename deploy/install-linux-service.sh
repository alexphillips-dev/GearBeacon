#!/usr/bin/env sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
umask 077
id gearbeacon >/dev/null 2>&1 || useradd --system --home-dir /var/lib/gearbeacon --shell /usr/sbin/nologin gearbeacon
install -d -o root -g root -m 0755 /opt/gearbeacon
install -d -o gearbeacon -g gearbeacon -m 0700 /var/lib/gearbeacon
install -o root -g root -m 0755 "$SOURCE_DIR/gearbeacon" /opt/gearbeacon/gearbeacon
rm -rf /opt/gearbeacon/web
cp -R "$SOURCE_DIR/web" /opt/gearbeacon/web
install -o root -g root -m 0644 "$SOURCE_DIR/release-manifest.json" /opt/gearbeacon/release-manifest.json
chown -R root:root /opt/gearbeacon
chmod -R go-w /opt/gearbeacon
chown -R gearbeacon:gearbeacon /var/lib/gearbeacon
chmod 0700 /var/lib/gearbeacon
printf '%s\n' '[Unit]' 'Description=GearBeacon private stock monitor' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=simple' 'User=gearbeacon' 'Group=gearbeacon' 'UMask=0077' 'Environment=GEARBEACON_DATA_DIR=/var/lib/gearbeacon' 'Environment=GEARBEACON_ACCESS_MODE=private' 'Environment=GEARBEACON_BIND_HOST=0.0.0.0' 'ExecStart=/opt/gearbeacon/gearbeacon' 'Restart=on-failure' 'RestartSec=5' 'NoNewPrivileges=true' 'CapabilityBoundingSet=' 'AmbientCapabilities=' 'PrivateDevices=true' 'PrivateTmp=true' 'ProtectControlGroups=true' 'ProtectHome=true' 'ProtectKernelLogs=true' 'ProtectKernelModules=true' 'ProtectKernelTunables=true' 'ProtectSystem=strict' 'LockPersonality=true' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' 'RestrictNamespaces=true' 'RestrictRealtime=true' 'RestrictSUIDSGID=true' 'SystemCallArchitectures=native' 'ReadWritePaths=/var/lib/gearbeacon' '' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/gearbeacon.service
chown root:root /etc/systemd/system/gearbeacon.service
chmod 0644 /etc/systemd/system/gearbeacon.service
systemctl daemon-reload
systemctl enable --now gearbeacon
echo 'GearBeacon installed. Run journalctl -u gearbeacon to see the one-time setup token.'
