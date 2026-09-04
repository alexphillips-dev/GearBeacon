# GearBeacon V1.4

**Know the second it's back.**

GearBeacon monitors Ubiquiti/UniFi Store inventory, lets users watch individual products, and alerts when relevant stock events occur. V1.4 builds on V1.3's upgrade-safe SQLite foundation with **production notification controls, GitHub Releases integration, monitor health safeguards, and a cloud-ready deployment path**.

## What's new in V1.4

### 1. GitHub-powered updates and releases

GearBeacon now checks the official project repository by default:

`https://github.com/alexphillips-dev/GearBeacon`

**Settings → Check for updates** queries the latest GitHub Release, selects the GearBeacon `.zip` release asset when available, and shows release notes/download links. If GitHub is unavailable or there are no releases yet, GearBeacon safely falls back to the bundled `release-manifest.json`.

The repo package includes:

- `.github/workflows/ci.yml` — runs backend compilation, browser JavaScript validation, mobile type-checking, and the GearBeacon self-test on `dev`, `main`, and pull requests.
- `.github/workflows/release.yml` — when a tag such as `v1.4.0` is pushed, verifies the tag matches the app version, runs tests, creates `GearBeacon-v1.4.0.zip`, generates a SHA-256 file, and publishes both as a GitHub Release.

### 2. Server-side mobile push

The Expo/React Native client can register a physical device with GearBeacon. Once the app has an EAS project ID and is installed as a development/release build, the server can send Expo push notifications even when the app is closed.

V1.4 adds:

- push token registration and removal;
- Expo push-ticket error handling;
- automatic cleanup of `DeviceNotRegistered` tokens;
- optional Expo access-token support;
- a **Send test notification** action;
- notification delivery logging in SQLite.

### 3. Notification preferences

Web and mobile Settings now control which event types can alert:

- **Restock** — on by default for watched products.
- **Sold out** — optional for watched products.
- **Price change** — optional for watched products.
- **Status change** — optional for watched products.
- **New product** — optional global catalog alert.

These preferences are stored in the same persistent SQLite database as the watchlist, so they survive upgrades/restarts.

### 4. More reliable monitoring

V1.4 adds monitor health protection intended to favor a missed cycle over a false mass stock change:

- catalog-size health guard rejects suspiciously tiny catalog responses;
- partial category errors are reported as degraded health instead of inferred sellouts;
- failed checks use exponential retry/backoff up to 15 minutes;
- stale-monitor detection is exposed through status/health endpoints;
- products missing from a partial catalog remain preserved rather than being marked sold out;
- startup still establishes/uses a baseline without alerting simply because a product is already available.

Health endpoints:

- `GET /healthz` — GearBeacon process is alive.
- `GET /readyz` — monitor has a recent successful store check.
- `GET /api/health` — detailed monitor health.

### 5. Cloud-ready centralized monitor

V1.4 includes `Dockerfile`, `docker-compose.yml`, and `deploy/README.md`. This lets one always-on GearBeacon server poll the UniFi Store while phones/browsers connect to that central service.

The included Docker configuration stores SQLite under a persistent `/data` volume. Rebuilding the container does **not** replace watched products.

> **V1.4 is still single-watchlist and unauthenticated.** Do not expose port 8787 directly to the public internet. Use a private network/VPN or authenticated reverse proxy. Accounts, device ownership, and per-user cloud sync are the next architecture milestone rather than something V1.4 pretends to provide.

## V1.3 upgrade safety remains intact

V1.4 keeps all V1.3 data guarantees:

- SQLite via Node's built-in `node:sqlite`.
- User data outside the application folder.
- Transactional schema migrations (V1.4 schema **v3**).
- Automatic pre-update database backup when the application version changes.
- Five-backup retention.
- Import/export.
- Legacy V1.0–V1.2 JSON migration.

Default database locations:

- **Windows:** `%LOCALAPPDATA%\GearBeacon\gearbeacon.sqlite3`
- **macOS:** `~/Library/Application Support/GearBeacon/gearbeacon.sqlite3`
- **Linux:** `${XDG_DATA_HOME:-~/.local/share}/GearBeacon/gearbeacon.sqlite3`

Mock mode uses `gearbeacon.mock.sqlite3`, so demonstrations/tests cannot overwrite live state.

## Fastest local test

Install **Node.js 22.13+**.

Windows:

```text
run-mock-windows.bat
```

macOS/Linux:

```bash
./run-mock-mac-linux.sh
```

Then open:

```text
http://localhost:8787
```

For live inventory use `run-windows.bat` or `./run-mac-linux.sh`.

## Automated verification

```bash
node --no-warnings scripts/self-test.mjs
```

The V1.4 self-test verifies:

- schema migrations through v3;
- restock detection/watchlists;
- notification preference persistence;
- monitor health endpoint;
- export/import restoration;
- manual backups;
- persistence after a server restart;
- automatic pre-update backup;
- update-check fallback behavior.

## Mobile app / real push setup

The mobile client targets Expo SDK 57 / React Native 0.86.

```bash
cd mobile
npm install
npx expo install --fix
npx expo start
```

For true remote push, create/configure an Expo project and put its EAS project ID in `mobile/app.json`:

```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "YOUR-EAS-PROJECT-ID"
      }
    }
  }
}
```

Then create a development or preview build, for example:

```bash
npx eas build --profile development --platform ios
```

or use the included scripts:

```bash
npm run eas:development
npm run eas:preview
```

In the app open **Settings → Remote push notifications → Register this device for push**. Use **Send test notification** to confirm server-side delivery.

If Expo push security is enabled for the EAS project, set `EXPO_ACCESS_TOKEN` on the GearBeacon server.

## GitHub release flow

Recommended branch flow:

```text
dev → pull request → main → tag vX.Y.Z → GitHub Release
```

For a release:

```bash
git switch main
git pull
git tag v1.4.0
git push origin v1.4.0
```

The included release workflow packages the release and publishes ZIP + SHA-256 assets. Future installed copies of GearBeacon will then see that release through **Check for updates**.

## Cloud deployment

```bash
docker compose up -d --build
```

Persistent data is stored in the `gearbeacon-data` Docker volume. See `deploy/README.md` for health endpoints and deployment warnings.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8787` | Web/API port |
| `REGION` | `us` | `us`, `eu`, `uk`, or `ca` |
| `POLL_SECONDS` | `60` | Normal polling cadence; minimum 30 seconds |
| `NTFY_TOPIC` | blank | Optional ntfy.sh destination |
| `DISCORD_WEBHOOK_URL` | blank | Optional Discord webhook |
| `EXPO_ACCESS_TOKEN` | blank | Optional Expo Push access token when Expo enhanced push security is enabled |
| `GEARBEACON_DATA_DIR` | OS user-data folder | Override persistent data directory |
| `GEARBEACON_GITHUB_RELEASE_API` | GitHub `releases/latest` endpoint | Update source; set empty to disable GitHub checks |
| `GEARBEACON_UPDATE_MANIFEST_URL` | blank | Optional custom release JSON/API; takes priority over GitHub |
| `GEARBEACON_DEPLOYMENT` | `local` | Set `cloud` for hosted deployment metadata |
| `GEARBEACON_PUBLIC_BASE_URL` | blank | Public/private base URL used by notification/test links |
| `GEARBEACON_MIN_CATALOG_RATIO` | `0.55` | Reject a catalog response below this fraction of the known baseline |
| `GEARBEACON_STALE_AFTER_SECONDS` | max of 180 or 3×poll | Monitor stale threshold |
| `GEARBEACON_LEGACY_DATA_FILE` | auto-discovered | Explicit legacy JSON state file |
| `GEARBEACON_SKIP_LEGACY_IMPORT` | `0` | Disable automatic legacy import |
| `MOCK_MODE` | `0` | Offline demo/test inventory |

## API summary

Monitoring and catalog:

- `GET /api/status`
- `GET /api/health`
- `GET /api/products`
- `GET /api/watchlist`
- `POST /api/watch`
- `DELETE /api/watch/:slug`
- `GET /api/events`
- `POST /api/check`

Notifications:

- `POST /api/push/register`
- `POST /api/push/unregister`
- `GET /api/notifications/preferences`
- `PUT /api/notifications/preferences`
- `POST /api/notifications/test`
- `GET /api/notifications/log`

Persistence and updates:

- `GET /api/data/info`
- `GET /api/data/export`
- `POST /api/data/import`
- `POST /api/data/backup`
- `GET /api/update/check`

## Store integration note

GearBeacon follows publicly reachable data used by the UniFi Store frontend. It does not bypass authentication or anti-bot controls. This is not a guaranteed public API, so GearBeacon deliberately isolates the catalog adapter and uses health guards rather than treating malformed/partial responses as real inventory transitions.

## Trademark note

GearBeacon is an independent project and is not affiliated with or endorsed by Ubiquiti Inc. Ubiquiti and UniFi are trademarks of their respective owner.
