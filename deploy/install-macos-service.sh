#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run with sudo." >&2; exit 1; }
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=/usr/local/lib/gearbeacon
DATA_DIR='/Library/Application Support/GearBeacon'
SERVICE_USER=_gearbeacon
SERVICE_GROUP=_gearbeacon
umask 077

if ! dscl . -read "/Groups/$SERVICE_GROUP" >/dev/null 2>&1; then
  SERVICE_ID=399
  while { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}' | grep -qx "$SERVICE_ID"; do
    SERVICE_ID=$((SERVICE_ID - 1))
    test "$SERVICE_ID" -ge 300 || { echo 'No unused macOS service account ID is available.' >&2; exit 1; }
  done
  dscl . -create "/Groups/$SERVICE_GROUP"
  dscl . -create "/Groups/$SERVICE_GROUP" PrimaryGroupID "$SERVICE_ID"
fi
SERVICE_GID=$(dscl . -read "/Groups/$SERVICE_GROUP" PrimaryGroupID | awk '{print $2}')

if ! dscl . -read "/Users/$SERVICE_USER" >/dev/null 2>&1; then
  SERVICE_UID=399
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$SERVICE_UID"; do
    SERVICE_UID=$((SERVICE_UID - 1))
    test "$SERVICE_UID" -ge 300 || { echo 'No unused macOS service user ID is available.' >&2; exit 1; }
  done
  dscl . -create "/Users/$SERVICE_USER"
  dscl . -create "/Users/$SERVICE_USER" UniqueID "$SERVICE_UID"
  dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID "$SERVICE_GID"
  dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory "$DATA_DIR"
  dscl . -create "/Users/$SERVICE_USER" RealName 'GearBeacon service'
  dscl . -create "/Users/$SERVICE_USER" IsHidden 1
  dscl . -create "/Users/$SERVICE_USER" AuthenticationAuthority ';DisabledUser;'
fi

install -d -o root -g wheel -m 0755 "$INSTALL_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$DATA_DIR"
install -o root -g wheel -m 0755 "$SOURCE_DIR/gearbeacon" "$INSTALL_DIR/gearbeacon"
rm -rf "$INSTALL_DIR/web"
cp -R "$SOURCE_DIR/web" "$INSTALL_DIR/web"
install -o root -g wheel -m 0644 "$SOURCE_DIR/release-manifest.json" "$INSTALL_DIR/release-manifest.json"
chown -R root:wheel "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
touch "$DATA_DIR/gearbeacon.log"
chown "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR/gearbeacon.log"
chmod 0600 "$DATA_DIR/gearbeacon.log"
launchctl bootout system /Library/LaunchDaemons/com.gearbeacon.server.plist 2>/dev/null || true
cat > /Library/LaunchDaemons/com.gearbeacon.server.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.gearbeacon.server</string><key>UserName</key><string>$SERVICE_USER</string><key>GroupName</key><string>$SERVICE_GROUP</string><key>Umask</key><integer>63</integer><key>ProcessType</key><string>Background</string><key>ProgramArguments</key><array><string>$INSTALL_DIR/gearbeacon</string></array><key>EnvironmentVariables</key><dict><key>GEARBEACON_DATA_DIR</key><string>$DATA_DIR</string><key>GEARBEACON_ACCESS_MODE</key><string>private</string><key>GEARBEACON_BIND_HOST</key><string>0.0.0.0</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$DATA_DIR/gearbeacon.log</string><key>StandardErrorPath</key><string>$DATA_DIR/gearbeacon.log</string></dict></plist>
EOF
chown root:wheel /Library/LaunchDaemons/com.gearbeacon.server.plist
chmod 0644 /Library/LaunchDaemons/com.gearbeacon.server.plist
launchctl bootstrap system /Library/LaunchDaemons/com.gearbeacon.server.plist
echo "GearBeacon installed as $SERVICE_USER. Read $DATA_DIR/gearbeacon.log for the one-time setup token."
