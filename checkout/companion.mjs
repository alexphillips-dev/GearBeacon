import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openVault, VaultError } from './vault.mjs';
import { companionClient, validateDashboardUrl } from './client.mjs';
import { CheckoutAttention, StoreBrowser, STORES } from './store.mjs';
import { publicProfiles, runCompanion } from './runner.mjs';
import { savedProfileChecks, savedProfileReport, setupProfile } from './profiles.mjs';

class CommandError extends Error {}
const command = process.argv[2] || 'run';
const abort = new AbortController();
let browser, questions, unlock;
const cancel = () => { abort.abort(); questions?.close(); browser?.close().catch(()=>{}); };
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,cancel);
const launch = async headless => {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless, chromiumSandbox:true, ...(process.env.GEARBEACON_CHECKOUT_BROWSER_CHANNEL ? { channel:process.env.GEARBEACON_CHECKOUT_BROWSER_CHANNEL } : {}) });
};
try {
  if (!['pair','connect','profiles','verify','run'].includes(command) || process.argv.length > 3) throw new CommandError('Use pair, connect, profiles, verify, or run (no extra arguments).');
  const vault = openVault(undefined,{ readOnly:command === 'profiles' });
  // Atomic vault snapshots let local inspection run alongside the worker without modifying files.
  if (command !== 'profiles') unlock = vault.lock();
  const state = vault.read();
  if (['pair','connect','verify'].includes(command)) {
    questions = createInterface({ input:stdin, output:stdout });
    questions.on('SIGINT',cancel);
  }
  const ask = prompt => questions.question(prompt,{ signal:abort.signal });
  if (command === 'profiles') {
    const report = savedProfileReport(state);
    for (const line of report.lines) console.log(line);
    if (!report.ok) process.exitCode = 1;
  } else if (command === 'pair') {
    const base = validateDashboardUrl(await ask('GearBeacon dashboard origin (HTTPS, or HTTP on this computer): '));
    const code = (await ask('One-time pairing code from Settings > General > Auto-buy: ')).trim();
    const mode = (await ask('Mode (live or mock): ')).trim();
    const result = await companionClient(base,null)('pair',{ code,mode,protocol:1 });
    state.base = base; state.token = result.token; state.mode = result.mode;
    // A new server pairing is allowed only after uncertain submissions were resolved there.
    // Keep prior receipts for audit without trying to report them through a new worker identity.
    for (const record of Object.values(state.journal)) if (record.state === 'confirmed') record.state = 'archived';
    state.profiles = {}; vault.write(state);
    console.log('Companion paired. No address profile has been saved yet. Run npm run connect next.');
  } else {
    if (!state.token || !state.base) throw new CommandError('Pair this companion first with npm run pair.');
    if (state.mode !== 'live') throw new CommandError('Connect, verify, and run require live mode. Mock purchases use the isolated test harness.');
    const client = companionClient(state.base,state.token);
    if (command === 'connect' || command === 'verify') {
      const region = (await ask('Store region (us, eu, uk, ca): ')).trim().toLowerCase();
      if (!STORES[region]) throw new CommandError('Unknown Store region. Use us, eu, uk, or ca.');
      const saved = state.profiles[region];
      if (command === 'verify' && (!saved || !savedProfileChecks(saved,region).every(check=>check.ok))) {
        throw new CommandError('No complete saved profile for this region. Use npm run profiles to inspect it, then npm run connect to finish setup.');
      }
      const addressLabel = command === 'verify' ? saved.addressLabel : (await ask('Address nickname for GearBeacon only (for example, Home; choose the real address in the browser): ')).trim();
      if (!addressLabel || addressLabel.length > 80 || /[\p{Cc}\p{Cf}]/u.test(addressLabel)) throw new CommandError('Choose an address nickname of 1–80 characters without control characters.');
      if (saved && command === 'connect') console.log('Completing Connect replaces this region’s saved profile. Review and explicitly reauthorize its purchase rules afterwards.');
      browser = await launch(false);
      const store = await new StoreBrowser(browser,{ region,storageState:saved?.storageState }).start();
      await store.page.goto(`${store.origin}${store.store.path}/checkout`,{ waitUntil:'domcontentloaded' });
      await setupProfile({ store,region,addressLabel,saved:command === 'verify' ? saved : null,state,vault,ask,log:line=>console.log(line),signal:abort.signal });
      if (command === 'connect') {
        try {
          await client('heartbeat',{ protocol:1,mode:state.mode,profiles:publicProfiles(state.profiles) });
          console.log('Saved profile reported to GearBeacon.');
        } catch { console.log('Profile is saved locally, but GearBeacon could not be updated. Check the dashboard connection; npm start will report the saved profile again.'); }
      }
      await store.close();
      console.log(command === 'verify' ? 'Verification did not refresh the saved login or rearm any purchase. Use Connect if the saved session needs updating.'
        : 'Run npm start and leave this companion running, then set up auto-buy on a watched product.');
    } else {
      browser = await launch(true);
      console.log('Checkout companion running. GearBeacon controls every purchase authorization.');
      await runCompanion({ client,vault,state,signal:abort.signal,
        makeStore:async(attempt,profile)=>new StoreBrowser(browser,{ region:attempt.region,storageState:profile.storageState }).start() });
    }
  }
} catch (err) {
  // Browser exceptions can contain private checkout URLs, selectors, and session values.
  if (abort.signal.aborted) console.error(command === 'connect' ? 'Setup cancelled. A new profile is saved only after the SAVED confirmation. Run npm run profiles to check what is on disk.'
    : command === 'verify' ? 'Verification cancelled. The saved profile is unchanged; remove any setup item before restarting purchasing.' : 'Checkout companion stopped.');
  else console.error(err instanceof CommandError ? err.message
    : err instanceof VaultError && err.code === 'locked' ? 'A companion is already using this vault. Stop it with Ctrl+C before Connect or Verify. The profiles command can run while it is active.'
    : err instanceof CheckoutAttention ? 'The Store checkout could not be read. Return to checkout review, check sign-in and the saved card, then retry. No order was submitted during setup or verification.'
    : err.status ? `GearBeacon rejected the companion request (${err.status}). Check the connection and any unresolved purchase in Settings.`
    : 'Checkout companion stopped. Verify installation, private vault access, pairing, and browser availability. Run npm run profiles to check saved setup. Uncertain orders must be checked in Settings > General > Auto-buy before restarting.');
  process.exitCode = 1;
} finally { questions?.close(); await browser?.close().catch(()=>{}); unlock?.(); }
