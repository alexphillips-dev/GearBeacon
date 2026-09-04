# GearBeacon changelog

## V1.10.0 — Release readiness, accessibility, and trust

- Locked TypeScript, axe-core, postject, Node build versions, GitHub Actions, security scanners, Docker build actions, and the multi-platform runtime image to reviewable versions or immutable identities.
- Added manually dispatched candidate packages that use the same reusable Windows, macOS, Linux, and source packaging path as tagged releases without creating a public release.
- Added archive extraction and real executable startup rehearsals for every standalone package plus extracted-source validation before an artifact can be published.
- Added SPDX JSON software bills of materials and GitHub artifact attestations for downloadable packages, with registry SBOM and maximum provenance for multi-platform container images.
- Added fail-closed release policy checks for version, manifest, changelog, source branch, and successful CI and security runs at the exact tag commit.
- Restricted prerelease tags to `dev` commits and stable tags to protected `main` commits, while keeping a release draft until all packages, images, and attestations succeed.
- Added cross-platform tests proving update helpers refuse to run without an explicit validated-backup confirmation.
- Added a weekly and manually dispatchable read-only live catalog canary for the US, Canada, Europe, and UK with temporary storage, structural checks, and no watchlist or notification configuration.
- Updated Canada, Europe, and UK monitoring and product links to their direct regional Store hosts after the canary exposed redirect loops on the shared host.
- Added automated axe WCAG scans for owner setup and primary workflows, keyboard navigation for main tabs, improved dialog focus containment, explicit tab/panel semantics, status announcements, accessible filter names, and corrected small-text contrast.
- Added deterministic checks for reduced motion, keyboard focus, dialog behavior, responsive reflow, product images, and both color themes to the real Chrome suite.
- Added Dependabot coverage for npm tooling, GitHub Actions, and Docker plus security reporting, contribution, issue, pull-request, and real-install release-checklist guidance.

## V1.9.0 — Daily-use polish and fault testing

- Preserved the selected main tab, Settings subsection, Browse filters, Watchlist filters, and Activity filters across browser refreshes using local browser storage only.
- Added clear reset actions to every filtered view and specific no-match explanations for Browse, Watchlist, and retained Activity results.
- Added explicit browser-offline, reconnecting, and connection-restored feedback while preserving the last successfully loaded dashboard state.
- Added one-click copy actions for product SKUs and UniFi Store links, plus visually distinct success and failure feedback for dashboard actions.
- Added deterministic mock-only fault controls and an automated reliability suite covering HTTP 429 `Retry-After`, repeated partial catalogs, oscillating observations, pending-confirmation restarts, and queued-notification restarts.
- Added automated recovery failure coverage for unavailable secondary storage, corrupt primary and encrypted backups, and missing or incorrect local encryption keys.
- Added scale coverage for 500-product catalogs and more than 10,000 retained Activity rows, including pagination and the disclosed 10,000-row export cap.

## V1.8.0 — Reliability, history, and recovery

- Added persisted two-observation confirmation for sellouts, price changes, status changes, and delistings while preserving a one-observation fast path for restocks from complete, valid catalogs.
- Preserved last-known-good product values while a change is pending, exposed pending evidence in Operations, and made unlisted products explicit after two complete catalogs omit them.
- Added persisted monitor-check evidence, upstream `Retry-After` handling, and randomized retry timing to reduce false alerts and avoid synchronized request bursts.
- Rebuilt Stock activity as a durable, searchable history with region, change-type, date, product/SKU, and notification-outcome filters, configurable retention, pagination, and CSV or JSON export.
- Added an activity evidence drawer showing the confirmation policy, observation count, first-observed and confirmed times, notification outcome, and direct links to the product and UniFi Store.
- Added optional secondary recovery copies to a separate absolute directory or mounted share, with validated SQLite or passphrase-encrypted export formats, automatic retention, and same-filesystem warnings.
- Added non-destructive restore tests for primary and secondary backups and kept primary backups successful when an unavailable secondary destination fails.
- Added one-click installation diagnostics for database integrity, directory access, encryption-key readability, restore readiness, free space, delivery health, store connectivity, and access security.
- Added a privacy-redacted support bundle, a persistent owner-attention banner for operational issues and reconnects, and richer recovery status throughout Operations and Data settings.
- Added schema-v7 migration and verified fresh installs plus automatic, backup-protected upgrades from V1.5, V1.6, and V1.7.
- Added release-candidate publication support so prerelease tags create GitHub prereleases without replacing the stable `latest` container tag.

## V1.7.0 — Watch intelligence and alert control

- Added a Watchlist-page importer for pasted UniFi Store links, product SKUs/slugs, and TXT, CSV, or JSON files, with regional catalog matching, duplicate and already-watched detection, review-before-add selection, and non-destructive bulk import.
- Enriched the Stock activity feed with exact before/after transitions, price movement, prior-state duration, region context, exact detection times, and server-alert outcomes while preserving the compact 64-pixel row height across desktop and mobile.
- Fixed the product-detail backdrop changing to an opaque gray or light button background when hovered.
- Fixed the main navigation tabs lifting into and being clipped by their scroll container on hover.
- Rebuilt SMTP notifications as responsive, event-specific HTML emails with equivalent plain-text parts, inline branding, secure optional product-image embedding, unique message IDs, and graceful image fallbacks.
- Added dedicated restock, target-price, price-drop, sellout, status-change, new-product, digest, operational, and test-email presentations with captured detection-time details and price calculations.
- Added email appearance settings for density, theme, subject prefix, explanations, price calculations, embedded images, and digest limits, plus same-renderer desktop/mobile previews and email-only test delivery.
- Added private dashboard product deep links from email and immutable alert snapshots so queued messages retain product imagery, trigger reason, targets, prices, status, timezone, and original links.
- Added product detail drawers with a larger image, price and availability, SKU, store link, first-seen and last-change times, price history, and recent changes.
- Added change-only product observations in SQLite with configurable retention, automatic pruning, and encrypted export/import support.
- Added per-product alert rules for restocks, sellouts, price/status changes, price drops, target prices, immediate restocks, and temporary or indefinite pauses.
- Added watchlist search, availability/category filters, six sorting modes, rule summaries, recent-change indicators, selection, and bulk pause/resume/remove actions.
- Added debounced Browse search, paged card rendering, loading skeletons, image fallbacks and retry, and render caching so ten-second refreshes do not rebuild unchanged cards.
- Added timezone-aware quiet hours, daily digests, event cooldowns, immediate-restock override, and an in-browser delivery preview.
- Added optional operational alerts for repeated monitor failures, terminal notification failures, scheduled backup failures, and low disk space.
- Reorganized backup/history controls into Data and delivery scheduling into Notifications, and added a Healthy/Degraded/Action Required Operations summary with linked remediation.
- Added real headless-browser coverage for private setup/login/logout, dark/light themes, product images, Browse filters and loading, watch/rule/bulk flows, settings tabs, backup preview/import, Operations, sessions, and responsive layout.
- Added a schema-v6 migration with automatic pre-update backup, exact-host image scoring, generic public 500 errors, a smaller Node 24 Alpine runtime image without package-manager tooling, and improved native standalone startup diagnostics.

## V1.6.0 — Easier setup and self-hosting

- Added a five-step browser first-run wizard for owner security, regions, access mode, notifications, backups, live tests, and a final security summary.
- Added validated browser configuration for monitoring, access, backup retention, and every supported server notification channel.
- Added AES-256-GCM encryption for stored notification credentials using a generated restricted-permission key outside SQLite.
- Added individually enabled/testable ntfy, Discord, Gotify, generic webhook, and SMTP channels.
- Added a durable SQLite notification queue with attempt limits, exponential backoff, manual retry, failure reporting, and optional grouping.
- Added HMAC-SHA256 generic webhook signatures and strict SMTP STARTTLS/certificate controls.
- Added an Operations dashboard with per-region health, check timing, counts, notification outcomes, backup integrity/history, storage, security warnings, logs, and build provenance.
- Added owner-controlled update preparation with a validated backup, release notes, platform commands, explicit confirmation, checksum validation, and rollback guidance.
- Added Node single-executable packages for Windows x64, macOS x64/ARM64, and Linux x64/ARM64 with service installers and data-preserving uninstallers.
- Added prebuilt amd64/arm64 Compose images while retaining source builds and loopback-only host publication.
- Expanded CI across Windows, macOS, Linux, Compose, amd64/arm64 containers, standalone binaries, database upgrades, reverse-proxy security behavior, all notification mocks, STARTTLS, CodeQL, and Trivy.

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
