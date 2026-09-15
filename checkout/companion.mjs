import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openVault } from './vault.mjs';
import { companionClient, validateDashboardUrl } from './client.mjs';
import { StoreBrowser, STORES } from './store.mjs';
import { publicProfiles, runCompanion } from './runner.mjs';

const command = process.argv[2] || 'run';
if (!['pair','connect','run'].includes(command)) throw new Error('Use pair, connect, or run.');
const vault = openVault(), unlock = vault.lock(), state = vault.read();
const questions = ['pair','connect'].includes(command) ? createInterface({ input:stdin, output:stdout }) : null;
const abort = new AbortController();
let browser;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{ abort.abort(); browser?.close().catch(()=>{}); });
const launch = async headless => chromium.launch({ headless, chromiumSandbox:true, ...(process.env.GEARBEACON_CHECKOUT_BROWSER_CHANNEL ? { channel:process.env.GEARBEACON_CHECKOUT_BROWSER_CHANNEL } : {}) });
try {
  if (command === 'pair') {
    const base = validateDashboardUrl(await questions.question('GearBeacon dashboard origin (HTTPS, or HTTP on this computer): '));
    const code = (await questions.question('One-time pairing code from Settings > General > Auto-buy: ')).trim();
    const mode = (await questions.question('Mode (live or mock): ')).trim();
    const result = await companionClient(base,null)('pair',{ code,mode,protocol:1 });
    state.base = base; state.token = result.token; state.mode = result.mode;
    // A new server pairing is allowed only after uncertain submissions were resolved there.
    // Keep prior receipts for audit without trying to report them through a new worker identity.
    for (const record of Object.values(state.journal)) if (record.state === 'confirmed') record.state = 'archived';
    state.profiles = {}; vault.write(state);
    console.log('Companion paired. Run npm run connect to connect a Store checkout.');
  } else {
    if (!state.token || !state.base) throw new Error('Pair this companion first with npm run pair.');
    const client = companionClient(state.base,state.token);
    if (state.mode !== 'live') throw new Error('The interactive companion only runs live Store checkout. Mock purchases are exercised by the isolated test harness.');
    if (command === 'connect') {
      const region = (await questions.question('Store region (us, eu, uk, ca): ')).trim();
      if (!STORES[region]) throw new Error('Unknown Store region.');
      const addressLabel = (await questions.question('A short name for this shipping address (for example, Home): ')).trim();
      if (!addressLabel || addressLabel.length > 80 || /[\x00-\x1f\x7f]/.test(addressLabel)) throw new Error('Choose a short address label.');
      browser = await launch(false);
      const store = await new StoreBrowser(browser,{ region,storageState:state.profiles[region]?.storageState }).start();
      await store.page.goto(`${store.origin}${store.store.path}/checkout`);
      console.log('In the dedicated browser, sign in directly at Ubiquiti. Add one item and reach checkout review with your saved shipping address, shipping service, and a selected saved card. Order submission is blocked during setup.');
      await questions.question('When the final total and saved card are visible, press Enter to validate this checkout profile. ');
      const profile = await store.captureProfile(addressLabel);
      console.log('Profile verified without placing an order. Remove the setup item from the Store cart before continuing.');
      await questions.question('Once the Store cart is empty, press Enter. ');
      await store.visitCheckout();
      if (store.checkout?.items?.length || store.checkout?.externalItems?.length) throw new Error('The checkout cart must be empty before arming auto-buy.');
      profile.storageState = await store.context.storageState();
      state.profiles[region] = profile; vault.write(state);
      await client('heartbeat',{ protocol:1,mode:state.mode,profiles:publicProfiles(state.profiles) });
      await store.close();
      console.log('Store checkout connected. Run npm start and leave this companion running, then arm a purchase in GearBeacon.');
    } else {
      browser = await launch(true);
      console.log('Checkout companion running. GearBeacon controls every purchase authorization.');
      await runCompanion({ client,vault,state,signal:abort.signal,
        makeStore:async(attempt,profile)=>new StoreBrowser(browser,{ region:attempt.region,storageState:profile.storageState }).start() });
    }
  }
} catch (err) {
  // Browser exceptions can contain private checkout URLs, selectors, and session values.
  console.error(err.name === 'CheckoutAttention' ? 'Store profile could not be verified. Check sign-in, the selected saved card, address, shipping, and final total. No order was submitted during setup.'
    : err.status ? `GearBeacon rejected the companion request (${err.status}). Check the connection and any unresolved purchase in Settings.`
    : 'Checkout companion stopped. Verify installation, private vault access, pairing, and browser availability. Uncertain orders must be checked in Settings > General > Auto-buy before restarting.');
  process.exitCode = 1;
} finally { questions?.close(); await browser?.close().catch(()=>{}); unlock(); }
