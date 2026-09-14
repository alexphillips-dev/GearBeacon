# GearBeacon 1.3.0 — Live Activity, flexible alerts, and easier settings

This release includes **all development changes since the last published main release, 1.2.0**. It improves everyday monitoring with automatic Activity arrivals, more useful event details, saved views, flexible delivery rules, shorter Settings pages, and update notices for the installed branch.

GearBeacon remains a private, single-owner, self-hosted UniFi Store monitor. Monitoring and external notifications run on your server, even when the browser is closed.

## Activity

- **Automatic arrivals:** the visible Activity tab checks for new cards every second. At the top, new events appear immediately; when scrolled down, the card being read and keyboard focus stay in place. No button click is required to reveal arrivals.
- **Stable history and pagination:** retain filters and the selected historical page while newer events appear above it. Bounded batches handle large bursts without skipping events; reconnects and expired reading boundaries recover automatically. The 20/50/100 page sizes remain available.
- **Individual events:** every event remains its own compact card, including separate parent products and exact variants. Events are never combined or collapsed into groups.
- **Current status beside original evidence:** see current availability and check freshness, current Watchlist and collection membership, exact variant identity, and the event price compared with the current target. Original detection snapshots remain unchanged.
- **Observed price context:** a 30-day observed-low indicator requires sufficient retained history for that Store and exact item, ending at the event. Limited history is not presented as a proven low.
- **Clear delivery outcomes:** badges identify successful channels and suppression reasons. Delivery outcomes refresh automatically; details retain the underlying evidence.
- **Dates and totals:** Today, Yesterday, and date separators help navigation without combining cards. Totals cover all matching events across pages, and calendar filters and headings follow the configured timezone.
- **Consistent colors:** price decreases use blue for the icon and savings amount/percentage; increases retain amber. Sold out text matches the red icon, and In stock text matches green. Both themes retain readable text, arrows, and before/after values.

## Watches, views, and collections

- **Saved views:** save, rename, replace, and delete named Watchlist and Browse views per regional Store. Views are stored on the installation for use across browsers and are included in recovery data. Revision checks prevent conflicting edits from silently overwriting a newer view.
- **Compact lists:** choose Cards or Compact list while retaining product images, prices, availability, collection memberships, and actions.
- **Simpler Watchlist controls:** search, status, collection, and sorting share one primary row. View options contains category, layout, optional Watchlist collection grouping, and saved views; Manage contains collection management, imports, and bulk selection. Browse saved views use the same dropdown styling.
- **Budget-aware readiness:** optionally require a collection to be within budget before it can send a ready alert. Qualification combines recorded spending, remaining quantities, and confirmed qualifying prices; unknown costs and pending prices block qualification. Cards and explanations identify the blocker. This condition defaults off for existing collections.
- **Safer collection rule changes:** budget and rule edits establish a new baseline and cancel obsolete pending deliveries. Existing item-alert overrides, quantities, recorded payments, and purchased state are preserved.

## Notifications and monitoring evidence

- **Choose delivery channels per watch or collection:** use the configured defaults or select ntfy, Discord, Gotify, Webhook, and Email. Previews explain disabled or unconfigured selections. Collection routes apply to collection-ready events; member watches keep their own routes. Browser popups remain controlled separately.
- **Apply route changes to queued work:** removing a channel cancels its pending and failed jobs. Adding a channel affects future events and does not resend earlier alerts. An in-progress delivery cannot be recalled.
- **Optional alert expiry:** set a time limit for restock, target-price, price-drop, and collection-ready alerts, including time spent in quiet hours, digests, and retries. Queued jobs retain their original expiry ceiling; shorter current limits apply immediately. Expired alerts remain visible in Activity and cannot be revived with Retry failed. Existing rules default to no expiry.
- **Context for delayed alerts:** messages delayed by at least one minute show the original detection time alongside separately labeled current confirmed or last-known status. Exact-variant context remains tied to the triggering SKU. Supported server channels, email, and grouped/digest messages include this context without rewriting the original event.
- **Product freshness:** Watchlist cards and compact lists, Browse, and product details distinguish confirmed checks, pending changes, delayed checks, and unknown coverage. Freshness labels update without rebuilding the card or discarding an open rule form. Monitoring gaps never count as confirmation.
- **Explain effective rules:** item and collection summaries describe inherited settings, target conditions, pauses, purchased state, collection-only overrides, channels, scheduling, and cooldowns. Actual notification jobs are shown separately from hypothetical delivery timing.

## Settings, accessibility, and interface fixes

- **Shorter Settings pages:** each existing category has section tabs. General separates Application from Stores & access; Notifications separates Alert types, Channels, Delivery, and Email; Data separates Schedule & retention from Backups & transfer; Security separates Overview, Password, and Sessions; Privacy separates Catalog & updates from Notifications; Operations separates Overview, Monitoring, Delivery, Backups, Diagnostics, and Logs.
- **Remember navigation and preserve drafts:** each Settings category remembers its last section in this browser. Switching tabs preserves unsaved inputs; explicit Save controls still apply changes. Passwords and drafts are not stored as navigation preferences.
- **Accessible section navigation:** scoped arrow-key/Home/End handling, visible focus, responsive wrapping, and deep links reveal the relevant section. Operations remains the final Settings category, including compatibility with old Operations links.
- **Compact help controls:** card and rule explanation buttons now display a question mark with descriptive labels and tooltips. The explanation dialog has padded content, a contained sticky header, and wrapping long titles. Empty results no longer leave an extra bar, and horizontal overflow is removed.
- **Stores & access spacing:** Store choices, field rows, and access options have consistent vertical gaps, including stacked mobile fields, so labels no longer crowd the controls above them.
- **Smoother refreshes:** unchanged product, collection, and Activity nodes and dropdown options are reused. Overlapping refreshes are coalesced and stale responses after edits or region changes are rejected. Unsaved rules and notification preferences remain intact. Hidden tabs defer expensive rendering while server monitoring and delivery continue.

## Updates and deployment

- **Update button:** a compact blue `update available · vX.Y.Z` button appears below the header on every tab. It opens matching release notes in a new tab, or the local update details when a notes link is unavailable. Its arrival preserves Activity reading position and focus.
- **Branch-aware checks:** main follows newer published stable releases and excludes drafts and prereleases. Dev compares the running commit with the dev branch, detecting newer commits even when the version number is unchanged. It opens matching prerelease notes when available, otherwise the changelog for that commit.
- **Automatic checking:** the server checks at startup and daily, sharing cached results across browsers. Manual checks remain in Settings. Offline failures preserve the last confirmed result; retries respect rate limits. Automatic checking can be disabled, and downloads and installation remain owner-initiated.
- **Build identity:** packaged source archives, standalone packages, and container builds retain branch, version, and commit metadata so update checks can identify the installed build.
- **Verified updates:** native helpers check local startup health and the expected version after restart, support custom ports, retain build metadata, and report recovery steps if verification fails. Docker updates persist the selected image tag in the Compose project `.env`, preserve other settings, and verify the resolved and running image. All helpers retain mandatory backup confirmation.

## Documentation, privacy, and maintenance

- Reorganized release history and getting-started guidance under `docs/`, source startup scripts under `launchers/`, and contribution/security guidance under `.github/`. Standalone packages retain their top-level getting-started file and appropriate service helpers.
- Simplified the README and deployment overview, connected the complete Wiki, and added badges for releases, main CI, license, platforms, Docker, and documentation. Clarified source archive layout, saved-setting precedence, Windows Scheduled Task management, Docker version pinning, configuration, and recovery.
- Removed local agent instructions from tracked files and expanded ignore rules for editor state, environment overrides, credentials, databases, exports, logs, and generated packages. Delayed-delivery product context stays redacted from support diagnostics.
- Added deterministic coverage for saved views, routing, expiry, freshness, collection budgets, migration/recovery, Activity evidence, timezone boundaries, refresh races, large lists, update channels, and updater success/failure behavior. Browser coverage includes mobile, both themes, keyboard/focus, Settings drafts, dialogs, and live Activity anchoring.
- Corrected the notification restart test to retain alerts sent during startup and explicitly verify that due jobs resume with their original delayed context.
- Updated source-package rehearsal to validate the full installed version, including prerelease suffixes, and confirm that disabled update checks remain unverified.
- Made the imported-history duration test account for the API's actual rolling window, preserving exact duration assertions on slower runners.
- Candidate packages and releases retain required automated platform, security, checksum, SBOM, and attestation checks. Real-host installation, rollback, manual accessibility, and soak testing are documented as recommended additional validation, without weakening automated release requirements.

## Upgrading from 1.2.0

1. Create a backup and use the restore-test controls before updating. Keep the compatible pre-upgrade database and its matching encryption key for rollback.
2. Follow the update procedure for your installation type. Source installations require Node.js 22.13 or newer; standalone packages include their runtime. Source checkout launchers now live under `launchers/`; older 1.2.0 source archives keep their launchers at the root.
3. Restart the GearBeacon process after replacing the application files, then hard-refresh the browser to load the matching interface.
4. Startup creates and validates a safety backup before migrating the 1.2.0 database from **schema v11 to v13**. Existing watches, rules, collections, quantities, spending, history, settings, encrypted secrets, and owner access are retained.

Recovery exports now use **format v9**, preserving saved views, collection budget conditions, delivery channel choices, and expiry. Previous supported formats remain importable. Existing watches and collections retain default channels, no expiry, and no budget-based readiness requirement until you change those settings.

Older application versions cannot open a schema-v13 database or format-v9 export. Rollback requires the compatible pre-upgrade database, matching key, and application version; update helpers do not automatically restore a database.

Stock freshness and observed price history describe monitoring evidence, not a promise of checkout availability or a prediction of future restocks. GearBeacon remains independent from Ubiquiti. UniFi and Ubiquiti are trademarks of Ubiquiti Inc.
