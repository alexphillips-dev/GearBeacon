![GearBeacon — Track Ubiquiti gear and get notified when it is back in stock](.github/assets/banner.png)

# GearBeacon

**Know the second it's back.**

GearBeacon is a private, self-hosted Ubiquiti and UniFi Store inventory monitor. It provides one browser dashboard, one SQLite database, and one central polling service that you control on Windows, macOS, Linux, a home server, NAS, or Docker host.

GearBeacon has no hosted account system, public multi-user service, subscription, analytics, or telemetry. It is an independent project and is not affiliated with or endorsed by Ubiquiti Inc.

## Highlights

- Browse the United States, Canada, Europe, and United Kingdom UniFi Store catalogs.
- Monitor multiple configured regions from one private instance.
- Build separate persistent watchlists for each region.
- Detect restocks, sellouts, price changes, status changes, and new products.
- Send browser, ntfy, Discord, Gotify, email, or generic webhook notifications.
- Protect remote dashboards and API requests with single-owner authentication.
- Store only scrypt password hashes and SHA-256 session-token hashes.
- Reject cross-origin requests and require CSRF tokens for authenticated changes.
- Keep upgrade-safe SQLite data with validated scheduled and on-demand backups.
- Export passphrase-encrypted backup files and preview them before restoring.
- Reject suspicious or incomplete catalog responses rather than creating false events.
- Run directly with Node.js or in an amd64/arm64 Docker container.

## Deployment model

GearBeacon is intentionally a single-owner application. Everyone who signs in to an instance sees that instance's shared regional watchlists and history. There are no public registrations, separate user accounts, or external GearBeacon database.

```text
UniFi Store regions
        │
        ▼
Private GearBeacon instance
        │
        ├── catalog validation and stock comparison
        ├── regional watchlists and SQLite history
        ├── owner authentication and encrypted exports
        ├── browser dashboard
        └── optional self-hosted notification services
```

The default direct launch listens only on `127.0.0.1`. GearBeacon refuses an unauthenticated non-loopback bind unless the emergency insecure override is explicitly enabled.

## Requirements

- Node.js 22.13 or newer for direct Windows, macOS, or Linux operation
- A modern web browser
- Docker Engine and Docker Compose for container operation

No package installation or external application database is required. The backend uses Node's built-in SQLite implementation.

## Quick start

### Local computer

Windows:

```text
run-windows.bat
```

macOS or Linux:

```bash
chmod +x run-mac-linux.sh
./run-mac-linux.sh
```

Open `http://localhost:8787`. Local mode listens only on the same computer and does not require a password unless you create one in Settings.

### Offline demonstration

Mock mode never contacts the UniFi Store:

```text
run-mock-windows.bat
```

```bash
./run-mock-mac-linux.sh
```

### Private LAN or VPN server

Use the private launcher:

```text
run-private-windows.bat
```

```bash
./run-private-mac-linux.sh
```

On first start, GearBeacon prints a random one-time setup token. Open the server address in a browser, enter that token, and create an owner password of at least 12 characters. The token stops working as soon as setup finishes.

Allow TCP port `8787` through the host firewall only for the private network that should reach GearBeacon. A private VPN such as Tailscale or WireGuard is preferable for access away from home. Use HTTPS when traffic crosses an untrusted network.

## Docker

Build and start the included Compose deployment:

```bash
docker compose up -d --build
docker compose logs gearbeacon
```

The logs contain the one-time owner setup token. Open `http://localhost:8787` and complete setup. Compose publishes `127.0.0.1:8787` by default and persists data in the `gearbeacon-data` volume.

Tagged releases also publish multi-platform images to GitHub Container Registry:

```bash
docker pull ghcr.io/alexphillips-dev/gearbeacon:latest
docker run -d \
  --name gearbeacon \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v gearbeacon-data:/data \
  -e GEARBEACON_ACCESS_MODE=private \
  -e GEARBEACON_BIND_HOST=0.0.0.0 \
  ghcr.io/alexphillips-dev/gearbeacon:latest
docker logs gearbeacon
```

The image runs as the unprivileged `node` user and supports `linux/amd64` and `linux/arm64`.

## Access modes

| Mode | Default bind | Authentication | Intended use |
|---|---|---|---|
| `local` | `127.0.0.1` | Optional | One computer |
| `private` | `0.0.0.0` | Required | Trusted LAN, private VPN, container, or server |
| `proxy` | `127.0.0.1` | Required | HTTPS reverse proxy on the same host |

For reverse-proxy deployments, set `GEARBEACON_ACCESS_MODE=proxy`, configure `GEARBEACON_PUBLIC_BASE_URL` with the HTTPS URL, and forward the original `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` headers. Set `GEARBEACON_BIND_HOST=0.0.0.0` only when the proxy reaches GearBeacon over an isolated container network rather than the host loopback interface.

Owner security includes:

- one-time setup token or initial password/password-file provisioning;
- scrypt password hashing with a unique random salt;
- cryptographically random browser sessions whose raw tokens are never stored;
- `HttpOnly`, `SameSite=Strict`, and HTTPS `Secure` cookies;
- CSRF validation for every authenticated state-changing request;
- same-origin CORS by default with an explicit origin allowlist option;
- sign-in throttling, session visibility, individual revocation, and password rotation;
- security response headers and a restrictive Content Security Policy.

## Multiple regions

Use a comma-separated region list:

```text
REGIONS=us,ca,eu,uk
```

The dashboard displays a region selector when more than one is configured. Each region has its own products, watchlist, events, monitor health, retry state, and polling context. Notification preferences are instance-wide.

## Persistent data and backups

Default data locations:

- Windows: `%LOCALAPPDATA%\GearBeacon\gearbeacon.sqlite3`
- macOS: `~/Library/Application Support/GearBeacon/gearbeacon.sqlite3`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/GearBeacon/gearbeacon.sqlite3`
- Docker: `/data/gearbeacon.sqlite3` in the mounted volume

Mock mode uses a separate `gearbeacon.mock.sqlite3` database.

Data safeguards include:

- transactional schema migrations;
- a validated safety backup before application-version migrations;
- a validated safety backup before every import;
- scheduled backups every 24 hours by default;
- configurable retention, defaulting to ten database backups;
- SQLite integrity checks before and after backup creation;
- encrypted AES-256-GCM exports using a scrypt-derived key;
- restore preview showing regional watchlist, product, and event counts;
- an optional plain JSON export for controlled migration workflows;
- one-time import support for older GearBeacon JSON state.

Owner credentials and sessions are never included in exported application data.

## Notifications

Browser notifications work while the dashboard is open. For always-on delivery, configure one or more server-side channels:

- `ntfy`, including a private self-hosted ntfy server and bearer token;
- Discord webhook;
- Gotify;
- SMTP email with implicit TLS or STARTTLS;
- a generic JSON webhook with an optional bearer token.

Restocks are enabled by default for watched products. Sellout, price-change, status-change, and new-product notifications are opt-in. Delivery attempts are recorded in the SQLite notification log.

The generic webhook receives:

```json
{
  "source": "GearBeacon",
  "version": "1.5.0",
  "title": "U7 Pro XGS is back in stock",
  "message": "$299.00 · United States · detected now",
  "event": {},
  "sentAt": "2026-09-04T00:00:00.000Z"
}
```

## Monitoring reliability

The first successful observation establishes a baseline and does not send alerts for products that were already available. Later checks compare exact product state and preserve products missing from a partial response.

Reliability controls include catalog-size sanity checks, partial-category degradation reporting, exponential retry backoff capped at 15 minutes, stale-monitor detection, duplicate-check prevention, startup baselines, and independent health state per region.

Health endpoints:

- `GET /healthz` confirms that the process is alive and intentionally exposes no private state.
- `GET /readyz` confirms that configured regional monitors are current.
- `GET /api/health` returns authenticated detailed monitor health.

## Configuration

Copy `.env.example` as a reference and provide variables through the shell, service manager, or container environment.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8787` | Dashboard and API port |
| `REGIONS` | `us` | Comma-separated `us`, `ca`, `eu`, and/or `uk` |
| `POLL_SECONDS` | `60` | Polling cadence; minimum 30 seconds |
| `GEARBEACON_ACCESS_MODE` | `local` | `local`, `private`, or `proxy` |
| `GEARBEACON_BIND_HOST` | mode-dependent | Listening address |
| `GEARBEACON_SETUP_TOKEN` | random | Optional fixed first-run token |
| `GEARBEACON_OWNER_PASSWORD_FILE` | blank | Preferred initial/reset password source |
| `GEARBEACON_OWNER_PASSWORD` | blank | Optional initial password environment value |
| `GEARBEACON_RESET_OWNER_PASSWORD` | `0` | Reset from configured password once, then disable |
| `GEARBEACON_SESSION_HOURS` | `168` | Owner session lifetime |
| `GEARBEACON_PUBLIC_BASE_URL` | blank | Canonical HTTPS URL and notification link |
| `GEARBEACON_ALLOWED_ORIGINS` | same origin | Extra comma-separated browser origins |
| `GEARBEACON_COOKIE_SECURE` | HTTPS URL detection | Force HTTPS-only session cookies |
| `GEARBEACON_DATA_DIR` | OS data folder | Persistent data override |
| `GEARBEACON_BACKUP_INTERVAL_HOURS` | `24` | Scheduled backup interval; `0` disables |
| `GEARBEACON_BACKUP_RETENTION` | `10` | Number of database backups retained |
| `NTFY_BASE_URL` | `https://ntfy.sh` | Hosted or self-hosted ntfy base URL |
| `NTFY_TOPIC` | blank | ntfy topic |
| `NTFY_TOKEN` | blank | Optional ntfy bearer token |
| `DISCORD_WEBHOOK_URL` | blank | Discord notification webhook |
| `GOTIFY_BASE_URL` / `GOTIFY_TOKEN` | blank | Gotify server and application token |
| `GEARBEACON_WEBHOOK_URL` | blank | Generic JSON notification webhook |
| `GEARBEACON_WEBHOOK_TOKEN` | blank | Optional generic webhook bearer token |
| `SMTP_HOST` / `SMTP_PORT` | blank / `587` | SMTP notification server |
| `SMTP_SECURE` | auto for port 465 | Use implicit TLS; port 587 upgrades with STARTTLS when offered |
| `SMTP_USER` / `SMTP_PASSWORD` | blank | Optional SMTP credentials; never sent without TLS |
| `SMTP_FROM` / `SMTP_TO` | blank | Sender and comma-separated recipients |
| `GEARBEACON_GITHUB_RELEASE_API` | project releases | Manual update-check source; blank disables |
| `GEARBEACON_UPDATE_MANIFEST_URL` | blank | Custom update manifest/API override |
| `GEARBEACON_MIN_CATALOG_RATIO` | `0.55` | Reject unexpectedly small catalogs |
| `GEARBEACON_STALE_AFTER_SECONDS` | at least 180 | Monitor stale threshold |
| `MOCK_MODE` | `0` | Offline demonstration catalog |

See [deployment guidance](deploy/README.md) for Windows, macOS, Linux, Docker, LAN/VPN, and reverse-proxy examples.

## API

Only `/healthz`, `/readyz`, `/api/auth/status`, `/api/auth/setup`, and `/api/auth/login` are reachable before authentication. All catalog, watchlist, history, notification, update, and data-management routes require the owner session in authenticated modes.

State-changing authenticated API requests require the session's `X-CSRF-Token`. Region-aware routes accept `?region=us`, `?region=ca`, `?region=eu`, or `?region=uk` when configured.

Main route groups:

- `/api/auth/*` — setup, login, logout, password, and sessions
- `/api/status`, `/api/health` — monitor and privacy state
- `/api/products`, `/api/watchlist`, `/api/watch/*`, `/api/events`, `/api/check`
- `/api/notifications/*` — preferences, test, and delivery log
- `/api/data/*` — database information, backup, export, preview, and import
- `/api/update/check` — owner-initiated release check

## Development and verification

From the repository root:

```bash
node scripts/check-versions.mjs
npx --yes -p typescript@5.8.3 tsc -p backend/tsconfig.json
node --check web/app.js
node --no-warnings scripts/self-test.mjs
docker build -t gearbeacon:test .
```

The end-to-end test uses temporary databases and verifies safe bind refusal, owner setup/login, password and session hashing, CSRF/origin defenses, multi-region isolation, stock events, SQLite integrity, validated backups, encrypted restore, restart persistence, migration backups, and update fallback behavior.

CI runs for pushes and pull requests targeting `dev` or `main`. Tagged releases produce a ZIP, SHA-256 checksum, and multi-platform GHCR image.

## Project structure

| Path | Purpose |
|---|---|
| `backend/src/` | TypeScript server, authentication, monitoring, persistence, and notifications |
| `backend/dist/` | Compiled backend used by launchers and containers |
| `web/` | Browser dashboard and static assets |
| `scripts/` | Version consistency and end-to-end verification |
| `deploy/` | Self-hosting and security guidance |
| `.github/workflows/` | CI and release automation |

Release history is in [CHANGELOG.md](CHANGELOG.md).

## Store integration and trademarks

GearBeacon follows publicly reachable data used by the UniFi Store frontend. It does not bypass authentication, rate limits, or anti-bot controls. This is not a guaranteed public API, so catalog responses are validated before they become inventory events.

GearBeacon is not affiliated with or endorsed by Ubiquiti Inc. Ubiquiti and UniFi are trademarks of their respective owner. The Apache License does not grant permission to use project or third-party trademarks beyond the rights stated in that license.

## License

Copyright 2026 alexphillips-dev.

GearBeacon is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution and project notices.
