# GearBeacon agent guide

This file applies to the entire repository. Follow it for every change unless the user gives more specific instructions.

## Product direction

GearBeacon is a private, single-owner, self-hosted UniFi Store inventory monitor. It runs on Windows, macOS, Linux, NAS/server hosts, and Docker and is operated through a responsive web browser.

Preserve these boundaries:

- Do not turn GearBeacon into a hosted public cloud service, subscription service, multi-tenant platform, or telemetry product.
- Do not add a native mobile application. Mobile browser support is required.
- Do not require a GearBeacon, Ubiquiti, or other third-party cloud login.
- Do not add unofficial UniFi account sign-in, account scraping, automated purchasing, checkout automation, or storage of store credentials unless the user explicitly changes the product direction.
- Keep monitoring and notification processing server-side so a browser does not need to remain open.
- Keep the application independent from Ubiquiti and retain the existing trademark disclaimer.

## Repository and release policy

- Work on `dev`. Do not merge or push changes to `main` unless the user explicitly asks to prepare or publish the stable release.
- `main` is protected and reserved for reviewed stable-release commits. Do not change branch protection, bypass checks, force-push, rewrite history, create tags, or publish a GitHub Release without explicit approval.
- The `0.1.x` line is pre-1.0 development. The first release promoted to `main` is intended to be `1.0.0`.
- Use semantic versions. Derive the current version from the repository; do not assume this document contains the latest patch number.
- Prerelease tags belong on `dev`. Stable tags belong on the exact reviewed `main` commit and must follow `.github/RELEASE_CHECKLIST.md`.
- Keep `package.json`, `package-lock.json`, `backend/package.json`, `backend/src/index.ts`, `release-manifest.json`, visible UI version text, changelog headings, tests, package paths, and workflow examples consistent when changing versions. `npm run check` enforces the core contract.
- Record user-visible changes under the current version in `CHANGELOG.md`. Keep `README.md` focused on current behavior rather than a version-by-version narrative.
- Use `alexphillips-dev` as the Git author/committer display name and the repository's existing GitHub noreply address. Do not add a personal name or private email address to files or commit metadata.
- Normal implementation work may be committed and pushed to `dev` after appropriate validation. Do not monitor post-push GitHub Actions unless the user asks or the task specifically requires a remote CI result.

## Privacy and local data

The GitHub repository is public. Treat every tracked file, commit message, test fixture, workflow log, artifact, and support example as public information.

- Never read, copy, modify, stage, or commit the owner's live data unless the user explicitly asks for a narrowly scoped operation.
- Windows source/portable data is normally under `%LOCALAPPDATA%\GearBeacon`, outside this checkout. Other platform paths are documented in `README.md`.
- Live data may contain `gearbeacon.sqlite3`, SQLite WAL/SHM files, backups, `secrets.key`, owner credentials, sessions, watchlists, private URLs, notification endpoints, and delivery history. None belongs in Git.
- Never commit `.env`, environment-specific Compose overrides, databases, backups, exported GearBeacon JSON, keys, certificates, logs, support bundles, notification endpoints, tokens, passwords, private hostnames/IP addresses, or absolute user paths.
- `.env.example` must contain blank or unmistakably fake values only.
- Use generated temporary directories and mock credentials in tests. Never point tests at the owner's normal application-data directory.
- If a new runtime file type is introduced, add a safe ignore rule before generating it in the checkout.
- Keep support bundles privacy-redacted. They must exclude credentials, tokens, webhook URLs, local paths, host addresses, and watchlist/product data.
- Do not weaken secret encryption, key-file permission checks, session protection, CSRF/origin validation, secure-cookie behavior, or security headers.

Before any push, inspect `git status`, the staged diff, and tracked filenames for accidental local data. If sensitive data may have entered history, stop, report the exact scope without echoing the secret, and ask before rotating credentials or rewriting shared history.

## Architecture and source of truth

- `backend/src/` is the server source. It uses TypeScript compiled as CommonJS for Node.js.
- `backend/dist/index.js` and `backend/dist/email.js` are committed generated output. Never hand-edit them; run `npm run build` after changing the corresponding source and commit the resulting output.
- `web/index.html`, `web/app.js`, and `web/styles.css` are a framework-free browser interface. Preserve the ID-based HTML/JavaScript contract checked by `scripts/check-web-contract.mjs`.
- `scripts/` contains deterministic integration, fault, browser, update, live-catalog, packaging, and standalone tests.
- `deploy/` contains service installation, removal, and explicit update helpers. Updates must remain owner-initiated and backup-confirmed.
- `.github/workflows/` contains pinned CI, security, package, canary, and release automation. Keep third-party actions pinned to full commit SHAs.
- Source installations require Node.js 22.13 or newer; CI uses the versions declared in workflows. Standalone SEA packaging uses the newer Node version declared by the packaging workflow.
- Avoid adding runtime dependencies when the Node standard library is sufficient. Preserve the small, auditable self-hosted footprint.

## Persistence and monitoring invariants

- Runtime state belongs in the operating system's application-data directory or the Docker `/data` volume, never the application directory by default.
- SQLite schema migrations are append-only and transactional. Do not edit the meaning of an already-shipped migration. Create and validate a safety backup before schema or version migration.
- Preserve upgrade compatibility, watchlists, rules, history, settings, encrypted secrets, and owner access. Keep legacy early-development data discovery working unless a documented migration deliberately replaces it.
- A complete valid catalog may confirm a restock immediately.
- Sellouts, price/status changes, and catalog disappearance require two matching complete observations.
- Preserve the last-known-good value while a change is pending.
- Two complete omissions produce `Unlisted`; partial catalogs must never advance missing-product evidence.
- Honor `Retry-After`, retain exponential backoff/jitter, and do not let transient upstream failures generate false stock events.
- Notification jobs must be durable before delivery, bounded in retry behavior, and auditable through Operations.
- Backups must use SQLite integrity checks and consistent snapshots. A secondary-copy failure must not invalidate a successful primary backup.

## UI and accessibility invariants

The primary navigation order is:

1. Watchlist
2. Browse
3. Activity
4. Settings

The Settings subtab order is:

1. General
2. Notifications
3. Data
4. Security
5. Privacy
6. Operations

Operations must remain the final Settings subtab rather than a primary tab. Preserve old saved `operations` navigation and `#operations` links by routing them to Settings > Operations.

For interface work:

- Preserve responsive operation at a 390-pixel viewport and at 200% browser zoom without horizontal page overflow.
- Maintain keyboard tab navigation, roving focus for tablists, visible focus indicators, dialog focus containment/restoration, Escape behavior, semantic labels, and live status announcements.
- Support both dark and light themes and `prefers-reduced-motion`.
- Keep product images visible and retryable. Hovering a product-dialog backdrop must not change it into an opaque gray surface.
- Keep primary navigation controls unclipped on hover.
- Keep Activity rows at their tested compact 64-pixel height on desktop and mobile; fit additional detail horizontally or through accessible titles/dialogs.
- Keep product-dialog actions compact and consistently sized with the adjacent UniFi Store action.
- Keep Browse availability text readable and preserve the outlined red `Sold out` treatment.
- Keep the bottom-right To top control keyboard-accessible, contained on mobile, and animated with the tested slow fade. Honor reduced-motion preferences.
- Do not solve layout issues by hiding important information from assistive technology.

## Security and external access

- Safe default access is loopback-only local mode. Never allow unauthenticated local mode to bind beyond loopback.
- Private/VPN and reverse-proxy modes require owner authentication. Proxy trust, HTTPS origin, forwarded headers, HSTS, and secure cookies must remain explicit and fail closed.
- Never silently download or install an application update.
- Catalog fetching is read-only. Keep exact Ubiquiti host allowlists for image fetching and enforce timeout, content-type, redirect, and size limits.
- Keep SMTP STARTTLS/certificate validation secure by default. Never send SMTP credentials over an unencrypted connection.
- Keep generic webhook HMAC signing based on the exact body and timestamp.
- Do not send telemetry, analytics, watchlists, credentials, or installation details to GearBeacon-controlled infrastructure.

## Validation

Choose validation proportional to the change, but do not skip the contract checks for code changes.

Baseline after source or UI changes:

```bash
npm run build
npm run check
```

Backend, persistence, monitoring, notification, security, backup, or migration changes:

```bash
npm test
```

UI, CSS, navigation, accessibility, focus, dialog, image, or responsive changes:

```bash
npm run test:browser
```

Installer or updater changes:

```bash
npm run test:update-helpers
```

Docker changes should also build and start the Compose stack with mock mode and a temporary test data volume. Validate shell syntax on non-Windows scripts and PowerShell parsing on Windows scripts.

`npm run test:live-catalog` contacts the real UniFi Stores. Run it only for catalog/parser/network changes, release validation, or when explicitly requested. It must remain read-only, credential-free, and unable to create watches or send notifications.

Before a release candidate, use the complete CI/security/package matrix and `.github/RELEASE_CHECKLIST.md`; local tests do not replace real Windows, macOS, Linux, Docker, upgrade, rollback, accessibility, and soak evidence.

## Change discipline

- Read the affected implementation and its tests before editing.
- Keep changes focused and preserve unrelated user work in a dirty tree.
- Add deterministic regression coverage for every bug fix or behavior change.
- Prefer mock-mode fixtures over live services. Never make tests depend on notification accounts or private infrastructure.
- Preserve clear error messages without leaking stack traces, filesystem paths, credentials, or internal exception details to browser clients.
- Update documentation when installation, configuration, security, recovery, or user-visible behavior changes.
- Report what changed, what was validated, the commit pushed, and any remaining limitation. Never claim remote checks passed unless they were actually inspected.
