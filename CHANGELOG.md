# GearBeacon changelog

## V1.5.0 — Private self-hosting and web-only operation

- Made GearBeacon an explicitly private, single-owner, self-hosted web application for Windows, macOS, Linux, servers, NAS systems, and Docker.
- Removed the separate client application, its dependencies, push registration API, push-token persistence, and related CI/release paths.
- Added safe `local`, authenticated `private`, and authenticated `proxy` access modes.
- Changed direct-launch defaults to loopback and added fail-closed refusal for unauthenticated non-loopback binding.
- Added one-time owner setup, password-file/environment provisioning, and controlled password recovery.
- Added scrypt password hashing, timing-safe comparison, sign-in throttling, hashed session tokens, CSRF validation, secure cookie attributes, session inspection/revocation, and password rotation.
- Replaced wildcard CORS with same-origin enforcement, optional explicit origins, a restrictive Content Security Policy, and standard browser security headers.
- Added simultaneous monitoring for configured `us`, `ca`, `eu`, and `uk` regions with isolated watchlists, histories, health, and retry state.
- Added self-hosted ntfy URL/token support, Gotify, SMTP email, and authenticated generic JSON webhooks while retaining Discord and browser alerts.
- Added SQLite integrity checks, validated scheduled backups, configurable retention, AES-256-GCM encrypted exports, and restore previews.
- Added an in-dashboard outbound-connection report and explicit no-telemetry/no-public-cloud status.
- Changed Docker Compose to loopback-only host publishing, hardened the image to run as an unprivileged user, and added multi-platform GHCR release publication.
- Added private-server launchers and expanded Windows, macOS, Linux, Docker, VPN, and reverse-proxy deployment guidance.

## V1.4.0 — Production alerts & release infrastructure

- Connected **Check for updates** to `alexphillips-dev/GearBeacon` GitHub Releases with bundled-manifest fallback.
- Added GitHub Actions CI for `dev`, `main`, and pull requests.
- Added tag-driven GitHub Release packaging with ZIP + SHA-256 artifacts.
- Added persisted notification preferences for restock, sold-out, price-change, status-change, and new-product alerts.
- Added SQLite `notification_log` and schema migration **v3**.
- Added notification settings UI to the browser dashboard.
- Added new-product discovery events after a catalog baseline exists.
- Added catalog-size health guard, partial-response degraded health, stale-monitor detection, and exponential retry/backoff.
- Added `/healthz`, `/readyz`, and `/api/health` health endpoints.
- Added Dockerfile, Docker Compose, persistent cloud volume, and deployment guidance for a centralized always-on monitor.
- Preserved V1.3 external SQLite data, automatic pre-update backups, migrations, import/export, and watchlist safety.

## V1.3.0 — Upgrade-safe persistence

- Replaced application-folder JSON persistence with SQLite.
- Moved runtime user data to the operating system's per-user application-data folder.
- Added transactional database migrations and automatic pre-update safety backups.
- Added Export / Import, version information, and the original update-check foundation.

## V1.2

- Unified neutral dark/light theme across GearBeacon.
- Added theme switching on the web dashboard.

## V1.1

- Added category tabs, image-first UniFi Store-style Browse cards, and Ubiquiti-hosted product preview image extraction.
