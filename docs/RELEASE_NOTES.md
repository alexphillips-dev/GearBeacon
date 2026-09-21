# GearBeacon 1.4.0 — Optional purchasing, stronger security, and clearer Activity

This release includes **all changes since the last published main release, v1.3.0**: optional experimental auto-buy, a checkout companion with clearer setup and verification, new-product Activity labels, owner-access and local-data hardening, signed update verification, and release/CI maintenance.

GearBeacon remains a private, single-owner, self-hosted UniFi Store monitor. Monitoring and notifications need no Store account and continue when the browser is closed. Purchasing is optional and requires separate setup and explicit authorization.

## Optional experimental auto-buy

- **Authorize one exact purchase:** choose a watched variant, quantity, maximum final order total including shipping/tax/surcharges, expiry, and the watch or collection that receives the purchase record. Each authorization allows one successful order. Arming an already available item permits checkout after the next complete Store check.
- **Dedicated checkout companion:** pair the optional Node.js/Playwright companion with a one-time code and sign in directly in its sandboxed Store browser. The server and companion must remain running; the dashboard can be closed. A NAS, Docker, or headless installation can use a companion on a separate browser-capable computer over HTTPS.
- **Checkout checks and recovery:** validate the exact cart contents, quantity, region, currency, account, address fingerprints, shipping service, selected saved card, and final total. Unrecognized Store write endpoints, visible challenges, changed checkout details, or an uncertain submission stop further checkout and require review. The companion retains an encrypted browser session and durable submission journal locally.
- **Dashboard controls:** Watchlist purchase setup/status, Settings > General > Auto-buy, pause/disconnect controls, and Settings > Operations > Purchases expose rules and outcomes. Recovery restores purchase instructions paused and does not reactivate old companion tokens.
- **Setup that explains its result:** numbered steps, aligned checks, failed checks first, wrapped guidance, retries in the same browser, and explicit SAVED/cancelled summaries. The address label is a GearBeacon nickname, not an address created in the Store. Local `profiles` and browser `verify` commands check saved profiles without replacing them.
- **Pairing improvements:** connection instructions expand automatically only while unpaired. The mode/expiry label sits beside a compact field that selects and copies only the pairing code; pairing clears both.
- **Checkout setup fixes:** cart preparation is no longer blocked by purchase/payment words in response fragments; the guard checks executed mutation fields. Account confirmation is separate from visible challenge detection, so Stripe's one-pixel background helper no longer falsely reports a signed-out account. Expanded helpers and active challenges still require owner attention.

**Compatibility limitation:** unattended checkout requires an existing reusable saved card with a visible masked label. Entering a card number, expiry, and security code does not create a supported saved payment method. If Use saved payment has no usable card, auto-buy setup cannot finish; do not place an order just to try to save a card. The companion does not collect raw payment-field values, solve CAPTCHAs, or bypass MFA/payment challenges. Authenticated live Ubiquiti checkout, regional account behavior, and unattended payment compatibility remain unverified with a real owner account; automated coverage uses isolated checkout fixtures. Stock availability does not reserve an item or guarantee an order.

See the [auto-buy setup, profile verification, and troubleshooting guide](https://github.com/alexphillips-dev/GearBeacon/blob/v1.4.0/docs/AUTO_BUY.md). Standalone and Docker users install the companion separately from the matching Source archive; the base server does not install a browser.

## Clearer new-product Activity

- Teal **NEW TO STORE** badges distinguish newly discovered listings and show their availability at detection.
- **NOW AVAILABLE** distinguishes Coming soon → In stock launches from ordinary restocks. Launch timing says Coming soon for; unchanged upcoming listings say Still coming soon.
- The same context appears in accessible descriptions and event details. Events remain individual compact cards, including separate product and variant events, with live arrivals and reading-position preservation retained.

## Owner access and local-data security

- **Fail-closed access:** local mode always refuses non-loopback binds, including the former insecure remote override. Invalid saved configuration stops startup instead of silently falling back to environment defaults.
- **Session policy:** configurable absolute sign-in lifetime (default 24 hours) and inactivity lock (default 30 minutes). Background polling does not renew activity; monitoring, delivery, and an independently running companion continue while the dashboard is locked.
- **Fresh owner verification:** sensitive configuration, data-transfer/recovery, password/session, and authenticator operations require a recent sign-in or verification. The verification dialog supports keyboard cancellation, focus recovery, mobile layouts, and both themes.
- **Optional authenticator codes:** local TOTP enrollment, replay protection, and ten single-use recovery codes. No cloud account or external QR service is required. Setup secrets clear on lock/sign-out; MFA material and local security policy stay out of portable exports.
- **Protected installation keys:** Windows uses account-scoped DPAPI and verified private ACLs for application data and the installation key, including existing raw-key migration without changing the underlying key. Linux/macOS retain owner-only directory/key permissions. These installation-key protections are separate from the companion's own local vault.
- **Restricted notification requests:** exact configured origins, DNS-validated address pinning, redirect rejection, TLS validation, timeouts, bounded responses, and metadata/link-local/reserved-address blocking. Private DNS destinations require explicit hostname approval; configured private IPs and localhost remain supported.

See [owner security and recovery](https://github.com/alexphillips-dev/GearBeacon/blob/v1.4.0/docs/SECURITY_CONTROLS.md) for session limits, authenticator setup, account recovery, and private-host approvals.

## Updates, packaging, and maintenance

- Native and Docker update helpers require GitHub artifact attestations tied to the official repository, signer workflow, release tag, and source commit, and reject self-hosted signer runners. Packages include signed verification bundles. Docker pins the verified immutable image digest. Updates remain owner-initiated and backup-confirmed; GitHub CLI is required by these helpers.
- Source and standalone packaging include the new backend modules while excluding companion state and keys. Companion dependencies receive their own Dependabot checks.
- Updated pinned actions: CodeQL **4.38.1**, Docker Buildx setup **4.4.1**, Docker build/push **7.4.0**, and QEMU setup **4.4.0**. CodeQL actions update together and are enforced by the security contract.
- Release promotion uses a merge commit, then fast-forwards dev to the reviewed main commit. This preserves shared ancestry and prevents already-released development commits from appearing ahead of main again.
- Expanded backend, browser, profile, recovery, and security regression coverage. Fixed relative-time fixture races, contrast scans during CSS transitions, updater deadline timing, and slow first-use Windows startup. Updater fixtures also cover delayed health and retries.

## Upgrading from v1.3.0

1. Use Prepare safe update and test the backup before replacing files. Keep the compatible pre-upgrade database **and pre-upgrade encryption key** for rollback. Stop an existing companion and update it to the matching version before reconnecting.
2. Follow the installation-specific update procedure, restart GearBeacon, and hard-refresh the browser. Source and companion installs require Node.js 22.13 or newer; standalone packages include their server runtime.
3. Startup validates a safety backup before upgrading **schema v13 to v15**. Existing watches, rules, collections, history, settings, encrypted integration secrets, and owner credentials are preserved. Existing browser sessions are signed out once; sign in again to continue.
4. If notifications use a hostname resolving to a private LAN/VPN address, approve the exact hostname in Settings > Security > Sessions. Review access configuration if the removed insecure remote override was previously used.
5. On Windows, the upgraded installation key is tied to its original account and DPAPI profile. Prepare an encrypted data export before moving machines or changing service identity; copying the wrapped key alone is insufficient.

Recovery exports use **format v10**. Supported older exports remain importable. Portable exports exclude owner credentials, MFA material, browser sessions, private-network approvals, and local integration secrets. Purchase instructions restore paused; pair the companion again on a restored installation. Companion session files and keys stay on the companion host and are excluded from GearBeacon backups.

Older applications cannot open a schema-v15 database, a format-v10 export, or a DPAPI-wrapped key. Rollback requires the compatible pre-upgrade database, pre-upgrade key, and matching older application. Update helpers do not automatically restore a database.

[Full comparison: v1.3.0…v1.4.0](https://github.com/alexphillips-dev/GearBeacon/compare/v1.3.0...v1.4.0)

GearBeacon remains independent from Ubiquiti. UniFi and Ubiquiti are trademarks of Ubiquiti Inc.
