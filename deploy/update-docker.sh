#!/usr/bin/env sh
set -eu
VERSION=${1:-}
CONFIRM=${2:-}
test -n "$VERSION" || { echo 'Usage: update-docker.sh VERSION --backup-confirmed' >&2; exit 2; }
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo 'Version must be a release version such as 1.9.0.' >&2; exit 2; }
test "$CONFIRM" = '--backup-confirmed' || { echo 'Use Prepare safe update in GearBeacon first, then add --backup-confirmed.' >&2; exit 2; }
export GEARBEACON_IMAGE_TAG="$VERSION"
docker compose pull gearbeacon
docker compose up -d --no-deps gearbeacon
docker compose ps gearbeacon
echo "GearBeacon requested V$VERSION. The named volume and pre-update backup were preserved. Roll back by rerunning this script with the previous version."
