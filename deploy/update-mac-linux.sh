#!/usr/bin/env sh
set -eu
VERSION=${1:-}
CONFIRM=${2:-}
test -n "$VERSION" || { echo 'Usage: update-mac-linux.sh VERSION --backup-confirmed' >&2; exit 2; }
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo 'Version must be a release version such as 1.0.0.' >&2; exit 2; }
test "$CONFIRM" = '--backup-confirmed' || { echo 'Use Prepare safe update in GearBeacon first, then add --backup-confirmed.' >&2; exit 2; }
case "$(uname -s)" in Darwin) PLATFORM=macos; INSTALL=/usr/local/lib/gearbeacon; SERVICE=com.gearbeacon.server ;; Linux) PLATFORM=linux; INSTALL=/opt/gearbeacon; SERVICE=gearbeacon ;; *) echo 'Unsupported platform.' >&2; exit 2 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
NAME="GearBeacon-v${VERSION}-${PLATFORM}-${ARCH}"
BASE="https://github.com/alexphillips-dev/GearBeacon/releases/download/v${VERSION}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
curl -fL "$BASE/$NAME.tar.gz" -o "$TMP_DIR/$NAME.tar.gz"
curl -fL "$BASE/$NAME.tar.gz.sha256" -o "$TMP_DIR/$NAME.tar.gz.sha256"
(cd "$TMP_DIR" && shasum -a 256 -c "$NAME.tar.gz.sha256")
tar -xzf "$TMP_DIR/$NAME.tar.gz" -C "$TMP_DIR"
if [ "$PLATFORM" = macos ]; then sudo launchctl bootout system /Library/LaunchDaemons/com.gearbeacon.server.plist 2>/dev/null || true; else sudo systemctl stop "$SERVICE"; fi
sudo install -m 0755 "$TMP_DIR/$NAME/gearbeacon" "$INSTALL/gearbeacon"
sudo rm -rf "$INSTALL/web"
sudo cp -R "$TMP_DIR/$NAME/web" "$INSTALL/web"
sudo install -m 0644 "$TMP_DIR/$NAME/release-manifest.json" "$INSTALL/release-manifest.json"
if [ "$PLATFORM" = macos ]; then sudo launchctl bootstrap system /Library/LaunchDaemons/com.gearbeacon.server.plist; else sudo systemctl start "$SERVICE"; fi
echo "GearBeacon updated to V$VERSION. Data was preserved."
