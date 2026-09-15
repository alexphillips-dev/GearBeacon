// Only fixed check names and nicknames/masked card labels are used in terminal reports.
// Never print browser state, account identifiers, address values, or fingerprints.
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
export async function setupProfile({ store, region, addressLabel, saved, state, vault, ask, log, signal }) {
  let candidate;
  const verifying = Boolean(saved);
  log(verifying ? 'Verification only: the saved profile and purchase rules will not be changed.'
    : 'The address nickname is only a name in GearBeacon. Choose the actual address in the Store browser.');
  log('In this dedicated browser, sign in, add one setup item, and reach checkout review. Select the shipping address, billing address, shipping service, and a saved card. Wait for the final total. Do not place an order; submission is blocked.');
  for (;;) {
    await ask('Press Enter here when checkout review and the selected saved card are visible (Ctrl+C cancels). ');
    if (signal?.aborted) throw new Error('Cancelled');
    const report = await store.inspectProfile(addressLabel);
    for (const check of report.checks) log(`${check.ok ? 'PASS' : 'NEEDS ATTENTION'} · ${check.name}${check.ok ? '' : ': ' + check.help}`);
    if (!report.profile) { log('Nothing saved. Correct the checks above in the same browser, then try again.'); continue; }
    if (verifying) {
      const matches = profileMatches(saved,report.profile);
      for (const check of matches) log(`${check.ok ? 'MATCH' : 'DIFFERENT'} · ${check.name}`);
      if (!matches.every(check=>check.ok)) { log('The checkout does not match the saved profile. Select the original choices and retry, or cancel and use npm run connect to replace it.'); continue; }
    }
    candidate = report.profile; break;
  }
  log(verifying ? 'Saved choices match this checkout. Remove the setup item to finish verification.'
    : 'Checkout checks passed. NOT SAVED YET: remove the setup item from the Store cart, then complete the next prompt.');
  for (;;) {
    await ask('Press Enter AFTER the Store cart is empty (Ctrl+C cancels). ');
    if (signal?.aborted) throw new Error('Cancelled');
    if (await store.confirmEmptyCart()) break;
    log('An empty cart could not be confirmed. Remove all items in the same browser and try again. Nothing has been saved.');
  }
  if (verifying) {
    log('VERIFIED: shipping address, billing address, shipping service, saved card, and Store account match. Cart is empty. No order was submitted; saved profile and rules are unchanged.');
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
  log(`SAVED: ${terminalLabel(addressLabel)} (${region.toUpperCase()}) address profile and browser session are encrypted locally. You can close this setup terminal now.`);
  log('Run npm run profiles to inspect it, or npm run verify to compare it with Store checkout.');
  return candidate;
}
