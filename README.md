![GearBeacon — Track Ubiquiti gear and get notified when it is back in stock](.github/assets/banner.png)

# GearBeacon

**Know the second it's back.**

GearBeacon is a private, self-hosted Ubiquiti and UniFi Store inventory monitor. One installation provides a browser dashboard, regional watchlists, reliable notifications, and an upgrade-safe SQLite database on a Windows PC, Mac, Linux server, NAS, or Docker host.

There is no GearBeacon cloud account, hosted database, public registration, subscription, analytics, or telemetry. GearBeacon is independent and is not affiliated with or endorsed by Ubiquiti Inc.

GearBeacon `1.0.0` is the first stable self-hosted release. The `dev` branch is currently `1.1.0`, the precision monitoring and smart watchlist update under development before promotion to `main`.

## What it does

- Monitors the United States, Canada, Europe, and United Kingdom UniFi Stores from one private installation.
- Keeps separate watchlists, product state, activity, and health for every enabled region.
- Imports watchlists from pasted UniFi Store links, product SKUs/slugs, or TXT, CSV, and JSON files with a regional match-and-confirm review before anything is added.
- Detects restocks, sellouts, price changes, status changes, and newly listed products.
- Confirms potentially destructive changes across two complete observations while keeping fast one-check restock detection and the last-known-good state visible.
- Shows a focused product view with current availability, store details, first/last-seen times, price history, and recent changes.
- Keeps durable, searchable activity with evidence, delivery outcomes, date/type/region filters, pagination, and CSV or JSON export.
- Supports per-product alert overrides, price-drop and target-price rules, immediate restocks, and temporary or indefinite pauses.
- Watches exact product variants by SKU, color, length, or pack size, with independent availability, prices, history, and direct variant links.
- Combines availability and target-price conditions, previews alert decisions, organizes watches into collections, and retains purchased watches with alerts stopped.
- Searches, filters, sorts, selects, pauses, resumes, and removes watched products in bulk.
- Delivers browser, ntfy, Discord, Gotify, SMTP email, or generic webhook alerts.
- Queues delivery durably, retries failures with exponential backoff, and supports grouping, cooldowns, quiet hours, and daily digests.
- Can alert the owner when monitoring, delivery, backups, or available disk space need attention.
- Signs generic webhooks with HMAC-SHA256 and supports optional bearer authentication.
- Configures stores, access, backups, and notification integrations in the browser.
- Encrypts saved notification credentials using a generated installation key stored outside SQLite with restricted permissions.
- Protects private and reverse-proxy installations with a single owner password, versioned scrypt hashing and automatic legacy rehashing, secure sessions, CSRF checks, strict Host/origin validation, bounded HTTP connections, and security headers.
- Validates catalogs, honors upstream retry guidance, and never treats a partial response as a product delisting.
- Creates validated scheduled, manual, pre-import, and pre-update SQLite backups.
- Can copy each backup to a separate disk or mounted share as validated SQLite or a passphrase-encrypted recovery export.
- Exports passphrase-encrypted transfer files, previews imports, and tests primary or secondary restores without changing active data.
- Shows region health, pending confirmations, delivery failures, recovery readiness, storage, security warnings, logs, diagnostics, and exact build information in Operations.
- Downloads a privacy-redacted support bundle without owner credentials, saved notification secrets, local paths, or private addresses.
- Detects updates but never silently downloads or installs one.

## Choose an installation

### Standalone package — easiest

Download the package for your operating system from [GitHub Releases](https://github.com/alexphillips-dev/GearBeacon/releases). It contains its own Node runtime; Node.js does not need to be installed.

- **Windows x64:** run `GearBeacon.exe` directly, or run `install-windows-service.ps1` from an elevated PowerShell window for automatic startup.
- **macOS Intel or Apple Silicon:** run `./gearbeacon`, or use `sudo ./install-macos-service.sh` for a LaunchDaemon.
- **Linux x64 or ARM64:** run `./gearbeacon`, or use `sudo ./install-linux-service.sh` for a hardened systemd service.

The service installers keep the application files administrator/root-owned and run GearBeacon with low-privilege service identities. The uninstallers preserve GearBeacon data by default; their explicit `-RemoveData` or `--remove-data` option is required to delete it. Every release archive includes an adjacent SHA-256 checksum and SPDX JSON SBOM and is covered by GitHub artifact provenance. Release packages are currently unsigned; signing and macOS notarization remain a separate future milestone.

### Source checkout

Requires Node.js 22.13 or newer. No `npm install` is required because the application uses Node's built-in SQLite implementation.

Windows local-only launch:

```text
run-windows.bat
```

macOS or Linux local-only launch:

```bash
chmod +x run-mac-linux.sh
./run-mac-linux.sh
```

Open `http://localhost:8787`.

Use `run-private-windows.bat` or `./run-private-mac-linux.sh` for a trusted LAN or private VPN server. GearBeacon prints a one-time setup token for authenticated first start.

### Docker Compose

```bash
docker compose up -d
docker compose logs gearbeacon
```

Compose first uses the published multi-platform image and can build the included Dockerfile when an image is unavailable. It publishes only `127.0.0.1:8787` on the host by default and persists `/data` in the `gearbeacon-data` volume. Images support `linux/amd64` and `linux/arm64`; the process runs as an unprivileged user with a read-only root filesystem, no Linux capabilities, no-new-privileges, a PID limit, and only `/data` plus a constrained temporary filesystem writable.

To build the checkout explicitly:

```bash
docker compose build
docker compose up -d --no-build --pull never
```

## Guided first run

On a new installation, the browser wizard walks through:

1. Creating the private owner password.
2. Selecting UniFi Store regions and the access mode.
3. Adding optional notification channels.
4. Choosing backup interval and retention, then testing the store and notifications.
5. Reviewing the final URL, security state, and any restart requirement.

In authenticated modes, enter the one-time token printed by the process or container before the wizard. A region, bind-address, or access-mode change is saved safely but requires one restart because it changes process-level listeners. Operational settings take effect immediately.

## Access modes

| Mode | Default bind | Owner password | Use |
|---|---|---|---|
| `local` | `127.0.0.1` | Optional | One computer |
| `private` | `0.0.0.0` | Required | Trusted LAN, private VPN, server, or container |
| `proxy` | `127.0.0.1` | Required | HTTPS reverse proxy on the same host |

GearBeacon refuses an unauthenticated `local` server on a non-loopback address. Do not publish it directly to the unrestricted internet. Prefer WireGuard, Tailscale, or another private VPN. If routed access is necessary, terminate HTTPS at a maintained reverse proxy and restrict firewall sources.

Proxy mode requires a loopback bind and accepts `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` only from that same-host proxy connection. Set an HTTPS public URL so session cookies are `Secure`; forwarded HTTPS responses also receive HSTS.

See [deployment guidance](deploy/README.md) for service installation, Caddy/Nginx examples, recovery, updates, and rollback.

## Data and backup safety

Default data locations:

- Windows source/portable: `%LOCALAPPDATA%\GearBeacon`
- Windows service: `%ProgramData%\GearBeacon`
- macOS portable: `~/Library/Application Support/GearBeacon`
- macOS service: `/Library/Application Support/GearBeacon`
- Linux portable: `${XDG_DATA_HOME:-~/.local/share}/GearBeacon`
- Linux service: `/var/lib/gearbeacon`
- Docker: `/data` in the named volume

The data directory contains the SQLite database, validated backup files, and `secrets.key`. Keep the key with the installation when restoring the database if it contains saved notification credentials. Losing the key does not lose watchlists or history, but encrypted integration secrets must be entered again.

Backups use `PRAGMA integrity_check`, a consistent SQLite `VACUUM INTO` snapshot, and a second integrity check. GearBeacon automatically makes a validated backup before a schema upgrade or import. Encrypted exports use AES-256-GCM with a scrypt-derived key; owner credentials, sessions, and local integration secrets are excluded.

Settings → Data can send scheduled, manual, pre-import, and pre-update backups to an optional secondary directory. Use an absolute path on another disk, NAS share, or mounted Docker volume. GearBeacon validates the destination, refuses symbolic-link destinations, reports when it appears to share the primary data filesystem, and can encrypt every secondary copy with a separately saved passphrase. A secondary-copy failure is reported without discarding a valid primary backup.

Use **Test latest primary** and **Test latest secondary** after setup and periodically afterward. Restore tests open a temporary copy, verify its SQLite integrity or decrypt and validate its export structure, confirm schema compatibility, and leave the running database unchanged. Activity retention is independent of per-product history retention; `0` keeps activity until the owner changes the policy.

## Reliable change detection

Every store check records its outcome and catalog evidence. A restock seen in a complete valid catalog is recorded immediately. Sellouts, ordinary status changes, price changes, and products disappearing from the catalog must match on two complete observations before GearBeacon commits the transition or queues an alert. While confirmation is pending, the dashboard keeps displaying the last-known-good value and Operations shows the candidate and observation count.

A product omitted from two consecutive complete catalogs becomes **Unlisted** rather than being silently removed. A later reappearance is detected immediately. Partial catalogs never advance missing-product evidence. HTTP rate limits honor `Retry-After`, and scheduled retries include jitter so multiple self-hosted installations do not retry in lockstep.

## Notifications

### Exact watches, conditions, and collections

Open a product from Browse and use **Watch a specific variant** to choose a SKU, color, length, or pack size. **Any variant** keeps the original product-level watch behavior. Each exact variant has its own history and confirmation evidence; a selected variant can restock even while another remains available. Variant choices depend on the public regional catalog. Explicit `?variant=` Store links and known variant SKUs retain their selection during import; an unknown explicit variant is reported for review.

After watching an item, set a target price and enable **Alert when available at or below the target price** to combine both conditions. This replaces the separate restock and price-change choices for that watch. A qualifying restock alerts immediately; a price reaching the target while available needs the normal two complete observations. The rule alerts once per qualifying period and rearms after confirmed observations no longer meet the condition. For an Any variant watch, stock and price must match on the same variant. Its notification identifies that matching variant. Prices use the selected Store's currency and the catalog display price; shipping, taxes not already included in that price, and checkout surcharges are not calculated.

**Preview rule & notification** evaluates the unsaved rule without recording activity or delivering an alert. Existing quiet hours, digests, cooldowns, and immediate-restock settings still apply. **All activity updates**, when enabled, continues to override event filters and combined conditions; the preview calls this out. Purchased watches remain stopped.

Use **Watchlist > Manage collections** to create, rename, or delete regional collections. Assign a watch to one or more collections from its alert rules. Filter by collection, then **Select visible watches** to pause or resume those watches in bulk. Collections reference the same watch: overlapping collections do not duplicate notifications, and deleting a collection preserves its watches and history. Independently watching both Any variant and an exact variant creates two separate watches with their own rules.

**Purchased** retains the watch, its rules, and its history while stopping subsequent alerts and cancelling its pending or failed delivery jobs. A delivery already in progress may finish. **Still wanted** restores the saved rules, including any existing pause. Use the Purchased or Still wanted status filters to review these items.

Upgrading to 1.1.0 creates a validated safety backup before schema v8. Existing watches remain Any variant and existing rules keep their behavior until the combined condition is explicitly enabled. New format-v4 recovery exports include exact variants, collections, purchased state, and condition state; older exports remain supported. Keep the pre-upgrade backup for rollback: 1.0.x cannot use a schema-v8 database or a format-v4 export. Stop the service and restore a compatible pre-upgrade backup with its matching encryption key before running the older application.

### Delivery settings

Channel configuration, delivery timing, previews, and individual test buttons are in Settings. A channel can be configured but independently disabled. Restock alerts for watched products are enabled by default; sellout, price, status, and new-product alerts are opt-in. The separate **All activity updates** option alerts for every new Activity feed entry, including changes to unwatched products, and overrides the individual event filters while enabled. It is disabled by default to avoid unexpected notification volume.

Each watched product can inherit those global event choices or override them. Product rules can limit price notifications to drops, wait for a target price, pause alerts, or force restocks to deliver immediately. Immediate restocks bypass quiet hours and digest scheduling. Other queued events can be held until quiet hours end, collected for the next daily digest, and suppressed during a configurable per-product event cooldown.

Normal events are written to a persistent SQLite queue before delivery. Failed attempts use exponential backoff up to the configured limit. Operations shows pending/delivered/failed counts, failure reasons, and an owner-controlled retry action. The optional grouping window combines nearby events for the same region and channel.

SMTP email uses responsive, event-specific HTML with a matching plain-text alternative. Restocks, price targets and drops, sellouts, status changes, new products, operational issues, tests, and grouped digests each have a focused layout. Product details are captured when the event is queued, so delayed alerts describe what GearBeacon actually detected. When a public URL is configured, email can link directly back to the matching product in the private dashboard.

Email appearance controls in Settings offer compact, standard, or detailed layouts; device, light, or dark themes; subject prefixes; price calculations; alert explanations; digest limits; and a desktop/mobile preview rendered by the same code used for SMTP. Product images are embedded inline by default from an exact Ubiquiti host allowlist with strict timeout, content-type, and size limits. Image failures fall back cleanly and never prevent the alert from being sent. Messages contain no tracking pixels, scripts, remote fonts, or analytics.

SMTP port 465 uses implicit TLS. Other SMTP ports require STARTTLS by default, and credentials are never sent on an unencrypted connection. Certificate validation is enabled by default. Messages use `multipart/alternative` for HTML and text, `multipart/related` for inline images, and a unique `Message-ID`.

Generic webhooks receive JSON and, when a signing secret is configured, these headers:

```text
X-GearBeacon-Timestamp: <unix timestamp>
X-GearBeacon-Signature: sha256=<HMAC of timestamp + "." + exact body>
```

Verify the HMAC against the raw request body and reject stale timestamps at the receiver.

## Operations and updates

The Operations page starts with an overall **Healthy**, **Degraded**, or **Action Required** state and links actionable warnings to the relevant Settings tab. The same highest-priority issue appears in a compact owner-attention banner throughout the dashboard. Operations also includes every region's last/next check, product and watch counts, catalog errors and pending confirmations, notification queue outcomes and next delivery, primary and secondary recovery status, database/free-space sizes, security warnings, filtered downloadable logs, runtime architecture, commit, and container image information.

**Run diagnostics** checks database integrity, data/backup directory access, local encryption-key decryption, non-destructive restore readiness, free space, notification failures, store connectivity, and access-mode security. **Support bundle** downloads a redacted JSON snapshot of runtime health, recent checks, configuration state, queue summaries, and application logs. It excludes passwords, tokens, webhook URLs, local filesystem paths, host addresses, and product/watchlist data.

**Check for updates** reads GitHub Releases (or a configured manifest) and shows notes and download links. **Prepare safe update** flushes current state, creates and validates a pre-update backup, and displays the platform command. GearBeacon never performs an unattended update.

Standalone helpers require an explicit backup confirmation flag and validate the release SHA-256 file. Docker updates keep the named data volume. To roll back, stop GearBeacon, restore the validated pre-update SQLite backup, and reinstall or select the previous application/image version.

## Environment configuration

Browser-saved settings are intended for most owners. Environment values seed new installations and remain useful for automation.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8787` | Dashboard/API port |
| `REGIONS` | `us` | Comma-separated `us`, `ca`, `eu`, `uk` |
| `POLL_SECONDS` | `60` | Poll interval; minimum 30 seconds |
| `GEARBEACON_ACCESS_MODE` | `local` | `local`, `private`, or `proxy` |
| `GEARBEACON_BIND_HOST` | mode default | Listening address |
| `GEARBEACON_SETUP_TOKEN` | random | Optional fixed one-time token |
| `GEARBEACON_OWNER_PASSWORD_FILE` | blank | Initial/recovery password file |
| `GEARBEACON_OWNER_PASSWORD` | blank | Initial/recovery password value |
| `GEARBEACON_RESET_OWNER_PASSWORD` | `0` | Apply configured recovery password and revoke sessions |
| `GEARBEACON_PUBLIC_BASE_URL` | blank | Canonical URL and notification link |
| `GEARBEACON_ALLOWED_ORIGINS` | same origin | Extra browser origins |
| `GEARBEACON_COOKIE_SECURE` | URL detection | Force `Secure` cookies |
| `GEARBEACON_DATA_DIR` | OS data folder | Persistent data override |
| `GEARBEACON_BACKUP_INTERVAL_HOURS` | `24` | `0` disables scheduled backups |
| `GEARBEACON_BACKUP_RETENTION` | `10` | Database backups to retain |
| `GEARBEACON_HISTORY_RETENTION_DAYS` | `365` | Change-only product history retention |
| `GEARBEACON_EVENT_RETENTION_DAYS` | `365` | Activity retention; `0` keeps activity indefinitely |
| `GEARBEACON_SECONDARY_BACKUP_DIR` | blank | Absolute recovery directory or mounted share |
| `GEARBEACON_SECONDARY_ENCRYPTED_EXPORTS` | `0` | Encrypt secondary copies; save its passphrase in Settings first |
| `GEARBEACON_NOTIFICATION_MAX_ATTEMPTS` | `5` | Delivery attempt limit |
| `GEARBEACON_NOTIFICATION_GROUP_SECONDS` | `0` | Optional event grouping window |
| `GEARBEACON_NOTIFICATION_COOLDOWN_MINUTES` | `30` | Suppress duplicate product/event alerts during this window |
| `GEARBEACON_TIME_ZONE` | system timezone | IANA timezone for schedules |
| `GEARBEACON_QUIET_HOURS_ENABLED` | `0` | Hold normal alerts during quiet hours |
| `GEARBEACON_QUIET_HOURS_START` / `GEARBEACON_QUIET_HOURS_END` | `22:00` / `07:00` | Local quiet-hours window |
| `GEARBEACON_DIGEST_ENABLED` / `GEARBEACON_DIGEST_TIME` | `0` / `09:00` | Enable and schedule a daily digest |
| `GEARBEACON_ALERT_MONITOR_FAILURES` | `1` | Alert after repeated store-check failures |
| `GEARBEACON_ALERT_NOTIFICATION_FAILURES` | `1` | Alert when a channel exhausts delivery attempts |
| `GEARBEACON_ALERT_BACKUP_FAILURES` | `1` | Alert when a scheduled backup fails |
| `GEARBEACON_ALERT_LOW_DISK` | `1` | Alert when less than 1 GB remains |
| `NTFY_BASE_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | blank | ntfy integration |
| `DISCORD_WEBHOOK_URL` | blank | Discord webhook |
| `GOTIFY_BASE_URL` / `GOTIFY_TOKEN` | blank | Gotify integration |
| `GEARBEACON_WEBHOOK_URL` | blank | Generic webhook |
| `GEARBEACON_WEBHOOK_TOKEN` | blank | Optional bearer token |
| `GEARBEACON_WEBHOOK_HMAC_SECRET` | blank | Optional signing secret |
| `SMTP_HOST` / `SMTP_PORT` | blank / `587` | SMTP server |
| `SMTP_SECURE` | port-based | Implicit TLS |
| `SMTP_STARTTLS` | `1` | Require STARTTLS when not using implicit TLS |
| `SMTP_REJECT_UNAUTHORIZED` | `1` | Validate SMTP certificate |
| `SMTP_USER` / `SMTP_PASSWORD` | blank | SMTP credentials |
| `SMTP_FROM` / `SMTP_TO` | blank | Sender and recipients |
| `GEARBEACON_EMAIL_DETAIL_LEVEL` | `standard` | `compact`, `standard`, or `detailed` email layout |
| `GEARBEACON_EMAIL_EMBED_IMAGES` | `1` | Embed allowlisted product images as inline attachments |
| `GEARBEACON_EMAIL_EXPLAIN_REASON` | `1` | Include why each alert was sent |
| `GEARBEACON_EMAIL_PRICE_CALCULATIONS` | `1` | Show savings or price-increase math |
| `GEARBEACON_EMAIL_DIGEST_MAX_ITEMS` | `12` | Maximum unique products shown per digest, 1–50 |
| `GEARBEACON_EMAIL_SUBJECT_PREFIX` | `[GearBeacon]` | Optional subject prefix, up to 60 characters |
| `GEARBEACON_EMAIL_THEME` | `auto` | `auto`, `light`, or `dark` email colors |
| `GEARBEACON_BUILD_COMMIT` / `GEARBEACON_IMAGE` | blank | Build provenance shown in Operations |
| `GEARBEACON_GITHUB_RELEASE_API` | project releases | Manual update source; blank disables |
| `GEARBEACON_UPDATE_MANIFEST_URL` | blank | Custom update channel |
| `GEARBEACON_MIN_CATALOG_RATIO` | `0.55` | Partial-catalog rejection threshold |
| `GEARBEACON_STALE_AFTER_SECONDS` | at least `180` | Stale monitor threshold |
| `MOCK_MODE` | `0` | Offline demonstration catalog/database |

See [.env.example](.env.example) for a copyable template.

## API and health

Only liveness, readiness, and authentication bootstrap routes work without an owner session in authenticated modes. State-changing authenticated requests also require the session's `X-CSRF-Token`.

- `/healthz`, `/readyz`, `/api/health` — process and monitor health
- `/api/auth/*`, `/api/onboarding/complete` — owner access and setup
- `/api/config`, `/api/config/validate` — sanitized configuration and validation
- `/api/products`, `/api/products/:slug`, `/api/watchlist`, `/api/watch/*`, `/api/watch/import`, `/api/watch/import/preview`, `/api/events`, `/api/check` — regional monitor data, watchlist importing, details, history, and per-product rules
- `/api/collections`, `/api/collections/:id`, `/api/watch/:slug/collections`, `/api/watch/:slug/preview` — regional collections, membership, and previews of unsaved watch conditions
- `/api/activity`, `/api/activity/:id`, `/api/activity/export` — searchable confirmed activity, evidence, pagination, and CSV/JSON export
- `/api/notifications/*` — preferences, scheduling preview, individual tests, queue retry, and delivery history
- `/api/operations`, `/api/operations/diagnostics`, `/api/operations/support-bundle`, `/api/logs` — operational status, installation diagnostics, redacted support data, and filtered logs
- `/api/data/*` — integrity, primary/secondary backup, non-destructive restore testing, export, preview, and import
- `/api/update/check`, `/api/update/prepare` — manual release information and validated preparation

## Development and verification

API clients should treat a returned `slug` as an opaque watch identity and URL-encode it in route parameters. Exact variants additionally expose `parentSlug`, `variantId`, `variantSlug`, and `sku`; use the returned `url` for the Store link. The default product list includes parent products and watched variants. Add `includeVariants=1` to retrieve every retained variant. Product details return the parent and variant choices. Existing parent identities remain valid.

```bash
npm ci
npm run build
npm run check
npm test
npm run test:browser
npm run test:update-helpers
docker compose build
```

CI exercises fresh installs and backup-protected upgrades from V0.1.5–V0.1.7 on Windows, macOS, and Linux; confirmation and unlisting behavior; searchable/exportable activity; primary and encrypted-secondary restore tests; diagnostics and support-bundle redaction; deterministic rate-limit, partial-catalog, restart, storage, key, 500-product, and 10k-activity fault scenarios; real Chrome workflows with axe WCAG scans, keyboard/focus behavior, reduced motion, persistent filters, reset states, offline recovery, copy actions, responsive widths, both themes, product images, rules, scheduling and bulk actions; integration-secret encryption; every notification mock; webhook signing; SMTP STARTTLS; authentication, CSRF, Host/origin, secure-cookie, and forwarded-header behavior; update-helper safety; launcher syntax; real Docker Compose isolation and startup; amd64/arm64 containers; and native standalone packages. CodeQL scans source, while Trivy fails closed on repository secrets and high/critical container vulnerabilities.

Before a stable release, run **Candidate packages** manually with a matching prerelease version such as `1.1.0-rc.1` to create retained Actions artifacts without publishing a release. It uses the exact reusable packaging jobs used by a tag, extracts every archive, starts every native executable, validates the source archive, generates SBOMs, and records attestations.

Prerelease tags such as `v1.1.0-rc.1` must point to a commit on `dev` and never move the stable container `latest` tag. Stable tags such as `v1.1.0` must point to the reviewed commit on protected `main`. Publication also requires successful CI and security workflows at the exact SHA, consistent version/changelog/manifest data, checksummed and rehearsed packages, amd64/arm64 images, SBOMs, and provenance. The GitHub release stays a draft until those steps succeed. Use the [stable release checklist](.github/RELEASE_CHECKLIST.md) for real installation, upgrade, rollback, accessibility, and 24–48 hour soak evidence.

## Project layout

| Path | Purpose |
|---|---|
| `backend/src` / `backend/dist` | Server source and compiled CommonJS application |
| `web` | Browser dashboard and assets |
| `deploy` | Service installers, uninstallers, updaters, and hosting guidance |
| `scripts` | Version, integration, STARTTLS, packaging, and smoke tests |
| `.github/workflows` | Cross-platform CI, security scans, and releases |

Release-specific history belongs in [CHANGELOG.md](CHANGELOG.md), keeping this README current and readable.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md), never in a public issue.

## License and trademarks

Copyright 2026 alexphillips-dev. GearBeacon is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).

Ubiquiti and UniFi are trademarks of their respective owner. The license does not grant permission to use GearBeacon or third-party trademarks beyond applicable law.
