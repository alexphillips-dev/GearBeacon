# GearBeacon 1.2.0 — Smarter watches, collections, and browsing

This update brings together **everything added since the last published release, 1.0.0**, including the 1.0.1 security improvements and 1.1.0 precision-watch features developed on `dev`.

GearBeacon remains a private, single-owner, self-hosted UniFi Store monitor. Monitoring and notifications run on your server, and you manage them through a desktop or mobile browser.

## Features

### Exact products and smarter alerts

- **Watch exact variants:** track a particular SKU, color, or pack option with its own availability, price history, image, and regional Store link. Existing watches keep their **Any variant** behavior.
- **Import exact variants:** pasted Store links retain their selected variant, and SKU imports match exact options. An unknown explicit variant produces an error instead of silently adding a different product.
- **Combine availability and price:** choose to alert only when an item is in stock at or below your target. For Any variant watches, the same variant must satisfy both conditions.
- **Preview before saving:** see how a rule would behave and what its notification would contain, including regional currency, configured delivery channels, and any All activity override.
- **Track purchased watches:** Purchased stops individual alerts while retaining the watch, rules, and history. Still wanted enables the saved rules again.

### Collections and project planning

- **Organize watches into regional collections:** create projects, select members with a searchable picker, and add selected watches in bulk. A watch can belong to multiple collections without duplicating its individual notification jobs.
- **Add directly from Browse:** choose Watchlist, an existing collection, or a new collection while adding a product. Select an exact variant and a desired quantity for the project.
- **Reuse existing watches:** adding a watched product to a collection preserves its alert rules. Re-adding an existing membership preserves its quantities and recorded spending.
- **Plan quantities and partial purchases:** record desired units, purchased units, and the total actually paid for each collection item. Purchase records belong to the project; per-unit target prices remain shared watch settings.
- **Set a project budget:** see recorded spending, estimated remaining cost, estimated project total, and how far the project is over or under budget. Unknown costs are identified so an incomplete subtotal is not presented as a complete total.
- **Monitor collection readiness:** see which remaining items qualify, which are waiting, and which have unknown monitoring coverage.
- **Receive collection-ready alerts:** opt in to one notification when all remaining items meet their availability and individual target-price conditions. These alerts use GearBeacon's existing channels, quiet hours, grouping, digests, and durable delivery queue.
- **Use Collection alerts only:** optionally suppress members' individual notifications while an active collection alert is enabled. Saved item rules remain intact, and overlapping collection overrides are identified.
- **Archive completed or paused projects:** retain items, quantities, spending, and saved alert settings while keeping the project out of active readiness summaries. Restoring a collection starts a fresh alert baseline.
- **Undo item removal:** restore a removed collection membership, including its quantity and purchase record, during the current page session. Undo remains available after closing and reopening collection management until dismissed or the page is refreshed.

### Stock insights and Watchlist overview

- **Observed availability timelines:** review recorded restocks, observed available durations, and explicit gaps caused by outages, restarts, overdue checks, partial catalogs, or pending confirmation.
- **Price insights:** compare the lowest recorded prices over 7, 30, and 90 days, including the lowest price observed while available and comparisons with your watch target. Comparisons stay within the same variant, region, and currency.
- **Actionable Watchlist summaries:** select Ready to buy, At target price, or Collections ready to open the matching products or projects. Counts account for remaining quantities in active projects and exclude stale or relevant unconfirmed observations.

## UI / UX

- **Store-inspired Browse:** illustrated category tiles, larger product previews, separated cards, blue action accents, clearer model/SKU labels, and a prominent Watchlist/collection action.
- **Browse filters and sorting:** combine availability, Watching / Not watched, category, and search; sort by name, price, or availability. Filters and sorting are remembered in the browser and can be reset together.
- **Variant-aware Browse cards:** search exact SKUs, see variant counts, and recognize a parent product as watched when an exact variant is watched. Multi-variant cards show a From price when every current variant has a known price.
- **Mobile Browse:** filters fold into a compact expandable panel, categories scroll within their own navigation strip, and cards reflow to preserve readable names, prices, and controls.
- **Collection cards:** collections use the same grid as individual watches, preview up to four product images, indicate additional members, and show the estimated project total in the normal price position.
- **Optional folder-style grouping:** collected watches appear inside their collection cards without duplicate individual cards in the default Watchlist view. Open a collection to see its items; search also finds matching members.
- **Focused collection management:** a dedicated dialog includes a guided empty state, Active / Archived / All views, thumbnail member selection, and accessible editing controls.
- **Always-visible collection items:** thumbnail rows show product names, variant/SKU details, prices, and readiness, with Edit item, Record purchase, Store, and Remove actions.
- **Accessible collection alerts:** Alerts actions are available from collection cards, management, details, and the bottom of the editor. Returning from alerts preserves unsaved selections and keyboard focus.
- **Clear membership badges:** item badges now explicitly read Collection: followed by the collection name.
- **Activity pagination:** choose 20 entries per page by default, or 50 or 100. Additional entries appear on subsequent pages, and the selected size is remembered.
- **Collection activity:** filter collection-ready events, inspect their details, follow links back to the project, and receive collection details in email notifications.
- **Keyboard and theme support:** category arrow-key navigation, focus restoration, live status announcements, image retry behavior, dark/light contrast, mobile reflow, and 200% equivalent zoom coverage extend across the new workflows.

## Fixes and reliability

- **Verified collection saves:** name and membership changes save together. The UI checks server capabilities and returned membership data before reporting success, preventing false Collection updated messages against an older running backend.
- **Predictable deletion:** deleting a collection returns to the Watchlist instead of reopening an empty Manage collections window.
- **Preserved purchase records:** membership edits retain existing plans; archived spending is preserved when shared watches are marked Purchased or Still wanted; recorded payments remain fixed when catalog prices change.
- **Safe Undo behavior:** restoring a removed membership never overwrites a newer membership or recreates a deleted watch or collection.
- **Correct alert transitions:** qualifying state survives restarts, enabling or editing conditions establishes a baseline, and empty or fully purchased collections do not alert. Restore does not replay past collection-ready notifications.
- **Delivery cancellation:** disabling, archiving, deleting, or changing relevant collection conditions cancels obsolete pending/failed jobs. Delivery checks active collection-only suppression before sending individual alerts.
- **Reliable catalog evidence:** incomplete or invalid variant catalogs cannot advance destructive-change confirmation. Insights show unknown periods instead of inventing availability during missing coverage.
- **Honest variant pricing:** missing prices display Prices vary, unknown prices sort after known values, zero prices remain valid, and retired variants are excluded from current variant price summaries.
- **Correct standalone validation:** package startup checks now use the release manifest's application version and schema rather than an outdated schema assertion. Identity mismatches are reported separately from startup timeouts.

## Security and self-hosting

- **Stricter host validation:** validate Host and forwarded-host authorities before routing, enforce loopback-only local mode, and require explicit reverse-proxy authority settings to resist DNS rebinding.
- **Stronger password hashing:** new owner passwords use a stronger versioned scrypt profile; valid older hashes are upgraded after successful sign-in.
- **Bounded HTTP resources:** apply header, request, keep-alive, header-count, and per-socket request limits while retaining no-store API responses.
- **Lower-privilege services:** Windows and macOS service installation uses dedicated restricted identities; Linux keeps application files root-owned and applies additional systemd sandboxing.
- **Hardened Docker isolation:** Compose runs with a read-only root filesystem, dropped capabilities, no-new-privileges, a process limit, and constrained temporary storage while preserving writable application data.
- **Privacy-preserving diagnostics:** support bundles exclude product identities, variant metadata, collection contents, and pending product observations while retaining useful operational counts.
- **Repository safeguards:** security contracts check service identities, container isolation, HTTP/password settings, dependency-update targeting, and pinned actions. Dependency updates target dev, and repository secret scanning was expanded.

## Maintenance and support

- Added structured GitHub forms for bugs, feature requests, deployment issues, monitoring issues, and notification problems, with guidance to avoid sharing private data.
- Expanded deterministic coverage for variants, conditions, collection readiness, purchase plans, budgets, archive/restore, Undo, migrations, and recovery, plus browser accessibility and focus checks.
- Added collection purchase-plan and Watchlist-workflow suites to the Windows, macOS, and Linux CI matrix.
- Updated the release manifest to schema v11 and added consistency checks so source, generated server output, manifest, and curated release notes remain aligned.
- GitHub release publication now uses these sectioned notes for new or refreshed draft releases.

## Upgrading from 1.0.0

1. Create a backup and use GearBeacon's restore-test controls before updating. Keep the compatible pre-upgrade database and its matching encryption key for rollback.
2. Follow the update instructions for your installation type. Restart the GearBeacon process after replacing the application files, then hard-refresh the browser to load the matching interface.
3. Startup creates and validates a safety backup before migrating to **database schema v11**. Existing regional watches, rules, history, settings, encrypted secrets, and owner access are retained.

Recovery exports now use **format v7** and preserve exact variants, condition state, insights, collections, purchase plans, budgets, alert modes, and archive state. Older supported export formats remain importable. Earlier application versions cannot open a schema-v11 database or format-v7 export; rollback requires the compatible pre-upgrade backup and matching application version.

Existing product watches remain Any variant watches. Collection alerts, collection-only mode, budgets, and grouping are opt-in. Older collection records receive compatible defaults; historical purchase amounts that were never recorded remain unknown.

## Notes

- Stock insights begin with complete observations after upgrading. Earlier activity cannot reconstruct unobserved availability, and partial history is labeled. GearBeacon does not predict future restocks.
- Catalog prices are regional display prices. They do not calculate shipping, additional taxes, or checkout surcharges. Collection quantities express purchase plans, not the number of units physically available in the Store.
- Item-removal Undo is retained only in the current browser page session. Removing a watch globally also removes its collection memberships, including archived ones.
- An alert already being delivered may finish even if it is disabled or cancelled in the meantime.
- GearBeacon remains independent software, unaffiliated with Ubiquiti Inc. Ubiquiti and UniFi are trademarks of their respective owner.

[Installation, updates, and recovery documentation](https://github.com/alexphillips-dev/GearBeacon/blob/main/README.md) · [All changes since 1.0.0](https://github.com/alexphillips-dev/GearBeacon/compare/v1.0.0...main)
