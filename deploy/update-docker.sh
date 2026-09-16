#!/usr/bin/env sh
set -eu
VERSION=${1:-}
CONFIRM=${2:-}
TIMEOUT=${3:-60}
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo 'Usage: update-docker.sh VERSION --backup-confirmed [timeout-seconds]' >&2; exit 2; }
test "$CONFIRM" = '--backup-confirmed' || { echo 'Use Prepare safe update in GearBeacon first, then add --backup-confirmed.' >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo 'Install the GitHub CLI (gh) to verify signed image attestations before updating.' >&2; exit 2; }
case "$TIMEOUT" in ''|*[!0-9]*) echo 'Timeout must be 1 to 300 seconds.' >&2; exit 2;; esac
test "$TIMEOUT" -ge 1 && test "$TIMEOUT" -le 300 || { echo 'Timeout must be 1 to 300 seconds.' >&2; exit 2; }
test -f docker-compose.yml || test -f compose.yaml || test -f compose.yml || { echo 'Run this helper from your Compose project directory.' >&2; exit 2; }
test ! -L .env && { test ! -e .env || test -f .env; } || { echo 'The project .env must be a regular file, not a symlink.' >&2; exit 2; }
test -z "${COMPOSE_ENV_FILES:-}" && test "${COMPOSE_DISABLE_ENV_FILE:-0}" != 1 || { echo 'Use the project .env for persistent image selection; custom Compose env-file settings are not supported by this helper.' >&2; exit 2; }
mkdir .gearbeacon-update.lock 2>/dev/null || { echo 'Another update is running, or its lock remains. Check before removing .gearbeacon-update.lock.' >&2; exit 2; }
TEMP_ENV=''
BUNDLE=''
BUNDLE_DIR=''
CHANGED=0
finish() {
  result=$?
  trap - EXIT
  test -z "$TEMP_ENV" || rm -f "$TEMP_ENV"
  test -z "$BUNDLE" || rm -f "$BUNDLE"
  test -z "$BUNDLE_DIR" || rmdir "$BUNDLE_DIR"
  rmdir .gearbeacon-update.lock
  if test "$result" -ne 0 && test "$CHANGED" -eq 1; then
    echo 'Update was not verified. The requested image tag remains pinned in .env. Inspect docker compose ps and docker compose logs gearbeacon.' >&2
    echo 'To roll back: docker compose stop gearbeacon; restore a compatible pre-update database and its matching secrets.key while stopped; select the previous exact image tag in .env, pull it and start. Never run an older application against a migrated database. Keep the data volume and backup.' >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
TEMP_ENV=$(mktemp .gearbeacon-update.env.XXXXXX)
if test -f .env; then awk '!/^[[:space:]]*(export[[:space:]]+)?GEARBEACON_IMAGE_TAG[[:space:]]*=/' .env > "$TEMP_ENV"; fi
printf '\nGEARBEACON_IMAGE_TAG=%s\n' "$VERSION" >> "$TEMP_ENV"
export GEARBEACON_IMAGE_TAG="$VERSION"
EXPECTED_IMAGE="ghcr.io/alexphillips-dev/gearbeacon:$VERSION"
test "$(docker compose config --images gearbeacon)" = "$EXPECTED_IMAGE" || { echo 'Compose must resolve gearbeacon to the requested official image before updating.' >&2; exit 1; }
docker compose pull gearbeacon
EXPECTED_ID=$(docker image inspect --format '{{.Id}}' "$EXPECTED_IMAGE")
test -n "$EXPECTED_ID"
DIGEST_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' "$EXPECTED_IMAGE")
printf '%s' "$DIGEST_IMAGE" | grep -Eq '^ghcr.io/alexphillips-dev/gearbeacon@sha256:[a-f0-9]{64}$' || { echo 'The downloaded image has no valid official repository digest.' >&2; exit 1; }
BUNDLE_DIR=$(mktemp -d .gearbeacon-update.attestation.XXXXXX)
BUNDLE="$BUNDLE_DIR/bundle.jsonl"
curl -fL "https://github.com/alexphillips-dev/GearBeacon/releases/download/v$VERSION/GearBeacon-v$VERSION-container.attestation.jsonl" -o "$BUNDLE"
COMMIT=$(curl -fsS --max-time 30 "https://api.github.com/repos/alexphillips-dev/GearBeacon/commits/refs%2Ftags%2Fv$VERSION" | sed -n 's/^[[:space:]]*"sha"[[:space:]]*:[[:space:]]*"\([a-f0-9]*\)".*/\1/p' | head -n 1)
printf '%s' "$COMMIT" | grep -Eq '^[a-f0-9]{40}$' || { echo 'The release tag did not resolve to a valid source commit.' >&2; exit 1; }
gh attestation verify "oci://$DIGEST_IMAGE" --bundle "$BUNDLE" --repo alexphillips-dev/GearBeacon --signer-workflow alexphillips-dev/GearBeacon/.github/workflows/release.yml --source-ref "refs/tags/v$VERSION" --source-digest "$COMMIT" --deny-self-hosted-runners || { echo 'Image provenance verification failed. The running application was not changed.' >&2; exit 1; }
PINNED_TAG="$VERSION@${DIGEST_IMAGE#*@}"
if test -f .env; then awk '!/^[[:space:]]*(export[[:space:]]+)?GEARBEACON_IMAGE_TAG[[:space:]]*=/' .env > "$TEMP_ENV"; else : > "$TEMP_ENV"; fi
printf '\nGEARBEACON_IMAGE_TAG=%s\n' "$PINNED_TAG" >> "$TEMP_ENV"
export GEARBEACON_IMAGE_TAG="$PINNED_TAG"
test "$(docker compose config --images gearbeacon)" = "ghcr.io/alexphillips-dev/gearbeacon:$PINNED_TAG" || { echo 'Compose did not accept the verified image digest.' >&2; exit 1; }
mv -f "$TEMP_ENV" .env
TEMP_ENV=''
CHANGED=1
docker compose up -d --no-deps gearbeacon
CONTAINER=$(docker compose ps -q gearbeacon)
test -n "$CONTAINER"
test "$(docker inspect --format '{{.Image}}' "$CONTAINER")" = "$EXPECTED_ID" || { echo 'The running container does not use the requested image.' >&2; exit 1; }
deadline=$(($(date +%s) + TIMEOUT))
while test "$(date +%s)" -lt "$deadline"; do
  if docker compose exec -T gearbeacon node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||8787)+"/healthz",{signal:AbortSignal.timeout(1500)}).then(async r=>{const h=await r.json(),v=process.argv[1],base=v.split(/[-+]/)[0];process.exit(r.ok&&h.ok===true&&h.name==="GearBeacon"&&h.version===base&&(!h.packageVersion||h.packageVersion===base||h.packageVersion===v)?0:1)}).catch(()=>process.exit(1))' "$VERSION" 2>/dev/null; then
    echo "GearBeacon V$VERSION verified: requested image and local startup health. Version pinned in .env; data volume preserved."
    exit 0
  fi
  sleep 2
done
echo 'Startup/version verification timed out.' >&2
exit 1
