![GearBeacon — Track Ubiquiti gear and get notified when it is back in stock](.github/assets/banner.png)

# GearBeacon

**Know the second it's back.**

GearBeacon monitors Ubiquiti and UniFi Store inventory, lets you watch individual products, and alerts you when meaningful stock events occur. One monitor can serve the web dashboard and mobile clients, avoiding separate store polling from every device.

GearBeacon is an independent project and is not affiliated with or endorsed by Ubiquiti Inc.

## Highlights

- Browse regional UniFi Store catalogs using category tabs, product images, search, pricing, and availability.
- Build a persistent watchlist without tying user data to the application directory.
- Detect restocks, sellouts, price changes, status changes, and newly listed products.
- Send browser, Expo push, ntfy, and Discord notifications.
- Review a timestamped stock-activity history.
- Switch between coordinated light and dark themes.
- Protect existing data with transactional migrations, automatic backups, and import/export tools.
- Reject suspicious or incomplete catalog responses instead of producing mass false alerts.
- Run locally or as an always-on Docker service with health and readiness endpoints.
- Check GitHub Releases for available updates.

## Current deployment model

> [!IMPORTANT]
> GearBeacon currently operates as a single shared watchlist without user authentication. Do not expose port `8787` directly to the public internet. Use a private network, VPN, or authenticated reverse proxy. Per-user accounts, device ownership, and authorization are required before operating it as a public multi-user service.

## How it works

```text
UniFi Store
     │
     ▼
GearBeacon monitor
     │
     ├── catalog validation and health guards
     ├── product-state comparison
     ├── SQLite persistence
     └── event and notification routing
             │
             ├── Web dashboard
             ├── iPhone and Android
             ├── Expo Push
             ├── ntfy
             └── Discord
```

The monitor establishes an inventory baseline, compares later observations with the previous known state, records valid transitions, and notifies only through enabled channels. Restock alerts are enabled by default; noisier event types are opt-in.

## Requirements

- Node.js 22.13 or newer
- A modern browser for the web dashboard
- Docker and Docker Compose only if using the container deployment
- An Expo/EAS project and physical device for remote mobile push notifications

## Quick start

### Offline demonstration

Mock mode uses a small offline catalog and never contacts the UniFi Store.

Windows:

```text
run-mock-windows.bat
```

macOS or Linux:

```bash
./run-mock-mac-linux.sh
```

Open `http://localhost:8787`, browse the catalog, add a watched product, and use **Check now** to exercise the monitor.

### Live inventory

Windows:

```text
run-windows.bat
```

macOS or Linux:

```bash
./run-mac-linux.sh
```

The live monitor uses publicly reachable data exposed to the UniFi Store frontend. The integration is unofficial and can change without notice, so keep the default polling interval unless you have a specific operational reason to adjust it.

## Web interface

The dashboard contains four main areas:

- **Watchlist** — products whose qualifying events can trigger alerts.
- **Browse** — searchable, category-based product catalog with store links and watch controls.
- **Activity** — recorded product transitions and their detection times.
- **Settings** — update checks, notification preferences, push registration, backups, import/export, and storage information.

The theme button in the upper-right switches between light and dark modes and remembers the selection locally.

## Persistent data and safe upgrades

GearBeacon uses Node's built-in SQLite interface. The database lives outside the application directory so application files can be replaced without replacing watched products or settings.

Default data locations:

- **Windows:** `%LOCALAPPDATA%\GearBeacon\gearbeacon.sqlite3`
- **macOS:** `~/Library/Application Support/GearBeacon/gearbeacon.sqlite3`
- **Linux:** `${XDG_DATA_HOME:-~/.local/share}/GearBeacon/gearbeacon.sqlite3`

Mock mode uses `gearbeacon.mock.sqlite3`, keeping demonstrations and tests separate from live state.

Data safeguards include:

- transactional schema migrations;
- an automatic safety backup before application-version migrations;
- retention of the five most recent database backups;
- manual backup creation in Settings;
- JSON export and import for recovery or migration;
- an automatic one-time import path for legacy JSON state.

Import replaces the active monitor state only after GearBeacon creates a safety backup.

## Notifications

GearBeacon can notify through:

- browser notifications while the dashboard is open;
- Expo Push for registered iOS and Android devices;
- an ntfy topic;
- a Discord webhook.

Settings control these event types:

- **Restock** — enabled by default for watched products.
- **Sold out** — optional for watched products.
- **Price change** — optional for watched products.
- **Status change** — optional for watched products.
- **New product** — optional across the selected regional catalog.

Push tokens and notification preferences are stored in SQLite. Invalid Expo tokens reported as `DeviceNotRegistered` are removed automatically, and delivery results are recorded in the notification log.

## Mobile app and remote push

Install the mobile dependencies and start Expo:

```bash
cd mobile
npm install
npx expo install --fix
npx expo start
```

Set `extra.apiBaseUrl` in `mobile/app.json` to a GearBeacon server address that the device can reach. For remote push, create an Expo project and set its EAS project ID:

```json
{
  "expo": {
    "extra": {
      "apiBaseUrl": "https://your-gearbeacon-server.example.com",
      "eas": {
        "projectId": "YOUR_EAS_PROJECT_ID"
      }
    }
  }
}
```

Create a development, preview, or production build using EAS. The included package scripts can create development and preview builds:

```bash
npm run eas:development
npm run eas:preview
```

On the installed app, open **Settings → Remote push notifications**, register the device, and use **Send test notification** to verify delivery. If enhanced Expo push security is enabled, configure `EXPO_ACCESS_TOKEN` on the GearBeacon server.

## Monitoring reliability

GearBeacon favors missing a questionable polling cycle over publishing a false inventory event. Its monitor includes:

- catalog-size sanity checks against the known baseline;
- partial-category failure detection;
- preservation of products omitted from incomplete responses;
- exponential retry backoff, capped at 15 minutes;
- stale-monitor detection;
- duplicate-check protection;
- startup baseline handling that does not alert merely because an item is already available.

Monitor state is reported as healthy, degraded, or stale through the dashboard and API.

## Docker deployment

Start the centralized monitor with:

```bash
docker compose up -d --build
```

The Compose configuration mounts `/data` as the persistent `gearbeacon-data` volume. Rebuilding or replacing the container does not replace the watchlist database.

Health endpoints:

- `GET /healthz` — confirms the process is alive.
- `GET /readyz` — confirms the monitor has a recent successful inventory check.
- `GET /api/health` — returns detailed monitor health information.

See [`deploy/README.md`](deploy/README.md) for deployment notes and the public-access warning.

## Configuration

Copy `.env.example` as a reference and provide variables through your shell, service manager, or container environment.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8787` | Web and API port |
| `REGION` | `us` | Store region: `us`, `eu`, `uk`, or `ca` |
| `POLL_SECONDS` | `60` | Normal polling cadence; minimum 30 seconds |
| `NTFY_TOPIC` | blank | Optional ntfy topic |
| `DISCORD_WEBHOOK_URL` | blank | Optional Discord webhook |
| `EXPO_ACCESS_TOKEN` | blank | Optional Expo Push access token when enhanced push security is enabled |
| `GEARBEACON_DATA_DIR` | OS data folder | Override the persistent data directory |
| `GEARBEACON_GITHUB_RELEASE_API` | Project's latest-release API | Update source; set empty to disable GitHub checks |
| `GEARBEACON_UPDATE_MANIFEST_URL` | blank | Optional custom release manifest or API; takes priority over GitHub |
| `GEARBEACON_DEPLOYMENT` | `local` | Set to `cloud` for hosted deployment metadata |
| `GEARBEACON_PUBLIC_BASE_URL` | blank | Base URL used by notification and test links |
| `GEARBEACON_MIN_CATALOG_RATIO` | `0.55` | Reject catalogs below this fraction of the known baseline |
| `GEARBEACON_STALE_AFTER_SECONDS` | at least 180 or 3× poll | Monitor stale threshold |
| `GEARBEACON_LEGACY_DATA_FILE` | auto-discovered | Explicit legacy JSON state file |
| `GEARBEACON_SKIP_LEGACY_IMPORT` | `0` | Disable automatic legacy import |
| `MOCK_MODE` | `0` | Enable the offline demonstration catalog |

## API reference

### Monitoring and catalog

- `GET /api/status`
- `GET /api/health`
- `GET /api/products`
- `GET /api/watchlist`
- `POST /api/watch`
- `DELETE /api/watch/:slug`
- `GET /api/events`
- `POST /api/check`

### Notifications

- `POST /api/push/register`
- `POST /api/push/unregister`
- `GET /api/notifications/preferences`
- `PUT /api/notifications/preferences`
- `POST /api/notifications/test`
- `GET /api/notifications/log`

### Persistence and updates

- `GET /api/data/info`
- `GET /api/data/export`
- `POST /api/data/import`
- `POST /api/data/backup`
- `GET /api/update/check`

## Project structure

| Path | Purpose |
|---|---|
| `backend/src/` | TypeScript API, monitoring, persistence, and notification source |
| `backend/dist/` | Compiled backend used by local launchers and container images |
| `web/` | Browser dashboard and static assets |
| `mobile/` | Expo/React Native application |
| `scripts/` | Version consistency and end-to-end self-tests |
| `deploy/` | Deployment guidance |
| `.github/workflows/` | Continuous integration and release automation |
| `data/` | Application-local placeholder; persistent runtime data is stored elsewhere |

## Development and verification

Run the end-to-end test from the repository root:

```bash
node --no-warnings scripts/self-test.mjs
```

The test creates an isolated temporary database and verifies migrations, catalog loading, watch and restock behavior, notification preferences, health reporting, backups, export/import, restart persistence, and update-check fallback behavior.

The continuous-integration workflow also runs:

```bash
node scripts/check-versions.mjs
npx --yes -p typescript@5.8.3 tsc -p backend/tsconfig.json
node --check web/app.js
cd mobile
npm install --ignore-scripts --no-audit --no-fund
npx tsc --noEmit
```

CI runs for pushes and pull requests targeting `dev` or `main`.

## Updates and releases

The recommended flow is:

```text
dev → pull request → main → SemVer tag → GitHub Release
```

The release workflow verifies that the tag matches the application metadata, runs the tests, builds a ZIP archive, generates a SHA-256 checksum, and publishes both files to GitHub Releases.

**Settings → Check for updates** queries the project's latest GitHub Release and selects the GearBeacon ZIP asset when one is available. If GitHub is unavailable or no release has been published, the application falls back to its bundled `release-manifest.json`.

Release history belongs in [`CHANGELOG.md`](CHANGELOG.md).

## Store integration and trademarks

GearBeacon follows publicly reachable data used by the UniFi Store frontend. It does not bypass authentication, rate limits, or anti-bot controls. This is not a guaranteed public API, so the store adapter is isolated and catalog responses are validated before they can become inventory events.

GearBeacon is not affiliated with or endorsed by Ubiquiti Inc. Ubiquiti and UniFi are trademarks of their respective owner. The Apache License does not grant permission to use project or third-party trademarks beyond the rights stated in that license.

## License

Copyright 2026 alexphillips-dev.

GearBeacon is licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution and project notices.
