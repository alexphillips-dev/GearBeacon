import { setTimeout as delay } from 'node:timers/promises';

export function publicProfiles(profiles) {
  return Object.fromEntries(Object.entries(profiles).map(([region,p])=>[region,{ id:p.id,state:p.state,addressLabel:p.addressLabel,paymentLabel:p.paymentLabel }]));
}

export async function runAttempt({ client, vault, state, attempt, makeStore }) {
  const path = `attempts/${attempt.id}`;
  if (state.journal[attempt.authorization]) {
    await client(`${path}/report`,{ code:'interrupted' });
    return;
  }
  const profile = state.profiles[attempt.region];
  if (!profile || profile.id !== attempt.profileId || profile.state !== 'ready') {
    await client(`${path}/report`,{ code:'session' }); return;
  }
  let store;
  let authorized = false;
  const journal = value => { state.journal[attempt.authorization] = { attemptId:attempt.id, ...state.journal[attempt.authorization], ...value }; vault.write(state); };
  try {
    journal({ state:'preparing' });
    store = await makeStore(attempt,profile);
    await store.prepare(attempt,profile);
    const receipt = await store.submit(attempt,profile,{
      authorize:async proof => {
        // Ambiguous authorization responses are treated conservatively; never try the gate twice.
        authorized = true;
        return client(`${path}/authorize`,proof);
      },
      beforeSubmit:async proof => journal({ state:'submitting', proof }),
      onCreated:async order => journal({ order }),
    });
    if (!receipt) throw new Error('Order confirmation was not verified.');
    journal({ state:'confirmed', receipt });
    // Retrying delivery of a confirmed receipt is safe. It cannot place another order.
    await client(`${path}/complete`,receipt);
    journal({ state:'reported' });
    profile.storageState = await store.context.storageState(); vault.write(state);
  } catch (err) {
    if (state.journal[attempt.authorization]?.receipt) return;
    journal({ state:authorized ? 'unknown' : 'attention' });
    if (!authorized) { profile.state = 'attention'; vault.write(state); }
    await client(`${path}/report`,{ code:err.code || 'interrupted' }).catch(()=>{});
  } finally { await store?.close().catch(()=>{}); }
}

export async function runCompanion({ client, vault, state, makeStore, signal }) {
  let activeAttempt = null;
  let reconnectDelay = 1000;
  const heartbeat = () => client('heartbeat',{ protocol:1,mode:state.mode,profiles:publicProfiles(state.profiles),attemptId:activeAttempt });
  let heartbeatBusy = false;
  const timer = setInterval(async()=>{
    if (heartbeatBusy) return; heartbeatBusy = true;
    try { await heartbeat(); } catch {} finally { heartbeatBusy = false; }
  },5000);
  try {
    while (!signal?.aborted) {
      try {
        await heartbeat(); reconnectDelay = 1000;
        for (const record of Object.values(state.journal)) if (record.state === 'confirmed' && record.receipt) {
          await client(`attempts/${record.attemptId}/complete`,record.receipt);
          record.state = 'reported'; vault.write(state);
        }
        const { attempt } = await client('claim');
        if (attempt) {
          activeAttempt = attempt.id;
          try { await runAttempt({ client,vault,state,attempt,makeStore }); } finally { activeAttempt = null; }
        } else await delay(1000,undefined,{ signal }).catch(()=>{});
      } catch (err) {
        if (err.status === 401 || err.status === 409) throw err;
        await delay(reconnectDelay,undefined,{ signal }).catch(()=>{});
        reconnectDelay = Math.min(30000,reconnectDelay*2);
      }
    }
  } finally { clearInterval(timer); }
}
