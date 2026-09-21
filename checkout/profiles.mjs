// Only fixed check names and nicknames/masked card labels are used in terminal reports.
// Never print browser state, account identifiers, address values, or fingerprints.
import { createTerminal } from './terminal.mjs';

export const PROFILE_FIELDS = {
  shipping:'Shipping address', billing:'Billing address', delivery:'Shipping service',
  payment:'Saved card', customer:'Store account',
};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value);
export const terminalLabel = value => String(value || '').replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,80);

export function savedProfileChecks(profile, region) {
  const session = profile?.storageState;
  return [
    { name:'Profile identity and region', ok:label(profile?.id) && profile?.region === region },
    { name:'Address nickname', ok:label(profile?.addressLabel) },
    ...Object.entries(PROFILE_FIELDS).map(([field,name])=>({ name, ok:field === 'payment'
      ? /^(visa|mastercard|american express|amex|discover):\d{4}$/.test(profile?.payment || '')
      : hash(profile?.[field]) })),
    { name:'Saved browser session', ok:Boolean(session && Array.isArray(session.cookies) && Array.isArray(session.origins) && (session.cookies.length || session.origins.length)) },
  ];
}

export function profileMatches(saved, current) {
  return Object.entries(PROFILE_FIELDS).map(([field,name])=>({ name, ok:saved?.[field] === current[field] }));
}

export function savedProfileReport(state) {
  const lines = ['Saved checkout profiles (local inspection; no Store connection).'];
  lines.push(state.token && state.base ? 'Dashboard pairing: saved locally (connection not checked).' : 'Dashboard pairing: not saved. Run npm run pair.');
  const entries = Object.entries(state.profiles || {});
  let ok = entries.length > 0 && Boolean(state.token && state.base);
  if (!entries.length) lines.push('No address profile is saved. Run npm run connect and complete BOTH Enter prompts.');
  for (const [region,p] of entries) {
    if (!['us','eu','uk','ca'].includes(region)) { ok = false; lines.push('An unrecognized Store profile needs reconnecting.'); continue; }
    const checks = savedProfileChecks(p,region), complete = checks.every(check=>check.ok);
    ok &&= complete;
    lines.push('',`${region.toUpperCase()} · ${terminalLabel(p?.addressLabel) || '(no nickname)'} · ${complete ? 'Saved profile complete' : 'Saved profile incomplete'}`);
    if (/^(visa|mastercard|american express|amex|discover):\d{4}$/.test(p?.payment || '')) {
      const [brand,last4] = p.payment.split(':'); lines.push(`Saved card: ${brand} ···· ${last4}`);
    }
    lines.push(`Profile state: ${p?.state === 'ready' ? 'ready at last update' : 'needs attention; reconnect before arming'}`);
    lines.push(`Saved at: ${Number.isFinite(Date.parse(p?.savedAt)) ? new Date(p.savedAt).toISOString() : 'not recorded by this companion version'}`);
    for (const check of checks) lines.push(`${check.ok ? 'PASS' : 'MISSING'} · ${check.name}`);
  }
  lines.push('', 'This checks saved data, not whether your Store login is still valid. Run npm run verify for a browser check.');
  return { ok, lines };
}

// The caller owns the browser and vault lock. A failed check or cancellation never writes a profile.
export async function setupProfile({ store, region, addressLabel, saved, state, vault, ask, signal, terminal = createTerminal() }) {
  let candidate;
  let attempt = 0;
  let cardEntryOnly = false;
  const verifying = Boolean(saved);
  terminal.section('2. Prepare checkout in the browser');
  terminal.text(verifying ? 'Verification only. Your saved profile and purchase rules stay unchanged.'
    : 'Your nickname only names the profile. Choose the actual address in the Store browser.');
  terminal.blank();
  terminal.list([
    'Sign in to your Store account in the dedicated browser.',
    'Add one setup item and continue to checkout review.',
    'Select shipping and billing addresses, a shipping service, and a saved card.',
    'Wait for the final total, then return to this terminal.',
  ]);
  terminal.blank();
  terminal.text('Do not place an order. Submission is blocked during setup and verification.',{ tone:'attention' });
  for (;;) {
    await ask(cardEntryOnly ? 'If the Store offers no reusable saved card, press Ctrl+C to exit. Press Enter to retry only after selecting a supported saved card.'
      : attempt ? 'Correct the checks above in the browser. Press Enter to check again, or Ctrl+C to cancel.'
      : 'Press Enter when checkout review and the selected saved card are visible. Ctrl+C cancels.');
    if (signal?.aborted) throw new Error('Cancelled');
    const report = await store.inspectProfile(addressLabel);
    cardEntryOnly = report.paymentStatus === 'card-entry';
    terminal.checks(`Checkout check ${++attempt}`,report.checks);
    if (!report.profile) {
      terminal.text(verifying ? 'Saved profile unchanged.' : 'Nothing saved.',{ tone:'attention' });
      terminal.text(cardEntryOnly ? 'Unattended auto-buy needs a reusable saved-card selection.' : 'Fix the checks marked [FIX] above.',{ tone:'attention' }); continue;
    }
    if (verifying) {
      const matches = profileMatches(saved,report.profile);
      terminal.checks(`Saved profile comparison ${attempt}`,matches,{ comparison:true });
      if (!matches.every(check=>check.ok)) {
        terminal.text('Saved profile unchanged. Select the original choices and retry.');
        terminal.text('To replace the saved choices, cancel and run npm run connect.'); continue;
      }
    }
    candidate = report.profile; break;
  }
  terminal.section('3. Empty the setup cart');
  terminal.text(verifying ? 'Saved choices match this checkout.' : 'Checkout checks passed. NOT SAVED YET.',{ tone:verifying ? 'success' : 'attention' });
  terminal.text('Remove every setup item from the Store cart, then return here.');
  for (;;) {
    await ask('Press Enter AFTER the Store cart is empty. Ctrl+C cancels.');
    if (signal?.aborted) throw new Error('Cancelled');
    if (await store.confirmEmptyCart()) break;
    terminal.notice('Cart still needs attention',[
      'An empty cart could not be confirmed. Remove all items in the same browser and try again.',
      verifying ? 'Saved profile unchanged.' : 'Nothing has been saved.',
    ]);
  }
  if (verifying) {
    terminal.notice('VERIFIED',[
      'Shipping address, billing address, shipping service, saved card, and Store account match.',
      'Cart is empty. No order was submitted. Saved profile and rules are unchanged.',
    ],'success');
    return saved;
  }
  candidate.storageState = await store.context.storageState();
  if (signal?.aborted) throw new Error('Cancelled');
  candidate.savedAt = new Date().toISOString();
  // Commit the session only after the final prompt and empty-cart confirmation.
  const next = { ...state, profiles:{ ...state.profiles, [region]:candidate } };
  vault.write(next);
  const persisted = vault.read().profiles?.[region];
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(candidate)) throw new Error('Profile read-back failed');
  state.profiles = next.profiles;
  terminal.notice('SAVED',[
    `${terminalLabel(addressLabel)} (${region.toUpperCase()}) address profile and browser session are encrypted locally.`,
    'You can close this setup terminal now.',
    'Run npm run profiles to inspect it, or npm run verify to compare it with Store checkout.',
  ],'success');
  return candidate;
}
