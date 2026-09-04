# GearBeacon changelog

## V1.4.0 — Production alerts & release infrastructure

- Connected **Check for updates** to `alexphillips-dev/GearBeacon` GitHub Releases with bundled-manifest fallback.
- Added GitHub Actions CI for `dev`, `main`, and pull requests.
- Added tag-driven GitHub Release packaging with ZIP + SHA-256 artifacts.
- Added persisted notification preferences for restock, sold-out, price-change, status-change, and new-product alerts.
- Added Expo push registration/unregistration, Expo ticket validation, stale-token cleanup, optional Expo access-token support, and test notifications.
- Added SQLite `notification_log` and schema migration **v3**.
- Added notification settings UI to both browser and mobile clients.
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
- Added theme switching on web/mobile.

## V1.1

- Added category tabs, image-first UniFi Store-style Browse cards, and Ubiquiti-hosted product preview image extraction.
