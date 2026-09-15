# Optional auto-buy

Auto-buy authorizes one order for an exact variant when GearBeacon confirms availability. Each instruction specifies a quantity, a maximum **final order total** in the Store currency, an expiry, and the watch or collection that should receive the purchase record. Shipping, taxes, and surcharges must fit within that total. Arming an already available item permits purchasing after the next complete Store check.

Monitoring and notifications work without a Store account or checkout companion. Purchasing is optional and is disabled until the owner connects a checkout profile and explicitly arms an instruction. The dashboard does not need to remain open; both the GearBeacon server and checkout companion must remain running.

## Current support and verification

The companion uses the English US, EU, UK, or Canada Store browser interface. It observes the Store's checkout responses and drives ordinary page controls. It does not use a documented public ordering API. Its Store integration was built from the public checkout structure and tested end to end against an isolated browser fixture. **Authenticated live Ubiquiti checkout, regional account behavior, and unattended payment compatibility have not been verified with a real owner account.** A successful mock test does not establish live compatibility.

Setup requires an authenticated Store checkout, a saved shipping and billing address, a selected shipping service, a calculated final total, and a visibly selected saved Visa, Mastercard, American Express, or Discover card with a masked last-four label. The companion does not collect a password or raw card number, fill payment forms, solve CAPTCHAs, bypass MFA/3-D Secure, or automate PayPal, ACH, invoice, bank-transfer, or wallet payment choices. If the Store does not expose a verifiable selected saved card, setup cannot finish and unattended auto-buy is unavailable for that session. Changed or ambiguous page controls stop the attempt.

Only a cart containing the one authorized exact SKU/variant and quantity is accepted. Additional accessories, warranties, subscriptions, external items, or separately listed bundle components stop checkout. A product being available does not reserve it or guarantee an accepted order.

## Install the companion

Use the `checkout` directory from the same GearBeacon source checkout or source package. The base server and Docker image do not download Chromium or gain a browser dependency. The optional companion requires Node.js 22.13 or newer and runs on Windows, macOS, or Linux. For a NAS, Docker, or headless server, run it on a separate computer that can reach GearBeacon through HTTPS. HTTP is accepted only for a loopback dashboard on the same computer. Keep the computer awake while purchases are armed.

From the `checkout` directory:

```sh
npm ci
npx playwright install chromium
npm run pair
```

On Linux, install the browser's operating-system libraries using `npx playwright install --with-deps chromium` with the required local administrative access. Browser downloads and dependency installation are explicit owner actions. An installed browser can alternatively be selected with `GEARBEACON_CHECKOUT_BROWSER_CHANNEL=chrome` or `msedge`; omit it to use Playwright Chromium.

1. In GearBeacon, open **Settings > General > Auto-buy** and choose **Pair checkout companion**.
2. Enter the dashboard origin and one-time code into the companion's pairing prompt. Choose `live` for the normal installation. The code expires after five minutes and works once. The bearer credential returned to the companion is encrypted locally and never printed or sent to another service.
3. Run `npm run connect`. Choose a Store region and an address label such as `Home`.
4. In the dedicated browser, sign in directly at Ubiquiti. Add a setup item, select your saved address, shipping service, and saved card, and reach the final order review. Order submission is blocked throughout setup. Press Enter in the companion terminal to validate the profile.
5. Remove the setup item from the Store cart, then press Enter again. The companion verifies the empty cart and saves the encrypted browser session and checkout fingerprints.
6. Run `npm start`. Return to a Watchlist card and choose **Set up auto-buy**. Select an exact variant, fill in the quantity, final-total limit, and expiry, and explicitly authorize the order. An exact variant is added to your watchlist if the original card watched any variant.

To connect another region or refresh an expired Store session, stop the companion, run `npm run connect`, then restart it. A new checkout profile invalidates previously queued instructions for the old profile; reopen and authorize the desired rules after checking the Store cart. Use one companion and one dedicated Store session per GearBeacon installation. Do not edit that Store cart in another browser while purchasing is armed.

The interactive companion intentionally refuses `mock` mode. Automated tests pair a mock worker with a mock server and an isolated local Store; they cannot reach the live Store.

## States and controls

| State | Meaning |
|---|---|
| Armed | Waiting for a complete confirmed availability check and a connected companion. |
| Waiting for checkout | A durable attempt exists for this authorization. |
| Preparing checkout | The companion is verifying the cart and saved choices. |
| Submitting order | Server authorization has committed; an order request may already be in flight. |
| Purchased | A matching paid order was verified, or the owner recorded a purchase during reconciliation. The instruction is stopped. |
| Paused / needs attention | Review the Store session, cart, or instruction before explicitly rearming. |
| Check Store orders | Submission may have succeeded. All further checkout is blocked pending reconciliation. |

**Pause all auto-buy** is available on Watchlist when active and in Settings. It prevents further authorizations. It cannot recall an already submitted request. Disconnecting the companion revokes its API credential and pauses rules; close the companion browser too before resolving an uncertain order.

Operations > Purchases shows individual attempts, limits, timestamps, reasons, and order references. Purchase outcomes and attention requests use the installation's configured server notification channels. Those deliveries remain ordinary durable notification jobs; retrying one never retries a purchase. Auto-buy instructions are independent of alert-type and delivery-channel preferences. Removing a watch, marking it purchased, or changing a selected collection so it has insufficient remaining quantity invalidates a purchase authorization.

For a collection purchase, only the selected collection receives the ordered quantity and actual paid total. A watch-only purchase marks that watch purchased without marking unrelated collections purchased. If a collection changes during an already submitted order and no longer has enough remaining quantity, the order stays recorded in Purchases for manual accounting.

## Submission and recovery

Purchase attempts are durable in SQLite and separate from notification jobs. Each authorization has a unique identifier and can produce only one attempt. The companion claims one checkout at a time across all regions. Immediately before the outgoing order request, the server rechecks current authorization, expiry, exact identity, a fresh confirmed product observation, checkout profile, complete cart, currency, and the total. It commits `submitting` before issuing a short-lived permit. The companion fsyncs its encrypted journal before releasing that one browser request. The Store performs payment processing through its normal browser flow.

A matching order number alone is insufficient: the companion also checks the order's checkout ID, exact items, total, currency, and paid status. If it records a confirmed receipt but loses the reporting response, it can resend that receipt safely. It never resends an order submission. An interrupted preparation pauses for inspection. An interrupted submission becomes uncertain; browser automation cannot guarantee exactly-once ordering without a Store-side idempotency contract.

For an uncertain attempt:

1. Stop the companion and close its browser.
2. Disconnect it in General > Auto-buy.
3. Check Ubiquiti Store orders **and** payment activity. Allow pending payment processing to finish before concluding that no order exists.
4. In Operations > Purchases, choose **Resolve** and record whether an order was placed. If purchased, enter the order number and actual total. Owner-entered outcomes are labeled separately from Store-verified confirmations.
5. Pair and reconnect the companion, then explicitly authorize any further purchase.

Generated SQLite backups contain paused instructions and no companion bearer credential. JSON export format 10 preserves instructions and audit records, but restores cannot arm a purchase. The companion's encrypted session and journal are intentionally excluded from GearBeacon backups and support bundles. Raw filesystem or VM snapshots of both hosts can roll back purchase history: after such a restore, pause/disconnect purchasing and reconcile Store orders before reconnecting and reauthorizing.

## Private storage

The companion defaults to `%LOCALAPPDATA%\GearBeaconCheckout` on Windows, `~/Library/Application Support/GearBeaconCheckout` on macOS, and `$XDG_DATA_HOME/GearBeaconCheckout` or `~/.local/share/GearBeaconCheckout` on Linux. `GEARBEACON_CHECKOUT_DATA_DIR` can select another private directory outside the application checkout. The vault uses AES-256-GCM with a separate local key, atomic writes, and restrictive POSIX permissions; on Windows keep it under the owner's private application-data directory with restrictive inherited ACLs. Anyone who can read both the key and vault can use the Store session. Never commit, upload, or include these files in support reports.

No Store credentials or session cookies are sent to GearBeacon-controlled infrastructure. The companion connects to your dashboard, the selected Ubiquiti Store, its account services, and the payment services loaded by that checkout. GearBeacon remains independent from Ubiquiti.

## Validation

The backend integration tests use generated temporary data directories and mock products. The checkout browser test uses Playwright with an installed Chrome/Chromium or the downloaded Chromium and a loopback HTTP fixture. It places simulated orders only.

```sh
npm run build
npm run check
npm test
npm run test:browser
npm ci --prefix checkout
npm run test:checkout
```

The normal browser suite covers the setup dialog, persistence, pause controls, keyboard focus, dark/light themes, mobile sizing, and zoom. Live setup stops before purchase and must succeed with the owner's actual Store session before any rule can be armed.
