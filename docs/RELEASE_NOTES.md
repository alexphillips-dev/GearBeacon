# GearBeacon 1.4.1 — Delivery recovery and safer state changes

This patch includes every change since the last main release, v1.4.0. GearBeacon remains a private, single-owner, self-hosted UniFi Store monitor. Monitoring and notification delivery continue on the server while the browser is closed.

## Notification recovery and Operations

- **Resolve failed deliveries:** Settings > Operations > Delivery now offers Retry failed, Dismiss, and Dismiss all failed. The attention banner opens that section. Dismissal clears the active warning and keeps the failed attempt in Activity and the delivery log; it does not send or recall a message.
- **Recover after a connection outage:** after a failed Store check, the next successful, complete check requeues eligible network-related terminal delivery failures for one more bounded retry cycle. The recovery window survives partial catalogs and service restarts. Expired alerts and channels that are no longer allowed remain ineligible. Credential or other permanent failures still need correction and manual retry.
- **Stay current without losing focus:** Operations refreshes counts and warnings during background polling and after the connection returns while preserving keyboard focus.

See [notification delivery and recovery](https://github.com/alexphillips-dev/GearBeacon/blob/v1.4.1/docs/ALERT_DELIVERY.md) for the controls, retry limits, and manual recovery path.

## Monitoring, watches, and purchase state

- The Store request timeout now covers response-body parsing, so a stalled response cannot hold the monitor loop indefinitely.
- Each successful Store check commits product state, observation evidence, Activity events, and queued delivery jobs together. A failed commit cannot leave a recorded stock event with stale product state.
- Adding a watch and its alert rule now commits as one operation. Single and bulk watch removals, bulk pause/resume/purchased/wanted actions, product alert settings, and auto-buy arming commit their related database changes together. If a write fails, the request leaves watches, rules, collection purchase state, and delivery state unchanged.
- Removed a redundant delayed whole-state save after watch changes. It could previously fail after an otherwise successful request when another SQLite writer held a lock.

## Backups, restore, and local security

- Primary SQLite backups become visible only after validation; failed copies are removed. A secondary-copy failure does not invalidate a successful primary backup.
- Backup retention and abandoned-temp cleanup recognize only GearBeacon-owned copies. Secondary copies now carry an installation ID, so one installation leaves another installation's files alone. Old copies recorded in backup history remain available; unrecorded older copies may need manual cleanup. Abandoned primary and secondary temporary files are removed only when at least a day old and their creating process has exited.
- Secondary retention leaves unrelated files in a shared destination alone. GearBeacon no longer changes permissions on an existing secondary directory; plaintext copies receive owner-only file permissions on Unix.
- Portable restore rejects incompatible regions before changing purchase state and rolls back all regions and settings together if the restore fails.
- The optional Windows checkout companion now protects its vault with private ACLs and an account-scoped DPAPI key. A writable open migrates an older raw key without replacing its underlying key bytes. The vault must stay with its original Windows account or use the documented recovery process.

## Windows installation and diagnostics

- Reinstalling the Windows service now replaces the web assets without nesting another web directory or keeping obsolete pages.
- Source launchers no longer display a stale version. Malformed API paths return a client error.
- Added deterministic coverage for watch and rule write failures, backup ownership and cleanup, restore rollback, outage recovery, Windows vault migration, service web replacement, and update startup behavior. CI includes the Windows checkout vault test.

## Upgrading from v1.4.0

1. In Settings > General, choose Prepare safe update and confirm the backup before replacing application files. Keep a compatible database and the separate installation key for rollback.
2. Install the matching 1.4.1 server files or image and restart GearBeacon. If you use the optional checkout companion, update it from the matching 1.4.1 Source archive and keep its private vault with the original Windows account.
3. Hard-refresh the dashboard. Review Settings > Operations > Delivery for failures left by an outage; correct permanent channel errors before using Retry failed.
4. GearBeacon remains on SQLite schema v15 and portable export format v10. This patch adds no schema migration or intentional sign-out. Existing watches, rules, collections, history, settings, encrypted integrations, and owner access are retained.

Source installations require Node.js 22.13 or newer. Standalone packages include their server runtime. The optional auto-buy feature remains experimental: it requires an existing reusable saved card, explicit owner authorization, and a separately running companion. Authenticated live checkout compatibility remains unverified with a real owner account; automated tests use isolated fixtures. No automatic update or purchase is performed by this patch.

[Full comparison: v1.4.0…v1.4.1](https://github.com/alexphillips-dev/GearBeacon/compare/v1.4.0...v1.4.1)

GearBeacon remains independent from Ubiquiti. UniFi and Ubiquiti are trademarks of Ubiquiti Inc.
