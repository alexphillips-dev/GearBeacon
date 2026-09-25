# Optional auto-buy

**Start here:** [Set up an address profile](#set-up-an-address-profile) · [Verify an existing profile](#verify-an-existing-address-profile-without-replacing-it) · [Troubleshoot a failed check](#troubleshooting-address-setup). Commands run from the GearBeacon folder, as shown below.

Auto-buy authorizes one order for an exact variant when GearBeacon confirms availability. Each instruction specifies a quantity, a maximum **final order total** in the Store currency, an expiry, and the watch or collection that should receive the purchase record. Shipping, taxes, and surcharges must fit within that total. Arming an already available item permits purchasing after the next complete Store check.

Monitoring and notifications work without a Store account or checkout companion. Purchasing is optional and is disabled until the owner connects a checkout profile and explicitly arms an instruction. The dashboard does not need to remain open; both the GearBeacon server and checkout companion must remain running.

## Current support and verification

**Check payment compatibility before continuing:** if checkout only offers card-number/expiry/security-code fields and **Use saved payment** offers no existing reusable card, the current companion cannot complete unattended auto-buy setup. Signing into Ubiquiti and filling every card field does not make that form a reusable payment method. The companion saves the browser session and checkout profile, not the contents of payment inputs. Do not place an order just to try to finish setup; monitoring and alerts remain available.

The companion uses the English US, EU, UK, or Canada Store browser interface. It observes the Store's checkout responses and drives ordinary page controls. It does not use a documented public ordering API. Its Store integration was built from the public checkout structure and tested end to end against an isolated browser fixture. **Authenticated live Ubiquiti checkout, regional account behavior, and unattended payment compatibility have not been verified with a real owner account.** A successful mock test does not establish live compatibility.

Setup requires an authenticated Store checkout, a saved shipping and billing address, a selected shipping service, a calculated final total, and a visibly selected saved Visa, Mastercard, American Express, or Discover card with a masked last-four label. The companion does not collect a password or raw card number, fill payment forms, solve CAPTCHAs, bypass MFA/3-D Secure, or automate PayPal, ACH, invoice, bank-transfer, or wallet payment choices. If the Store does not expose a verifiable selected saved card, setup cannot finish and unattended auto-buy is unavailable for that session. Changed or ambiguous page controls stop the attempt.

Only a cart containing the one authorized exact SKU/variant and quantity is accepted. Additional accessories, warranties, subscriptions, external items, or separately listed bundle components stop checkout. A product being available does not reserve it or guarantee an accepted order.

During automated checkout, unrecognized Ubiquiti write endpoints are blocked. The companion also checks the total returned when the Store creates the order before letting its browser payment flow continue. A changed total can leave an unpaid order requiring owner reconciliation; it does not trigger another submission.

Cart creation and cart updates remain available during setup. The request guard inspects the executed mutation fields, so payment-provider or supplemental-purchase information returned with a cart does not count as submitting an order. Unsupported mutation documents stop rather than bypassing the submission check.

## Install the companion

Auto-buy is included as an **optional experimental feature in GearBeacon 1.4.0**. Download the matching **Source** archive from the [1.4.0 release](https://github.com/alexphillips-dev/GearBeacon/releases/tag/v1.4.0) for the companion, even if the server uses a standalone package or Docker. Use the same release for the dashboard and companion; development installations should keep both on the same dev revision. Updating source files preserves the separate private companion vault. Follow the [source installation guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Source-Installation) for the server and make a backup before upgrading. The payment and live-compatibility limitations above still apply.

The optional companion requires Node.js **22.13 or newer** and runs on Windows, macOS, or Linux. For a NAS, Docker, or headless server, install the companion on a separate computer with a browser and a connection to your **HTTPS** dashboard. HTTP works only for a loopback dashboard on the same computer. Keep the companion computer awake while purchasing is armed. The base server and Docker image do not install a browser.

**All commands below run from the GearBeacon folder containing `checkout`.** For example, if your prompt already ends in `GearBeacon>`, you are in the right folder.

Install once:

```sh
npm ci --prefix checkout
npm --prefix checkout exec -- playwright install chromium
```

On Linux, use `npm --prefix checkout exec -- playwright install --with-deps chromium` if browser system libraries are missing; installing those libraries requires the appropriate local administrative access. An installed browser can alternatively be selected with `GEARBEACON_CHECKOUT_BROWSER_CHANNEL=chrome` or `msedge`. Chromium's sandbox remains enabled; run the companion as a regular user on a host that supports it.

## Set up an address profile

**“Home” is a nickname in GearBeacon, not a new address in your Ubiquiti account.** You select the actual address in Store checkout. A profile records the selected shipping address, billing address, shipping service, saved card, and Store account as verification fingerprints, along with the encrypted browser session. Typing the nickname or pairing the companion alone does not save a checkout profile.

### 1. Pair once

In **Settings > General > Auto-buy**, select **Pair checkout companion**, then run:

```sh
npm --prefix checkout run pair
```

Enter your dashboard origin, the one-time pairing code, and `live` for a normal installation. The origin is the dashboard's base address, without a Settings path. The code expires after five minutes and works once.

If already paired, skip this step. Do not disconnect or re-pair just to check an address. Pairing resets the companion's profiles.

### 2. Start Connect and name the profile

Stop an already-running companion with Ctrl+C before Connect, then run:

```sh
npm --prefix checkout run connect
```

Enter `us`, `eu`, `uk`, or `ca`, then a nickname such as `Home`. There is **one profile per Store region**. Completing Connect again for that region replaces its previous profile; existing purchase instructions need review and explicit reauthorization afterwards.

A dedicated browser opens. Keep both this browser and the terminal open.

### 3. Choose the real address and checkout options in the browser

1. Sign in directly at Ubiquiti in the dedicated browser.
2. Add one available setup item to the cart, without extras or subscriptions.
3. Continue to checkout and select or enter the intended shipping address in the Store's address controls. Confirm it, including the country and postal code.
4. Select the billing address and a shipping service. Confirm billing even if it is the same as shipping.
5. Select an **existing saved card** with a visible masked card label. A new-card entry form is not a saved card, even after you fill it. If **Use saved payment** offers no existing usable card, stop setup with Ctrl+C; there is no companion step that saves the entered card or enables unattended payment from that form. Wallets, PayPal, bank transfers, and unrecognized saved-card controls cannot be verified.
6. Reach final checkout review and wait for shipping, taxes, and the final total.

Do not click Place Order. Order submission is blocked during Connect and Verify. Do not make a purchase just to try to finish setup.

### 4. Return to the terminal and press Enter

The terminal checks the checkout page and response, Store region, signed-in account, visible security challenges, setup cart, shipping address, billing address, shipping service, final total/tax, and selected saved card. Account confirmation and security challenges have separate results. A challenge does not by itself mean you are signed out. The known Stripe background helper is allowed only at its one-pixel background size; an expanded helper or visible challenge still requires owner attention.

Each attempt has a numbered **Checkout check** heading and a passed/total summary. Failed checks appear first under **NEEDS ATTENTION**, marked `[FIX]`, with the corrective instructions indented beneath them. Passed checks follow in a compact `[PASS]` list. If a check fails, the same browser stays open. Correct that step in the browser, then return to the terminal and press Enter again. Each retry gets a new heading, and earlier attempts stay in terminal scrollback.

Setup uses separate numbered steps, short prompts, and word wrapping for narrow terminals. Supported terminals show headings in cyan, passed checks in green, and items needing attention in yellow. The text labels work without color; redirected output, `TERM=dumb`, and the `NO_COLOR` environment variable use plain text.

If everything looks correct but a check still fails, the Store interface or response may be unsupported; the companion must be able to verify it before setup can succeed.

After the checks pass, you will see:

```text
Checkout checks passed. NOT SAVED YET.
```

### 5. Empty the cart, then press Enter a second time

In the same browser, remove the setup item and all other cart items. Return to the terminal and press Enter.

The companion confirms the empty cart, saves the encrypted profile/session, and reads the saved profile back. **Setup is complete only when this appears:**

```text
SAVED
--------------------------------------------------------------------------------

  Home (US) address profile and browser session are encrypted locally.

  You can close this setup terminal now.
```

If the cart cannot be confirmed empty, the browser remains open so you can correct it and retry.

Closing the browser or pressing Ctrl+C **before SAVED** does not save the new profile or session. Any previously saved profile remains. After SAVED, the profile persists across terminal closure and computer restarts. If notifying GearBeacon fails afterwards, the terminal explicitly says that the profile is saved locally; starting the companion reports it again.

### 6. Inspect the saved result, then run the companion

```sh
npm --prefix checkout run profiles
```

For a successful setup, expect output like:

```text
US · Home · Saved profile complete
Saved card: visa ···· 4242
Profile state: ready at last update
Saved at: <the save time in UTC>
PASS · Shipping address
PASS · Billing address
PASS · Shipping service
PASS · Saved card
PASS · Store account
PASS · Saved browser session
```

This command reads the encrypted local vault without changing it or contacting the Store. It can run in another terminal while the worker is active. It reports missing fields or an unsaved profile with a nonzero exit status. Older saved profiles remain supported; their save time may show “not recorded by this companion version.”

A complete local profile does **not** prove the Store login is still valid. Use the browser verification below for that check.

To start purchasing support:

```sh
npm --prefix checkout start
```

Leave this command running. Settings > General > Auto-buy will show the region, nickname, masked card, and profile state once reported. **Companion paired** with no reported profile means address setup has not reached the dashboard yet.

Then choose **Set up auto-buy** on a watched product, select an exact variant, enter quantity/final-total limit/expiry, and explicitly authorize the purchase.

## Verify an existing address profile without replacing it

Stop the running companion with Ctrl+C, then run:

```sh
npm --prefix checkout run verify
```

1. Choose the region whose profile you want to check.
2. The dedicated browser opens using its saved session. If you have to sign in again, the saved login may need refreshing with Connect afterwards.
3. Add one setup item and reach checkout review. Select the same address, billing address, shipping service, and saved card as the existing profile.
4. Press Enter in the terminal. The normal checkout checks run, followed by a saved-profile comparison with `[MATCH]` or `[DIFF]` for each saved choice and the Store account. Differences appear first with instructions. No address values or account identifiers are printed.
5. For a mismatch, select the original choice in the browser and retry. To deliberately change a saved choice, cancel Verify and run Connect.
6. Once everything matches, remove the setup item and press Enter again.

Success is explicit:

```text
VERIFIED
--------------------------------------------------------------------------------

  Shipping address, billing address, shipping service, saved card, and Store
  account match.

  Cart is empty. No order was submitted. Saved profile and rules are unchanged.
```

Verify checks the checkout in that browser **at that moment**. It does not place an order, replace the profile, persist a refreshed login, clear an attention state, or rearm an instruction. Use Connect to refresh an expired session or change the saved choices. Restart the worker only when the Store cart is empty and any uncertain orders have been resolved.

## Troubleshooting address setup

| What you see | What to do |
|---|---|
| Generic “Checkout companion stopped” after the first Enter on an older companion | Update the companion from current dev and rerun Connect. Earlier versions hid the checkout-validation error behind this generic message; current versions show the failed checks and keep the browser open. |
| `[FIX] Checkout response` | Wait for checkout to finish loading or reload its page. A blocked request or changed Store response cannot be used as proof. If cart creation fails, also ensure the companion includes the current dev cart-request fix. |
| `[FIX] Signed-in Store account` | Read the specific explanation: checkout has not confirmed a signed-in customer, has not reported its account email, or is still on a login page. Return to checkout after signing in and reload it. A saved address alone does not prove the current login. |
| `[FIX] Checkout security challenge` | Complete the visible verification in the Store browser and retry. This is separate from account sign-in; the companion does not solve or bypass it. Update an older companion if it mislabels a background Stripe helper as a sign-in failure. |
| `[FIX] Shipping address` | Choose and confirm the real address in Store checkout. Entering `Home` in the terminal only names the profile. |
| `[FIX] Billing address` | Confirm a billing address in checkout, even when using the shipping address for billing. |
| `[FIX] Selected saved card` | If only card entry is available, the current unattended flow is unsupported. Filling those fields does not save them in the companion. If **Use saved payment** offers no existing usable card, exit with Ctrl+C; do not place an order to try to save it. A wallet or card that the Store does not expose as visibly selected also cannot complete setup. |
| `[FIX] Final total and tax` | Finish address and shipping selection and wait for the Store's calculated total. |
| Profile matched, but setup did not finish | Empty the cart and complete the second Enter prompt. The first check alone does not save it. |
| No address profile is saved | Run Connect and wait for `SAVED`. Check that you are using the same operating-system user and the same `GEARBEACON_CHECKOUT_DATA_DIR` override, if any. Do not delete the vault to troubleshoot. |
| Profile exists locally, but Settings has no profile or says offline | Start the companion and check that it can reach the paired dashboard. Pairing and a saved local profile do not keep a stopped worker online. |
| A companion is already using this vault | Stop its worker with Ctrl+C before Connect or Verify. The Profiles command works while it is running. |
| `[DIFF]` during Verify | Select the original choices and Store account, or cancel and use Connect to replace the profile intentionally. |
| `Missing script: profiles` or `verify` | Update the companion source, and run the commands from the GearBeacon folder with `--prefix checkout`. |

If a check continues to fail, report **only the check name and its fixed explanation**. Do not share addresses, account emails, pairing codes, browser storage, or the companion vault.

Use one companion and one dedicated Store session per GearBeacon installation. Do not edit its Store cart in another browser while purchasing is armed. The interactive companion intentionally refuses `mock` mode; automated tests use a separate mock server and Store fixture.

If you already changed directory into `checkout`, omit `--prefix checkout`: use `npm run connect`, `npm run profiles`, `npm run verify`, and `npm start`.

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

The companion defaults to `%LOCALAPPDATA%\GearBeaconCheckout` on Windows, `~/Library/Application Support/GearBeaconCheckout` on macOS, and `$XDG_DATA_HOME/GearBeaconCheckout` or `~/.local/share/GearBeaconCheckout` on Linux. `GEARBEACON_CHECKOUT_DATA_DIR` can select another private directory outside the application checkout. The vault uses AES-256-GCM with a separate local key and atomic writes. Linux and macOS use restrictive POSIX permissions. Windows restricts the vault directory and files to the current account, SYSTEM, and Administrators and wraps the key with account-scoped DPAPI; opening an older raw-key vault for writing migrates its key without changing the encrypted data. Windows recovery therefore requires the original account and DPAPI profile. Anyone with access to the original account or both an older raw key and its vault can use the Store session. Never commit, upload, or include these files in support reports.

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
