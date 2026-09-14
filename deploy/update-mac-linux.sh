#!/usr/bin/env sh
set -eu
VERSION=${1:-}
CONFIRM=${2:-}
test -n "$VERSION" || { echo 'Usage: update-mac-linux.sh VERSION --backup-confirmed [--port PORT] [--timeout-seconds SECONDS] [--install-dir DIRECTORY]' >&2; exit 2; }
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo 'Version must be a release version such as 1.0.0.' >&2; exit 2; }
test "$CONFIRM" = '--backup-confirmed' || { echo 'Use Prepare safe update in GearBeacon first, then add --backup-confirmed.' >&2; exit 2; }
case "$(uname -s)" in Darwin) PLATFORM=macos; INSTALL=/usr/local/lib/gearbeacon; SERVICE=com.gearbeacon.server ;; Linux) PLATFORM=linux; INSTALL=/opt/gearbeacon; SERVICE=gearbeacon ;; *) echo 'Unsupported platform.' >&2; exit 2 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo 'Unsupported processor architecture.' >&2; exit 2 ;; esac
shift 2
PORT=8787
TIMEOUT=60
while test "$#" -gt 0; do
  test "$#" -ge 2 || { echo 'Missing update option value.' >&2; exit 2; }
  case "$1" in --port) PORT=$2 ;; --timeout-seconds) TIMEOUT=$2 ;; --install-dir) INSTALL=$2 ;; *) echo 'Unknown update option.' >&2; exit 2 ;; esac
  shift 2
done
case "$PORT:$TIMEOUT" in *[!0-9:]*) echo 'Port and timeout must be integers.' >&2; exit 2 ;; esac
test -n "$PORT" && test "$PORT" -ge 1 && test "$PORT" -le 65535 && test -n "$TIMEOUT" && test "$TIMEOUT" -ge 1 && test "$TIMEOUT" -le 300 || { echo 'Port must be 1 to 65535; timeout must be 1 to 300 seconds.' >&2; exit 2; }
test -d "$INSTALL" && test ! -L "$INSTALL" || { echo 'Install directory must exist and must not be a symlink.' >&2; exit 2; }
INSTALL=$(cd "$INSTALL" && pwd -P)
case "$INSTALL" in */gearbeacon) ;; *) echo 'Install directory must resolve to a directory named gearbeacon.' >&2; exit 2 ;; esac
test ! -L "$INSTALL/web" && test ! -L "$INSTALL/gearbeacon" || { echo 'Application files must not be symlinks.' >&2; exit 2; }
NAME="GearBeacon-v${VERSION}-${PLATFORM}-${ARCH}"
BASE="https://github.com/alexphillips-dev/GearBeacon/releases/download/v${VERSION}"
TMP_DIR=$(mktemp -d)
CHANGED=0
finish() {
  result=$?
  trap - EXIT
  rm -rf "$TMP_DIR"
  if test "$result" -ne 0 && test "$CHANGED" -eq 1; then
    echo 'Update was not verified. Inspect the GearBeacon service/task logs and confirm the configured port.' >&2
    echo 'To roll back: stop the GearBeacon service; restore a compatible pre-update database and matching secrets.key while stopped; reinstall the previous exact version, then start and verify it. Never run an older application against a migrated database. Keep the backup.' >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fL "$BASE/$NAME.tar.gz" -o "$TMP_DIR/$NAME.tar.gz"
curl -fL "$BASE/$NAME.tar.gz.sha256" -o "$TMP_DIR/$NAME.tar.gz.sha256"
EXPECTED=$(awk 'NR==1 {print $1}' "$TMP_DIR/$NAME.tar.gz.sha256")
printf '%s' "$EXPECTED" | grep -Eq '^[a-fA-F0-9]{64}$' || { echo 'Invalid checksum metadata.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP_DIR/$NAME.tar.gz" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$TMP_DIR/$NAME.tar.gz" | awk '{print $1}'); fi
test "$(printf '%s' "$EXPECTED" | tr A-F a-f)" = "$ACTUAL" || { echo 'Downloaded package checksum does not match release metadata.' >&2; exit 1; }
# Packages contain regular files/directories beneath one release directory only.
tar -tzf "$TMP_DIR/$NAME.tar.gz" > "$TMP_DIR/entries"
awk -v name="$NAME" '$0 !~ "^" name "/" || $0 ~ /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}' "$TMP_DIR/entries" || { echo 'Unsafe archive paths.' >&2; exit 1; }
tar -tvzf "$TMP_DIR/$NAME.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || { echo 'Archive links and special files are not supported.' >&2; exit 1; }
tar -xzf "$TMP_DIR/$NAME.tar.gz" -C "$TMP_DIR"
test -f "$TMP_DIR/$NAME/gearbeacon" && test -d "$TMP_DIR/$NAME/web" && test -f "$TMP_DIR/$NAME/release-manifest.json" || { echo 'Downloaded package is incomplete.' >&2; exit 1; }
CHANGED=1
if [ "$PLATFORM" = macos ]; then
  if sudo launchctl print "system/$SERVICE" >/dev/null 2>&1; then sudo launchctl bootout system /Library/LaunchDaemons/com.gearbeacon.server.plist; fi
else sudo systemctl stop "$SERVICE"; fi
sudo install -m 0755 "$TMP_DIR/$NAME/gearbeacon" "$INSTALL/gearbeacon"
sudo rm -rf "$INSTALL/web"
sudo cp -R "$TMP_DIR/$NAME/web" "$INSTALL/web"
sudo install -m 0644 "$TMP_DIR/$NAME/release-manifest.json" "$INSTALL/release-manifest.json"
if test -f "$TMP_DIR/$NAME/build-info.json"; then sudo install -m 0644 "$TMP_DIR/$NAME/build-info.json" "$INSTALL/build-info.json"; else sudo rm -f "$INSTALL/build-info.json"; fi
if [ "$PLATFORM" = macos ]; then sudo launchctl bootstrap system /Library/LaunchDaemons/com.gearbeacon.server.plist; else sudo systemctl start "$SERVICE"; fi
deadline=$(($(date +%s) + TIMEOUT))
BASE_VERSION=${VERSION%%[-+]*}
while test "$(date +%s)" -lt "$deadline"; do
  health=$(curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)
  observed=$(printf '%s' "$health" | sed -n 's/.*"packageVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  app_version=$(printf '%s' "$health" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if test -z "$observed"; then observed=$app_version; fi
  if test "$observed" = "$VERSION" && test "$app_version" = "$BASE_VERSION" && printf '%s' "$health" | grep -Eq '"name"[[:space:]]*:[[:space:]]*"GearBeacon"' && printf '%s' "$health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "GearBeacon V$VERSION verified: local startup health and expected version. Data was preserved."
    exit 0
  fi
  sleep 1
done
echo 'Startup/version verification timed out.' >&2
exit 1
