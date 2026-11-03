# GearBeacon v1.4.2 — Reliable actions, monitoring, delivery, and deployment

This patch includes every change since the last main release, v1.4.1. GearBeacon remains a private, single-owner, self-hosted UniFi Store monitor. Monitoring and notification delivery continue on the server while the browser is closed.

## Watchlist and restock dates

- Set up auto-buy stays directly above Alert rules, Purchased, and Remove in a shared bottom action area. Collection chips and variable product details stay above the actions. Grid, compact, and mobile layouts retain all controls.
- Watched products announce a newly published restock date after two matching complete Store observations, including dates published alongside a sellout. Global and per-watch controls apply to server channels, browser notifications, grouped messages, and email. Changed or removed dates also require confirmation.
- Restock dates are confirmed independently from sellout status, including when the date first appears or changes on the second sellout check. Insights count actual restocks without counting date announcements as stock availability.
- Health freshness follows the configured polling interval after settings changes and startup.

## Delivery, restore, and privacy

- SMTP connection and TLS setup have bounded deadlines so a stalled mail server cannot block the delivery worker indefinitely. A successful final DATA response counts as accepted even if QUIT fails, preventing that cleanup failure from resending a message.
- Restore preview and import reject malformed product records before creating a backup or changing application state. Valid legacy snapshots remain supported.
- Support bundles redact IPv6 addresses and address fields alongside existing IPv4 redaction.

## Native deployment and tooling

- Linux/macOS installation and updates explicitly set readable web-file permissions under restrictive administrator umasks, while private data permissions remain separate.
- Native installers preserve build-info.json so prerelease versions, update channels, and source commits remain identifiable. Reinstallation removes stale metadata when the package does not include it.
- Windows Scheduled Task launchers forward the application exit code. Existing task installations need the updated installer rerun; replacing application files alone does not update the launcher.
- Updated pinned CI/security actions, Playwright, axe-core, and container security packages. Added deterministic regression coverage for these monitoring, delivery, restore, privacy, and deployment fixes.
- Displayed versions, changelog headings, update messages, and GitHub release titles consistently use a lowercase `v` prefix. Container builds install the fixed Alpine musl, musl-utils, and zlib packages alongside OpenSSL updates.

## Upgrading from v1.4.1

1. Prepare and verify a backup before replacing application files. Retain the compatible database and matching installation key for rollback.
2. Install the matching v1.4.2 server files or image. If you use the optional checkout companion, update it from the matching Source archive and keep its private vault with the original account.
3. Restart GearBeacon and hard-refresh the dashboard. Rerun the matching Windows installer if the Scheduled Task launcher needs updating.
4. SQLite schema v15 and portable export format v10 remain unchanged. Existing watches, rules, collections, history, settings, encrypted integrations, and owner access are retained.

Source installations require Node.js 22.13 or newer. The optional auto-buy feature remains experimental and requires explicit owner authorization, a reusable saved payment method, and a separately running companion. Automated checkout validation uses isolated fixtures; real-account compatibility remains dependent on owner setup. This change does not initiate an update or purchase.

See [the changelog](CHANGELOG.md) for earlier versions and [.github/RELEASE_CHECKLIST.md](../.github/RELEASE_CHECKLIST.md) for candidate and stable publication requirements.

[Full comparison: v1.4.1…v1.4.2](https://github.com/alexphillips-dev/GearBeacon/compare/v1.4.1...v1.4.2)

GearBeacon remains independent from Ubiquiti. UniFi and Ubiquiti are trademarks of Ubiquiti Inc.
