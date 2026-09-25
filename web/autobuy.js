/* Optional purchasing UI. Form drafts remain untouched by background status refreshes. */
let autoBuyState = null;
let autoBuyLoading = false;
let autoBuyDraft = null;
let autoBuyFocus = null;
let autoBuyDialogRequest = 0;
let autoBuyUiEpoch = 0;
let autoBuyGuidePaired = null;
let autoBuyPairingTimer = null;
const autoBuyLabels = { armed:'Auto-buy armed', paused:'Auto-buy paused', attention:'Needs attention', expired:'Authorization expired', purchased:'Purchased', queued:'Waiting for checkout', preparing:'Preparing checkout', submitting:'Submitting order', unknown:'Check Store orders', cancelled:'Cancelled' };
const autoBuyMoney = (minor,currency) => new Intl.NumberFormat(undefined,{ style:'currency',currency }).format(minor/100);
function clearAutoBuyPairing() {
  clearTimeout(autoBuyPairingTimer); autoBuyPairingTimer = null;
  $('autoBuyPairing').value = ''; $('autoBuyPairing').hidden = true;
  $('autoBuyPairingRow').hidden = true; $('autoBuyPairingLabel').textContent = '';
}
function clearAutoBuyUi() {
  autoBuyUiEpoch++; autoBuyDialogRequest++; autoBuyDraft = null; autoBuyState = null; autoBuyFocus = null;
  $('autoBuyDialog').close(); $('autoBuyDialogBody').textContent = ''; $('autoBuyDialogResult').textContent = '';
  clearAutoBuyPairing(); autoBuyGuidePaired = null; $('autoBuyGuide').open = false;
}
function autoBuyCard(product) {
  const rule = product.autoBuy;
  return `<div class="auto-buy-card"><button type="button" class="auto-buy-action ${rule ? `auto-buy-${escapeHtml(rule.state)}` : ''}" data-auto-buy="${escapeHtml(product.slug)}">${rule ? escapeHtml(autoBuyLabels[rule.state] || 'Auto-buy') : 'Set up auto-buy'}</button>${rule ? `<span class="meta">Qty ${rule.quantity} · Up to ${escapeHtml(autoBuyMoney(rule.maxTotalMinor,rule.currency))}${rule.state === 'armed' ? ` · Expires ${escapeHtml(new Date(rule.expiresAt).toLocaleDateString())}` : ''}</span>` : ''}</div>`;
}
function autoBuyNavigate(section) {
  document.querySelector('[data-tab="settings"]').click();
  document.querySelector(`[data-settings-tab="${section === 'purchases' ? 'operations' : 'general'}"]`).click();
  document.querySelector(`[data-settings-subtab="${section === 'purchases' ? 'operations/purchases' : 'general/autobuy'}"]`).click();
}
function autoBuyMarkup(element,html) {
  if (element.dataset.rendered === html) return;
  const focus = element.contains(document.activeElement) ? document.activeElement?.dataset.autoAttempt : null;
  element.innerHTML = html; element.dataset.rendered = html;
  if (focus) [...element.querySelectorAll('[data-auto-attempt]')].find(node=>node.dataset.autoAttempt === focus)?.focus({ preventScroll:true });
}
async function refreshAutoBuy() {
  if (autoBuyLoading || document.hidden || $('appShell').classList.contains('hidden')) return;
  autoBuyLoading = true;
  const epoch = autoBuyUiEpoch;
  try {
    const state = await api('/api/auto-buy');
    if (epoch !== autoBuyUiEpoch || $('appShell').classList.contains('hidden')) return;
    autoBuyState = state;
    const connection = state.connection;
    const paired = Boolean(connection);
    // Only change the default when pairing changes, preserving manual toggles during polling.
    if (autoBuyGuidePaired !== paired) { $('autoBuyGuide').open = !paired; autoBuyGuidePaired = paired; }
    if (paired) clearAutoBuyPairing();
    const profiles = Object.entries(connection?.profiles || {});
    autoBuyMarkup($('autoBuyConnection'),`<p><strong>${state.mode === 'mock' ? 'Mock mode · simulated purchases only. ' : ''}${connection?.connected ? 'Checkout companion connected' : connection ? 'Checkout companion offline' : 'No checkout companion connected'}</strong></p>${connection ? profiles.length
      ? profiles.map(([region,p])=>`<p>Saved profile · ${escapeHtml(region.toUpperCase())} · ${escapeHtml(p.addressLabel)} · ${escapeHtml(p.paymentLabel)} · ${p.state === 'ready' ? 'Ready at last report' : 'Reconnect Store'}</p>`).join('')
      : '<p>Companion paired, but no saved address profile has been reported. Run Connect and finish both Enter prompts until you see SAVED, then start the companion.</p>'
      : '<p>Pair the companion to connect your Store session and saved checkout choices.</p>'}`);
    $('autoBuyPair').disabled = Boolean(connection || state.blocked);
    $('autoBuyDisconnect').disabled = !connection;
    const armed = state.rules.filter(rule=>rule.state === 'armed').length;
    const unknown = state.attempts.some(attempt=>attempt.state === 'unknown');
    $('autoBuyWatchStatus').hidden = !armed && !state.blocked;
    $('autoBuyWatchSummary').textContent = unknown ? 'Auto-buy stopped · check the uncertain order in Purchases.' : `${armed} auto-buy instruction${armed === 1 ? '' : 's'} armed${state.blocked ? ' · checkout in progress' : ''}${connection?.connected ? '' : ' · companion offline'}`;
    autoBuyMarkup($('autoBuyAttempts'),state.attempts.length ? state.attempts.map(attempt=>`<article class="auto-buy-attempt"><div><strong>${escapeHtml(attempt.name)}</strong><p>${escapeHtml(attempt.sku)} · ${escapeHtml(attempt.region.toUpperCase())} · Qty ${attempt.quantity}</p><p class="auto-buy-${escapeHtml(attempt.state)}">${escapeHtml(autoBuyLabels[attempt.state] || attempt.state)}${attempt.receipt ? ` · ${escapeHtml(autoBuyMoney(attempt.receipt.totalMinor,attempt.receipt.currency))}` : ''}</p><time datetime="${escapeHtml(attempt.createdAt)}">${escapeHtml(new Date(attempt.createdAt).toLocaleString())}</time></div><button type="button" data-auto-attempt="${escapeHtml(attempt.id)}">${attempt.state === 'unknown' ? 'Resolve' : 'Details'}</button></article>`).join('') : '<p>No purchase attempts yet. Arm an instruction from a watched product.</p>');
    let changed = false;
    for (const product of app.products) {
      const rule = state.rules.find(item=>item.region === app.currentRegion && item.slug === product.slug) || null;
      if (JSON.stringify(product.autoBuy || null) !== JSON.stringify(rule)) { product.autoBuy = rule; changed = true; }
    }
    if (changed && app.activeTab === 'watchlist') renderProducts();
  } catch { $('autoBuyConnection').textContent = 'Auto-buy status unavailable. Check your connection before making changes.'; }
  finally { autoBuyLoading = false; }
}
function openAutoBuyDialog(title,html) {
  $('autoBuyDialogTitle').textContent = title;
  $('autoBuyDialogBody').innerHTML = html;
  $('autoBuyDialogResult').textContent = '';
  if (!$('autoBuyDialog').open) { autoBuyFocus = document.activeElement; $('autoBuyDialog').showModal(); }
  ($('autoBuyDialogBody').querySelector('select,input,button') || $('closeAutoBuyDialog')).focus();
}
async function showAutoBuy(slug) {
  const request = ++autoBuyDialogRequest, region = app.currentRegion;
  try {
    const [details,status] = await Promise.all([api(`/api/products/${encodeURIComponent(slug)}`),api('/api/auto-buy')]);
    if (request !== autoBuyDialogRequest || region !== app.currentRegion) return;
    autoBuyState = status;
    const product = details.product;
    const variants = product.variantId ? [product] : (details.variants || []).filter(item=>!item.unlisted);
    const rule = status.rules.find(item=>item.slug === slug && item.region === region);
    const profile = status.connection?.profiles[region];
    autoBuyDraft = { region,variants,rule,collections:details.collections || [],profile };
    const connected = status.connection?.connected && profile?.state === 'ready';
    const date = new Date(rule?.expiresAt && Date.parse(rule.expiresAt) > Date.now() ? rule.expiresAt : Date.now()+14*86400000);
    const localExpiry = new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
    openAutoBuyDialog(`Auto-buy · ${product.name}`,`<form data-auto-form>
      ${status.mode === 'mock' ? '<p class="settings-result">Mock mode: this instruction can only make simulated purchases.</p>' : ''}
      ${rule?.reason ? `<p class="settings-result">${escapeHtml(rule.reason)}</p>` : ''}
      <label class="field"><span>Exact variant · ${escapeHtml(region.toUpperCase())}</span><select name="variant" required>${!product.variantId ? '<option value="">Choose the exact item to purchase</option>' : ''}${variants.map(item=>`<option value="${escapeHtml(item.slug)}">${escapeHtml(item.sku)} · ${escapeHtml(item.variantTitle || item.name)}</option>`).join('')}</select></label>
      <div class="form-row"><label class="field"><span>Quantity</span><input name="quantity" type="number" min="1" max="20" step="1" required value="${rule?.quantity || 1}"/></label><label class="field"><span>Maximum final total (${escapeHtml(profile ? variants[0]?.currency || ({us:'USD',eu:'EUR',uk:'GBP',ca:'CAD'})[region] : ({us:'USD',eu:'EUR',uk:'GBP',ca:'CAD'})[region])})</span><input name="total" type="number" min="0.01" max="1000000" step="0.01" inputmode="decimal" required value="${rule ? (rule.maxTotalMinor/100).toFixed(2) : ''}" placeholder="Includes shipping and tax"/></label></div>
      <p class="rule-help">This is the most you authorize for the entire order, including shipping, tax, and surcharges.</p>
      <label class="field"><span>Expires</span><input name="expires" type="datetime-local" required value="${localExpiry}"/></label>
      <label class="field"><span>Record purchase in</span><select name="collection"><option value="">This watch only</option>${autoBuyDraft.collections.filter(item=>!item.archived).map(item=>`<option value="${escapeHtml(item.id)}" ${rule?.collectionId === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
      <div class="auto-buy-checkout"><h3>Checkout connection</h3><p>${connected ? `${escapeHtml(profile.addressLabel)} · ${escapeHtml(profile.paymentLabel)}` : 'Connect the checkout companion and verify a Store profile before arming.'}</p><button type="button" data-auto-settings>Manage connection</button></div>
      <p>Stops after one successful order. Checkout pauses if the cart, saved address, payment, or final total cannot be verified. An already available item can be purchased after the next complete Store check.</p>
      <label class="inline-check auto-buy-consent"><input name="authorized" type="checkbox" required/> I authorize one order for this exact item within the quantity, final-total limit, and expiry above.</label>
      <div class="settings-actions">${rule?.state === 'armed' ? `<button type="button" data-auto-pause="${escapeHtml(rule.id)}">Pause auto-buy</button>` : ''}<button type="button" data-auto-close>Cancel</button><button type="submit" class="primary" ${!connected || status.blocked || !variants.length ? 'disabled' : ''}>Arm auto-buy</button></div>
      ${status.blocked ? '<p class="settings-result">Finish or resolve the current checkout before arming another instruction. Open Purchases for its status.</p>' : ''}
    </form>`);
  } catch (err) { toast(err.message,'error'); }
}
async function saveAutoBuy(form) {
  if (!autoBuyDraft || autoBuyDraft.region !== app.currentRegion) throw new Error('The Store region changed. Reopen auto-buy.');
  const values = new FormData(form), variant = autoBuyDraft.variants.find(item=>item.slug === values.get('variant'));
  if (!variant) throw new Error('Choose an exact variant.');
  const total = String(values.get('total'));
  if (!/^\d+(?:\.\d{1,2})?$/.test(total)) throw new Error('Enter a final total with at most two decimal places.');
  const maxTotalMinor = Math.round(Number(total)*100);
  const expiresAt = new Date(String(values.get('expires'))).toISOString();
  const quantity = Number(values.get('quantity'));
  const result = await api('/api/auto-buy/rules',{ method:'PUT',body:JSON.stringify({ slug:variant.slug, revision:autoBuyDraft.rule?.revision || 0,
    quantity,maxTotalMinor,expiresAt,collectionId:values.get('collection') || null,authorized:values.get('authorized') === 'on',watchIfNeeded:!variant.watched }) });
  if (result.rule?.state !== 'armed') throw new Error('The server did not confirm this purchase instruction.');
  $('autoBuyDialog').close(); toast('Auto-buy armed for one order within your limits.'); await refresh(); await refreshAutoBuy();
}
function showAutoBuyAttempt(id) {
  const attempt = autoBuyState?.attempts.find(item=>item.id === id); if (!attempt) return;
  autoBuyDraft = null;
  openAutoBuyDialog(autoBuyLabels[attempt.state] || 'Purchase details',`<h3>${escapeHtml(attempt.name)}</h3><p>${escapeHtml(attempt.sku)} · ${escapeHtml(attempt.region.toUpperCase())} · Qty ${attempt.quantity}</p><p>Authorized up to ${escapeHtml(autoBuyMoney(attempt.maxTotalMinor,attempt.currency))}. Expires ${escapeHtml(new Date(attempt.expiresAt).toLocaleString())}.</p><p>${escapeHtml(attempt.reason || 'The checkout companion is processing this purchase instruction.')}</p>${attempt.receipt ? `<p>Order ${escapeHtml(attempt.receipt.orderNumber)} · ${escapeHtml(autoBuyMoney(attempt.receipt.totalMinor,attempt.receipt.currency))} · ${attempt.receipt.verified ? 'Store confirmation verified' : 'Recorded by owner'}</p>` : ''}
    <p><a href="${({us:'https://store.ui.com/us/en/account',eu:'https://eu.store.ui.com/eu/en/account',uk:'https://uk.store.ui.com/uk/en/account',ca:'https://ca.store.ui.com/ca/en/account'})[attempt.region]}" target="_blank" rel="noopener noreferrer">Open Store orders</a></p>
    ${attempt.state === 'unknown' ? `<form data-auto-resolve="${escapeHtml(attempt.id)}"><p>Close the companion browser and disconnect it in Auto-buy settings before resolving this submission. Check both Store orders and payment activity.</p><label class="field"><span>Order outcome</span><select name="outcome"><option value="not-purchased">No order was placed</option><option value="purchased">An order was placed</option></select></label><label class="field"><span>Order number (if purchased)</span><input name="orderNumber" maxlength="160"/></label><label class="field"><span>Paid total (${escapeHtml(attempt.currency)}, if purchased)</span><input name="total" type="number" min="0.01" step="0.01"/></label><label class="inline-check auto-buy-consent"><input name="checked" type="checkbox" required/> I checked Store orders and payment activity and closed the companion browser.</label><button class="primary" type="submit">Record outcome</button></form>` : '<button type="button" data-auto-close>Close</button>'}`);
}
async function autoBuyAction(button,fn) {
  button.disabled = true;
  try { await fn(); }
  catch (err) { if ($('autoBuyDialog').open) $('autoBuyDialogResult').textContent = err.message; else toast(err.message,'error'); }
  finally { if (button.isConnected) button.disabled = false; }
}
document.addEventListener('click',event=>{
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-auto-buy')) showAutoBuy(button.dataset.autoBuy);
  if (button.hasAttribute('data-auto-attempt')) showAutoBuyAttempt(button.dataset.autoAttempt);
  if (button.hasAttribute('data-auto-close')) $('autoBuyDialog').close();
  if (button.hasAttribute('data-auto-settings') || button.hasAttribute('data-auto-purchases')) {
    $('autoBuyDialog').close(); autoBuyNavigate(button.hasAttribute('data-auto-purchases') ? 'purchases' : 'settings'); refreshAutoBuy();
  }
  if (button.hasAttribute('data-auto-pause-all') || button.hasAttribute('data-auto-pause')) autoBuyAction(button,async()=>{
    const result = await api(button.hasAttribute('data-auto-pause') ? `/api/auto-buy/rules/${button.dataset.autoPause}/pause` : '/api/auto-buy/pause-all',{ method:'POST',body:'{}' });
    $('autoBuyDialog').close(); await refreshAutoBuy(); toast(result.submitting ? 'Auto-buy paused. An order already being submitted may still finish.' : 'Auto-buy paused.');
  });
});
$('autoBuyPair').addEventListener('click',event=>autoBuyAction(event.currentTarget,async()=>{
  const epoch = autoBuyUiEpoch;
  const result = await api('/api/auto-buy/pairing',{ method:'POST',body:'{}' });
  if (epoch !== autoBuyUiEpoch || $('appShell').classList.contains('hidden')) return;
  clearAutoBuyPairing();
  $('autoBuyPairingLabel').textContent = `Pairing code (${result.mode} mode, expires in 5 minutes):`;
  $('autoBuyPairingRow').hidden = false;
  $('autoBuyPairing').hidden = false;
  $('autoBuyPairing').value = result.code;
  autoBuyPairingTimer = setTimeout(clearAutoBuyPairing,300000);
}));
for (const event of ['focus','click']) $('autoBuyPairing').addEventListener(event,()=> $('autoBuyPairing').select());
$('autoBuyDisconnect').addEventListener('click',event=>autoBuyAction(event.currentTarget,async()=>{
  await api('/api/auto-buy/disconnect',{ method:'POST',body:'{}' }); await refreshAutoBuy(); toast('Companion disconnected and auto-buy paused. Close its Store browser before resolving an uncertain order.');
}));
$('closeAutoBuyDialog').addEventListener('click',()=>$('autoBuyDialog').close());
$('autoBuyDialog').addEventListener('close',()=>{
  if ($('autoBuyDialog').open) return;
  autoBuyDraft = null; autoBuyDialogRequest++;
  if ($('appShell').classList.contains('hidden')) { $('authPassword').focus(); return; }
  if (autoBuyFocus?.isConnected && !autoBuyFocus.closest('[hidden],[inert]')) autoBuyFocus.focus({ preventScroll:true });
  else $('tabWatchlist').focus({ preventScroll:true });
});
$('autoBuyDialog').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.target, button = event.submitter || form.querySelector('button[type="submit"]');
  autoBuyAction(button,async()=>{
    if (form.hasAttribute('data-auto-form')) return saveAutoBuy(form);
    const values = new FormData(form);
    await api(`/api/auto-buy/attempts/${form.dataset.autoResolve}/resolve`,{ method:'POST',body:JSON.stringify({ outcome:values.get('outcome'),orderNumber:values.get('orderNumber'),totalMinor:Math.round(Number(values.get('total'))*100),checkedStoreOrders:values.get('checked') === 'on' }) });
    $('autoBuyDialog').close(); await refreshAutoBuy(); await refresh(); toast('Purchase outcome recorded. A new purchase requires fresh authorization.');
  });
});
setInterval(refreshAutoBuy,2000);
refreshAutoBuy();
