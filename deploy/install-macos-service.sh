#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/usr/local/lib/gearbeacon
DATA_DIR='/Library/Application Support/GearBeacon'
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
chmod 0700 "$DATA_DIR"
install -m 0755 "$SOURCE_DIR/gearbeacon" "$INSTALL_DIR/gearbeacon"
cp -R "$SOURCE_DIR/web" "$INSTALL_DIR/web"
install -m 0644 "$SOURCE_DIR/release-manifest.json" "$INSTALL_DIR/release-manifest.json"
cat > /Library/LaunchDaemons/com.gearbeacon.server.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.gearbeacon.server</string><key>ProgramArguments</key><array><string>$INSTALL_DIR/gearbeacon</string></array><key>EnvironmentVariables</key><dict><key>GEARBEACON_DATA_DIR</key><string>$DATA_DIR</string><key>GEARBEACON_ACCESS_MODE</key><string>private</string><key>GEARBEACON_BIND_HOST</key><string>0.0.0.0</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>/var/log/gearbeacon.log</string><key>StandardErrorPath</key><string>/var/log/gearbeacon.log</string></dict></plist>
EOF
chmod 0644 /Library/LaunchDaemons/com.gearbeacon.server.plist
launchctl bootstrap system /Library/LaunchDaemons/com.gearbeacon.server.plist
echo 'GearBeacon installed. Read /var/log/gearbeacon.log for the one-time setup token.'
