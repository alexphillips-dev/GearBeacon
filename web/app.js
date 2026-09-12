const $ = (id) => document.getElementById(id);
const THEME_KEY = 'gearbeacon.theme';
const SETTINGS_TAB_KEY = 'gearbeacon.settingsTab';
const UI_STATE_KEY = 'gearbeacon.uiState.v1';
const SETTINGS_TABS = ['general', 'notifications', 'data', 'security', 'privacy', 'operations'];
const APP_TABS = ['watchlist', 'browse', 'activity', 'settings'];
const initialDeepLink = new URLSearchParams(location.search);

function readUiState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
const savedUiState = readUiState();

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  const isDark = next === 'dark';
  const button = $('themeBtn');
  const icon = $('themeIcon');
  if (icon) icon.textContent = isDark ? '☀' : '☾';
  if (button) {
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', isDark ? '#090b0c' : '#f4f4f2');
}

applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

const CATEGORY_ORDER = ['Cloud Gateways', 'Switching', 'WiFi', 'Cameras & Physical Security', 'Door Access', 'Integrations', 'Accessories & Cables', 'Network Storage'];
const app = {
  dataRevision: 0,
  auth: null,
  catalogVariants: [],
  currentRegion: initialDeepLink.get('region') || localStorage.getItem('gearbeacon.region') || null,
  pendingProductSlug: initialDeepLink.get('product') || null,
  pendingCollectionId: initialDeepLink.get('collection') || null,
  status: null,
  products: [],
  collections: [],
  savedViews: [],
  watchOverview: null,
  watchQuickFilter: ["ready","target","collections"].includes(savedUiState.watch?.overview) ? savedUiState.watch.overview : "all",
  collectionUndos: [],
  pendingWatchCollection:typeof savedUiState.watch?.collection === 'string' ? savedUiState.watch.collection : 'all',
  events: [],
  activity: { events:[], count:0, page:1, pages:1, limit:[20,50,100].includes(Number(savedUiState.activity?.limit)) ? Number(savedUiState.activity.limit) : 20, loaded:false },
  dataInfo: null,
  config: null,
  operations: null,
  wizardStep: 1,
  notificationPreferences: { restock:true, soldOut:false, priceChange:false, statusChange:false, newProduct:false, allActivity:false },
  activeTab: savedUiState.activeTab === 'operations' ? 'settings' : APP_TABS.includes(savedUiState.activeTab) ? savedUiState.activeTab : 'watchlist',
  activeSettingsTab: savedUiState.activeTab === 'operations' ? 'operations' : SETTINGS_TABS.includes(localStorage.getItem(SETTINGS_TAB_KEY)) ? localStorage.getItem(SETTINGS_TAB_KEY) : 'general',
  browseCategory: typeof savedUiState.browse?.category === 'string' ? savedUiState.browse.category : 'All',
  browseVisibleCount: 48,
  selectedWatch: new Set(),
  loadedImages: new Set(),
  brokenImages: new Set(),
  watchRenderKey: '',
  browseRenderKey: '',
  lastFocusedProduct: null,
  currentProductDetails: null,
  watchImportPreview: null,
  watchImportLastFocus: null,
  activityDialogLastFocus: null,
  latestEventId: null,
  serverFailures: 0,
  browserOffline: !navigator.onLine,
  reconnectPending: false,
  pendingWatchCategory: typeof savedUiState.watch?.category === 'string' ? savedUiState.watch.category : null,
  pendingActivityRegion: typeof savedUiState.activity?.scope === 'string' ? savedUiState.activity.scope : null,
  lastOperationsRefresh: 0,
};

function setControlValue(id, value) {
  const control = $(id);
  if (!control || value === undefined || value === null) return;
  if (control.tagName === 'SELECT' && ![...control.options].some((option) => option.value === value)) return;
  control.value = value;
}
function restoreUiControls() {
  setControlValue('search', savedUiState.browse?.search);
  setControlValue('browseSort', savedUiState.browse?.sort);
  for (const name of ['availability', 'watching']) {
    const value = savedUiState.browse?.[name];
    const option = [...$('browseFilters').elements[name]].find((input) => input.value === value);
    if (option) option.checked = true;
  }
  setControlValue('watchSearch', savedUiState.watch?.search);
  setControlValue('watchStatus', savedUiState.watch?.status);
  setControlValue('watchSort', savedUiState.watch?.sort);
  setControlValue('watchLayout', savedUiState.watch?.layout);
  $('groupCollectedWatches').checked = savedUiState.watch?.groupCollections === true;
  setControlValue('activitySearch', savedUiState.activity?.search);
  setControlValue('activityType', savedUiState.activity?.type);
  setControlValue('activityDelivery', savedUiState.activity?.delivery);
  setControlValue('activityFrom', savedUiState.activity?.from);
  setControlValue('activityTo', savedUiState.activity?.to);
  setControlValue('activityPageSize', String(app.activity.limit));
}
function persistUiState() {
  const state = {
    activeTab:app.activeTab,
    browse:{ search:$('search')?.value || '', category:app.browseCategory, sort:$('browseSort').value, ...browseFilterValues() },
    watch:{ overview:app.watchQuickFilter, search:$('watchSearch')?.value || '', status:$('watchStatus')?.value || 'all', category:app.pendingWatchCategory || $('watchCategory')?.value || 'all', sort:$('watchSort')?.value || 'changed', collection:app.pendingWatchCollection || $('watchCollection').value || 'all', groupCollections:$('groupCollectedWatches').checked, layout:$('watchLayout').value },
    activity:{ search:$('activitySearch')?.value || '', scope:app.pendingActivityRegion || $('activityRegion')?.value || 'all', type:$('activityType')?.value || 'all', delivery:$('activityDelivery')?.value || 'all', from:$('activityFrom')?.value || '', to:$('activityTo')?.value || '', limit:Number($('activityPageSize')?.value || 20) },
  };
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch {}
}

function viewFilters(scope) {
  if (scope === 'browse') return { search:$('search').value.trim(), category:app.browseCategory, sort:$('browseSort').value, ...browseFilterValues() };
  return { search:$('watchSearch').value.trim(), category:app.pendingWatchCategory || $('watchCategory').value || 'all', status:$('watchStatus').value, sort:$('watchSort').value, collection:app.pendingWatchCollection || $('watchCollection').value || 'all', overview:app.watchQuickFilter, groupCollections:$('groupCollectedWatches').checked, layout:$('watchLayout').value };
}
function renderSavedViews() {
  for (const scope of ['watchlist','browse']) {
    const select = $(scope === 'watchlist' ? 'watchSavedView' : 'browseSavedView');
    const views = app.savedViews.filter(view => view.scope === scope).sort((a,b) => a.name.localeCompare(b.name));
    const key = JSON.stringify(views.map(({id,name}) => [id,name]));
    if (select.dataset.options !== key) {
      select.innerHTML = '<option value="">Current filters</option>' + views.map(view => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</option>`).join('');
      select.dataset.options = key;
    }
    const filters = viewFilters(scope);
    const matches = view => Object.keys(view.filters).every(key => view.filters[key] === filters[key]);
    select.value = views.find(view => view.id === select.value && matches(view))?.id || views.find(matches)?.id || '';
    const toggle = $(scope === 'watchlist' ? 'watchViewToggle' : 'browseViewToggle');
    const selected = views.find(view => view.id === select.value);
    toggle.title = selected ? `View options. Saved view: ${selected.name}` : 'View options';
  }
  const labels = [];
  const selected = app.savedViews.find(view => view.id === $('watchSavedView').value);
  if (selected) labels.push(`View: ${selected.name}`);
  if ($('watchCategory').value !== 'all') labels.push($('watchCategory').value);
  if ($('watchLayout').value === 'compact') labels.push('Compact list');
  const context = $('watchViewContext'); const description = labels.join(' · ');
  if (context.textContent !== description) context.textContent = description;
  context.classList.toggle('hidden', !description);
}

function toolbarToggle(panel) { return document.querySelector(`[data-toolbar-toggle="${panel.id}"]`); }
function closeToolbarPanels(except = null) {
  document.querySelectorAll('[data-toolbar-panel]:not(.hidden)').forEach(panel => {
    if (panel !== except) { panel.classList.add('hidden'); toolbarToggle(panel).setAttribute('aria-expanded','false'); }
  });
}
function applySavedView(id) {
  const view = app.savedViews.find(view => view.id === id);
  if (!view) return;
  const f = view.filters;
  if (view.scope === 'watchlist') {
    if (!['all','none'].includes(f.collection) && !app.collections.some(item => item.id === f.collection)) { toast('This view refers to a deleted collection. Update its filters in Manage views.', 'error'); renderSavedViews(); return; }
    app.pendingWatchCollection = f.collection; app.pendingWatchCategory = f.category;
    for (const [control,key] of [['watchSearch','search'],['watchStatus','status'],['watchSort','sort'],['watchLayout','layout']]) setControlValue(control,f[key]);
    $('groupCollectedWatches').checked = f.groupCollections;
    app.watchQuickFilter = f.overview; app.selectedWatch.clear();
  } else {
    $('search').value = f.search; app.browseCategory = f.category; $('browseSort').value = f.sort;
    for (const name of ['availability','watching']) for (const input of $('browseFilters').elements[name]) input.checked = input.value === f[name];
    app.browseVisibleCount = 48;
  }
  renderProducts(true); persistUiState(); toast(`View applied: ${view.name}`);
}
function openOwnerDialog(title, body) {
  app.viewDraft = null; app.alertExplanationRequest = null;
  $('ownerDialogTitle').textContent = title;
  $('ownerDialogBody').innerHTML = body;
  $('ownerDialogResult').textContent = '';
  if (!$('ownerDialog').open) {
    app.ownerDialogFocus = document.activeElement;
    $('ownerDialog').showModal();
  }
  ($('ownerDialogBody').querySelector('input,button') || $('closeOwnerDialog')).focus();
}
function showViewEditor(scope, id = null) {
  const previous = app.savedViews.find(view => view.id === id);
  const draft = { scope, region:app.currentRegion, previous:previous ? structuredClone(previous) : null, filters:viewFilters(scope) };
  openOwnerDialog(previous ? 'Edit saved view' : 'Save current view', `<form id="savedViewForm"><p>Saved on this GearBeacon installation for ${escapeHtml(app.status?.regionLabel || app.currentRegion)}. Available on your other devices.</p><label class="field"><span>View name</span><input id="savedViewName" maxlength="80" required autocomplete="off" value="${escapeHtml(previous?.name || '')}" /></label>${previous ? '<label class="inline-check"><input id="replaceViewFilters" type="checkbox" /> Replace with the filters currently shown behind this dialog</label>' : '<p>Includes the current filters, sorting, and Watchlist layout/grouping where applicable.</p>'}<div class="dialog-actions"><button type="submit" class="primary">Save view</button><button type="button" data-owner-close>Cancel</button></div></form>`);
  app.viewDraft = draft;
}
function showViewManager(scope) {
  const views = app.savedViews.filter(view => view.scope === scope).sort((a,b) => a.name.localeCompare(b.name));
  openOwnerDialog(`${scope === 'browse' ? 'Browse' : 'Watchlist'} saved views`, `<p>Rename a view, replace its filters, or remove it. These changes apply across your devices.</p><div class="saved-view-list">${views.map(view => `<div class="saved-view-row"><strong>${escapeHtml(view.name)}</strong><button type="button" data-view-edit="${escapeHtml(view.id)}">Edit</button><button type="button" data-view-delete="${escapeHtml(view.id)}" data-view-revision="${view.revision}">Delete</button></div>`).join('') || '<p>No saved views in this store yet. Set your filters and choose Save view.</p>'}</div>`);
}
async function saveOwnerView(form) {
  const draft = app.viewDraft;
  if (!draft || draft.region !== app.currentRegion) return;
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  const body = { name:form.querySelector('#savedViewName').value, scope:draft.scope, filters:draft.previous && !form.querySelector('#replaceViewFilters').checked ? draft.previous.filters : draft.filters, ...(draft.previous ? {revision:draft.previous.revision} : {}) };
  try {
    const result = await api(`/api/views${draft.previous ? '/' + encodeURIComponent(draft.previous.id) : ''}`, { method:draft.previous ? 'PUT' : 'POST', body:JSON.stringify(body) });
    if (app.currentRegion === draft.region) { app.savedViews = result.views; renderSavedViews(); }
    if (app.viewDraft === draft) { $('ownerDialog').close(); toast('View saved'); }
  } catch (err) { if (app.viewDraft === draft) $('ownerDialogResult').textContent = err.message; }
  finally { button.disabled = false; }
}
async function deleteOwnerView(id, revision) {
  const previous = app.savedViews.find(view => view.id === id); if (!previous) return;
  const region = app.currentRegion; const list = $('ownerDialogBody').querySelector('.saved-view-list');
  try {
    const result = await api(`/api/views/${encodeURIComponent(id)}`, { method:'DELETE', body:JSON.stringify({revision}) });
    if (app.currentRegion === region) { app.savedViews = result.views; renderSavedViews(); }
    if ($('ownerDialog').open && list?.isConnected && app.currentRegion === region) { showViewManager(previous.scope); $('ownerDialogResult').textContent = 'View deleted. Watches and rules are unchanged.'; }
  } catch (err) { if ($('ownerDialog').open && list?.isConnected) $('ownerDialogResult').textContent = err.message; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
}
function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}
function humanStatus(value) {
  const text = String(value || 'Unknown').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1).toLowerCase()}` : 'Unknown';
}
function exactEventTime(event) {
  const date = new Date(event.detectedAt);
  if (Number.isNaN(date.valueOf())) return String(event.detectedAt || 'Unknown time');
  const timeZone = event.notificationTimeZone || app.config?.config?.notificationTimeZone;
  try { return new Intl.DateTimeFormat(undefined, { dateStyle:'full', timeStyle:'long', ...(timeZone ? { timeZone } : {}) }).format(date); }
  catch { return date.toLocaleString(); }
}
function activityDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return 'under 1m';
  const units = [['d',86400],['h',3600],['m',60]];
  let remaining = total;
  const parts = [];
  for (const [label, size] of units) {
    const amount = Math.floor(remaining / size);
    if (amount) { parts.push(`${amount}${label}`); remaining -= amount * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}
function activityPriceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9,.-]/g, '').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function activityMoney(event, value) {
  const symbol = String(event.price || event.previousPrice || '$').match(/[^\d\s.,-]+/)?.[0] || '$';
  return `${symbol}${Math.abs(value).toFixed(2)}`;
}
function activityMeta(event) {
  const parts = [];
  const previousStatus = humanStatus(event.previousStatus);
  const currentStatus = humanStatus(event.status);
  if (event.type === 'collection_ready') parts.push({ text:`${event.readiness?.remaining || 0} remaining items qualify`, className:'event-meta-transition' });
  else if (event.type === 'restock') parts.push({ text:`${event.previousStatus ? previousStatus : 'Sold out'} → In stock`, className:'event-meta-transition' });
  else if (event.type === 'sold_out') parts.push({ text:`${event.previousStatus ? previousStatus : 'In stock'} → Sold out`, className:'event-meta-transition' });
  else if (event.type === 'status_change') parts.push({ text:`${previousStatus} → ${currentStatus}`, className:'event-meta-transition' });
  else if (event.type === 'price_change') parts.push({ text:`${event.previousPrice || 'Previous price'} → ${event.price || 'New price'}`, className:'event-meta-transition' });
  else if (event.type === 'new_product') parts.push({ text:'New product discovered', className:'event-meta-transition' });
  else parts.push({ text:humanStatus(event.type), className:'event-meta-transition' });

  if (event.type !== 'price_change' && event.price) parts.push({ text:event.price, className:'event-meta-price' });
  if (event.type === 'price_change') {
    const current = event.priceValue ?? activityPriceNumber(event.price);
    const previous = event.previousPriceValue ?? activityPriceNumber(event.previousPrice);
    const difference = event.priceDifference ?? (current !== null && previous !== null ? current - previous : null);
    const percent = event.priceDifferencePercent ?? (difference !== null && previous ? (difference / previous) * 100 : null);
    if (difference !== null && Number.isFinite(Number(difference)) && Number(difference) !== 0) {
      parts.push({ text:`${Number(difference) < 0 ? '↓' : '↑'} ${activityMoney(event, Number(difference))}`, extra:Number.isFinite(Number(percent)) ? `(${Math.abs(Number(percent)).toFixed(1)}%)` : '', className:'event-meta-delta', priceDecrease:Number(difference) < 0 });
    }
    if (event.alertKind === 'target_price') parts.push({ text:'Target reached', className:'event-meta-target' });
  }
  if (event.previousStateDurationSeconds !== null && event.previousStateDurationSeconds !== undefined) {
    const duration = activityDuration(event.previousStateDurationSeconds);
    const text = event.type === 'restock' ? `Back after ${duration}` : event.type === 'sold_out' ? `Available for ${duration}` : event.type === 'price_change' ? `Price held for ${duration}` : `Previous state for ${duration}`;
    parts.push({ text, className:'event-meta-duration' });
  }
  if ((app.status?.regions?.length || 0) > 1 && event.region) parts.push({ text:String(event.region).toUpperCase(), className:'event-meta-region' });
  return parts;
}
function serverAlertTitle(event) {
  const alert = event.serverAlert || {};
  let detail = alert.detail || 'No server-side notification information is available.';
  if (alert.deliverAt && ['queued', 'retrying', 'digest', 'quiet', 'sending'].includes(alert.state)) {
    try { detail += ` Scheduled for ${new Date(alert.deliverAt).toLocaleString()}.`; } catch {}
  }
  return detail;
}
function toast(message, tone = 'neutral') {
  $('toast').textContent = message;
  $('toast').className = `toast ${tone}`;
  $('toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 2600);
}
function updateToTopVisibility() {
  const button = $('toTop');
  const visible = window.scrollY > Math.max(360, window.innerHeight * .55) && !$('appShell').classList.contains('hidden');
  button.classList.toggle('visible', visible);
  button.setAttribute('aria-hidden', String(!visible));
  button.tabIndex = visible ? 0 : -1;
}
function scrollToTop() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top:0, behavior:reduceMotion ? 'auto' : 'smooth' });
  $('appShell').focus({ preventScroll:true });
}
async function copyText(value, label) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(value));
    else {
      const input = document.createElement('textarea');
      input.value = String(value); input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      if (!document.execCommand('copy')) throw new Error('Copy was rejected by the browser.');
      input.remove();
    }
    toast(`${label} copied`, 'success');
  } catch (err) { toast(`Could not copy ${label.toLowerCase()}: ${err.message}`, 'error'); }
}
async function api(path, options = {}) {
  let target = path;
  if (path.startsWith('/api/') && !path.startsWith('/api/auth/') && app.currentRegion) {
    const separator = path.includes('?') ? '&' : '?';
    target = `${path}${separator}region=${encodeURIComponent(app.currentRegion)}`;
  }
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && app.auth?.csrfToken) headers['X-CSRF-Token'] = app.auth.csrfToken;
  const res = await fetch(target, { credentials: 'same-origin', ...options, headers });
  const data = await res.json().catch(() => ({}));
  if ([401, 428].includes(res.status) && !path.startsWith('/api/auth/')) showAuth(Boolean(data.setupRequired));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) app.dataRevision++;
  return data;
}

const renderedRows = new WeakMap();
function reconcileList(container, values, attribute, render, force = false, update = null) {
  const existing = new Map([...container.children].map(node => [node.getAttribute(attribute),node]));
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const focusedRow = focused?.closest(`[${attribute}]`);
  const focusKey = focusedRow?.getAttribute(attribute);
  const focusIndex = focusedRow ? [...focusedRow.querySelectorAll('button,a,input,select,[tabindex]')].indexOf(focused) : -1;
  const scroll = { left:window.scrollX, top:window.scrollY };
  const keep = new Set();
  values.forEach((value,index) => {
    const markup = render(value);
    const key = String(attribute === 'data-activity-event' ? value.id : value.slug ?? value.id);
    let node = existing.get(key);
    if (!node || force || renderedRows.get(node) !== markup) {
      const template = document.createElement('template'); template.innerHTML = markup;
      const replacement = template.content.firstElementChild;
      if (node && update && !force) update(node,replacement);
      else { if (node) node.replaceWith(replacement); node = replacement; }
      renderedRows.set(node,markup);
    }
    if (container.children[index] !== node) container.insertBefore(node,container.children[index] || null);
    keep.add(node);
  });
  for (const node of [...container.children]) if (!keep.has(node)) node.remove();
  if (focused && document.activeElement !== focused) {
    const row = [...container.children].find(node => node.getAttribute(attribute) === focusKey);
    const target = focused.isConnected ? focused : focusIndex < 0 ? row : row?.querySelectorAll('button,a,input,select,[tabindex]')[focusIndex];
    (target || (attribute === 'data-activity-event' ? $('activityType') : $('watchSearch')))?.focus({preventScroll:true});
  }
  if (window.scrollX !== scroll.left || window.scrollY !== scroll.top) window.scrollTo(scroll);
}

function updateOptions(select, markup) {
  if (select.gearbeaconOptions === markup) return;
  const selected = select.value;
  select.innerHTML = markup; select.gearbeaconOptions = markup;
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

async function authRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (app.auth?.csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = app.auth.csrfToken;
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showAuth(setup = false) {
  $('appShell').classList.add('hidden');
  $('authGate').classList.remove('hidden');
  $('setupTokenField').classList.toggle('hidden', !setup);
  $('confirmPasswordField').classList.toggle('hidden', !setup);
  $('authTitle').textContent = setup ? 'Secure this GearBeacon instance' : 'GearBeacon owner access';
  $('authDescription').textContent = setup
    ? 'Enter the one-time token from the server log and create the private owner password.'
    : 'Sign in to your private GearBeacon instance.';
  $('passwordLabel').textContent = setup ? 'Create owner password' : 'Owner password';
  $('authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('authSubmit').textContent = setup ? 'Complete private setup' : 'Sign in';
  $('setupToken').required = setup;
  $('authPasswordConfirm').required = setup;
  $('authForm').dataset.setup = setup ? '1' : '0';
  $('authError').classList.add('hidden');
  setTimeout(() => (setup ? $('setupToken') : $('authPassword')).focus(), 0);
}

async function enterApp() {
  $('authGate').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('logoutBtn').classList.toggle('hidden', !app.auth?.authenticationRequired);
  showCatalogSkeletons();
  await refresh();
  await Promise.all([refreshDataInfo(), refreshNotificationPreferences(), refreshSessions(), refreshConfiguration(), refreshOperations()]);
  if (!app.auth?.onboardingComplete) showWizard();
  else if (app.pendingProductSlug) {
    const slug = app.pendingProductSlug;
    app.pendingProductSlug = null;
    activateTab('browse');
    await openProductDialog(slug);
  }
  else if (app.pendingCollectionId) {
    const id = app.pendingCollectionId; app.pendingCollectionId = null;
    await openCollection(id, app.currentRegion);
  }
}

async function initialize() {
  try {
    app.auth = await authRequest('/api/auth/status');
    if (!app.auth.authenticated) return showAuth(app.auth.setupRequired);
    await enterApp();
  } catch (err) {
    showAuth(false);
    $('authError').classList.remove('hidden');
    $('authError').textContent = `GearBeacon server unavailable: ${err.message}`;
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const setup = $('authForm').dataset.setup === '1';
  const password = $('authPassword').value;
  const error = $('authError');
  error.classList.add('hidden');
  if (setup && password !== $('authPasswordConfirm').value) {
    error.textContent = 'The owner passwords do not match.';
    error.classList.remove('hidden');
    return;
  }
  $('authSubmit').disabled = true;
  try {
    const result = await authRequest(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(setup ? { setupToken: $('setupToken').value, password } : { password }),
    });
    app.auth = { ...(await authRequest('/api/auth/status')), csrfToken: result.csrfToken };
    $('authForm').reset();
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  } finally {
    $('authSubmit').disabled = false;
  }
}

async function logout() {
  try { await authRequest('/api/auth/logout', { method: 'POST' }); } catch {}
  app.auth = await authRequest('/api/auth/status').catch(() => ({ authenticationRequired: true }));
  showAuth(false);
}

function productDetail(p) {
  if (p.unlisted) return 'No longer listed in two complete catalog checks';
  if (p.inStock) return 'Last known available';
  if (p.restockEtaAt) return `Store ETA ${new Date(p.restockEtaAt).toLocaleDateString()}`;
  if (p.comingSoon) return 'Coming soon';
  if (p.soldOutAt) return `Sold out ${relativeTime(p.soldOutAt)}`;
  return 'Waiting for restock';
}
function freshnessLabel(product) {
  const evidence = product.freshness;
  let state = evidence?.state || 'unknown';
  if (['confirmed','pending'].includes(state) && (app.browserOffline || app.serverFailures > 0 || !evidence.expiresAt || Date.now() > new Date(evidence.expiresAt).getTime())) state = 'stale';
  if (state === 'pending') return { state, text:'Change awaiting confirmation', title:`Stock or price change awaiting a second complete observation. Last confirmed: ${evidence.checkedAt ? alertDate(evidence.checkedAt) : 'not yet observed'}.` };
  if (state === 'confirmed') return { state, text:`Confirmed ${relativeTime(evidence.checkedAt)}`, title:`Last complete, confirmed observation: ${alertDate(evidence.checkedAt)}.` };
  return { state, text:state === 'stale' ? `${product.inStock ? 'Last known available' : 'Last known status'} · checks delayed` : 'Awaiting a complete check', title:evidence?.checkedAt ? `Last confirmed ${alertDate(evidence.checkedAt)}. Current stock and price are unconfirmed.` : 'No current, complete observation is available.' };
}
function freshnessMarkup(product) {
  const label = freshnessLabel(product);
  return `<span class="product-freshness" data-product-freshness="${escapeHtml(product.slug)}" data-freshness-state="${label.state}" title="${escapeHtml(label.title)}" aria-label="${escapeHtml(`${label.text}. ${label.title}`)}">${escapeHtml(label.text)}</span>`;
}
function updateProductFreshness() {
  const products = new Map([...app.products,...app.catalogVariants].map(product => [product.slug,product]));
  const dialogProduct = app.currentProductDetails?.product;
  if (dialogProduct && !products.has(dialogProduct.slug)) products.set(dialogProduct.slug, dialogProduct);
  document.querySelectorAll('[data-product-freshness]').forEach(node => {
    const product = products.get(node.dataset.productFreshness);
    if (!product) return;
    const label = freshnessLabel(product);
    if (node.textContent !== label.text) node.textContent = label.text;
    node.title = label.title; node.dataset.freshnessState = label.state;
    node.setAttribute('aria-label', `${label.text}. ${label.title}`);
    if (node.closest('#productDialog')) {
      const status = $('productDialogBody').querySelector('.product-status-row .badge');
      const price = $('productDialogBody').querySelector('.product-status-row strong');
      if (status) { status.textContent=product.unlisted ? 'Unlisted' : product.inStock ? 'In stock' : product.comingSoon ? 'Coming soon' : 'Sold out'; status.className=`badge ${product.inStock ? 'in' : product.comingSoon ? 'soon' : 'out'}`; }
      if (price) price.textContent=product.price || 'Price unavailable';
      // Refresh displayed facts together with their evidence without replacing the rule draft.
      if (dialogProduct) for (const key of ['status','inStock','unlisted','comingSoon','price','freshness','lastSeenAt']) dialogProduct[key]=product[key];
    }
  });
}

function priceNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9,.-]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function watchPaused(p) {
  if (p.watchRule?.purchasedAt) return true;
  const until = p.watchRule?.pausedUntil;
  return p.watchRule?.enabled === false || until === 'indefinite' || Boolean(until && new Date(until).getTime() > Date.now());
}
function collectionAlertSources(p, collections = app.collections) {
  return collections.filter((collection) => !collection.archived && collection.notifyReady && collection.alertsOnly && collection.slugs.includes(p.slug));
}
function ruleSummary(p) {
  const sources = collectionAlertSources(p);
  if (sources.length) return `<span class="rule-chip" title="${escapeHtml(sources.map(item=>item.name).join(', '))}">Collection alerts only: ${escapeHtml(sources.map(item=>item.name).join(', '))}</span>`;
  if (p.watchRule?.purchasedAt) return '<span class="rule-chip">Purchased · alerts stopped</span>';
  if (watchPaused(p)) return '<span class="rule-chip paused">Alerts paused</span>';
  const rule = p.watchRule || {};
  const chips = [];
  if (rule.targetPrice !== null && rule.targetPrice !== undefined) chips.push(`${rule.availableUnderTarget ? 'Available at' : 'Target'} ${Number(rule.targetPrice).toFixed(2)} ${app.status?.region === 'eu' ? 'EUR' : app.status?.region === 'uk' ? 'GBP' : app.status?.region === 'ca' ? 'CAD' : 'USD'}`);
  else if (rule.priceDropOnly) chips.push('Price drops');
  if (rule.immediateRestock) chips.push('Immediate restock');
  return (chips.length ? chips : ['Global alert rules']).map((text) => `<span class="rule-chip">${escapeHtml(text)}</span>`).join('');
}
function updateWatchAlertSummaries(workspace) {
  for (const product of app.products) if (workspace.watchAlerts?.[product.slug]) product.alertSummary = workspace.watchAlerts[product.slug];
}
function channelLabel(channel) { return ({email:'Email',discord:'Discord',gotify:'Gotify',ntfy:'ntfy',webhook:'Webhook'})[channel] || channel; }
function alertDate(value) { return value ? new Date(value).toLocaleString() : 'Now'; }
function alertSummaryMarkup(item, scope = 'watch') {
  const summary = item.alertSummary;
  if (!summary) return `<div class="rule-chips">${scope === 'watch' ? ruleSummary(item) : ''}</div>`;
  return `<div class="alert-summary"><span>${escapeHtml(summary.label)}</span><button type="button" class="alert-why" data-alert-explain="${scope}" data-alert-id="${escapeHtml(scope === 'collections' ? item.id : item.slug)}" aria-label="Why these alerts for ${escapeHtml(item.name)}?">Why?</button></div>`;
}
async function showAlertExplanation(scope, id) {
  const request = {};
  openOwnerDialog('Alert explanation', '<p>Loading saved rules and delivery status…</p>');
  app.alertExplanationRequest = request;
  try {
    const result = await api(`/api/${scope === 'collections' ? 'collections' : 'watch'}/${encodeURIComponent(id)}/alerts`);
    if (app.alertExplanationRequest !== request || !$('ownerDialog').open) return;
    const configuration = result.configuration;
    const modes = {'immediate-restock':'Immediately, bypassing grouping, digest and quiet hours',immediate:'Immediately',grouped:'After the grouping window',digest:'In the next digest','after-quiet-hours':'After quiet hours'};
    const types = {restock:'Restock',sold_out:'Sellout',price_change:'Price change',status_change:'Status change',collection_ready:'Collection readiness'};
    $('ownerDialogTitle').textContent = `Alerts · ${result.name}`;
    $('ownerDialogBody').innerHTML = `<div class="alert-explanation"><section><h3>${escapeHtml(configuration.label)}</h3><ul>${configuration.reasons.map(reason=>`<li>${escapeHtml(reason)}</li>`).join('')}</ul><p>Server channels: ${escapeHtml(configuration.channels.map(channelLabel).join(', ') || 'None enabled')}.</p></section>
      <section><h3>Delivery timing</h3><p>For a new matching event, using the current schedule (${escapeHtml(configuration.timeZone)}):</p>${result.plans.length ? `<ul>${result.plans.map(plan=>`<li>${escapeHtml(types[plan.type] || plan.type)}: ${escapeHtml(modes[plan.mode] || plan.mode)} · ${escapeHtml(alertDate(plan.deliverAt))}</li>`).join('')}</ul>` : '<p>No new server deliveries under the current rules.</p>'}${result.cooldowns.length ? `<p>Repeated events are held by cooldown: ${result.cooldowns.map(row=>`${escapeHtml(types[row.type] || row.type)} until ${escapeHtml(alertDate(row.until))}`).join('; ')}.</p>` : ''}</section>
      <section><h3>Actual notification jobs</h3>${result.delivery.length ? `<p>Latest ${result.delivery.length} pending, processing or failed jobs (up to ${result.deliveryLimit}).</p><ul>${result.delivery.map(job=>`<li>${escapeHtml(channelLabel(job.channel))} · ${escapeHtml(job.status === 'processing' ? 'Sending' : job.status === 'failed' ? 'Failed' : 'Queued')} · ${escapeHtml(alertDate(job.deliverAt))}${job.mode ? ` · ${escapeHtml(modes[job.mode] || job.mode)}` : ''} · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}</li>`).join('')}</ul>` : '<p>No pending, processing or failed jobs for this item.</p>'}<p>Activity shows event decisions; Settings &gt; Operations provides delivery history and retry controls. Saving a rule does not create a notification job.</p></section></div>`;
  } catch (error) { if (app.alertExplanationRequest === request) $('ownerDialogResult').textContent = error.message; }
}
function imageMarkup(p, className = 'product-image') {
  const failed = app.brokenImages.has(p.imageUrl);
  const retry = failed && p.imageUrl ? ` data-image-retry="${escapeHtml(p.imageUrl)}" title="Retry product image"` : '';
  const fallback = `<div class="image-placeholder${failed ? ' image-error' : ''}" aria-hidden="true"${retry}><span>${failed ? 'Image unavailable · retry' : ''}</span></div>`;
  if (!p.imageUrl) return fallback;
  return `${fallback}<img class="${className}" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy" data-product-image="${escapeHtml(p.imageUrl)}" />`;
}
function showCatalogSkeletons() {
  const watchSkeleton = '<article class="card skeleton-card" aria-hidden="true"><div class="skeleton skeleton-image"></div><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></article>';
  const browseSkeleton = '<article class="store-card skeleton-card" aria-hidden="true"><div class="skeleton skeleton-store-image"></div><div class="store-card-body"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div></div></article>';
  $('watchGrid').innerHTML = watchSkeleton.repeat(3);
  $('browseGrid').innerHTML = browseSkeleton.repeat(8);
  $('browseCount').textContent = 'Loading products…';
}
function wireProductImages(root = document) {
  root.querySelectorAll('img[data-product-image]').forEach((image) => {
    if (image.dataset.imageWired === 'true') return;
    image.dataset.imageWired = 'true';
    const url = image.dataset.productImage;
    const showImage = () => { app.loadedImages.add(url); app.brokenImages.delete(url); image.parentElement?.classList.add('image-loaded'); };
    const removeBrokenImage = () => {
      app.brokenImages.add(url); app.loadedImages.delete(url);
      const placeholder = image.parentElement?.querySelector('.image-placeholder');
      if (placeholder) {
        placeholder.classList.add('image-error');
        placeholder.dataset.imageRetry = url;
        placeholder.title = 'Retry product image';
        placeholder.querySelector('span').textContent = 'Image unavailable · retry';
      }
      image.remove();
    };
    image.addEventListener('load', showImage, { once: true });
    image.addEventListener('error', removeBrokenImage, { once: true });
    if (app.loadedImages.has(url)) showImage();
    else if (app.brokenImages.has(url)) removeBrokenImage();
    else if (image.complete) {
      if (image.naturalWidth > 0) showImage();
      else removeBrokenImage();
    }
  });
}
function watchCard(p) {
  const badgeClass = p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out';
  const badgeText = p.unlisted ? 'Unlisted' : p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out';
  const changedRecently = p.lastChangedAt && Date.now() - new Date(p.lastChangedAt).getTime() < 7 * 24 * 60 * 60 * 1000;
  return `<article class="card watch-card${watchPaused(p) ? ' paused' : ''}" data-product-card="${escapeHtml(p.slug)}">
    <label class="watch-select"><input type="checkbox" data-watch-select="${escapeHtml(p.slug)}" ${app.selectedWatch.has(p.slug) ? 'checked' : ''}/><span>Select ${escapeHtml(p.name)}</span></label>
    <button class="watch-image media-shell product-detail-trigger" type="button" data-product-detail="${escapeHtml(p.slug)}" aria-label="View ${escapeHtml(p.name)}">${imageMarkup(p)}</button>
    <div class="card-top"><span class="badge ${badgeClass}">${badgeText}</span><span class="meta">${escapeHtml(p.category)}</span></div>
    <button class="product-name-button" type="button" data-product-detail="${escapeHtml(p.slug)}"><h3>${escapeHtml(p.name)}</h3></button>
    <div class="meta">${escapeHtml(p.sku || p.slug)}${p.variantId ? '' : ' · Any variant'}</div>
    <div class="price">${escapeHtml(p.price || 'Price unavailable')}</div>
    <div class="detail">${escapeHtml(productDetail(p))}${changedRecently ? ' · changed recently' : ''}</div>
    ${freshnessMarkup(p)}
    ${alertSummaryMarkup(p)}
    <div class="rule-chips">${(p.collections || []).map((id) => app.collections.find((collection) => collection.id === id)).filter(Boolean).map((collection) => `<span class="rule-chip">Collection: ${escapeHtml(collection.name)}</span>`).join('')}</div>
    <div class="card-actions">
      <button data-product-detail="${escapeHtml(p.slug)}">Alert rules</button>
      <button data-purchased="${escapeHtml(p.slug)}">${p.watchRule?.purchasedAt ? 'Still wanted' : 'Purchased'}</button>
      <button class="watching" data-watch="${escapeHtml(p.slug)}">Remove</button>
    </div>
  </article>`;
}
function browseProductInfo(p, variants) {
  const watching = p.watched || variants.some((variant) => variant.watched);
  variants = variants.filter((variant) => !variant.unlisted && (!Array.isArray(p.variantKeys) || p.variantKeys.includes(variant.slug)));
  const prices = variants.map((variant) => ({ text:variant.price, value:activityPriceNumber(variant.price) }));
  const completePrices = prices.length > 1 && prices.every((price) => price.value !== null && price.value >= 0);
  const lowest = completePrices ? prices.reduce((a,b) => a.value <= b.value ? a : b) : null;
  const singlePrice = variants.length === 1 ? variants[0].price : p.price;
  const price = variants.length > 1 ? lowest ? `From ${lowest.text}` : 'Prices vary' : singlePrice || 'Price unavailable';
  return { watching, price, priceValue:variants.length > 1 ? lowest?.value ?? null : activityPriceNumber(singlePrice), sku:variants.length === 1 ? variants[0].sku || p.slug : p.sku || p.slug, variantCount:variants.length };
}
function storeCard(p, info) {
  const statusClass = p.unlisted ? 'out unlisted' : p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out sold-out';
  const status = p.unlisted ? 'Unlisted' : p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out';
  return `<article class="store-card" data-product-card="${escapeHtml(p.slug)}">
    <div class="store-media">
      <button class="store-image media-shell product-detail-trigger" type="button" data-product-detail="${escapeHtml(p.slug)}" aria-label="View ${escapeHtml(p.name)}">${imageMarkup(p)}</button>
      ${info.watching ? '<span class="store-watching-badge">✓ Watching</span>' : ''}
    </div>
    <div class="store-card-body">
      <button type="button" data-product-detail="${escapeHtml(p.slug)}" class="store-product-link"><h3>${escapeHtml(p.name)}</h3></button>
      <div class="store-sku">${escapeHtml(info.sku)}</div>
      <div class="store-product-meta"><span>${escapeHtml(p.category)}</span>${info.variantCount > 1 ? `<button type="button" data-product-detail="${escapeHtml(p.slug)}">${info.variantCount} variants</button>` : ''}</div>
      <div class="store-price-row"><strong>${escapeHtml(info.price)}</strong><span class="stock-label ${statusClass}">${status}</span></div>
      ${freshnessMarkup(p)}
      <button class="store-watch ${info.watching ? 'watching' : ''}" data-add-watch="${escapeHtml(p.slug)}" aria-label="Add ${escapeHtml(p.name)} to Watchlist or a collection">${info.watching ? 'Add to collection' : '+ Add to Watchlist or collection'}</button>
    </div>
  </article>`;
}

function categories() {
  const found = [...new Set(app.products.map((p) => p.category).filter(Boolean))];
  found.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a); const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return ['All', ...found];
}
function categoryIcon(category) {
  const shapes = {
    'Cloud Gateways':'<rect x="4" y="5" width="24" height="22" rx="4"/><path d="M9 20h8m5 0h1M9 11h14"/>',
    Switching:'<rect x="2" y="9" width="28" height="14" rx="3"/><path d="M7 14v4m5-4v4m5-4v4m6-4v4"/>',
    WiFi:'<circle cx="16" cy="16" r="13"/><circle cx="16" cy="16" r="4"/>',
    'Cameras & Physical Security':'<path d="M7 11h12l7 5-7 5H7zM10 21v6m-5 0h10"/><circle cx="24" cy="16" r="3"/>',
    'Door Access':'<rect x="7" y="2" width="18" height="28" rx="3"/><circle cx="16" cy="12" r="4"/><path d="M13 23h6"/>',
    Integrations:'<rect x="4" y="4" width="9" height="9" rx="2"/><rect x="19" y="19" width="9" height="9" rx="2"/><path d="M13 8h11v11M8 13v11h11"/>',
    'Accessories & Cables':'<path d="M8 4v5m-4 0h8v6H4zm4 6v6a6 6 0 0 0 12 0v-6m-4-6h8v6h-8zm4-5v5"/>',
    'Network Storage':'<rect x="4" y="3" width="24" height="26" rx="3"/><path d="M9 9h14M9 15h14M9 21h9m5 0h1"/>',
  };
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shapes[category] || '<rect x="4" y="4" width="9" height="9" rx="2"/><rect x="19" y="4" width="9" height="9" rx="2"/><rect x="4" y="19" width="9" height="9" rx="2"/><rect x="19" y="19" width="9" height="9" rx="2"/>'}</svg>`;
}
function renderCategoryTabs() {
  const tabs = categories();
  if (!tabs.includes(app.browseCategory)) app.browseCategory = 'All';
  const labels = { All:'All products', 'Cameras & Physical Security':'Physical Security', 'Accessories & Cables':'Accessories' };
  const markup = tabs.map((category, index) => {
    const count = app.products.filter((p) => !p.variantId && (category === 'All' || p.category === category)).length;
    const active = app.browseCategory === category;
    return `<button id="storeCategory${index}" type="button" class="store-category-tab ${active ? 'active' : ''}" data-category="${escapeHtml(category)}" role="tab" aria-controls="browseResults" aria-selected="${active}" tabindex="${active ? 0 : -1}">${categoryIcon(category)}<span class="store-category-name">${escapeHtml(labels[category] || category)}</span><span class="store-category-count">${count} product${count === 1 ? '' : 's'}</span></button>`;
  }).join('');
  // Catalog refreshes must not remove the focused category control.
  if ($('categoryTabs').dataset.rendered !== markup) {
    const focused = document.activeElement?.closest('#categoryTabs [data-category]')?.dataset.category;
    $('categoryTabs').innerHTML = markup;
    $('categoryTabs').dataset.rendered = markup;
    if (focused) [...$('categoryTabs').children].find((tab) => tab.dataset.category === focused)?.focus({ preventScroll:true });
  }
  $('browseResults').setAttribute('aria-labelledby', `storeCategory${tabs.indexOf(app.browseCategory)}`);
}

function browseFilterValues() {
  return { availability:$('browseFilters').elements.availability.value, watching:$('browseFilters').elements.watching.value };
}
function selectBrowseCategory(category) {
  app.browseCategory = category; app.browseVisibleCount = 48; persistUiState(); renderProducts(true);
  const tab = $('categoryTabs').querySelector('[aria-selected="true"]');
  tab?.focus({ preventScroll:true });
  if (tab) $('categoryTabs').scrollLeft = tab.offsetLeft - ($('categoryTabs').clientWidth - tab.offsetWidth) / 2;
}
function renderWatchOverview() {
  const summary=app.watchOverview;
  $('watchOverview').classList.toggle('hidden',!summary);
  $('watchOverviewHint').classList.toggle('hidden',!summary);
  if (!summary) return;
  for (const [id,key] of [['overviewReady','readyToBuy'],['overviewTarget','targetMet'],['overviewCollections','collectionsReady']]) $(id).textContent=summary[key].length;
  for (const button of $('watchOverview').querySelectorAll('button')) button.setAttribute('aria-pressed',String(app.watchQuickFilter===button.dataset.watchOverview));
}

function filterWatchOverview(value) {
  const next=app.watchQuickFilter===value ? 'all' : value;
  resetWatchFilters(); app.watchQuickFilter=next; app.selectedWatch.clear(); persistUiState(); renderProducts(true);
  $('watchOverview').querySelector(`[data-watch-overview="${value}"]`)?.focus();
}

function filteredWatchlist({ includeCollected = false, ignoreQuick = false } = {}) {
  const query = $('watchSearch').value.trim().toLowerCase();
  const status = $('watchStatus').value;
  const category = $('watchCategory').value;
  const sort = $('watchSort').value;
  const quick=ignoreQuick ? 'all' : app.watchQuickFilter;
  const matches=quick==='ready' ? app.watchOverview?.readyToBuy : quick==='target' ? app.watchOverview?.targetMet : null;
  const products = app.products.filter((p) => p.watched).filter((p) => {
    if (quick==='collections' || (matches && !matches.includes(p.slug))) return false;
    if (query && !`${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(query)) return false;
    if (category !== 'all' && p.category !== category) return false;
    if (status === 'in' && !p.inStock) return false;
    if (status === 'out' && p.inStock) return false;
    if (status === 'paused' && !watchPaused(p)) return false;
    if (status === 'purchased' && !p.watchRule?.purchasedAt) return false;
    if (status === 'wanted' && p.watchRule?.purchasedAt) return false;
    const collection = $('watchCollection').value;
    if (quick==='all' && !includeCollected && $('groupCollectedWatches').checked && collection === 'all' && p.collections?.length) return false;
    if (collection === 'none' && p.collections?.length) return false;
    if (!['all','none'].includes(collection) && !p.collections?.includes(collection)) return false;
    return true;
  });
  products.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'price-low') return priceNumber(a.price) - priceNumber(b.price);
    if (sort === 'price-high') return priceNumber(b.price) - priceNumber(a.price);
    if (sort === 'availability') return Number(b.inStock) - Number(a.inStock) || a.name.localeCompare(b.name);
    if (sort === 'added') return String(b.watchedAt || '').localeCompare(String(a.watchedAt || ''));
    return String(b.lastChangedAt || '').localeCompare(String(a.lastChangedAt || ''));
  });
  return products;
}
function renderWatchFilters(watched) {
  const collection = app.pendingWatchCollection || $('watchCollection').value || 'all';
  updateOptions($('watchCollection'), '<option value="all">All collections</option><option value="none">Uncollected</option>' + app.collections.filter(item=>!item.archived || item.id===collection).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join(''));
  $('watchCollection').value = ['all','none',...app.collections.map((item) => item.id)].includes(collection) ? collection : 'all';
  app.pendingWatchCollection = null;
  const selected = app.pendingWatchCategory || $('watchCategory').value || 'all';
  const choices = [...new Set(watched.map((p) => p.category).filter(Boolean))].sort();
  updateOptions($('watchCategory'), '<option value="all">All categories</option>' + choices.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
  $('watchCategory').value = choices.includes(selected) ? selected : 'all';
  if (choices.includes(selected) || watched.length) app.pendingWatchCategory = null;
}
function watchFiltersActive() { return Boolean(app.watchQuickFilter !== 'all' || $('watchSearch').value.trim() || $('watchStatus').value !== 'all' || $('watchCategory').value !== 'all' || $('watchSort').value !== 'changed' || $('watchCollection').value !== 'all'); }
function browseFiltersActive() { const filters = browseFilterValues(); return Boolean($('search').value.trim() || app.browseCategory !== 'All' || filters.availability !== 'all' || filters.watching !== 'all' || $('browseSort').value !== 'name'); }
function activityFiltersActive() { return Boolean($('activitySearch').value.trim() || $('activityRegion').value !== 'all' || $('activityType').value !== 'all' || $('activityDelivery').value !== 'all' || $('activityFrom').value || $('activityTo').value); }
function resetWatchFilters() {
  app.watchQuickFilter='all';
  $('watchCollection').value = 'all'; app.pendingWatchCollection = null;
  $('watchSearch').value = ''; $('watchStatus').value = 'all'; $('watchCategory').value = 'all'; $('watchSort').value = 'changed'; app.pendingWatchCategory = null;
  persistUiState(); renderProducts(true);
}
function resetBrowseFilters() {
  const restoreFocus = ['resetBrowseFilters','resetBrowseEmpty'].includes(document.activeElement?.id);
  $('search').value = ''; $('browseFilters').reset(); $('browseSort').value = 'name'; app.browseCategory = 'All'; app.browseVisibleCount = 48; persistUiState(); renderProducts(true);
  if (restoreFocus) $('search').focus({ preventScroll:true });
}
function resetActivityFilters() {
  $('activityFilters').reset(); $('activityRegion').value = 'all'; app.pendingActivityRegion = null; persistUiState(); refreshActivity(1, {reset:true});
}
function renderBulkActions() {
  const count = app.selectedWatch.size;
  $('bulkCount').textContent = `${count} selected`;
  $('bulkActions').classList.toggle('hidden', count === 0);
}
function renderProducts(force = false) {
  $('watchlistCards').classList.toggle('compact-list', $('watchLayout').value === 'compact');
  const allWatched = app.products.filter((p) => p.watched);
  renderWatchFilters(allWatched); renderWatchOverview();
  if (app.watchQuickFilter==='all' && $('groupCollectedWatches').checked && $('watchCollection').value === 'all') {
    for (const product of allWatched) if (product.collections?.length) app.selectedWatch.delete(product.slug);
  }
  renderCollectionReadiness();
  const watched = filteredWatchlist();
  $('watchCount').textContent = allWatched.length;
  if ($('settingsWatchCount')) $('settingsWatchCount').textContent = `${allWatched.length} product${allWatched.length === 1 ? '' : 's'}`;
  const watchKey = JSON.stringify([watched.map((p) => [p.slug,p.name,p.imageUrl,p.sku,p.variantTitle,p.category,p.status,p.inStock,p.unlisted,p.price,p.lastChangedAt,p.watchRule,p.collections,p.alertSummary]), app.collections.map(({ id,name,notifyReady,alertsOnly,archived,alertSummary }) => [id,name,notifyReady,alertsOnly,archived,alertSummary]), [...app.selectedWatch]]);
  if (force || watchKey !== app.watchRenderKey) {
    reconcileList($('watchGrid'), watched, 'data-product-card', watchCard);
    app.watchRenderKey = watchKey;
    wireProductImages($('watchGrid'));
  }
  const watchEmpty = $('watchEmpty');
  watchEmpty.querySelector('h3').textContent = allWatched.length ? 'No watched products match these filters' : 'No products watched yet';
  watchEmpty.querySelector('p').textContent = allWatched.length ? 'Clear or change a filter to see the rest of your watchlist.' : 'Open Browse and add the gear you are waiting for.';
  watchEmpty.querySelector('[data-goto]').classList.toggle('hidden', allWatched.length > 0);
  $('resetWatchEmpty').classList.toggle('hidden', !allWatched.length || !watchFiltersActive());
  $('resetWatchFilters').classList.toggle('hidden', !watchFiltersActive());
  const hasCards = watched.length > 0 || $('collectionReadiness').childElementCount > 0;
  watchEmpty.classList.toggle('hidden', hasCards);
  $('watchlistCards').classList.toggle('hidden', !hasCards);
  $('watchGrid').classList.toggle('hidden', watched.length === 0);
  renderBulkActions();

  renderCategoryTabs();
  const q = $('search').value.trim().toLowerCase();
  const filters = browseFilterValues();
  const variantsByParent = new Map();
  for (const product of app.catalogVariants) if (product.variantId && product.parentSlug) {
    if (!variantsByParent.has(product.parentSlug)) variantsByParent.set(product.parentSlug, []);
    variantsByParent.get(product.parentSlug).push(product);
  }
  const productInfo = new Map(app.products.filter((p) => !p.variantId).map((p) => [p.slug, browseProductInfo(p, variantsByParent.get(p.slug) || [])]));
  const filtered = app.products.filter((p) => {
    if (p.variantId) return false;
    const categoryMatch = app.browseCategory === 'All' || p.category === app.browseCategory;
    const searchMatch = !q || `${p.name} ${p.slug} ${p.category} ${(variantsByParent.get(p.slug) || []).map((v) => `${v.sku || ''} ${v.variantTitle || ''}`).join(' ')}`.toLowerCase().includes(q);
    const availability = p.unlisted ? 'unlisted' : p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out';
    const availabilityMatch = filters.availability === 'all' || filters.availability === availability;
    const watchingMatch = filters.watching === 'all' || productInfo.get(p.slug).watching === (filters.watching === 'watched');
    return categoryMatch && searchMatch && availabilityMatch && watchingMatch;
  });
  const sort = $('browseSort').value;
  filtered.sort((a,b) => {
    const byName = a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
    if (sort === 'availability') return Number(b.inStock && !b.unlisted) - Number(a.inStock && !a.unlisted) || byName;
    if (sort.startsWith('price-')) {
      const av = productInfo.get(a.slug).priceValue, bv = productInfo.get(b.slug).priceValue;
      if (av === null || bv === null) return (av === null ? 1 : 0) - (bv === null ? 1 : 0) || byName;
      return (sort === 'price-low' ? av - bv : bv - av) || byName;
    }
    return byName;
  });
  const visible = filtered.slice(0, app.browseVisibleCount);
  const browseKey = JSON.stringify(visible.map((p) => [p.slug,p.name,p.category,p.status,p.inStock,p.comingSoon,p.unlisted,p.imageUrl,productInfo.get(p.slug)]));
  if (force || browseKey !== app.browseRenderKey) {
    reconcileList($('browseGrid'), visible, 'data-product-card', (p) => storeCard(p, productInfo.get(p.slug)));
    app.browseRenderKey = browseKey;
    wireProductImages($('browseGrid'));
  }
  $('browseEmpty').classList.toggle('hidden', filtered.length > 0);
  const active = browseFiltersActive();
  $('resetBrowseFilters').classList.toggle('hidden', !active);
  $('browseActiveFilters').classList.toggle('hidden', !active);
  const filterLabels = [];
  if (q) filterLabels.push(`Search: ${$('search').value.trim()}`);
  if (app.browseCategory !== 'All') filterLabels.push(app.browseCategory);
  for (const name of ['availability','watching']) if (filters[name] !== 'all') filterLabels.push($('browseFilters').querySelector(`input[name="${name}"]:checked`).closest('label').textContent.trim());
  if (sort !== 'name') filterLabels.push($('browseSort').selectedOptions[0].textContent);
  $('browseFilterDescription').textContent = filterLabels.join(' · ');
  $('browseFilterSummary').textContent = [filters.availability,filters.watching].filter((value) => value !== 'all').length ? `${[filters.availability,filters.watching].filter((value) => value !== 'all').length} active` : 'All products';
  $('browseTitle').textContent = app.browseCategory === 'All' ? 'All products' : app.browseCategory;
  $('browseCount').textContent = filtered.length > visible.length ? `Showing ${visible.length} of ${filtered.length} products` : `${filtered.length} product${filtered.length === 1 ? '' : 's'}`;
  $('browseLoadMore').classList.toggle('hidden', visible.length >= filtered.length);
  renderSavedViews();
}

function setWatchImportError(message = '') {
  $('watchImportError').textContent = message;
  $('watchImportError').classList.toggle('hidden', !message);
}

function updateWatchImportSelection() {
  const selected = [...$('watchImportResults').querySelectorAll('[data-import-slug]:checked')];
  const count = selected.length;
  $('watchImportSelection').textContent = `${count} product${count === 1 ? '' : 's'} selected`;
  $('confirmWatchImport').textContent = count ? `Add ${count} product${count === 1 ? '' : 's'}` : 'Add products';
  $('confirmWatchImport').disabled = count === 0;
}

function renderWatchImportPreview(preview) {
  app.watchImportPreview = preview;
  const reviewCount = Number(preview.summary.regionMismatch || 0) + Number(preview.summary.unrecognized || 0) + Number(preview.summary.duplicates || 0);
  $('watchImportSummary').innerHTML = [
    ['Matched', preview.summary.matched],
    ['Ready', preview.summary.addable],
    ['Already watched', preview.summary.alreadyWatched],
    ['Needs review', reviewCount],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  const marker = { already:'✓', duplicate:'=', 'region-mismatch':'↗', unrecognized:'?' };
  $('watchImportResults').innerHTML = preview.items.length ? preview.items.map((item) => {
    const selectable = item.status === 'addable';
    const title = item.name || item.input;
    const details = item.slug ? `${item.sku || item.slug} · ${item.detail}` : item.detail;
    return `<div class="watch-import-result ${escapeHtml(item.status)}" title="Source: ${escapeHtml(item.input)}">
      ${selectable ? `<input type="checkbox" data-import-slug="${escapeHtml(item.slug)}" aria-label="Add ${escapeHtml(title)}" checked />` : `<span class="watch-import-result-marker" aria-hidden="true">${escapeHtml(marker[item.status] || '·')}</span>`}
      <div class="watch-import-result-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(details)}</small></div>
      <span class="watch-import-result-status">${escapeHtml(item.label)}</span>
    </div>`;
  }).join('') : '<div class="watch-import-empty">No import entries were found.</div>';
  $('watchImportRegion').textContent = `${preview.regionLabel} Store`;
  $('watchImportPreview').classList.remove('hidden');
  updateWatchImportSelection();
}

function clearWatchImport(clearInput = true) {
  app.watchImportPreview = null;
  $('watchImportPreview').classList.add('hidden');
  $('watchImportSummary').innerHTML = '';
  $('watchImportResults').innerHTML = '';
  if (clearInput) {
    $('watchImportInput').value = '';
    $('watchImportInput').dataset.fileName = '';
    $('watchImportFileName').textContent = 'No file selected';
    $('watchImportFile').value = '';
  }
  setWatchImportError();
  updateWatchImportSelection();
}

function openWatchImport() {
  app.watchImportLastFocus = document.activeElement;
  const regionName = $('regionPicker').selectedOptions?.[0]?.textContent || String(app.currentRegion || 'Current').toUpperCase();
  $('watchImportRegion').textContent = `${regionName} Store`;
  $('watchImportDialog').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  $('watchImportInput').focus();
}

function closeWatchImport() {
  $('watchImportDialog').classList.add('hidden');
  if ($('productDialog').classList.contains('hidden')) document.body.classList.remove('dialog-open');
  app.watchImportLastFocus?.focus?.();
}

async function previewWatchImport() {
  const button = $('previewWatchImport');
  button.disabled = true;
  button.textContent = 'Matching…';
  setWatchImportError();
  try {
    const preview = await api('/api/watch/import/preview', {
      method:'POST',
      body:JSON.stringify({ content:$('watchImportInput').value, fileName:$('watchImportInput').dataset.fileName || '' }),
    });
    renderWatchImportPreview(preview);
  } catch (err) {
    app.watchImportPreview = null;
    $('watchImportPreview').classList.add('hidden');
    setWatchImportError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Preview import';
  }
}

async function loadWatchImportFile(file) {
  if (!file) return;
  try {
    if (file.size > 200 * 1024) throw new Error('Watchlist imports must be 200 KB or smaller.');
    $('watchImportInput').value = await file.text();
    $('watchImportInput').dataset.fileName = file.name;
    $('watchImportFileName').textContent = file.name;
    await previewWatchImport();
  } catch (err) { setWatchImportError(err.message); }
  finally { $('watchImportFile').value = ''; }
}

async function confirmWatchImport() {
  const slugs = [...$('watchImportResults').querySelectorAll('[data-import-slug]:checked')].map((input) => input.dataset.importSlug);
  if (!slugs.length) return;
  const button = $('confirmWatchImport');
  button.disabled = true;
  button.textContent = 'Adding…';
  setWatchImportError();
  try {
    const result = await api('/api/watch/import', { method:'POST', body:JSON.stringify({ slugs }) });
    await refresh();
    clearWatchImport(true);
    closeWatchImport();
    toast(`${result.added} product${result.added === 1 ? '' : 's'} added to the watchlist`);
  } catch (err) {
    setWatchImportError(err.message);
    updateWatchImportSelection();
  }
}

function insightMoney(value, currency) {
  return value === null || value === undefined ? 'Not observed' : new Intl.NumberFormat(undefined, { style:'currency', currency }).format(value);
}

function insightChart(insights, price = false) {
  const rows = insights.timeline || [];
  const since = insights.timelineTruncated ? rows[0]?.startedAt : insights.since;
  const start = new Date(since).getTime(); const end = new Date(insights.until).getTime();
  const x = (at) => 12 + (new Date(at).getTime() - start) / Math.max(1, end - start) * 596;
  const values = rows.filter((row) => !row.unknown && row.priceValue !== null);
  const min = values.length ? Math.min(...values.map((row) => row.priceValue)) : 0;
  const max = values.length ? Math.max(...values.map((row) => row.priceValue)) : 1;
  const y = (value) => 125 - (value - min) / Math.max(1, max - min) * 90;
  const shapes = rows.map((row) => {
    const from = x(row.startedAt); const to = x(row.endedAt);
    const label = row.unknown ? 'Unknown' : row.inStock ? 'Available' : humanStatus(row.status);
    const title = escapeHtml(`${new Date(row.startedAt).toLocaleString()} to ${new Date(row.endedAt).toLocaleString()}: ${label}${row.price ? `, ${row.price}` : ''}`);
    if (price) return !row.unknown && row.priceValue !== null ? `<path d="M ${from.toFixed(2)} ${y(row.priceValue).toFixed(2)} H ${Math.max(from + 1, to).toFixed(2)}" stroke="currentColor" stroke-width="3"><title>${title}</title></path>` : '';
    return `<rect x="${from.toFixed(2)}" y="12" width="${Math.max(1, to - from).toFixed(2)}" height="38" class="insight-${row.unknown ? 'unknown' : row.inStock ? 'available' : 'unavailable'}"><title>${title}</title></rect>`;
  }).join('');
  const label = price ? `Catalog price observations in ${insights.currency}. Gaps have no connecting line. Values are listed below.` : 'Observed availability timeline. Unknown periods include monitoring gaps and pending confirmation. Details are listed below.';
  return `<div class="insight-chart ${price ? 'insight-price-chart' : ''}"><svg viewBox="0 0 620 ${price ? 150 : 62}" role="img" aria-label="${label}">${shapes}</svg><div class="insight-axis"><span>${escapeHtml(new Date(since).toLocaleDateString())}</span><span>${escapeHtml(new Date(insights.until).toLocaleDateString())}</span></div></div>`;
}

function renderInsights(insights) {
  const duration = (seconds) => seconds ? activityDuration(seconds) : '0m';
  const summary = `${insights.restocks.length} recorded restock${insights.restocks.length === 1 ? '' : 's'} · ${duration(insights.availableSeconds)} observed available · ${duration(Math.max(0, insights.observedSeconds - insights.availableSeconds))} observed unavailable · ${duration(insights.unknownSeconds)} unknown`;
  const rows = insights.timeline.slice(-100).reverse().map((row) => `<li><time>${escapeHtml(new Date(row.startedAt).toLocaleString())}</time> to <time>${escapeHtml(new Date(row.endedAt).toLocaleString())}</time><strong>${row.unknown ? 'Unknown' : row.inStock ? 'Available' : escapeHtml(humanStatus(row.status))}</strong>${!row.unknown && insights.exactPriceScope ? `<span>${escapeHtml(insightMoney(row.priceValue, insights.currency))}</span>` : ''}</li>`).join('');
  const priceRows = insights.prices.map((row) => `<tr><th scope="row">${row.days} days${row.fullWindow ? '' : '<small>Partial history</small>'}</th><td>${escapeHtml(insightMoney(row.lowest, insights.currency))}</td><td>${escapeHtml(insightMoney(row.lowestAvailable, insights.currency))}</td></tr>`).join('');
  const target = insights.targetPrice === null ? 'Set a target price in the watch rules to compare it with the current price.' : `Target: ${insightMoney(insights.targetPrice, insights.currency)}. ${!insights.currentConfirmed ? 'Waiting for a fresh, confirmed price.' : insights.targetDifference === null ? 'Current price unavailable.' : insights.targetDifference <= 0 ? 'Current price is at or below target.' : `${insightMoney(insights.targetDifference, insights.currency)} above target.`}`;
  return `<div class="insight-heading"><h3>Stock insights</h3><label class="field"><span>History window</span><select data-insight-days>${[7,30,90].map((days) => `<option value="${days}" ${days === insights.days ? 'selected' : ''}>${days} days</option>`).join('')}</select></label></div>
    <p class="insight-summary" role="status">${escapeHtml(summary)}</p><p class="insight-note">${insights.historySince ? `Retained observations begin ${escapeHtml(new Date(insights.historySince).toLocaleString())}.` : 'Insufficient history. Insights begin with complete store checks after this update.'} ${insights.fullWindow ? '' : 'The selected window has partial history.'} These are observations between checks; changes can occur between polls.</p>
    ${insightChart(insights)}<div class="insight-legend"><span><i class="insight-available"></i>Available</span><span><i class="insight-unavailable"></i>Unavailable / unlisted</span><span><i class="insight-unknown"></i>Unknown</span></div>
    <h3>Price insights</h3>${insights.exactPriceScope ? `${insightChart(insights, true)}<div class="insight-table-wrap"><table class="insight-prices"><caption>Lowest observed catalog prices (${escapeHtml(insights.currency)})</caption><thead><tr><th scope="col">Window</th><th scope="col">Any availability</th><th scope="col">While available</th></tr></thead><tbody>${priceRows}</tbody></table></div><p>${escapeHtml(target)}</p>` : '<p>Select an exact variant above to compare prices for the same SKU.</p>'}
    <p class="insight-note">Catalog prices are not checkout totals. Shipping, additional taxes, and surcharges are not calculated. Unknown periods are excluded; historical observations do not predict future restocks.</p>
    <details class="insight-observations"><summary>Observation details</summary><p>Latest ${Math.min(100, insights.timeline.length)} periods, including gaps.${insights.timelineTruncated ? ' The chart shows the latest 600 periods; summary totals cover the selected window.' : ''}</p><ol>${rows}</ol><h4>Recorded restocks</h4><ul>${insights.restocks.length ? insights.restocks.slice(-100).reverse().map((event) => `<li>${escapeHtml(new Date(event.detectedAt).toLocaleString())}</li>`).join('') : '<li>No restocks recorded in this window.</li>'}</ul></details>`;
}

async function changeInsightWindow(days) {
  const slug = app.currentProductDetails?.product.slug;
  if (!slug) return;
  const request = app.productRequest;
  const insightRequest = (app.insightRequest || 0) + 1; app.insightRequest = insightRequest;
  try {
    const result = await api(`/api/products/${encodeURIComponent(slug)}?days=${days}`);
    if (app.productRequest !== request || app.insightRequest !== insightRequest) return;
    app.currentProductDetails.insights = result.insights;
    document.querySelector('[data-product-insights]').innerHTML = renderInsights(result.insights);
    document.querySelector('[data-insight-days]')?.focus();
  } catch (err) { toast(err.message, 'error'); }
}

function alertDeliveryFields(policy = {}) {
  const configured = app.status?.notifications || {};
  const available = { ntfy:configured.ntfyConfigured, discord:configured.discordConfigured, gotify:configured.gotifyConfigured, webhook:configured.webhookConfigured, email:configured.smtpConfigured };
  return `<fieldset class="alert-delivery-fields"><legend>Server delivery</legend>
    <label class="field"><span>Notification channels</span><select name="deliveryMode" data-delivery-mode><option value="defaults" ${policy.channels == null ? 'selected' : ''}>Use defaults</option><option value="custom" ${policy.channels != null ? 'selected' : ''}>Choose channels</option></select></label>
    <div class="delivery-channel-choices ${policy.channels == null ? 'hidden' : ''}" data-delivery-choices>${Object.keys(available).map(channel => `<label><input type="checkbox" name="deliveryChannel" value="${channel}" ${(policy.channels ?? Object.keys(available).filter(name=>available[name])).includes(channel) ? 'checked' : ''} ${policy.channels == null ? 'disabled' : ''}/> ${channelLabel(channel)}${available[channel] ? '' : ' (not configured or disabled)'}</label>`).join('')}</div>
    <p class="rule-help">Defaults use every enabled, configured server channel. Choose no channels to stop server delivery for this alert. Browser popups are separate. Route changes cancel pending deliveries to removed channels; adding channels does not resend past events.</p>
    <label class="field"><span>Expire time-sensitive alerts after (minutes)</span><input name="maxAlertAgeMinutes" type="number" min="1" max="10080" step="1" value="${policy.maxAlertAgeMinutes ?? ''}" placeholder="Never expire" /></label>
    <p class="rule-help">Applies to restocks, price opportunities, and collection readiness, including quiet hours, digests, and retries. Leave blank for no expiry. Longer limits apply to new alerts; queued alerts keep their earlier deadline. Activity history is retained.</p>
  </fieldset>`;
}
function readAlertDelivery(container) {
  return { channels:container.querySelector('[name="deliveryMode"]').value === 'defaults' ? null : [...container.querySelectorAll('[name="deliveryChannel"]:checked')].map(input=>input.value),
    maxAlertAgeMinutes:container.querySelector('[name="maxAlertAgeMinutes"]').value === '' ? null : Number(container.querySelector('[name="maxAlertAgeMinutes"]').value) };
}

function ruleSelect(name, label, value) {
  const selected = value === null || value === undefined ? 'inherit' : String(Boolean(value));
  return `<label class="field"><span>${label}</span><select name="${name}"><option value="inherit" ${selected === 'inherit' ? 'selected' : ''}>Use global setting</option><option value="true" ${selected === 'true' ? 'selected' : ''}>Enabled</option><option value="false" ${selected === 'false' ? 'selected' : ''}>Disabled</option></select></label>`;
}

function renderProductDialog(details) {
  app.currentProductDetails = details;
  const p = details.product;
  const rule = p.watchRule || {};
  const variantSelector = details.variants?.length ? `<label class="field variant-picker"><span>Watch a specific variant</span><select data-variant-selector aria-label="Product variant"><option value="${escapeHtml(p.parentSlug || p.slug)}" ${!p.variantId ? 'selected' : ''}>Any variant</option>${details.variants.map((variant) => `<option value="${escapeHtml(variant.slug)}" ${variant.slug === p.slug ? 'selected' : ''}>${escapeHtml(variant.variantTitle)} · ${escapeHtml(variant.sku)} · ${escapeHtml(variant.price || 'Price unavailable')} · ${variant.unlisted ? 'Unlisted' : variant.inStock ? 'In stock' : 'Unavailable'}</option>`).join('')}</select></label>` : '';
  const collectionFields = `<fieldset class="watch-collection-choices"><legend>Collections</legend>${(details.collections || []).map((collection) => `<label><input type="checkbox" name="collection" value="${escapeHtml(collection.id)}" ${(p.collections || []).includes(collection.id) ? 'checked' : ''} /> ${escapeHtml(collection.name)}</label>`).join('') || '<p>Create collections from Watchlist > Manage collections.</p>'}</fieldset>`;
  $('productDialogCategory').textContent = `${p.category} · ${String(p.region || app.currentRegion || '').toUpperCase()}`;
  $('productDialogTitle').textContent = p.name;
  const currentPause = rule.pausedUntil && rule.pausedUntil !== 'indefinite' ? `<option value="existing:${escapeHtml(rule.pausedUntil)}" selected>Paused until ${escapeHtml(new Date(rule.pausedUntil).toLocaleString())}</option>` : '';
  const ruleForm = p.watched ? `<form id="productRuleForm" class="product-rule-form" data-rule-slug="${escapeHtml(p.slug)}">
    <h3>Product-specific alert rules</h3><p>Use global settings unless this product needs different behavior.</p>${alertSummaryMarkup(p)}
    <div class="form-row">${ruleSelect('restock','Restock alerts',rule.restock)}${ruleSelect('soldOut','Sold-out alerts',rule.soldOut)}${ruleSelect('priceChange','Price-change alerts',rule.priceChange)}${ruleSelect('statusChange','Other status alerts',rule.statusChange)}</div>
    <div class="form-row"><label class="field"><span>Target price</span><input name="targetPrice" type="number" min="0" step="0.01" value="${rule.targetPrice ?? ''}" placeholder="No target" /></label><label class="field"><span>Pause alerts</span><select name="pause"><option value="active" ${!rule.pausedUntil ? 'selected' : ''}>Active</option>${currentPause}<option value="60">For 1 hour</option><option value="1440">For 1 day</option><option value="10080">For 1 week</option><option value="indefinite" ${rule.pausedUntil === 'indefinite' ? 'selected' : ''}>Until resumed</option></select></label></div>
    <div class="inline-checks"><label><input name="priceDropOnly" type="checkbox" ${rule.priceDropOnly ? 'checked' : ''}/> Only alert when price drops</label><label><input name="immediateRestock" type="checkbox" ${rule.immediateRestock ? 'checked' : ''}/> Deliver restocks immediately</label></div>
    <div class="inline-checks"><label><input name="availableUnderTarget" type="checkbox" ${rule.availableUnderTarget ? 'checked' : ''} /> Alert when available at or below the target price</label></div>
    <p class="rule-help">This condition alerts on a qualifying restock or a confirmed price reaching the target while available. It replaces the separate restock and price-change choices. Prices use this Store region's currency and exclude checkout costs.</p>
    ${alertDeliveryFields(rule)}
    ${collectionFields}
    ${collectionAlertSources(p, details.collections).length ? `<p class="rule-help">Individual alerts are suppressed by: ${escapeHtml(collectionAlertSources(p, details.collections).map(item=>item.name).join(", "))}. They use Collection alerts only. Your item rules stay saved and resume when no collection suppresses them.</p>` : ""}
    <div class="settings-actions wrap"><button class="primary" type="submit">Save alert rules</button><button type="button" data-preview-rule>Preview rule & notification</button><button type="button" data-purchased="${escapeHtml(p.slug)}">${rule.purchasedAt ? 'Still wanted' : 'Mark purchased'}</button><button type="button" data-watch="${escapeHtml(p.slug)}">Remove from watchlist</button></div>
    ${rule.purchasedAt ? '<p class="rule-help">Purchased: alerts are stopped. Mark this watch as still wanted to enable it again.</p>' : ''}
    <div class="settings-result hidden" data-rule-result role="status" aria-live="polite"></div>
  </form>` : `<div class="product-watch-prompt"><p>Add this product to your watchlist to configure its alert rules.</p><button class="primary button-link" data-add-watch="${escapeHtml(p.slug)}">Add to Watchlist or collection</button></div>`;
  const changes = details.history.slice(0, 12).map((item) => `<div class="product-change"><span class="connection-dot ${item.inStock ? 'enabled' : ''}"></span><div><strong>${escapeHtml(item.changeType.replaceAll('-', ' '))}</strong><small>${escapeHtml(item.status || 'Unknown')}${item.price ? ` · ${escapeHtml(item.price)}` : ''}</small></div><time>${escapeHtml(relativeTime(item.observedAt))}</time></div>`).join('');
  $('productDialogBody').innerHTML = `<div class="product-hero"><div class="product-hero-image media-shell">${imageMarkup(p, 'product-image')}</div><div><div class="product-status-row"><span class="badge ${p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out'}">${p.unlisted ? 'Unlisted' : p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out'}</span><strong>${escapeHtml(p.price || 'Price unavailable')}</strong></div>${freshnessMarkup(p)}<div class="product-sku-row"><p>${escapeHtml(p.sku || p.slug)}</p><button class="copy-button" type="button" data-copy-text="${escapeHtml(p.sku || p.slug)}" data-copy-label="SKU">Copy SKU</button></div><dl class="settings-details"><div><dt>Store region</dt><dd>${escapeHtml(String(p.region || app.currentRegion || '').toUpperCase())}</dd></div><div><dt>First observed</dt><dd>${escapeHtml(relativeTime(details.firstObservedAt))}</dd></div><div><dt>Last checked</dt><dd>${escapeHtml(relativeTime(p.lastSeenAt))}</dd></div><div><dt>Last changed</dt><dd>${escapeHtml(relativeTime(details.lastChangedAt))}</dd></div><div><dt>History retention</dt><dd>${details.historyRetentionDays} days</dd></div></dl><div class="product-link-actions"><a class="button-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open UniFi Store ↗</a><button class="copy-button" type="button" data-copy-text="${escapeHtml(p.url)}" data-copy-label="Store link">Copy link</button></div></div></div>
    ${variantSelector}${p.watched ? `<div class="product-watch-prompt"><button class="button-link" type="button" data-add-watch="${escapeHtml(p.slug)}">Add to collection</button></div>` : ''}${ruleForm}<section class="product-history" data-product-insights>${renderInsights(details.insights)}</section><section class="product-history"><h3>Recent changes</h3><div class="product-change-list">${changes || '<div class="history-empty">No changes recorded yet.</div>'}</div></section>`;
  wireProductImages($('productDialogBody'));
}

async function openProductDialog(slug, preserveFocus = false) {
  const request = (app.productRequest || 0) + 1;
  app.productRequest = request;
  if (!preserveFocus) { app.lastFocusedProduct = document.activeElement; app.lastFocusedProductSlug = slug; }
  $('productDialog').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  $('productDialogTitle').textContent = 'Loading product…';
  $('productDialogBody').innerHTML = '<div class="dialog-loading">Loading product history and alert rules…</div>';
  $('closeProductDialog').focus();
  try { const details = await api(`/api/products/${encodeURIComponent(slug)}`); if (app.productRequest === request) renderProductDialog(details); }
  catch (err) { $('productDialogBody').innerHTML = `<div class="settings-result error">${escapeHtml(err.message)}</div>`; }
}

function closeProductDialog() {
  app.productRequest = (app.productRequest || 0) + 1;
  $('productDialog').classList.add('hidden');
  document.body.classList.remove('dialog-open');
  app.currentProductDetails = null;
  const original = app.lastFocusedProduct;
  const replacement = document.querySelector(`.page.active [data-product-detail="${CSS.escape(app.lastFocusedProductSlug || '')}"]`);
  (original?.isConnected ? original : replacement || document.querySelector('.tabs [aria-selected="true"]'))?.focus();
}

function readProductRule(form) {
  const readOverride = (name) => { const value = form.elements[name].value; return value === 'inherit' ? null : value === 'true'; };
  const pause = form.elements.pause.value;
  const pausedUntil = pause === 'active' ? null : pause === 'indefinite' ? 'indefinite' : pause.startsWith('existing:') ? pause.slice(9) : new Date(Date.now() + Number(pause) * 60000).toISOString();
  return { ...readAlertDelivery(form), restock:readOverride('restock'), soldOut:readOverride('soldOut'), priceChange:readOverride('priceChange'), statusChange:readOverride('statusChange'), targetPrice:form.elements.targetPrice.value || null, priceDropOnly:form.elements.priceDropOnly.checked, immediateRestock:form.elements.immediateRestock.checked, availableUnderTarget:form.elements.availableUnderTarget.checked, pausedUntil };
}

async function previewProductRule(form) {
  const result = form.querySelector('[data-rule-result]');
  result.classList.remove('hidden'); result.textContent = 'Checking this rule…';
  try {
    const preview = await api(`/api/watch/${encodeURIComponent(form.dataset.ruleSlug)}/preview`, { method:'POST', body:JSON.stringify({ rule:readProductRule(form) }) });
    result.textContent = `${preview.description} ${preview.allActivity ? 'All activity updates is enabled and overrides event conditions. ' : ''}${preview.decision.allowed ? 'A restock at the currently displayed price would qualify.' : `A restock at the currently displayed price would not alert (${preview.decision.reason.replaceAll('-', ' ')}).`} Channels: ${preview.configuredChannels.join(', ') || 'No server channels configured'}. Notification preview: ${preview.copy.title} — ${preview.copy.body}`;
  } catch (err) { result.textContent = err.message; }
}

async function saveProductRule(form) {
  const rule = readProductRule(form);
  const resultBox = form.querySelector('[data-rule-result]');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Saving…';
  try {
    if (!app.currentProductDetails?.capabilities?.alertDelivery) throw new Error('Update and restart GearBeacon before saving these alert settings.');
    const result = await api(`/api/watch/${encodeURIComponent(form.dataset.ruleSlug)}/rules`, { method:'PUT', body:JSON.stringify({ rule }) });
    const membership = await api(`/api/watch/${encodeURIComponent(form.dataset.ruleSlug)}/collections`, { method:'PUT', body:JSON.stringify({ collections:[...form.querySelectorAll('[name="collection"]:checked')].map((input) => input.value) }) });
    app.collections = membership.collections; updateWatchAlertSummaries(membership); app.watchOverview=membership.overview || app.watchOverview;
    const product = app.products.find((item) => item.slug === form.dataset.ruleSlug); if (product) Object.assign(product, membership.product, { watchRule:result.rule });
    renderProducts(true); await openProductDialog(form.dataset.ruleSlug, true); toast('Product alert rules saved');
  } catch (err) { resultBox.classList.remove('hidden'); resultBox.textContent = err.message; button.disabled = false; button.textContent = 'Save alert rules'; }
}

function activityReadingPosition() {
  if (window.scrollY <= 1 || app.activeTab !== 'activity') return [];
  const rows = [...$('activityFeed').querySelectorAll('[data-activity-event]')];
  const visible = rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight; });
  // Keep fallback anchors for a row removed by retention or an outcome filter.
  return (visible.length ? visible : rows.slice(-1)).map(row => ({ id:row.dataset.activityEvent, top:row.getBoundingClientRect().top }));
}

function restoreActivityReadingPosition(positions) {
  const rows = new Map([...$('activityFeed').querySelectorAll('[data-activity-event]')].map(row => [row.dataset.activityEvent,row]));
  for (const position of positions) {
    const row = rows.get(position.id);
    if (!row) continue;
    const delta = row.getBoundingClientRect().top - position.top;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top:delta, behavior:'instant' });
    break;
  }
  const dialogEventId = app.activityDialogLastFocus?.dataset.activityEvent;
  if (dialogEventId) app.activityDialogLastFocus = rows.get(dialogEventId) || $('activityType');
}

function setActivityLiveStatus(message) {
  if ($('activityLiveStatus').textContent === message) return;
  const position = activityReadingPosition();
  $('activityLiveStatus').textContent = message;
  restoreActivityReadingPosition(position);
}

function updateActivityRow(row, replacement) {
  // Relative times and delivery outcomes change frequently. Keep the button itself,
  // including its keyboard focus and any open dialog's return target.
  for (const attribute of [...row.attributes]) if (!replacement.hasAttribute(attribute.name)) row.removeAttribute(attribute.name);
  for (const attribute of replacement.attributes) if (row.getAttribute(attribute.name) !== attribute.value) row.setAttribute(attribute.name,attribute.value);
  row.replaceChildren(...replacement.childNodes);
}

function renderEvents() {
  const position = activityReadingPosition();
  const icon = { restock:'↑', sold_out:'↓', price_change:'$', status_change:'↔', new_product:'+' };
  const events = app.activity.events || [];
  const arrivals = app.activity.arrivals || [];
  const renderEvent = (e) => {
    const metadata = activityMeta(e);
    const priceClass = metadata.some(part => part.priceDecrease) ? ' price-decrease' : '';
    const metadataText = metadata.map((part) => `${part.text}${part.extra ? ` ${part.extra}` : ''}`).join(' · ');
    const metadataHtml = metadata.map((part) => `<span class="event-meta-part ${escapeHtml(part.className)}">${escapeHtml(part.text)}${part.extra ? ` <span class="event-delta-percent">${escapeHtml(part.extra)}</span>` : ''}</span>`).join('');
    const alert = e.serverAlert || { state:'no-channel', label:'No channel' };
    const exactTime = exactEventTime(e);
    const activityLabel = `Open ${e.name} activity details. ${metadataText}. Server alert: ${alert.label}. Detected ${exactTime}.`;
    return `<button class="event event-button ${escapeHtml(e.type)}${priceClass}" type="button" data-activity-event="${escapeHtml(e.id)}" aria-label="${escapeHtml(activityLabel)}">
      <span class="event-icon" aria-hidden="true">${icon[e.type] || '•'}</span>
      <span class="event-main"><strong>${escapeHtml(e.name)}</strong><span class="event-meta" title="${escapeHtml(metadataText)}">${metadataHtml}</span></span>
      <span class="event-side"><span class="event-alert ${escapeHtml(alert.state)}" title="${escapeHtml(serverAlertTitle(e))}"><span class="event-alert-dot" aria-hidden="true"></span><span class="event-alert-label">${escapeHtml(alert.label)}</span></span><time datetime="${escapeHtml(e.detectedAt)}" title="${escapeHtml(exactTime)}">${escapeHtml(relativeTime(e.detectedAt))}</time></span>
    </button>`;
  };
  reconcileList($('activityLiveList'), arrivals, 'data-activity-event', renderEvent, false, updateActivityRow);
  reconcileList($('activityList'), events, 'data-activity-event', renderEvent, false, updateActivityRow);
  $('activityLiveList').classList.toggle('hidden', !arrivals.length);
  $('activityList').classList.toggle('hidden', !events.length);
  const separatePage = arrivals.length > 0 && app.activity.page > 1;
  $('activityLiveHeading').classList.toggle('hidden', !separatePage);
  $('activityEarlierHeading').classList.toggle('hidden', !separatePage);
  $('activityEarlierHeading').textContent = `Earlier activity · Page ${app.activity.page}`;
  $('activityEmpty').classList.toggle('hidden', events.length + arrivals.length > 0 || !app.activity.loaded);
  const filteredEmpty = activityFiltersActive();
  $('activityEmpty').querySelector('h3').textContent = filteredEmpty ? 'No activity matches these filters' : 'No stock changes detected yet';
  $('activityEmpty').querySelector('p').textContent = filteredEmpty ? 'Reset or change a filter to see retained stock activity.' : 'The first check establishes a baseline. Changes appear here after that.';
  $('resetActivityEmpty').classList.toggle('hidden', !filteredEmpty);
  const first = (app.activity.page - 1) * app.activity.limit + 1;
  const total = app.activity.count + arrivals.length;
  let summary = app.activity.loaded ? `${total} matching event${total === 1 ? '' : 's'}` : 'Loading activity…';
  if (events.length && app.activity.count > app.activity.limit) {
    summary = separatePage ? `${arrivals.length} new · Showing ${first}–${first + events.length - 1} of ${app.activity.count} earlier events` : `Showing ${first}–${first + events.length + arrivals.length - 1} of ${total} events`;
  }
  if ($('activityResultCount').textContent !== summary) $('activityResultCount').textContent = summary;
  const retention = app.config?.config?.eventRetentionDays;
  $('activityRetention').textContent = retention === 0 ? 'Activity retained until manually changed' : retention ? `${retention}-day activity retention` : 'Retained activity';
  $('activityPagination').classList.toggle('hidden', !app.activity.loaded || app.activity.pages <= 1);
  $('activityPage').textContent = `Page ${app.activity.page} of ${app.activity.pages}${arrivals.length ? ' · Earlier activity' : ''}`;
  $('activityPrevious').disabled = app.activity.page <= 1;
  $('activityNext').disabled = app.activity.page >= app.activity.pages;
  restoreActivityReadingPosition(position);
}

function activityQueryParameters(page = app.activity.page || 1) {
  const params = new URLSearchParams({
    scope:$('activityRegion').value || 'all',
    type:$('activityType').value || 'all',
    delivery:$('activityDelivery').value || 'all',
    page:String(page),
    limit:$('activityPageSize').value || '20',
  });
  if ($('activitySearch').value.trim()) params.set('search', $('activitySearch').value.trim());
  if ($('activityFrom').value) params.set('from', $('activityFrom').value);
  if ($('activityTo').value) params.set('to', $('activityTo').value);
  return params;
}

async function refreshActivity(page = app.activity.page || 1, { background = false, reset = false } = {}) {
  if (background && (app.activityController || document.hidden || app.activeTab !== 'activity' || app.browserOffline || $('appShell').classList.contains('hidden'))) return;
  app.activityController?.abort();
  const controller = new AbortController(); app.activityController = controller;
  const request = (app.activityRequest || 0) + 1;
  app.activityRequest = request;
  const region = app.currentRegion;
  const stale = () => request !== app.activityRequest || region !== app.currentRegion || background && (document.hidden || app.activeTab !== 'activity' || $('appShell').classList.contains('hidden'));
  const params = background && app.activityQueryKey ? new URLSearchParams(app.activityQueryKey) : activityQueryParameters(page);
  params.delete('page');
  const queryKey = params.toString();
  if (!reset && queryKey === app.activityQueryKey && app.activity.snapshot) params.set('snapshot',app.activity.snapshot);
  params.set('page',String(page));
  if (!background) $('activityResultCount').textContent = 'Loading activity…';
  try {
    const options = { signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]) };
    const latestPage = () => {
      const latestParams = new URLSearchParams(queryKey); latestParams.set('page','1');
      return api(`/api/activity?${latestParams}`, options);
    };
    let result = await api(`/api/activity?${params}`, options);
    if (stale()) return;
    // Recover in this request, keeping the committed filters rather than applying drafts.
    if (result.snapshotReset) result = await latestPage();
    if (stale()) return;
    const arrivals = [];
    if (result.newCount > 0) {
      const liveParams = new URLSearchParams(queryKey);
      liveParams.set('after',result.snapshot); liveParams.set('limit','100');
      // Pin the upper boundary too, so a burst spanning multiple requests has no gaps.
      let livePage = 1, livePages = 1;
      do {
        liveParams.set('page',String(livePage));
        const live = await api(`/api/activity?${liveParams}`, options);
        if (stale()) return;
        if (live.snapshotReset) { result = await latestPage(); arrivals.length = 0; break; }
        liveParams.set('snapshot',live.snapshot);
        livePages = live.pages;
        arrivals.push(...live.events);
      } while (++livePage <= livePages);
    }
    if (stale()) return;
    app.activityQueryKey = queryKey;
    app.activity = { ...result, newCount:arrivals.length, arrivals:[...new Map(arrivals.map(event => [event.id,event])).values()], loaded:true };
    renderEvents();
    setActivityLiveStatus('Live · Updates automatically');
  } catch (err) {
    if (stale() || err.name === 'AbortError') return;
    setActivityLiveStatus('Reconnecting · Updates will resume automatically');
    if (!app.activity.loaded) $('activityResultCount').textContent = `Activity unavailable: ${err.message}`;
  } finally { if (request === app.activityRequest) app.activityController = null; }
}

async function exportActivity(format) {
  try {
    const params = activityQueryParameters(1);
    params.delete('page'); params.delete('limit'); params.set('format', format);
    const res = await fetch(`/api/activity/export?${params}`, { credentials:'same-origin', cache:'no-store' });
    await saveDownloadResponse(res, `GearBeacon-Activity-${new Date().toISOString().slice(0,10)}.${format}`);
    toast(`Activity exported as ${format.toUpperCase()}`);
  } catch (err) { toast(err.message, 'error'); }
}

function renderActivityDialog(event) {
  const metadata = activityMeta(event).map((item) => `${item.text}${item.extra ? ` ${item.extra}` : ''}`).join(' · ');
  const confirmation = event.confirmation || {};
  const alert = event.serverAlert || {};
  $('activityDialogTitle').textContent = event.name || 'Activity details';
  $('activityDialogBody').innerHTML = `<section class="activity-detail-hero"><span class="settings-kicker">${escapeHtml(String(event.region || '').toUpperCase())} · ${escapeHtml(humanStatus(event.type))}</span><h3>${escapeHtml(event.name || event.slug)}</h3><p>${escapeHtml(metadata)}</p></section><div class="activity-evidence"><article class="settings-card"><span class="settings-kicker">Monitor evidence</span><h3>Confirmation</h3><dl class="settings-details"><div><dt>Policy</dt><dd>${escapeHtml(humanStatus(confirmation.policy || 'legacy event'))}</dd></div><div><dt>Observations</dt><dd>${escapeHtml(confirmation.observations || 1)} of ${escapeHtml(confirmation.required || 1)}</dd></div><div><dt>First observed</dt><dd>${escapeHtml(confirmation.firstObservedAt ? new Date(confirmation.firstObservedAt).toLocaleString() : exactEventTime(event))}</dd></div><div><dt>Confirmed</dt><dd>${escapeHtml(confirmation.confirmedAt ? new Date(confirmation.confirmedAt).toLocaleString() : exactEventTime(event))}</dd></div></dl></article><article class="settings-card"><span class="settings-kicker">Server notification</span><h3>${escapeHtml(alert.label || 'No delivery')}</h3><p>${escapeHtml(serverAlertTitle(event))}</p><dl class="settings-details"><div><dt>Outcome</dt><dd>${escapeHtml(humanStatus(alert.state || 'not recorded'))}</dd></div><div><dt>Channels</dt><dd>${escapeHtml((alert.channels || []).join(', ') || 'None')}</dd></div><div><dt>Detected</dt><dd>${escapeHtml(exactEventTime(event))}</dd></div></dl></article></div><div class="settings-actions wrap activity-detail-actions">${event.collectionId ? `<button class="primary button-link" type="button" data-activity-collection="${escapeHtml(event.collectionId)}" data-activity-region="${escapeHtml(event.region || app.currentRegion || '')}">Open collection</button>` : `<button class="primary button-link" type="button" data-activity-product="${escapeHtml(event.slug)}" data-activity-region="${escapeHtml(event.region || app.currentRegion || '')}">Open product details</button>`}${event.url ? `<a class="button-link" href="${escapeHtml(event.url)}" target="_blank" rel="noopener">Open UniFi Store ↗</a>` : ''}</div>`;
}

async function openActivityDialog(id) {
  app.activityDialogLastFocus = document.activeElement;
  $('activityDialog').classList.remove('hidden'); document.body.classList.add('dialog-open');
  $('activityDialogTitle').textContent = 'Loading activity…'; $('activityDialogBody').innerHTML = '<div class="dialog-loading">Loading confirmation and delivery evidence…</div>'; $('closeActivityDialog').focus();
  try { renderActivityDialog((await api(`/api/activity/${encodeURIComponent(id)}`)).event); }
  catch (err) { $('activityDialogBody').innerHTML = `<div class="settings-result error">${escapeHtml(err.message)}</div>`; }
}

function closeActivityDialog() {
  $('activityDialog').classList.add('hidden');
  if ($('productDialog').classList.contains('hidden') && $('watchImportDialog').classList.contains('hidden')) document.body.classList.remove('dialog-open');
  app.activityDialogLastFocus?.focus?.();
}

async function openActivityProduct(slug, region) {
  closeActivityDialog();
  if (region && region !== app.currentRegion) {
    app.currentRegion = region; localStorage.setItem('gearbeacon.region', region); await refresh();
  }
  await openProductDialog(slug);
}

function renderStatus() {
  const s = app.status;
  if (!s) return;
  $('productCount').textContent = s.productCount || 0;
  $('regionName').textContent = s.region.toUpperCase();
  $('pollRate').textContent = `${s.pollSeconds}s`;
  if (!app.currentRegion || !s.regions.some((region) => region.key === app.currentRegion)) app.currentRegion = s.region;
  localStorage.setItem('gearbeacon.region', app.currentRegion);
  const picker = $('regionPicker');
  updateOptions(picker, s.regions.map((region) => `<option value="${escapeHtml(region.key)}">${escapeHtml(region.label)}</option>`).join(''));
  picker.value = app.currentRegion;
  $('regionPickerWrap').classList.toggle('hidden', s.regions.length < 2);
  const activityRegion = $('activityRegion');
  const activitySelection = app.pendingActivityRegion || activityRegion.value || 'all';
  updateOptions(activityRegion, `<option value="all">All enabled stores</option>${s.regions.map((region) => `<option value="${escapeHtml(region.key)}">${escapeHtml(region.label)}</option>`).join('')}`);
  activityRegion.value = [...activityRegion.options].some((option) => option.value === activitySelection) ? activitySelection : 'all';
  app.pendingActivityRegion = null;
  const dot = $('statusDot');
  dot.className = 'dot';
  if (s.lastError) {
    dot.classList.add('bad');
    $('statusTitle').textContent = 'Store check error';
    $('statusSub').textContent = s.lastError;
  } else if (s.checking) {
    $('statusTitle').textContent = 'Checking UniFi Store…';
    $('statusSub').textContent = s.mockMode ? 'Mock mode' : 'Live monitor';
  } else if (s.lastSuccessAt) {
    dot.classList.add('good');
    $('statusTitle').textContent = s.mockMode ? 'Monitor online · MOCK MODE' : 'Monitor online';
    $('statusSub').textContent = `Last successful check ${relativeTime(s.lastSuccessAt)}${s.pendingChanges ? ` · ${s.pendingChanges} change${s.pendingChanges === 1 ? '' : 's'} awaiting confirmation` : ''}`;
  } else {
    $('statusTitle').textContent = 'Establishing baseline…';
    $('statusSub').textContent = 'No alert is sent on the first observation';
  }
  const channels = [];
  if (s.notifications.ntfyConfigured) channels.push('ntfy');
  if (s.notifications.discordConfigured) channels.push('Discord');
  if (s.notifications.webhookConfigured) channels.push('Webhook');
  if (s.notifications.gotifyConfigured) channels.push('Gotify');
  if (s.notifications.smtpConfigured) channels.push('Email');
  $('notifyStatus').textContent = channels.length ? `Alert channels: ${channels.join(' · ')}` : 'No server-side alert channel configured';
}

function renderAttentionBanner() {
  const banner = $('attentionBanner');
  if (app.browserOffline) {
    banner.className = 'attention-banner action';
    $('attentionTitle').textContent = 'This browser is offline';
    $('attentionDetail').textContent = 'GearBeacon is preserving its last view and will reconnect when the network returns.';
    $('attentionAction').classList.add('hidden');
    banner.classList.remove('hidden');
    return;
  }
  $('attentionAction').classList.remove('hidden');
  if (app.serverFailures) {
    banner.className = 'attention-banner action';
    $('attentionTitle').textContent = app.serverFailures > 1 ? 'GearBeacon is still reconnecting' : 'GearBeacon connection interrupted';
    $('attentionDetail').textContent = 'The dashboard is preserving its last view and will retry automatically.';
    banner.classList.remove('hidden');
    return;
  }
  const summary = app.operations?.summary;
  if (!summary || summary.state === 'healthy') { banner.className = 'attention-banner hidden'; return; }
  const first = summary.issues?.[0];
  banner.className = `attention-banner ${summary.state === 'action' ? 'action' : ''}`;
  $('attentionTitle').textContent = summary.label || 'GearBeacon needs attention';
  $('attentionDetail').textContent = first?.message || 'Open Operations for details.';
  banner.classList.remove('hidden');
}

function renderSettings(updatePreferences = true) {
  const status = app.status;
  const info = app.dataInfo;
  if (status && $('settingsVersion')) $('settingsVersion').textContent = `V${status.version}`;
  if (!info) return;
  $('storageEngine').textContent = info.engine || 'SQLite';
  $('schemaVersion').textContent = `v${info.schemaVersion} of v${info.expectedSchemaVersion}`;
  $('schemaBadge').textContent = `${info.engine || 'SQLite'} · schema v${info.schemaVersion}`;
  $('dataPath').textContent = info.userDataDir || '—';
  const count = info.backup?.count || 0;
  $('backupBadge').textContent = `${count} backup${count === 1 ? '' : 's'}`;
  $('latestBackup').textContent = info.backup?.latest ? `${relativeTime(info.backup.latest.createdAt)} · ${info.backup.latest.name}` : 'None yet';
  $('testPrimaryBackup').disabled = !info.backup?.latest;
  $('testSecondaryBackup').disabled = !info.backup?.secondary?.latest;
  if ($('historyBadge')) $('historyBadge').textContent = `${info.history?.observations || 0} change record${info.history?.observations === 1 ? '' : 's'}`;
  renderSecurity();
  renderPrivacy();
  if (updatePreferences) renderNotificationSettings();
}

function renderNotificationSettings() {
  const prefs = app.notificationPreferences || {};
  if ($('notifyRestock')) $('notifyRestock').checked = prefs.restock !== false;
  if ($('notifySoldOut')) $('notifySoldOut').checked = Boolean(prefs.soldOut);
  if ($('notifyPriceChange')) $('notifyPriceChange').checked = Boolean(prefs.priceChange);
  if ($('notifyStatusChange')) $('notifyStatusChange').checked = Boolean(prefs.statusChange);
  if ($('notifyNewProduct')) $('notifyNewProduct').checked = Boolean(prefs.newProduct);
  if ($('notifyAllActivity')) $('notifyAllActivity').checked = Boolean(prefs.allActivity);
  if ($('channelBadge')) {
    const notifications = app.status?.notifications || {};
    const count = ['ntfyConfigured', 'discordConfigured', 'webhookConfigured', 'gotifyConfigured', 'smtpConfigured'].filter((key) => notifications[key]).length;
    $('channelBadge').textContent = count ? `${count} server channel${count === 1 ? '' : 's'}` : 'Browser only';
  }
}

function renderSecurity() {
  if (!app.auth || !app.status) return;
  const mode = app.status.deployment?.mode || app.auth.accessMode || 'local';
  $('accessMode').textContent = mode;
  $('accessBadge').textContent = mode === 'local' ? 'Local only' : mode === 'proxy' ? 'Reverse proxy' : 'Private server';
  $('authenticationState').textContent = app.auth.authenticationRequired ? 'Owner password required' : 'Not required on loopback';
  $('accessDescription').textContent = mode === 'local'
    ? 'The server binds to this computer only. You can optionally create an owner password below.'
    : 'Every dashboard and API request is protected by the private owner session.';
  $('currentPasswordField').classList.toggle('hidden', !app.auth.authenticationRequired);
}

function renderPrivacy() {
  const connections = app.status?.privacy?.outboundConnections || [];
  $('outboundList').innerHTML = connections.map((item) => `<div class="outbound-item">
    <span class="connection-dot ${item.enabled ? 'enabled' : ''}"></span>
    <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.purpose)}${item.required ? ' · required' : item.enabled ? ' · enabled' : ' · disabled'}</small></div>
    <span>${item.destination ? escapeHtml(item.destination) : 'Off'}</span>
  </div>`).join('');
}

async function refreshSessions() {
  try {
    const result = await authRequest('/api/auth/sessions');
    const sessions = result.sessions || [];
    $('sessionCount').textContent = app.auth?.authenticationRequired ? String(sessions.length) : 'Local access';
    $('sessionList').innerHTML = sessions.map((session) => `<div class="session-item">
      <div><strong>${session.current ? 'Current session' : 'Signed-in browser'}</strong><small>${escapeHtml(session.remoteAddress || 'Unknown address')} · used ${escapeHtml(relativeTime(session.lastUsedAt))}</small></div>
      <button data-revoke-session="${escapeHtml(session.id)}">${session.current ? 'Sign out' : 'Revoke'}</button>
    </div>`).join('');
  } catch (err) {
    $('sessionCount').textContent = 'Unavailable';
  }
}

async function refreshNotificationPreferences() {
  try {
    const result = await api('/api/notifications/preferences');
    app.notificationPreferences = result.preferences || app.notificationPreferences;
    renderNotificationSettings();
  } catch (err) {
    if ($('notificationResult')) {
      $('notificationResult').classList.remove('hidden');
      $('notificationResult').textContent = `Notification settings unavailable: ${err.message}`;
    }
  }
}

async function saveNotificationPreferences() {
  const button = $('saveNotificationPrefs');
  const resultEl = $('notificationResult');
  button.disabled = true;
  try {
    const preferences = {
      restock: $('notifyRestock').checked,
      soldOut: $('notifySoldOut').checked,
      priceChange: $('notifyPriceChange').checked,
      statusChange: $('notifyStatusChange').checked,
      newProduct: $('notifyNewProduct').checked,
      allActivity: $('notifyAllActivity').checked,
    };
    const result = await api('/api/notifications/preferences', { method:'PUT', body: JSON.stringify({ preferences }) });
    app.notificationPreferences = result.preferences;
    renderNotificationSettings();
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = '<strong>Notification settings saved.</strong> Future Activity events will use these preferences.';
    toast('Notification settings saved');
  } catch (err) {
    resultEl.classList.remove('hidden');
    resultEl.textContent = `Could not save notification settings: ${err.message}`;
  } finally { button.disabled = false; }
}

async function testServerNotification() {
  const button = $('testNotificationBtn');
  const resultEl = $('notificationResult');
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await api('/api/notifications/test', { method:'POST' });
    const passed = (result.outcomes || []).filter((x) => x.ok).map((x) => x.channel).join(', ');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<strong>Test notification sent.</strong>${passed ? ` Delivered through: ${escapeHtml(passed)}.` : ''}`;
    toast('Test notification sent');
  } catch (err) {
    resultEl.classList.remove('hidden');
    resultEl.textContent = `Test notification failed: ${err.message}`;
  } finally { button.disabled = false; button.textContent = 'Send test notification'; }
}

async function refreshDataInfo() {
  try {
    app.dataInfo = await api('/api/data/info');
    renderSettings();
  } catch (err) {
    if ($('dataPath')) $('dataPath').textContent = `Unavailable: ${err.message}`;
  }
}

function regionChoices(containerId, selected = []) {
  const target = $(containerId);
  if (!target || !app.config) return;
  target.innerHTML = app.config.availableRegions.map((region) => `<label class="choice"><input type="checkbox" value="${escapeHtml(region.key)}" ${selected.includes(region.key) ? 'checked' : ''}/><span><strong>${escapeHtml(region.label)}</strong><small>${escapeHtml(region.currency)}</small></span></label>`).join('');
}

function selectedRegions(containerId) {
  return [...$(containerId).querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function channelBlock(name, title, fields) {
  const configured = app.config?.secretsConfigured || {};
  return `<fieldset class="channel-block" data-channel-block="${name}"><legend><label><input data-channel-enabled="${name}" type="checkbox" ${app.config.config.channelEnabled[name] ? 'checked' : ''}/> ${title}</label></legend>${fields}<div class="channel-actions"><button type="button" data-test-channel="${name}">Test ${title}</button></div></fieldset>`;
}

function secretField(key, label, placeholder = '') {
  const saved = Boolean(app.config?.secretsConfigured?.[key]);
  return `<label class="field"><span>${label}${saved ? ' · saved' : ''}</span><input data-secret="${key}" type="password" autocomplete="new-password" placeholder="${escapeHtml(placeholder || (saved ? 'Leave blank to keep saved value' : ''))}"/></label>${saved ? `<label class="clear-secret"><input data-clear-secret="${key}" type="checkbox"/> Clear saved value</label>` : ''}`;
}

function renderConfiguration() {
  if (!app.config) return;
  const c = app.config.config;
  regionChoices('settingsRegions', c.regions);
  $('configPollSeconds').value = c.pollSeconds;
  $('configAccessMode').value = c.accessMode;
  $('configBindHost').value = c.bindHost;
  $('configPublicUrl').value = c.publicBaseUrl || '';
  $('configAllowedOrigins').value = (c.allowedOrigins || []).join(', ');
  $('configCookieSecure').checked = Boolean(c.cookieSecure);
  $('configBackupHours').value = c.backupIntervalHours;
  $('configBackupRetention').value = c.backupRetention;
  $('configHistoryRetention').value = c.historyRetentionDays;
  $('configEventRetention').value = c.eventRetentionDays;
  $('configSecondaryBackupDir').value = c.secondaryBackupDir || '';
  $('configSecondaryEncrypted').checked = Boolean(c.secondaryEncryptedExports);
  const secondaryPassphraseSaved = Boolean(app.config.secretsConfigured?.secondaryBackupPassphrase);
  $('secondaryPassphraseLabel').textContent = `Secondary export passphrase${secondaryPassphraseSaved ? ' · saved' : ''}`;
  $('clearSecondaryPassphraseWrap').classList.toggle('hidden', !secondaryPassphraseSaved);
  $('clearSecondaryPassphrase').checked = false;
  $('configSecondaryPassphrase').value = '';
  $('configMaxAttempts').value = c.notificationMaxAttempts;
  $('configGroupSeconds').value = c.notificationGroupSeconds;
  $('configTimeZone').value = c.notificationTimeZone;
  $('configCooldownMinutes').value = c.notificationCooldownMinutes;
  $('configQuietEnabled').checked = Boolean(c.quietHoursEnabled);
  $('configQuietStart').value = c.quietHoursStart;
  $('configQuietEnd').value = c.quietHoursEnd;
  $('configDigestEnabled').checked = Boolean(c.digestEnabled);
  $('configDigestTime').value = c.digestTime;
  $('operationalMonitorFailures').checked = c.operationalAlerts?.monitorFailures !== false;
  $('operationalNotificationFailures').checked = c.operationalAlerts?.notificationFailures !== false;
  $('operationalBackupFailures').checked = c.operationalAlerts?.backupFailures !== false;
  $('operationalLowDisk').checked = c.operationalAlerts?.lowDiskSpace !== false;
  $('emailDetailLevel').value = c.emailDetailLevel || 'standard';
  $('emailTheme').value = c.emailTheme || 'auto';
  $('emailSubjectPrefix').value = c.emailSubjectPrefix ?? '[GearBeacon]';
  $('emailDigestMaxItems').value = c.emailDigestMaxItems || 12;
  $('emailEmbedImages').checked = c.emailEmbedImages !== false;
  $('emailExplainReason').checked = c.emailExplainReason !== false;
  $('emailPriceCalculations').checked = c.emailPriceCalculations !== false;
  $('emailAppearanceBadge').textContent = `${(c.emailDetailLevel || 'standard')[0].toUpperCase()}${(c.emailDetailLevel || 'standard').slice(1)} · ${(c.emailTheme || 'auto') === 'auto' ? 'Device theme' : c.emailTheme}`;
  renderEmailPreviewProducts();
  $('deliveryModeBadge').textContent = c.digestEnabled ? `Daily · ${c.digestTime}` : c.quietHoursEnabled ? `Quiet ${c.quietHoursStart}–${c.quietHoursEnd}` : c.notificationGroupSeconds ? `Grouped ${c.notificationGroupSeconds}s` : 'Immediate';
  $('configRestartBadge').classList.toggle('hidden', !app.config.restartPending);
  const form = $('channelConfigForm');
  form.innerHTML = [
    channelBlock('ntfy', 'ntfy', `<div class="form-row"><label class="field"><span>Server URL</span><input data-config="ntfyBaseUrl" type="url" value="${escapeHtml(c.ntfyBaseUrl || '')}"/></label><label class="field"><span>Topic</span><input data-config="ntfyTopic" value="${escapeHtml(c.ntfyTopic || '')}"/></label></div>${secretField('ntfyToken', 'Access token (optional)')}`),
    channelBlock('discord', 'Discord', secretField('discordWebhookUrl', 'Webhook URL')),
    channelBlock('gotify', 'Gotify', `<label class="field"><span>Server URL</span><input data-config="gotifyBaseUrl" type="url" value="${escapeHtml(c.gotifyBaseUrl || '')}"/></label>${secretField('gotifyToken', 'Application token')}`),
    channelBlock('webhook', 'Generic webhook', `${secretField('webhookUrl', 'Webhook URL')}${secretField('webhookToken', 'Bearer token (optional)')}${secretField('webhookHmacSecret', 'HMAC signing secret (recommended)')}`),
    channelBlock('email', 'Email', `<div class="form-row"><label class="field"><span>SMTP host</span><input data-config="smtpHost" value="${escapeHtml(c.smtpHost || '')}"/></label><label class="field"><span>Port</span><input data-config="smtpPort" type="number" min="1" max="65535" value="${c.smtpPort}"/></label></div><div class="form-row"><label class="field"><span>Username</span><input data-config="smtpUser" value="${escapeHtml(c.smtpUser || '')}" autocomplete="username"/></label>${secretField('smtpPassword', 'Password')}</div><div class="form-row"><label class="field"><span>From</span><input data-config="smtpFrom" value="${escapeHtml(c.smtpFrom || '')}"/></label><label class="field"><span>Recipients (comma separated)</span><input data-config="smtpTo" value="${escapeHtml((c.smtpTo || []).join(', '))}"/></label></div><div class="inline-checks"><label><input data-config="smtpSecure" type="checkbox" ${c.smtpSecure ? 'checked' : ''}/> Implicit TLS</label><label><input data-config="smtpStarttls" type="checkbox" ${c.smtpStarttls ? 'checked' : ''}/> Require STARTTLS</label><label><input data-config="smtpRejectUnauthorized" type="checkbox" ${c.smtpRejectUnauthorized ? 'checked' : ''}/> Verify certificate</label></div>`),
  ].join('');
}

async function refreshConfiguration() {
  try {
    app.config = await api('/api/config');
    renderConfiguration();
  } catch (err) {
    if ($('configResult')) { $('configResult').classList.remove('hidden'); $('configResult').textContent = `Configuration unavailable: ${err.message}`; }
  }
}

function baseConfigFromSettings() {
  return {
    ...app.config.config,
    regions: selectedRegions('settingsRegions'),
    pollSeconds: Number($('configPollSeconds').value),
    accessMode: $('configAccessMode').value,
    bindHost: $('configBindHost').value.trim(),
    publicBaseUrl: $('configPublicUrl').value.trim(),
    allowedOrigins: $('configAllowedOrigins').value.split(',').map((x) => x.trim()).filter(Boolean),
    cookieSecure: $('configCookieSecure').checked,
  };
}

function dataConfigFromSettings() {
  return { ...app.config.config, backupIntervalHours:Number($('configBackupHours').value), backupRetention:Number($('configBackupRetention').value), historyRetentionDays:Number($('configHistoryRetention').value), eventRetentionDays:Number($('configEventRetention').value), secondaryBackupDir:$('configSecondaryBackupDir').value.trim(), secondaryEncryptedExports:$('configSecondaryEncrypted').checked };
}

function deliveryConfigFromSettings() {
  return { ...app.config.config, notificationTimeZone:$('configTimeZone').value.trim(), notificationCooldownMinutes:Number($('configCooldownMinutes').value), notificationMaxAttempts:Number($('configMaxAttempts').value), notificationGroupSeconds:Number($('configGroupSeconds').value), quietHoursEnabled:$('configQuietEnabled').checked, quietHoursStart:$('configQuietStart').value, quietHoursEnd:$('configQuietEnd').value, digestEnabled:$('configDigestEnabled').checked, digestTime:$('configDigestTime').value, operationalAlerts:{ monitorFailures:$('operationalMonitorFailures').checked, notificationFailures:$('operationalNotificationFailures').checked, backupFailures:$('operationalBackupFailures').checked, lowDiskSpace:$('operationalLowDisk').checked } };
}

function emailConfigFromSettings() {
  return {
    ...app.config.config,
    emailDetailLevel:$('emailDetailLevel').value,
    emailTheme:$('emailTheme').value,
    emailSubjectPrefix:$('emailSubjectPrefix').value,
    emailDigestMaxItems:Number($('emailDigestMaxItems').value),
    emailEmbedImages:$('emailEmbedImages').checked,
    emailExplainReason:$('emailExplainReason').checked,
    emailPriceCalculations:$('emailPriceCalculations').checked,
  };
}

function renderEmailPreviewProducts() {
  const select = $('emailPreviewProduct');
  if (!select) return;
  const products = [...app.products].sort((a, b) => Number(b.watched) - Number(a.watched) || a.name.localeCompare(b.name));
  updateOptions(select, products.length ? products.map((product) => `<option value="${escapeHtml(product.slug)}">${escapeHtml(product.name)}${product.watched ? ' · watched' : ''}</option>`).join('') : '<option value="">Example product</option>');
}

async function saveConfigurationSection(config, resultEl, successMessage) {
  const result = await api('/api/config', { method:'PUT', body:JSON.stringify({ config }) });
  app.config = { ...app.config, config:result.config, secretsConfigured:result.secretsConfigured, restartPending:result.restartRequired };
  renderConfiguration();
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `<strong>${escapeHtml(successMessage)}</strong>${result.restartRequired ? ' Restart GearBeacon to apply store-region, access-mode, or bind-address changes.' : ' Changes are active now.'}`;
}

async function saveAppConfiguration(event) {
  event?.preventDefault();
  const resultEl = $('configResult');
  try {
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify({ config: baseConfigFromSettings() }) });
    app.config = { ...app.config, config: result.config, secretsConfigured: result.secretsConfigured, restartPending: result.restartRequired };
    renderConfiguration();
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<strong>Configuration validated and saved.</strong>${result.restartRequired ? ' Restart GearBeacon to apply store-region, access-mode, or bind-address changes.' : ' Changes are active now.'}`;
    toast('Configuration saved');
  } catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
}

async function saveDataConfiguration(event) {
  event.preventDefault();
  const resultEl = $('dataScheduleResult');
  const button = event.submitter;
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  try {
    const secrets = { secondaryBackupPassphrase:$('clearSecondaryPassphrase').checked ? '' : $('configSecondaryPassphrase').value || null };
    const result = await api('/api/config', { method:'PUT', body:JSON.stringify({ config:dataConfigFromSettings(), secrets }) });
    app.config = { ...app.config, config:result.config, secretsConfigured:result.secretsConfigured, restartPending:result.restartRequired };
    renderConfiguration(); resultEl.classList.remove('hidden'); resultEl.innerHTML = '<strong>Data settings saved.</strong> Changes are active now.';
    await refreshDataInfo(); await refreshOperations(); toast('Data settings saved');
  }
  catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
  finally { if (button) { button.disabled = false; button.textContent = 'Save data settings'; } }
}

async function saveDeliveryConfiguration(event) {
  event.preventDefault();
  const resultEl = $('deliveryResult');
  const button = event.submitter;
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  try { await saveConfigurationSection(deliveryConfigFromSettings(), resultEl, 'Delivery settings saved.'); toast('Delivery settings saved'); }
  catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
  finally { if (button) { button.disabled = false; button.textContent = 'Save delivery settings'; } }
}

async function saveEmailConfiguration(event) {
  event.preventDefault();
  const resultEl = $('emailAppearanceResult');
  const button = event.submitter;
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  try {
    await saveConfigurationSection(emailConfigFromSettings(), resultEl, 'Email appearance saved.');
    toast('Email appearance saved');
  } catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
  finally { if (button) { button.disabled = false; button.textContent = 'Save email appearance'; } }
}

function previewEmail() {
  const button = $('previewEmail');
  const frame = $('emailPreviewFrame');
  const canvas = $('emailPreviewCanvas');
  const status = $('emailPreviewStatus');
  const params = new URLSearchParams({
    region:app.currentRegion || 'us',
    slug:$('emailPreviewProduct').value,
    eventType:$('emailPreviewType').value,
    theme:$('emailTheme').value,
    detailLevel:$('emailDetailLevel').value,
    subjectPrefix:$('emailSubjectPrefix').value,
    digestMaxItems:$('emailDigestMaxItems').value,
    explainReason:$('emailExplainReason').checked ? '1' : '0',
    priceCalculations:$('emailPriceCalculations').checked ? '1' : '0',
    preview:String(Date.now()),
  });
  button.disabled = true; button.textContent = 'Rendering…';
  canvas.classList.toggle('mobile', $('emailPreviewViewport').value === 'mobile');
  canvas.classList.remove('hidden'); status.classList.add('hidden');
  frame.onload = () => { button.disabled = false; button.textContent = 'Preview email'; };
  frame.onerror = () => { button.disabled = false; button.textContent = 'Preview email'; status.textContent = 'The email preview could not be rendered.'; status.classList.remove('hidden'); canvas.classList.add('hidden'); };
  frame.src = `/api/notifications/email-preview?${params}`;
}

async function sendTestEmail() {
  const button = $('sendTestEmail');
  const resultEl = $('emailAppearanceResult');
  button.disabled = true; button.textContent = 'Sending…';
  try {
    const result = await api('/api/notifications/test', { method:'POST', body:JSON.stringify({ channel:'email' }) });
    const outcome = result.outcomes?.[0];
    if (!outcome?.ok) throw new Error(outcome?.error || 'Email is disabled or SMTP settings are incomplete.');
    resultEl.classList.remove('hidden'); resultEl.innerHTML = '<strong>Test email sent.</strong> Check the configured SMTP recipient inbox.';
    toast('Test email sent');
  } catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = `Test email failed: ${err.message}`; }
  finally { button.disabled = false; button.textContent = 'Send test email'; }
}

async function previewDelivery() {
  const resultEl = $('deliveryResult');
  const button = $('previewDelivery'); button.disabled = true; button.textContent = 'Calculating…';
  try {
    const watched = app.products.find((product) => product.watched);
    const params = new URLSearchParams({ eventType:'restock' }); if (watched) params.set('slug', watched.slug);
    const result = await api(`/api/notifications/preview?${params}`);
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<strong>${escapeHtml(result.copy.title)}</strong><br>${escapeHtml(result.copy.body)}<br>Delivery: ${escapeHtml(result.delivery.mode)} · ${escapeHtml(new Date(result.delivery.deliverAt).toLocaleString())} (${escapeHtml(result.delivery.timeZone)})${result.configuredChannels.length ? `<br>Channels: ${escapeHtml(result.configuredChannels.join(', '))}` : '<br>No server channel is currently enabled.'}`;
  } catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
  finally { button.disabled = false; button.textContent = 'Preview delivery'; }
}

function channelConfigPayload() {
  const config = { ...app.config.config, channelEnabled: { ...app.config.config.channelEnabled } };
  document.querySelectorAll('[data-channel-enabled]').forEach((input) => { config.channelEnabled[input.dataset.channelEnabled] = input.checked; });
  document.querySelectorAll('[data-config]').forEach((input) => {
    const key = input.dataset.config;
    config[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  });
  const secrets = {};
  document.querySelectorAll('[data-secret]').forEach((input) => {
    const clear = document.querySelector(`[data-clear-secret="${input.dataset.secret}"]`);
    if (clear?.checked) secrets[input.dataset.secret] = '';
    else if (input.value) secrets[input.dataset.secret] = input.value;
    else secrets[input.dataset.secret] = null;
  });
  return { config, secrets };
}

async function saveChannelConfiguration() {
  const resultEl = $('channelConfigResult');
  try {
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(channelConfigPayload()) });
    app.config = { ...app.config, config: result.config, secretsConfigured: result.secretsConfigured, restartPending: result.restartRequired };
    renderConfiguration();
    await refresh();
    resultEl.classList.remove('hidden'); resultEl.innerHTML = '<strong>Notification channels saved.</strong> Credentials are encrypted with the installation key outside the database.';
    toast('Notification channels saved');
  } catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
}

async function testChannel(channel, button) {
  button.disabled = true;
  try {
    await api('/api/notifications/test', { method: 'POST', body: JSON.stringify({ channel }) });
    toast(`${channel} test sent`);
  } catch (err) { toast(`${channel} test failed: ${err.message}`, 'error'); }
  finally { button.disabled = false; }
}

function bytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unknown';
  const units = ['B','KB','MB','GB','TB']; let index = 0; let n = amount;
  while (n >= 1024 && index < units.length - 1) { n /= 1024; index += 1; }
  return `${n.toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function refreshLogs() {
  const params = new URLSearchParams({ limit: '250' });
  if ($('logLevel').value) params.set('level', $('logLevel').value);
  if ($('logSearch').value.trim()) params.set('search', $('logSearch').value.trim());
  try {
    const result = await api(`/api/logs?${params}`);
    $('operationsLogs').innerHTML = result.logs.length ? result.logs.map((row) => `<div class="log-row ${escapeHtml(row.level)}"><time>${escapeHtml(new Date(row.created_at).toLocaleString())}</time><span>${escapeHtml(row.level)}</span><strong>${escapeHtml(row.source)}</strong><p>${escapeHtml(row.message)}</p></div>`).join('') : '<div class="settings-note">No matching logs.</div>';
  } catch (err) { $('operationsLogs').textContent = err.message; }
}

async function refreshOperations() {
  try {
    const ops = await api('/api/operations'); app.operations = ops;
    app.lastOperationsRefresh = Date.now();
    $('runtimeBadge').textContent = `${ops.runtime.platform} · ${ops.runtime.standalone ? 'standalone' : ops.runtime.node}`;
    $('operationsSummary').className = `operations-summary ${escapeHtml(ops.summary.state)}`;
    $('operationsSummary').innerHTML = `<div><span class="summary-state-dot"></span><div><strong>${escapeHtml(ops.summary.label)}</strong><small>${ops.summary.issues.length ? `${ops.summary.issues.length} item${ops.summary.issues.length === 1 ? '' : 's'} need review` : 'Monitoring, delivery, storage, and security checks are healthy'}</small></div></div>${ops.summary.issues.slice(0,3).map((item) => `<button ${item.settingsTab ? `data-settings-link="${escapeHtml(item.settingsTab)}"` : ''}>${escapeHtml(item.message)}</button>`).join('')}`;
    $('securityWarnings').innerHTML = ops.securityWarnings.length ? ops.securityWarnings.map((item) => `<div class="warning ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.severity.toUpperCase())}</strong><span>${escapeHtml(item.message)}</span>${item.settingsTab ? `<button data-settings-link="${escapeHtml(item.settingsTab)}">Open setting</button>` : ''}</div>`).join('') : '<div class="warning good"><strong>SECURE</strong><span>No configuration warnings detected.</span></div>';
    const queue = ops.notifications.queue;
    const failures = (queue.recentFailures || []).map((item) => `<div class="failure-row"><strong class="bad-text">${escapeHtml(item.channel)} · ${escapeHtml(item.region.toUpperCase())}</strong><small>${escapeHtml(item.last_error || 'Unknown delivery error')} · ${item.attempts}/${item.max_attempts} attempts</small></div>`).join('');
    const backupHistory = (ops.backups.history || []).slice(0, 6).map((item) => `<div class="failure-row"><strong class="${item.status === 'failed' ? 'bad-text' : ''}">${escapeHtml(item.reason)} · ${escapeHtml(item.status)}</strong><small>${escapeHtml(item.filename || item.detail || 'No file')} · ${escapeHtml(relativeTime(item.created_at))}</small></div>`).join('');
    $('operationsGrid').innerHTML = `<article class="settings-card"><span class="settings-kicker">Regions</span><h3>Store health</h3>${ops.regions.map((r) => `<div class="ops-row"><span class="connection-dot ${r.lastSuccessAt && !r.lastError ? 'enabled' : ''}"></span><div><strong>${escapeHtml(r.label)}</strong><small>${r.lastError ? escapeHtml(r.lastError) : `Last check ${escapeHtml(relativeTime(r.lastSuccessAt))} · next ${escapeHtml(relativeTime(r.nextCheckAt))}`}</small></div><b>${r.productCount || 0} products</b></div>`).join('')}</article><article class="settings-card"><span class="settings-kicker">Delivery</span><h3>Notification queue</h3><dl class="settings-details"><div><dt>Pending</dt><dd>${queue.pending}</dd></div><div><dt>Delivered</dt><dd>${queue.sent}</dd></div><div><dt>Failed</dt><dd>${queue.failed}</dd></div><div><dt>Next scheduled</dt><dd>${queue.nextDeliveryAt ? escapeHtml(relativeTime(queue.nextDeliveryAt)) : 'None'}</dd></div></dl>${failures ? `<div class="failure-list">${failures}</div>` : ''}<div class="settings-actions wrap">${queue.failed ? '<button data-retry-failed>Retry failed</button>' : ''}<button data-settings-link="notifications">Delivery settings</button></div></article><article class="settings-card"><span class="settings-kicker">Data safety</span><h3>Backups</h3><dl class="settings-details"><div><dt>Validated</dt><dd>${ops.backups.count}</dd></div><div><dt>Integrity</dt><dd>${ops.backups.integrity.ok ? 'OK' : 'Failed'}</dd></div><div><dt>Latest</dt><dd>${ops.backups.latest ? escapeHtml(relativeTime(ops.backups.latest.createdAt)) : 'None'}</dd></div></dl>${backupHistory ? `<div class="failure-list">${backupHistory}</div>` : ''}<div class="settings-actions"><button data-settings-link="data">Data settings</button></div></article><article class="settings-card"><span class="settings-kicker">Storage & build</span><h3>Installation</h3><dl class="settings-details"><div><dt>Database</dt><dd>${bytes(ops.storage.databaseSize)}</dd></div><div><dt>Free space</dt><dd>${bytes(ops.storage.freeSpace)}</dd></div><div><dt>Version</dt><dd>V${escapeHtml(ops.runtime.version)}</dd></div><div><dt>Commit / image</dt><dd>${escapeHtml(ops.runtime.commit || ops.runtime.image || 'Source checkout')}</dd></div></dl></article>`;
    const confidence = ops.monitoringConfidence || { pending:[], count:0, recentChecks:[] };
    const pendingRows = confidence.pending.slice(0, 6).map((item) => `<div class="failure-row"><strong>${escapeHtml(item.slug)} · ${escapeHtml(humanStatus(item.kind))}</strong><small>${item.observations} of 2 valid observations · ${escapeHtml(String(item.region).toUpperCase())}</small></div>`).join('');
    const secondary = ops.backups.secondary || {};
    $('operationsGrid').insertAdjacentHTML('beforeend', `<article class="settings-card"><span class="settings-kicker">Monitoring confidence</span><h3>${confidence.count ? `${confidence.count} pending change${confidence.count === 1 ? '' : 's'}` : 'No pending changes'}</h3><p>${confidence.count ? 'GearBeacon is preserving last-known-good values until another complete observation confirms these changes.' : 'Every recorded transition is confirmed under the current monitoring policy.'}</p>${pendingRows ? `<div class="failure-list">${pendingRows}</div>` : ''}</article><article class="settings-card"><span class="settings-kicker">Recovery copy</span><h3>${secondary.configured ? `${secondary.count} secondary cop${secondary.count === 1 ? 'y' : 'ies'}` : 'Not configured'}</h3><dl class="settings-details"><div><dt>Format</dt><dd>${secondary.configured ? secondary.encrypted ? 'Encrypted export' : 'Validated SQLite' : '—'}</dd></div><div><dt>Latest</dt><dd>${secondary.latest ? escapeHtml(relativeTime(secondary.latest.createdAt)) : 'None'}</dd></div><div><dt>Separate device</dt><dd>${secondary.sameFilesystem === null ? 'Unknown' : secondary.sameFilesystem ? 'No' : 'Yes'}</dd></div></dl><div class="settings-actions"><button data-settings-link="data">Recovery settings</button></div></article>`);
    renderAttentionBanner();
    await refreshLogs();
  } catch (err) { $('operationsGrid').textContent = `Operations unavailable: ${err.message}`; }
}

async function runInstallationDiagnostics() {
  const button = $('runDiagnostics'); const panel = $('diagnosticsPanel');
  button.disabled = true; button.textContent = 'Running…'; panel.classList.remove('hidden'); panel.innerHTML = '<div class="dialog-loading">Checking storage, backups, encryption, delivery, and store connectivity…</div>';
  try {
    const result = await api('/api/operations/diagnostics', { method:'POST', body:JSON.stringify({ network:true }) });
    panel.innerHTML = `<div class="diagnostics-panel-head"><h3>${result.summary.failed ? 'Diagnostics found required actions' : result.summary.warned ? 'Diagnostics completed with recommendations' : 'All diagnostics passed'}</h3><span class="settings-badge">${result.summary.passed} passed · ${result.summary.warned} warnings · ${result.summary.failed} failed</span></div><div class="diagnostic-list">${result.checks.map((check) => `<div class="diagnostic-item ${escapeHtml(check.status)}"><span class="connection-dot ${check.status === 'pass' ? 'enabled' : ''}"></span><div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div></div>`).join('')}</div>`;
    await refreshOperations();
  } catch (err) { panel.innerHTML = `<div class="settings-result error">Diagnostics could not complete: ${escapeHtml(err.message)}</div>`; }
  finally { button.disabled = false; button.textContent = 'Run diagnostics'; }
}

async function prepareUpdate() {
  const button = $('prepareUpdateBtn'); const resultEl = $('updateResult'); button.disabled = true;
  try { const result = await api('/api/update/prepare', { method:'POST' }); resultEl.classList.remove('hidden'); resultEl.innerHTML = `<strong>Validated pre-update backup created:</strong> ${escapeHtml(result.backup.filename)}<br>Run manually: <code>${escapeHtml(result.command || result.dockerCommand)}</code><br>${escapeHtml(result.warning)}`; }
  catch (err) { resultEl.classList.remove('hidden'); resultEl.textContent = err.message; }
  finally { button.disabled = false; }
}

function showWizard() {
  app.wizardStep = app.auth?.authenticationRequired ? 2 : 1;
  $('setupWizard').classList.remove('hidden');
  $('appShell').classList.add('wizard-blur');
  $('appShell').inert = true;
  regionChoices('wizardRegions', app.config?.config?.regions || ['us']);
  if (app.config) {
    $('wizardAccessMode').value = app.config.config.accessMode;
    $('wizardPublicUrl').value = app.config.config.publicBaseUrl || '';
    $('wizardNtfyBaseUrl').value = app.config.config.ntfyBaseUrl || '';
    $('wizardNtfyTopic').value = app.config.config.ntfyTopic || '';
    $('wizardGotifyUrl').value = app.config.config.gotifyBaseUrl || '';
    $('wizardSmtpHost').value = app.config.config.smtpHost || '';
    $('wizardSmtpPort').value = app.config.config.smtpPort || 587;
    $('wizardSmtpUser').value = app.config.config.smtpUser || '';
    $('wizardSmtpFrom').value = app.config.config.smtpFrom || '';
    $('wizardSmtpTo').value = (app.config.config.smtpTo || []).join(', ');
    $('wizardBackupHours').value = app.config.config.backupIntervalHours;
    $('wizardBackupRetention').value = app.config.config.backupRetention;
  }
  renderWizardStep();
}

function renderWizardStep() {
  document.querySelectorAll('[data-wizard-step]').forEach((page) => page.classList.toggle('hidden', Number(page.dataset.wizardStep) !== app.wizardStep));
  $('wizardStepLabel').textContent = `Step ${app.wizardStep} of 5`;
  $('wizardProgress').value = app.wizardStep;
  $('wizardBack').classList.toggle('hidden', app.wizardStep <= (app.auth?.authenticationRequired ? 2 : 1));
  $('wizardNext').textContent = app.wizardStep === 5 ? 'Finish setup' : 'Continue';
  if (app.wizardStep === 5 && app.config) {
    const c = app.config.config;
    const warnings = app.operations?.securityWarnings || [];
    $('wizardSummary').innerHTML = `<dl class="settings-details"><div><dt>URL</dt><dd>${escapeHtml(c.publicBaseUrl || `${location.protocol}//${location.host}`)}</dd></div><div><dt>Access</dt><dd>${escapeHtml(c.accessMode)}</dd></div><div><dt>Regions</dt><dd>${c.regions.map((x) => escapeHtml(x.toUpperCase())).join(', ')}</dd></div><div><dt>Backups</dt><dd>Every ${c.backupIntervalHours || 'disabled'}${c.backupIntervalHours ? ' hours' : ''} · retain ${c.backupRetention}</dd></div><div><dt>Security</dt><dd>${warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'} — review Operations` : 'No warnings detected'}</dd></div></dl>${app.config.restartPending ? '<p class="warning-text">Restart GearBeacon once to apply region, access-mode, or bind changes.</p>' : '<p>No restart is required.</p>'}`;
  }
  const heading = document.querySelector(`[data-wizard-step="${app.wizardStep}"] h1`);
  if (heading) { heading.tabIndex = -1; heading.focus(); }
}

async function wizardSaveConfiguration(includeNotifications = false) {
  const current = app.config.config;
  const accessMode = $('wizardAccessMode').value;
  const config = { ...current, regions: selectedRegions('wizardRegions'), accessMode, bindHost: accessMode === 'private' ? '0.0.0.0' : '127.0.0.1', publicBaseUrl: $('wizardPublicUrl').value.trim(), backupIntervalHours: Number($('wizardBackupHours').value), backupRetention: Number($('wizardBackupRetention').value), ntfyBaseUrl: $('wizardNtfyBaseUrl').value.trim(), ntfyTopic: $('wizardNtfyTopic').value.trim(), gotifyBaseUrl: $('wizardGotifyUrl').value.trim(), smtpHost:$('wizardSmtpHost').value.trim(), smtpPort:Number($('wizardSmtpPort').value), smtpUser:$('wizardSmtpUser').value, smtpFrom:$('wizardSmtpFrom').value.trim(), smtpTo:$('wizardSmtpTo').value.split(',').map((x) => x.trim()).filter(Boolean) };
  const secrets = includeNotifications ? { ntfyToken:$('wizardNtfyToken').value || null, discordWebhookUrl: $('wizardDiscordUrl').value || null, gotifyToken: $('wizardGotifyToken').value || null, webhookUrl:$('wizardWebhookUrl').value || null, webhookToken:$('wizardWebhookToken').value || null, webhookHmacSecret:$('wizardWebhookHmac').value || null, smtpPassword:$('wizardSmtpPassword').value || null } : {};
  const result = await api('/api/config', { method:'PUT', body:JSON.stringify({ config, secrets }) });
  app.config = { ...app.config, config: result.config, secretsConfigured: result.secretsConfigured, restartPending: result.restartRequired };
}

async function wizardNext() {
  const error = $('wizardError'); error.classList.add('hidden');
  try {
    if (app.wizardStep === 1) {
      const password = $('wizardPassword').value;
      if (password !== $('wizardPasswordConfirm').value) throw new Error('Owner passwords do not match.');
      const result = await authRequest('/api/auth/password', { method:'PUT', body:JSON.stringify({ newPassword: password }) });
      app.auth = { ...(await authRequest('/api/auth/status')), csrfToken: result.csrfToken };
    } else if (app.wizardStep === 2) await wizardSaveConfiguration(false);
    else if (app.wizardStep === 3) await wizardSaveConfiguration(true);
    else if (app.wizardStep === 4) app.operations = await api('/api/operations');
    else if (app.wizardStep === 5) {
      const result = await api('/api/onboarding/complete', { method:'POST' });
      app.auth.onboardingComplete = true;
      $('setupWizard').classList.add('hidden'); $('appShell').classList.remove('wizard-blur'); $('appShell').inert = false; $('tabWatchlist').focus();
      toast('GearBeacon setup complete'); await refreshConfiguration(); return;
    }
    app.wizardStep += 1; renderWizardStep();
  } catch (err) { error.textContent = err.message; error.classList.remove('hidden'); }
}

async function saveDownloadResponse(res, fallbackName) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = match?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function exportData(encrypted = true) {
  const button = encrypted ? $('exportBtn') : $('exportPlainBtn');
  button.disabled = true;
  try {
    const region = app.currentRegion ? `?region=${encodeURIComponent(app.currentRegion)}` : '';
    if (encrypted) {
      const passphrase = window.prompt('Create an export passphrase (at least 12 characters). You will need it to restore this file.');
      if (passphrase == null) return;
      const confirmation = window.prompt('Enter the export passphrase again.');
      if (passphrase !== confirmation) throw new Error('The export passphrases do not match.');
      const res = await fetch(`/api/data/export/encrypted${region}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(app.auth?.csrfToken ? { 'X-CSRF-Token': app.auth.csrfToken } : {}) },
        body: JSON.stringify({ passphrase }),
      });
      await saveDownloadResponse(res, `GearBeacon-Backup-${new Date().toISOString().slice(0,10)}.encrypted.gearbeacon.json`);
      toast('Encrypted GearBeacon data exported');
    } else {
      if (!window.confirm('Plain JSON exports are not encrypted and may contain your watchlist and history. Continue?')) return;
      const res = await fetch(`/api/data/export${region}`, { cache: 'no-store', credentials: 'same-origin' });
      await saveDownloadResponse(res, `GearBeacon-Backup-${new Date().toISOString().slice(0,10)}.gearbeacon.json`);
      toast('Plain GearBeacon data exported');
    }
  } catch (err) { toast(err.message, 'error'); }
  finally { button.disabled = false; }
}

async function importDataFile(file) {
  if (!file) return;
  const button = $('importBtn');
  button.disabled = true;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    const encrypted = backup?.format === 'GearBeaconEncryptedBackup';
    const passphrase = encrypted ? window.prompt('Enter the passphrase for this encrypted GearBeacon backup.') : '';
    if (encrypted && passphrase == null) return;
    const preview = await api('/api/data/preview', { method: 'POST', body: JSON.stringify({ backup, passphrase }) });
    const summary = preview.regions.map((region) => `${region.region.toUpperCase()}: ${region.watchCount} watched, ${region.eventCount} events${region.configured ? '' : ' (not configured; skipped)'}`).join('\n');
    if (!window.confirm(`Restore this GearBeacon backup?\n\n${summary}\n\nA validated SQLite safety backup will be created first.`)) return;
    const result = await api('/api/data/import', { method: 'POST', body: JSON.stringify({ backup, passphrase }) });
    await refresh();
    await refreshDataInfo();
    toast(`Restore complete · ${result.watchCount} watched product${result.watchCount === 1 ? '' : 's'}`);
  } catch (err) { toast(`Import failed: ${err.message}`, 'error'); }
  finally { button.disabled = false; $('importFile').value = ''; }
}

async function testLatestBackup(location) {
  const button = location === 'secondary' ? $('testSecondaryBackup') : $('testPrimaryBackup');
  const resultEl = $('backupTestResult');
  button.disabled = true; resultEl.classList.remove('hidden'); resultEl.textContent = `Testing the latest ${location} backup without changing active data…`;
  try {
    const result = await api('/api/data/test-restore', { method:'POST', body:JSON.stringify({ location }) });
    resultEl.innerHTML = `<strong>Restore test passed.</strong> ${escapeHtml(result.filename)} is intact and compatible${result.schemaVersion ? ` with schema v${escapeHtml(result.schemaVersion)}` : ''}. Active data was not changed.`;
    toast(`${location === 'secondary' ? 'Secondary' : 'Primary'} restore test passed`);
    await refreshOperations();
  } catch (err) { resultEl.textContent = `Restore test failed: ${err.message}`; }
  finally { button.disabled = false; }
}

async function checkUpdates() {
  const button = $('updateBtn');
  const resultEl = $('updateResult');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await api('/api/update/check');
    resultEl.classList.remove('hidden', 'update-available');
    if (result.updateAvailable) {
      resultEl.classList.add('update-available');
      const link = result.downloadUrl ? ` <a href="${escapeHtml(result.downloadUrl)}" target="_blank" rel="noopener">Download V${escapeHtml(result.latestVersion)} ↗</a>` : '';
      const warnings = (result.compatibilityWarnings || []).map((item) => `<br><span class="warning-text">${escapeHtml(item)}</span>`).join('');
      resultEl.innerHTML = `<strong>GearBeacon V${escapeHtml(result.latestVersion)} is available.</strong>${link}${result.releaseNotes ? `<br>${escapeHtml(result.releaseNotes)}` : ''}${warnings}`;
    } else {
      resultEl.innerHTML = `<strong>You're up to date.</strong> GearBeacon V${escapeHtml(result.currentVersion)} is the latest version on the configured update channel.${result.warning ? `<br>${escapeHtml(result.warning)}` : ''}`;
    }
  } catch (err) {
    resultEl.classList.remove('hidden');
    resultEl.textContent = `Update check failed: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Check for updates';
  }
}

async function updateOwnerPassword(event) {
  event.preventDefault();
  const resultEl = $('securityResult');
  const newPassword = $('newPassword').value;
  if (newPassword !== $('newPasswordConfirm').value) {
    resultEl.textContent = 'The new owner passwords do not match.';
    resultEl.classList.remove('hidden');
    return;
  }
  const button = event.submitter || $('passwordForm').querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await authRequest('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword: $('currentPassword').value, newPassword }),
    });
    app.auth = { ...(await authRequest('/api/auth/status')), csrfToken: result.csrfToken };
    $('passwordForm').reset();
    $('logoutBtn').classList.remove('hidden');
    resultEl.innerHTML = '<strong>Owner password updated.</strong> Other signed-in sessions were revoked.';
    resultEl.classList.remove('hidden');
    renderSecurity();
    await refreshSessions();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.classList.remove('hidden');
  } finally { button.disabled = false; }
}

async function revokeSession(id) {
  try {
    const result = await authRequest(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result.currentRevoked) {
      app.auth = { authenticationRequired: true };
      showAuth(false);
      return;
    }
    await refreshSessions();
    toast('Session revoked');
  } catch (err) { toast(err.message, 'error'); }
}

function maybeBrowserNotify(events) {
  if (!events.length) return;
  const eventStorageKey = `gearbeacon.latestEvent.${app.currentRegion || 'default'}`;
  if (app.latestEventId == null) app.latestEventId = localStorage.getItem(eventStorageKey);
  const newest = events[0].id;
  if (!app.latestEventId) {
    app.latestEventId = newest;
    localStorage.setItem(eventStorageKey, newest);
    return;
  }
  const fresh = [];
  for (const e of events) {
    if (e.id === app.latestEventId) break;
    fresh.push(e);
  }
  app.latestEventId = newest;
  localStorage.setItem(eventStorageKey, newest);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  fresh.filter((e) => e.notificationDecision?.allowed).reverse().forEach((e) => {
    const titles = { restock:`${e.name} is back in stock`, sold_out:`${e.name} sold out`, price_change:`${e.name} price changed`, status_change:`${e.name} status changed`, new_product:`New UniFi product: ${e.name}`, collection_ready:`${e.name} is ready` };
    const n = new Notification(`GearBeacon: ${titles[e.type] || e.name}`, { body: `${e.price ? `${e.price} · ` : ''}Detected ${relativeTime(e.detectedAt)}` });
    if (e.collectionId) n.onclick = () => { window.focus(); openCollection(e.collectionId, e.region); };
    else if (e.url) n.onclick = () => window.open(e.url, '_blank');
  });
}

let refreshTask = null;
let refreshAgain = false;
function refresh({ background = false } = {}) {
  if (refreshTask) {
    if (!background) refreshAgain = true;
    return refreshTask;
  }
  refreshTask = (async () => {
    do {
      refreshAgain = false;
      await performRefresh(background);
      background = false;
    } while (refreshAgain);
  })().finally(() => { refreshTask = null; });
  return refreshTask;
}

async function performRefresh(background) {
  const region = app.currentRegion;
  const revision = app.dataRevision;
  const controller = new AbortController();
  try {
    const options = { signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]) };
    if (background && document.hidden) {
      if ('Notification' in window && Notification.permission === 'granted') {
        const events = await api('/api/events?limit=100',options);
        if (region === app.currentRegion) maybeBrowserNotify(events.events || []);
      }
      return;
    }
    const wasDisconnected = app.serverFailures > 0 || app.browserOffline || app.reconnectPending;
    const loadViews = !background || Date.now() - (app.lastViewsRefresh || 0) > 60000;
    const [status, products, events, views] = await Promise.all([api('/api/status',options), api('/api/products?includeVariants=1',options), api('/api/events?limit=100',options), loadViews ? api('/api/views',options) : null]);
    if (region !== app.currentRegion || revision !== app.dataRevision || background && document.hidden) return;
    app.serverFailures = 0;
    app.browserOffline = false;
    app.reconnectPending = false;
    app.status = status;
    if (views) { app.savedViews = views.views || []; app.lastViewsRefresh = Date.now(); }
    app.catalogVariants = (products.products || []).filter((product) => product.variantId);
    app.products = (products.products || []).filter((product) => !product.variantId || product.watched);
    app.collections = products.collections || []; updateWatchAlertSummaries(products); app.watchOverview=products.overview || null;
    if (!background || !$('collectionDialog').classList.contains('hidden')) renderCollections();
    maybeBrowserNotify(events.events || []);
    app.events = events.events || [];
    renderStatus();
    if (!background || ['watchlist','browse'].includes(app.activeTab) || !$('collectionDialog').classList.contains('hidden')) renderProducts();
    if (!background || app.activeTab === 'settings') { renderSettings(false); renderEmailPreviewProducts(); }
    updateProductFreshness();
    renderAttentionBanner();
    if (wasDisconnected) toast('Connection restored', 'success');
    if (app.activeTab === 'activity') await refreshActivity(app.activity.page || 1, { background:true });
    if (Date.now() - app.lastOperationsRefresh > 60000 && !(app.activeTab === 'settings' && app.activeSettingsTab === 'operations')) refreshOperations();
  } catch (err) {
    if (region !== app.currentRegion || revision !== app.dataRevision || background && document.hidden) return;
    if (/Region must be one of/i.test(err.message) && app.currentRegion) {
      app.currentRegion = null;
      localStorage.removeItem('gearbeacon.region');
      refreshAgain = true;
      return;
    }
    $('statusDot').className = 'dot bad';
    app.serverFailures += 1;
    $('statusTitle').textContent = 'Reconnecting to GearBeacon…';
    $('statusSub').textContent = app.browserOffline ? 'Waiting for this browser to reconnect' : `${err.message} · automatic retry ${app.serverFailures}`;
    renderAttentionBanner();
  } finally { controller.abort(); }
}

async function toggleWatch(slug) {
  const product = app.products.find((p) => p.slug === slug) || (app.currentProductDetails?.product.slug === slug ? app.currentProductDetails.product : null);
  if (!product) return;
  try {
    if (product.watched) {
      await api(`/api/watch/${encodeURIComponent(slug)}`, { method:'DELETE' });
      product.watched = false; product.watchRule = null; app.selectedWatch.delete(slug);
    } else {
      const result = await api('/api/watch', { method:'POST', body:JSON.stringify({ slug }) });
      Object.assign(product, result.product || {}, { watched:true });
      if (!app.products.some((item) => item.slug === slug)) app.products.push(product);
    }
    await refresh();
    renderProducts(true);
    toast(product.watched ? `Watching ${product.name}` : `Stopped watching ${product.name}`);
    if (!$('productDialog').classList.contains('hidden')) openProductDialog(slug, true);
  } catch (err) { toast(err.message, 'error'); }
}

async function requireWatchWorkflow() {
  const result=await api('/api/collections');
  if (!result.capabilities?.watchWorkflow) throw new Error('Update and restart GearBeacon to use the new Watchlist workflow. Your changes have not been saved.');
  return result;
}

async function openAddWatch(slug) {
  const returnProduct=!$('productDialog').classList.contains('hidden') ? app.currentProductDetails?.product.slug : null;
  if (returnProduct) closeProductDialog();
  openCollectionManager(); app.addWatchReturn=returnProduct;
  const draft={slug,products:[],region:app.currentRegion}; app.addWatchDraft=draft;
  collectionView('add'); $('collectionDialogTitle').textContent='Add product';
  $('collectionDialogDescription').textContent='Choose a variant and where to keep it.';
  $('addWatchSummary').innerHTML=''; $('addWatchVariant').innerHTML='';
  $('addWatchDestination').innerHTML='<option value="watchlist">Watchlist</option>';
  $('addWatchName').value=''; $('addWatchQuantity').value='1';
  $('saveAddWatch').disabled=true; renderAddWatch();
  $('collectionResult').textContent='Loading product…';
  try {
    const [details,result]=await Promise.all([api(`/api/products/${encodeURIComponent(slug)}`),requireWatchWorkflow()]);
    if (app.addWatchDraft!==draft || draft.region!==app.currentRegion) return;
    app.collections=result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview;
    draft.products=[details.parent || details.product,...details.variants].filter((product,index,all)=>all.findIndex(item=>item.slug===product.slug)===index);
    $('addWatchVariant').innerHTML=draft.products.map(product=>`<option value="${escapeHtml(product.slug)}">${escapeHtml(product.variantTitle || (product.variantId ? product.sku || product.name : 'Any variant'))}${product.sku ? ` · ${escapeHtml(product.sku)}` : ''}</option>`).join('');
    $('addWatchVariant').value=slug;
    $('addWatchDestination').innerHTML='<option value="watchlist">Watchlist</option>'+app.collections.filter(item=>!item.archived).map(item=>`<option value="${escapeHtml(item.id)}">Collection: ${escapeHtml(item.name)}</option>`).join('')+'<option value="new">+ New collection</option>';
    $('collectionResult').textContent=''; renderAddWatch(); $('addWatchVariant').focus();
  } catch (err) { if (app.addWatchDraft===draft) { $('collectionResult').textContent=err.message; $('collectionResult').classList.add('error'); } }
}

function renderAddWatch() {
  const draft=app.addWatchDraft; if (!draft) return;
  const product=draft.products.find(item=>item.slug===$('addWatchVariant').value);
  const destination=$('addWatchDestination').value;
  const member=app.collections.find(item=>item.id===destination)?.items.find(item=>item.slug===product?.slug);
  $('addWatchNameField').classList.toggle('hidden',destination!=='new');
  $('addWatchName').disabled=destination!=='new'; $('addWatchName').required=destination==='new';
  $('addWatchQuantityField').classList.toggle('hidden',destination==='watchlist');
  $('addWatchQuantity').disabled=destination==='watchlist' || Boolean(member);
  if (member) $('addWatchQuantity').value=member.quantity;
  else if (draft.lastMember) $('addWatchQuantity').value='1';
  draft.lastMember=Boolean(member);
  $('saveAddWatch').disabled=!product;
  $('saveAddWatch').textContent=member || (destination==='watchlist' && product?.watched) ? 'Done' : 'Add product';
  $('addWatchHint').textContent=member ? `Already in this collection: ${member.purchasedQuantity} of ${member.quantity} purchased. Its quantity and recorded costs will be kept.` : destination==='watchlist' ? product?.watched ? 'Already watched. Its existing rules and collections will be kept.' : 'Watch this product using your global notification settings.' : 'An existing watch is reused with its rules preserved. New collection items start with this desired quantity and no purchases recorded.';
  if (!product) return;
  $('addWatchSummary').innerHTML=`<div class="collection-item-heading"><button class="collection-watch-image media-shell" type="button" data-collection-image="${escapeHtml(product.slug)}" aria-label="Retry image for ${escapeHtml(product.name)}">${imageMarkup(product)}</button><div class="collection-watch-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml([product.sku,product.price].filter(Boolean).join(' · '))}</small></div></div>`;
  wireProductImages($('addWatchSummary'));
}

async function saveAddedWatch() {
  const draft=app.addWatchDraft;
  if (!draft || app.collectionBusy || draft.region!==app.currentRegion) return;
  const slug=$('addWatchVariant').value; const destination=$('addWatchDestination').value;
  const body={slug,...(destination==='watchlist' ? {} : {quantity:Number($('addWatchQuantity').value),...(destination==='new' ? {collectionName:$('addWatchName').value} : {collectionId:destination})})};
  const controls=[...$('collectionDialog').querySelectorAll('button,input,select')].map(node=>[node,node.disabled]);
  app.collectionBusy=true; controls.forEach(([node])=>node.disabled=true);
  $('collectionResult').textContent='Adding product…'; $('collectionResult').classList.remove('error');
  let saved=false;
  try {
    const result=await api('/api/watch/add',{method:'POST',body:JSON.stringify(body)});
    const collection=result.collections?.find(item=>item.id===result.collectionId);
    if (!result.product?.watched || result.product.slug!==slug || (destination!=='watchlist' && (!collection?.slugs.includes(slug) || (destination!=='new' && collection.id!==destination) || (!result.alreadyMember && collection.items.find(item=>item.slug===slug)?.quantity!==body.quantity)))) throw new Error('The server did not confirm the product was added. Your selections are still here.');
    app.collections=result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview;
    const product=app.products.find(item=>item.slug===slug);
    if (product) Object.assign(product,result.product); else app.products.push(result.product);
    renderCollections(true); renderProducts(true);
    saved=true;
    if (app.addWatchReturn) app.addWatchReturn=slug;
    toast(result.alreadyMember ? 'Already in this collection. Purchase records kept.' : collection ? `Added to ${collection.name}.` : result.alreadyWatched ? 'Already watched. Existing rules kept.' : 'Added to Watchlist.');
  } catch (err) { $('collectionResult').textContent=err.message; $('collectionResult').classList.add('error'); }
  finally { app.collectionBusy=false; controls.forEach(([node,disabled])=>node.disabled=disabled); }
  if (saved) closeCollectionManager();
}

async function archiveCollection(id) {
  const collection=app.collections.find(item=>item.id===id); if (!collection) return;
  const overviewVisible=!$('collectionOverview').classList.contains('hidden');
  const result=await commitCollection('PUT',id,{archived:!collection.archived});
  if (!result) return;
  if ($('watchCollection').value===id && !collection.archived) { $('watchCollection').value='all'; app.pendingWatchCollection=null; persistUiState(); }
  renderProducts(true);
  toast(collection.archived ? 'Collection restored. Current conditions establish a new alert baseline.' : 'Collection archived. Purchases kept; collection alerts and its override are inactive.');
  if (overviewVisible) { renderCollections(true); $('collectionArchiveFilter').focus(); }
  else closeCollectionManager();
}

function renderCollectionUndos() {
  const entries=app.collectionUndos.filter(item=>item.region===app.currentRegion);
  $('collectionUndo').classList.toggle('hidden',!entries.length);
  $('collectionUndo').innerHTML=entries.length ? '<p>Recently removed · Undo remains available until you dismiss it or refresh this page.</p>'+entries.map(item=>`<div><span>${escapeHtml(item.name)} removed from ${escapeHtml(app.collections.find(collection=>collection.id===item.id)?.name || 'collection')}</span><button type="button" data-undo-collection="${escapeHtml(item.key)}" aria-label="Undo removal of ${escapeHtml(item.name)}">Undo</button><button type="button" data-dismiss-collection-undo="${escapeHtml(item.key)}" aria-label="Dismiss undo for ${escapeHtml(item.name)}">Dismiss</button></div>`).join('') : '';
}

async function undoCollectionRemoval(key) {
  const entry=app.collectionUndos.find(item=>item.key===key && item.region===app.currentRegion); if (!entry) return;
  if (await mutateCollectionItem('POST',entry.id,entry.slug,entry.plan)) {
    app.collectionUndos=app.collectionUndos.filter(item=>item.key!==key); renderCollectionUndos();
    openCollectionDetails(entry.id);
    $('collectionDetails').querySelector(`[data-collection-item-edit="${CSS.escape(entry.slug)}"]`)?.focus();
    toast('Item restored with its quantity and purchase record.');
  }
}

function renderCollections(force = false) {
  const archiveFilter=$('collectionArchiveFilter').value;
  const visible=app.collections.filter(item=>archiveFilter==='all' || Boolean(item.archived)===(archiveFilter==='archived'));
  const key = JSON.stringify([archiveFilter,app.collections.map(({ id,name,slugs,archived }) => ({ id,name,slugs,archived }))]);
  if (!force && key === app.collectionsRenderKey) return;
  app.collectionsRenderKey = key;
  const focused = document.activeElement;
  const focusAction = ['data-edit-collection','data-view-collection','data-collection-alerts'].find((attribute) => focused?.hasAttribute(attribute));
  const focusId = focusAction && focused.getAttribute(focusAction);
  $('collectionTotal').textContent = `${visible.length} collection${visible.length === 1 ? '' : 's'}`;
  $('collectionEmpty').classList.toggle('hidden', visible.length > 0);
  $('collectionEmpty').querySelector('h3').textContent=archiveFilter==='archived' ? 'No archived collections' : 'A place for every project';
  $('collectionEmpty').querySelector('p').textContent=archiveFilter==='archived' ? 'Archived projects keep their purchase records here until you restore or delete them.' : 'Group your watches into projects, like Home network or Camera upgrade.';
  $('firstCollection').classList.toggle('hidden',archiveFilter==='archived');
  $('newCollection').classList.toggle('hidden', app.collections.length === 0);
  $('collectionList').innerHTML = visible.map((collection) => `<article class="collection-row" data-collection-row="${escapeHtml(collection.id)}"><div class="collection-row-copy"><h3>${escapeHtml(collection.name)}</h3><p>${collection.slugs.length} watch${collection.slugs.length === 1 ? '' : 'es'}${collection.archived ? ' · Archived' : ''}</p></div><div class="collection-row-actions"><button type="button" data-view-collection="${escapeHtml(collection.id)}" aria-label="View watches in ${escapeHtml(collection.name)}">View watches</button><button type="button" data-collection-alerts="${escapeHtml(collection.id)}" aria-label="Configure alerts for ${escapeHtml(collection.name)}">Alerts</button><button type="button" data-edit-collection="${escapeHtml(collection.id)}" aria-label="Edit ${escapeHtml(collection.name)}">Edit</button><button type="button" data-archive-collection="${escapeHtml(collection.id)}" aria-label="${collection.archived ? 'Restore' : 'Archive'} ${escapeHtml(collection.name)}">${collection.archived ? 'Restore' : 'Archive'}</button></div></article>`).join('');
  if (focusId && !focused.isConnected) ($('collectionList').querySelector(`[${focusAction}="${CSS.escape(focusId)}"]`) || $('newCollection').offsetParent && $('newCollection') || $('firstCollection')).focus();
}

function collectionView(view) {
  if (view !== 'details') app.collectionDetailId = null;
  if (view !== 'alerts') app.collectionAlertId = null;
  for (const [id, name] of [['collectionOverview','list'],['addWatchForm','add'],['collectionBulk','bulk'],['collectionForm','edit'],['collectionDetails','details'],['collectionItemForm','item'],['collectionAlerts','alerts'],['collectionDeleteConfirm','delete']]) $(id).classList.toggle('hidden', name !== view);
  $('collectionResult').textContent = '';
  $('collectionResult').classList.remove('error');
}

function openCollectionManager(bulk = false) {
  app.collectionLastFocus = document.activeElement;
  const add=app.collectionLastFocus?.closest('[data-add-watch]');
  app.collectionLastAddSelector=add ? `#browseGrid .${add.classList.contains('watch-icon') ? 'watch-icon' : 'store-watch'}[data-add-watch="${CSS.escape(add.dataset.addWatch)}"]` : null;
  const card = app.collectionLastFocus?.closest('[data-collection-card]');
  const action = ['data-collection-detail','data-collection-alerts','data-edit-collection','data-view-collection'].find((name) => app.collectionLastFocus?.hasAttribute(name));
  app.collectionLastCardSelector = card && action ? `[data-collection-card="${CSS.escape(card.dataset.collectionCard)}"] ${app.collectionLastFocus.classList.contains('collection-preview') ? '.collection-preview' : app.collectionLastFocus.classList.contains('product-name-button') ? '.product-name-button' : '.card-actions button'}[${action}]` : null;
  app.collectionRegion = app.currentRegion;
  app.collectionBulkSlugs = bulk ? [...app.selectedWatch] : null;
  app.collectionDraft = null;
  $('collectionDialog').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  document.querySelector('main').inert = true;
  $('toTop').inert = true;
  showCollectionOverview(); renderCollectionUndos();
}

function closeCollectionManager() {
  if (app.collectionBusy) return;
  $('collectionDialog').classList.add('hidden');
  document.body.classList.remove('dialog-open');
  document.querySelector('main').inert = false;
  $('toTop').inert = false;
  app.collectionDraft = null;
  app.collectionDetailId = null;
  app.collectionAlertId = null;
  app.collectionAlertReturn = null;
  app.collectionItemDraft = null;
  app.addWatchDraft=null;
  const returnProduct=app.addWatchReturn; app.addWatchReturn=null;
  const original = app.collectionLastFocus;
  const replacement = (app.collectionLastCardSelector && document.querySelector(app.collectionLastCardSelector)) || (app.collectionLastAddSelector && document.querySelector(app.collectionLastAddSelector));
  (original?.isConnected && original.offsetParent !== null ? original : replacement || $('watchManageToggle')).focus();
  if (returnProduct) openProductDialog(returnProduct);
}

function dismissCollectionManager() {
  if (app.collectionBusy) return;
  if (!$('collectionItemForm').classList.contains('hidden')) { closeCollectionItem(); return; }
  if (!$('collectionAlerts').classList.contains('hidden') && app.collectionAlertReturn?.view) returnFromCollectionAlerts();
  else closeCollectionManager();
}

function showCollectionOverview(focusId = null) {
  if (app.collectionBusy) return;
  app.collectionDraft = null;
  const bulk = app.collectionBulkSlugs;
  collectionView(bulk ? 'bulk' : 'list');
  $('collectionDialogTitle').textContent = bulk ? 'Add to collection' : 'Manage collections';
  $('collectionDialogDescription').textContent = bulk ? `${bulk.length} selected watch${bulk.length === 1 ? '' : 'es'} · choose a project for your gear.` : 'Group your watched gear by project.';
  renderCollections(true);
  $('collectionDestination').innerHTML = app.collections.filter(item=>!item.archived).map((collection) => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join('');
  $('collectionBulkForm').classList.toggle('hidden', !$('collectionDestination').options.length);
  const target = bulk ? ($('collectionDestination').options.length ? $('collectionDestination') : $('newBulkCollection')) : focusId ? $('collectionList').querySelector(`[data-edit-collection="${CSS.escape(focusId)}"]`) : null;
  (target || (app.collections.length ? $('newCollection') : $('firstCollection'))).focus();
}

function editCollection(id = null) {
  if (app.collectionBusy) return;
  const collection = id ? app.collections.find((item) => item.id === id) : null;
  if (id && !collection) return;
  app.collectionDraft = { id, slugs:new Set(collection?.slugs || app.collectionBulkSlugs || []), products:app.products.filter((product) => product.watched).map((product) => ({ ...product })) };
  collectionView('edit');
  $('collectionDialogTitle').textContent = id ? 'Edit collection' : 'New collection';
  $('collectionDialogDescription').textContent = 'Keep the gear for your next project together.';
  $('collectionName').value = collection?.name || '';
  $('collectionBudget').value = collection?.budget ?? '';
  $('collectionWatchSearch').value = '';
  $('saveCollection').textContent = id ? 'Save changes' : 'Create collection';
  $('collectionDeleteArea').classList.toggle('hidden', !id);
  $('archiveCollection').textContent=collection?.archived ? 'Restore collection' : 'Archive collection';
  $('editCollectionAlerts').classList.toggle('hidden', !id);
  renderCollectionChoices();
  $('collectionName').focus();
}

function renderCollectionChoices() {
  const draft = app.collectionDraft;
  if (!draft) return;
  const search = $('collectionWatchSearch').value.trim().toLowerCase();
  const products = draft.products.filter((product) => `${product.name} ${product.sku || ''} ${product.variantTitle || ''} ${product.slug}`.toLowerCase().includes(search)).sort((a,b) => a.name.localeCompare(b.name));
  $('collectionSelection').textContent = `${draft.slugs.size} selected`;
  $('collectionWatchChoices').innerHTML = products.map((product, index) => `<div class="collection-watch-option"><label for="collectionWatch${index}"><input id="collectionWatch${index}" type="checkbox" data-collection-watch="${escapeHtml(product.slug)}" ${draft.slugs.has(product.slug) ? 'checked' : ''}/><span class="collection-watch-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml([product.variantTitle || (product.variantId ? '' : 'Any variant'),product.sku,product.price].filter(Boolean).join(' · '))}</small></span></label><button class="collection-watch-image media-shell" type="button" data-collection-image="${escapeHtml(product.slug)}" aria-label="Retry image for ${escapeHtml(product.name)}">${imageMarkup(product)}</button></div>`).join('') || `<p class="collection-no-watches">${draft.products.length ? 'No watches match your search.' : 'No watched products yet. You can save this collection empty and add watches after visiting Browse.'}</p>`;
  wireProductImages($('collectionWatchChoices'));
}

async function commitCollection(method, id, body) {
  if (app.collectionBusy) return null;
  if (app.collectionRegion !== app.currentRegion) { $('collectionResult').textContent = 'The store region changed. Close and reopen the collection manager.'; return null; }
  app.collectionBusy = true;
  $('collectionResult').classList.remove('error');
  $('collectionResult').textContent = method === 'DELETE' ? 'Deleting collection…' : 'Saving collection…';
  const controls = [...$('collectionDialog').querySelectorAll('button,input,select')].map((control) => [control,control.disabled]);
  controls.forEach(([control]) => { control.disabled = true; });
  try {
    if (body?.archived !== undefined) await requireWatchWorkflow();
    const editsMembers = body?.slugs !== undefined || body?.addSlugs !== undefined;
    if (editsMembers || body?.budget !== undefined) {
      const server = await api('/api/collections');
      if (body?.budget !== undefined && server.capabilities?.purchasePlanning !== true) throw new Error('The running server needs to be updated and restarted before it can save purchase plans. Your edits are still here.');
      if (server.capabilities?.memberEditing !== true) throw new Error('The running server needs to be updated and restarted before it can save collection items. Your selections are still here. Restart GearBeacon, then try saving again.');
    }
    const result = await api(id ? `/api/collections/${encodeURIComponent(id)}` : '/api/collections', { method, ...(body ? { body:JSON.stringify(body) } : {}) });
    if (editsMembers) {
      const saved = result.collections?.find((collection) => collection.id === (id || result.id));
      // Keep a created collection editable if its server response reports an incomplete save.
      if (method === 'POST' && saved && app.collectionDraft) {
        app.collectionDraft.id = saved.id;
        $('saveCollection').textContent = 'Save changes';
      }
      const expected = [...new Set(body.slugs ?? body.addSlugs)];
      const membersSaved = Array.isArray(saved?.slugs) && expected.every((slug) => saved.slugs.includes(slug)) && (body.slugs === undefined || saved.slugs.length === expected.length);
      if (!membersSaved) throw new Error('The server did not confirm your collection items were saved. Your selections are still here. Restart GearBeacon after updating, then try saving again.');
    }
    if (body?.budget !== undefined && result.collections?.find(item=>item.id===(id || result.id))?.budget !== body.budget) throw new Error('The server did not confirm your budget was saved. Restart GearBeacon after updating and try again.');
    if (body?.archived !== undefined && result.collections?.find(item=>item.id===id)?.archived !== body.archived) throw new Error('The server did not confirm the archive change.');
    app.collections = result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview || app.watchOverview;
    for (const product of app.products) product.collections = app.collections.filter((collection) => collection.slugs.includes(product.slug)).map((collection) => collection.id);
    renderCollections(); renderProducts(true);
    return result;
  } catch (err) {
    $('collectionResult').classList.add('error');
    $('collectionResult').textContent = err.message;
    return null;
  } finally {
    app.collectionBusy = false;
    controls.forEach(([control,disabled]) => { control.disabled = disabled; });
  }
}

async function saveCollection() {
  const draft = app.collectionDraft;
  if (!draft) return;
  const creating = !draft.id;
  const result = await commitCollection(draft.id ? 'PUT' : 'POST', draft.id, { name:$('collectionName').value, budget:$('collectionBudget').value === '' ? null : Number($('collectionBudget').value), slugs:[...draft.slugs] });
  if (!result) return;
  if (app.collectionBulkSlugs) { app.selectedWatch.clear(); renderProducts(true); closeCollectionManager(); }
  else showCollectionOverview(draft.id || result.id);
  toast(creating ? 'Collection created.' : 'Collection updated.', 'success');
}

async function addSelectedToCollection() {
  if (!app.collectionBulkSlugs?.length || !$('collectionDestination').value) return;
  const result = await commitCollection('PUT', $('collectionDestination').value, { addSlugs:app.collectionBulkSlugs });
  if (!result) return;
  app.selectedWatch.clear(); renderProducts(true); closeCollectionManager();
  toast('Selected watches added to the collection.', 'success');
}

function confirmCollectionDeletion() {
  if (app.collectionBusy || !app.collectionDraft?.id) return;
  collectionView('delete');
  const collection = app.collections.find((item) => item.id === app.collectionDraft.id);
  $('collectionDialogTitle').textContent = 'Delete collection';
  $('collectionDeleteDescription').textContent = `“${collection?.name || 'This collection'}” will be deleted. Its watches, alert rules, and history will be kept.`;
  $('cancelDeleteCollection').focus();
}

async function deleteCollection() {
  const result = await commitCollection('DELETE', app.collectionDraft?.id);
  if (!result) return;
  closeCollectionManager();
  toast('Collection deleted. Watches retained.', 'success');
}

function collectionPriceText(collection) {
  const price = collection.pricing;
  if (!price || (price.items > 0 && price.priced === 0 && price.total === 0)) return 'Price unavailable';
  return `${insightMoney(price.total, price.currency)}${price.missing ? '+' : ''}`;
}

function collectionPriceNote(collection) {
  const price = collection.pricing;
  if (!price) return 'Total price unavailable';
  return price.missing ? `Subtotal · ${price.missing} item${price.missing === 1 ? '' : 's'} with unknown costs` : `Total for ${collection.planning?.quantity ?? price.items} units`;
}

function collectionBudgetText(collection) {
  if (collection.budget === null || collection.budget === undefined) return 'No budget set';
  const delta = collection.planning?.budgetDifference;
  if (delta === null || delta === undefined) return `Budget ${insightMoney(collection.budget, collection.pricing.currency)} · costs incomplete`;
  return delta === 0 ? 'On budget' : `${insightMoney(Math.abs(delta), collection.pricing.currency)} ${delta < 0 ? 'over' : 'under'} budget`;
}

function collectionStatusText(collection) {
  const result = collection.readiness;
  if (result.remaining && collection.budgetRequired && result.budget?.state !== 'within') return `${result.qualifying} of ${result.remaining} items qualify · ${result.budget?.reason || 'Waiting for confirmed costs.'}`;
  return result.remaining ? `${result.qualifying} of ${result.remaining} remaining items meet your conditions` : result.purchased ? 'All items purchased' : 'Add watches to this collection';
}

function collectionCard(collection) {
  const result = collection.readiness;
  const members = collection.slugs.map((slug) => app.products.find((product) => product.slug === slug) || { slug, name:slug });
  const previews = members.slice(0,4);
  const badge = collection.archived ? 'Archived' : !members.length ? 'Empty' : !result.remaining ? 'Purchased' : result.ready ? 'Ready' : result.budget?.state === 'over' ? 'Over budget' : result.unknown || result.budget?.state === 'unknown' ? 'Awaiting check' : 'Waiting';
  const badgeClass = result.ready ? 'in' : result.waiting ? 'out' : 'soon';
  const preview = previews.map((product) => `<span class="collection-preview-tile media-shell">${imageMarkup(product)}${!product.imageUrl ? '<span class="collection-image-missing" aria-hidden="true">No image</span>' : ''}</span>`).join('');
  return `<article class="card collection-card" data-collection-card="${escapeHtml(collection.id)}">
    <button class="watch-image collection-preview" data-preview-count="${previews.length}" type="button" data-collection-detail="${escapeHtml(collection.id)}" aria-label="View ${escapeHtml(collection.name)} collection details">${preview || '<span class="collection-preview-empty">Add gear to your collection</span>'}${members.length > 4 ? `<span class="collection-preview-more">+${members.length - 4} more</span>` : ''}</button>
    <div class="card-top"><span class="badge ${badgeClass}">${badge}</span><span class="meta">Collection</span></div>
    <button class="product-name-button" type="button" data-collection-detail="${escapeHtml(collection.id)}"><h3>${escapeHtml(collection.name)}</h3></button>
    <div class="meta">${collection.planning?.purchasedQuantity ?? result.purchased} of ${collection.planning?.quantity ?? members.length} units purchased</div>
    <div class="price" title="${escapeHtml(collectionPriceNote(collection))}">${escapeHtml(collectionPriceText(collection))}</div>
    <div class="detail readiness-status" role="status">${escapeHtml(collectionStatusText(collection))}</div>
    <div class="rule-chips"><span class="rule-chip">${escapeHtml(collectionPriceNote(collection))}</span></div>
    ${alertSummaryMarkup(collection, 'collections')}
    ${collection.budget !== null && collection.budget !== undefined ? `<div class="rule-chips"><span class="rule-chip">${escapeHtml(collectionBudgetText(collection))}</span></div>` : ''}
    <div class="card-actions"><button type="button" data-view-collection="${escapeHtml(collection.id)}">View items</button><button type="button" data-collection-alerts="${escapeHtml(collection.id)}" aria-label="Configure alerts for ${escapeHtml(collection.name)}">Alerts</button><button type="button" data-edit-collection="${escapeHtml(collection.id)}">Edit</button></div>
  </article>`;
}

function openCollectionDetails(id) {
  if (!app.collections.some((collection) => collection.id === id)) return;
  if ($('collectionDialog').classList.contains('hidden')) openCollectionManager();
  app.collectionDetailId = id;
  app.collectionDetailsKey = null;
  collectionView('details');
  renderCollectionDetails();
  $('closeCollectionManager').focus();
}

function renderCollectionDetails() {
  const collection = app.collections.find((item) => item.id === app.collectionDetailId);
  if (!collection || $('collectionDetails').classList.contains('hidden') || $('collectionDialog').classList.contains('hidden')) return;
  const result = collection.readiness;
  const members = result.items.map((item) => ({ item, product:app.products.find((product) => product.slug === item.slug) || { slug:item.slug, name:item.name } }));
  const key = JSON.stringify({ ...collection, readiness:{ ...result, checkedAt:null }, products:members.map(({ product }) => [product.name,product.sku,product.variantTitle,product.price,product.imageUrl,product.watchRule?.targetPrice,collectionAlertSources(product).map(value=>[value.id,value.name])]) });
  if (key === app.collectionDetailsKey) return;
  app.collectionDetailsKey = key;
  const focused = document.activeElement;
  const focusAction = focused?.closest('#collectionDetails') && ['data-view-collection','data-edit-collection','data-collection-alerts','data-collection-image','data-collection-item-edit','data-collection-item-purchase','data-collection-item-remove'].find((name) => focused.hasAttribute(name));
  const focusValue = focusAction && focused.getAttribute(focusAction);
  const text = collectionStatusText(collection);
  $('collectionDialogTitle').textContent = collection.name;
  $('collectionDialogDescription').textContent = `${collection.slugs.length} item${collection.slugs.length === 1 ? '' : 's'} · ${collection.archived ? 'Archived collection' : 'Collection details'}`;
  const items = members.map(({ item, product }) => `<li class="collection-member-row">
    <button class="collection-watch-image media-shell" type="button" data-collection-image="${escapeHtml(product.slug)}" aria-label="Retry image for ${escapeHtml(product.name)}">${imageMarkup(product)}</button>
    <div class="collection-watch-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml([product.variantTitle || (product.variantId ? '' : 'Any variant'),product.sku,product.price || 'Price unavailable'].filter(Boolean).join(' · '))}</small><small>${escapeHtml(item.reason)}</small></div>
    <span class="collection-member-status">${escapeHtml(humanStatus(item.state))}</span>
    <div class="collection-member-plan"><span>${item.purchasedQuantity ?? 0} of ${item.quantity ?? 1} purchased</span><span>Target: ${item.targetPrice === null ? 'None' : escapeHtml(insightMoney(item.targetPrice, collection.pricing.currency))}</span><span>${collectionAlertSources(product).length ? `Item alerts suppressed by: ${escapeHtml(collectionAlertSources(product).map(value=>value.name).join(', '))}` : 'Individual alerts use saved watch rules'}</span></div>
    <div class="collection-member-actions"><button type="button" data-collection-item-edit="${escapeHtml(item.slug)}">Edit item</button><button type="button" data-collection-item-purchase="${escapeHtml(item.slug)}">Record purchase</button>${product.url ? `<a class="button-link" href="${escapeHtml(product.url)}" target="_blank" rel="noopener">Store ↗</a>` : ''}<button type="button" data-collection-item-remove="${escapeHtml(item.slug)}">Remove</button></div>
  </li>`).join('');
  $('collectionDetails').innerHTML = `<div class="collection-detail-price"><strong class="price">${escapeHtml(collectionPriceText(collection))}</strong><span>${escapeHtml(collectionPriceNote(collection))}. Recorded spending plus the current cost of remaining units.</span></div>
    ${collection.planning ? `<dl class="collection-plan-summary"><div><dt>Spent</dt><dd>${escapeHtml(insightMoney(collection.planning.spent,collection.pricing.currency))}${collection.planning.missingPaid ? ' + unknown payments' : ''}</dd></div><div><dt>Remaining cost</dt><dd>${escapeHtml(insightMoney(collection.planning.remainingCost,collection.pricing.currency))}${collection.planning.missingPrices ? ' + unavailable prices' : ''}</dd></div><div><dt>Budget</dt><dd>${collection.budget === null ? 'Not set' : escapeHtml(insightMoney(collection.budget,collection.pricing.currency))}</dd></div><div><dt>Budget status</dt><dd>${escapeHtml(collectionBudgetText(collection))}</dd></div></dl><p>${collection.planning.purchasedQuantity} of ${collection.planning.quantity} units purchased · ${collection.planning.completedItems} of ${collection.slugs.length} items complete</p>` : ''}
    <p class="collection-help">Quantities are for planning; availability does not confirm how many units the store has. Prices exclude shipping and additional checkout costs.</p><p class="readiness-status" role="status">${escapeHtml(text)}</p><progress max="${Math.max(1, result.remaining)}" value="${result.qualifying}" aria-label="${escapeHtml(collection.name)}: ${escapeHtml(text)}"></progress><p>${result.purchased} items fully purchased${result.unknown ? ` · ${result.unknown} awaiting confirmed observations` : ''}</p>
    <section class="collection-members" aria-labelledby="collectionItemsHeading"><h3 id="collectionItemsHeading">Items and conditions</h3><ul>${items || '<li class="collection-no-watches">No items assigned.</li>'}</ul></section>
    <div class="collection-form-actions"><button type="button" data-view-collection="${escapeHtml(collection.id)}">View items</button><button type="button" data-collection-alerts="${escapeHtml(collection.id)}">Alerts</button><button type="button" data-edit-collection="${escapeHtml(collection.id)}">Edit collection</button></div>`;
  wireProductImages($('collectionDetails'));
  if (focusAction) $('collectionDetails').querySelector(`[${focusAction}="${CSS.escape(focusValue)}"]`)?.focus();
}

function openCollectionItem(slug, purchase = false) {
  const collection = app.collections.find(item=>item.id===app.collectionDetailId);
  const item = collection?.items?.find(item=>item.slug===slug);
  const product = app.products.find(item=>item.slug===slug);
  if (app.collectionBusy || !collection || !product) return;
  if (!item) { toast('Update and restart GearBeacon to edit purchase plans.','error'); return; }
  app.collectionItemDraft = { collectionId:collection.id, slug, action:purchase ? 'data-collection-item-purchase' : 'data-collection-item-edit' };
  collectionView('item');
  $('collectionDialogTitle').textContent = purchase ? 'Record purchase' : 'Edit collection item';
  $('collectionDialogDescription').textContent = `${collection.name} · ${collection.pricing.currency}`;
  $('collectionItemSummary').innerHTML = `<div class="collection-item-heading"><button class="collection-watch-image media-shell" type="button" data-collection-image="${escapeHtml(product.slug)}" aria-label="Retry image for ${escapeHtml(product.name)}">${imageMarkup(product)}</button><div class="collection-watch-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml([product.variantTitle,product.sku,product.price].filter(Boolean).join(' · '))}</small></div></div>`;
  wireProductImages($('collectionItemSummary'));
  $('collectionItemQuantity').value=item.quantity;
  $('collectionItemPurchased').value=purchase ? item.quantity : item.purchasedQuantity;
  let paid = item.paidTotal;
  if (purchase && item.purchasedQuantity < item.quantity) {
    const current = collection.readiness.items.find(value=>value.slug===slug)?.unitPrice;
    paid = Number.isFinite(current) && (!item.purchasedQuantity || item.paidTotal !== null) ? Math.round(((item.paidTotal || 0) + current * (item.quantity - item.purchasedQuantity)) * 100) / 100 : null;
  }
  $('collectionItemPaid').value=paid ?? '';
  $('collectionItemTarget').value=product.watchRule?.targetPrice ?? '';
  $(purchase ? 'collectionItemPaid' : 'collectionItemQuantity').focus();
}

function closeCollectionItem() {
  if (app.collectionBusy) return;
  const draft=app.collectionItemDraft;
  app.collectionItemDraft=null;
  if (!draft) { closeCollectionManager(); return; }
  openCollectionDetails(draft.collectionId);
  ($('collectionDetails').querySelector(`[${draft.action}="${CSS.escape(draft.slug)}"]`) || $('closeCollectionManager')).focus();
}

async function mutateCollectionItem(method, id, slug, body) {
  if (app.collectionBusy) return null;
  if (app.collectionRegion !== app.currentRegion) { toast('The store region changed. Reopen the collection.','error'); return null; }
  app.collectionBusy=true;
  $('collectionResult').textContent=method==='DELETE' ? 'Removing item…' : 'Saving item…';
  $('collectionResult').classList.remove('error');
  const controls=[...$('collectionDialog').querySelectorAll('button,input,select')].map(control=>[control,control.disabled]);
  controls.forEach(([control])=>control.disabled=true);
  try {
    await requireWatchWorkflow();
    const result=await api(`/api/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(slug)}`,{method,...(body ? {body:JSON.stringify(body)} : {})});
    const collection=result.collections?.find(item=>item.id===id);
    const saved=collection?.items?.find(item=>item.slug===slug);
    if (!collection || (method==='DELETE' ? collection.slugs.includes(slug) : !saved || ['quantity','purchasedQuantity','paidTotal'].some(key=>saved[key]!==body[key]) || (body.targetPrice !== undefined && result.product?.watchRule?.targetPrice!==body.targetPrice))) throw new Error('The server did not confirm your item changes. Your edits are still here.');
    app.collections=result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview || app.watchOverview;
    const product=app.products.find(item=>item.slug===slug);
    if (product && result.product) Object.assign(product,result.product);
    for (const product of app.products) product.collections=app.collections.filter(item=>item.slugs.includes(product.slug)).map(item=>item.id);
    renderCollections(); renderProducts(true);
    $('collectionResult').textContent='';
    return result;
  } catch (err) { $('collectionResult').textContent=err.message; $('collectionResult').classList.add('error'); return null; }
  finally { app.collectionBusy=false; controls.forEach(([control,disabled])=>control.disabled=disabled); }
}

async function saveCollectionItem() {
  const draft=app.collectionItemDraft;
  if (!draft) return;
  const body={quantity:Number($('collectionItemQuantity').value),purchasedQuantity:Number($('collectionItemPurchased').value),paidTotal:$('collectionItemPaid').value==='' ? null : Number($('collectionItemPaid').value),targetPrice:$('collectionItemTarget').value==='' ? null : Number($('collectionItemTarget').value)};
  const result=await mutateCollectionItem('PUT',draft.collectionId,draft.slug,body);
  if (result) { closeCollectionItem(); toast('Collection item saved.'); }
}

async function removeCollectionItem(slug) {
  const id=app.collectionDetailId;
  if (!id) return;
  const result=await mutateCollectionItem('DELETE',id,slug);
  if (result) {
    if (result.removedItem) app.collectionUndos.push({key:crypto.randomUUID(),id,slug,region:app.currentRegion,plan:result.removedItem,name:app.products.find(item=>item.slug===slug)?.name || slug});
    renderCollectionUndos();
    app.collectionDetailsKey=null; renderCollectionDetails();
    ($('collectionDetails').querySelector('[data-collection-item-edit]') || $('collectionDetails').querySelector('[data-edit-collection]')).focus();
    toast('Item removed from this collection. Its watch and other collections are kept.');
  }
}

function openCollectionAlerts(id) {
  if (app.collectionBusy || !app.collections.some((collection) => collection.id === id)) return;
  const wasClosed = $('collectionDialog').classList.contains('hidden');
  const view = wasClosed ? null : !$('collectionForm').classList.contains('hidden') ? 'edit' : !$('collectionDetails').classList.contains('hidden') ? 'details' : 'list';
  if (wasClosed) openCollectionManager();
  app.collectionAlertReturn = { view, id };
  collectionView('alerts');
  app.collectionAlertId = id;
  app.collectionAlertsKey = null;
  renderCollectionAlerts();
  $('collectionAlerts').querySelector('[data-notify-collection]')?.focus();
}

function returnFromCollectionAlerts() {
  const destination = app.collectionAlertReturn;
  if (!destination?.view) { closeCollectionManager(); return; }
  if (destination.view === 'edit' && app.collectionDraft?.id === destination.id) {
    collectionView('edit');
    $('collectionDialogTitle').textContent = 'Edit collection';
    $('collectionDialogDescription').textContent = 'Keep the gear for your next project together.';
    $('editCollectionAlerts').focus();
  } else if (destination.view === 'details') {
    openCollectionDetails(destination.id);
    $('collectionDetails').querySelector('[data-collection-alerts]')?.focus();
  } else {
    showCollectionOverview();
    $('collectionList').querySelector(`[data-collection-alerts="${CSS.escape(destination.id)}"]`)?.focus();
  }
  app.collectionAlertReturn = null;
}

function renderCollectionAlerts() {
  const collection = app.collections.find((item) => item.id === app.collectionAlertId);
  if (!collection || $('collectionAlerts').classList.contains('hidden') || $('collectionDialog').classList.contains('hidden')) return;
  const deliveryForm = $('collectionAlerts').querySelector('[data-collection-delivery]');
  const deliveryDraft = deliveryForm?.dataset.collectionDelivery === collection.id ? readAlertDelivery(deliveryForm) : null;
  const returnView = app.collectionAlertReturn?.view;
  const budgetStatus = $('collectionAlerts').querySelector('[data-collection-budget-status]');
  if (budgetStatus) budgetStatus.textContent = collection.budgetRequired ? collection.readiness?.budget?.reason || 'Waiting for confirmed costs.' : '';
  const key = JSON.stringify([collection.id,collection.name,collection.notifyReady,collection.alertsOnly,collection.archived,collection.budgetRequired,collection.budget,collection.channels,collection.maxAlertAgeMinutes,returnView]);
  if (app.collectionNotificationBusy === collection.id) return;
  if (key === app.collectionAlertsKey) return;
  app.collectionAlertsKey = key;
  const focused = document.activeElement;
  const focusAlert = focused?.matches('[data-notify-collection]');
  const focusBack = focused?.hasAttribute('data-close-collection-alerts');
  const focusMode = focused?.hasAttribute('data-collection-alert-mode');
  const focusBudget = focused?.hasAttribute('data-collection-budget');
  $('collectionDialogTitle').textContent = collection.name;
  $('collectionDialogDescription').textContent = 'Collection alert settings';
  $('collectionAlerts').innerHTML = `<section class="collection-alert-settings" aria-labelledby="collectionAlertHeading">
    <h3 id="collectionAlertHeading">Collection alerts</h3>${collection.archived ? '<p><strong>This collection is archived.</strong> Its alerts and item-alert override are inactive. Restore it to use the saved settings.</p>' : ''}
    <label class="readiness-alert"><input type="checkbox" data-notify-collection="${escapeHtml(collection.id)}" aria-describedby="collectionAlertConditions collectionAlertInteraction collectionAlertDelivery" ${collection.notifyReady ? 'checked' : ''}/> Notify when all remaining items qualify<span class="sr-only"> in ${escapeHtml(collection.name)}</span></label>
    <p id="collectionAlertConditions">Receive one alert when every unpurchased item is in stock and meets its individual target price, if set.</p>
    <label class="readiness-alert"><input type="checkbox" data-collection-budget="${escapeHtml(collection.id)}" aria-describedby="collectionBudgetCondition" ${collection.budgetRequired ? 'checked' : ''}/> Only notify when this collection is within budget</label>
    <p id="collectionBudgetCondition">${collection.budget == null ? 'Set a project budget in Edit collection. Until then, this condition cannot qualify.' : `Project budget: ${escapeHtml(insightMoney(collection.budget,collection.pricing.currency))}.`} Includes recorded spending and the confirmed cost of remaining units. Missing or unconfirmed costs block this alert. For Any variant, uses the lowest-priced available variant meeting its target. Shipping and additional checkout costs are excluded.</p>
    <p data-collection-budget-status role="status">${collection.budgetRequired ? escapeHtml(collection.readiness?.budget?.reason || 'Waiting for confirmed costs.') : ''}</p>
    <form data-collection-delivery="${escapeHtml(collection.id)}">${alertDeliveryFields(deliveryDraft || collection)}<button type="submit" class="primary">Save delivery options</button><p data-delivery-result role="status"></p></form>
    <label class="field"><span>Individual item alerts</span><select data-collection-alert-mode="${escapeHtml(collection.id)}" aria-describedby="collectionAlertInteraction"><option value="both" ${!collection.alertsOnly ? 'selected' : ''}>Collection and item alerts</option><option value="only" ${collection.alertsOnly ? 'selected' : ''}>Collection alerts only</option></select></label>
    <p id="collectionAlertInteraction">${!collection.archived && collection.notifyReady && collection.alertsOnly ? 'Individual item alerts are suppressed while this collection alert is enabled. Their rules stay saved.' : 'Individual item alerts continue using their own rules unless another collection suppresses them.'} If any collection containing an item uses Collection alerts only with alerts enabled, it suppresses that item's notifications, including All activity and immediate restocks. Turning off the last override restores item alerts. Pausing an item does not pause collection alerts.</p>
    <p id="collectionAlertDelivery">Readiness and item-alert switches save automatically. Use Save delivery options for channels and expiry. Scheduling follows Settings &gt; Notifications. If the collection already qualifies, enabling this waits until it stops qualifying and becomes ready again.</p>
    ${returnView === 'edit' ? '<p>Your name and item selections stay in the editor. Alerts apply to saved items; choose Save changes after returning to apply your collection edits.</p>' : ''}
    </section><div class="collection-form-actions"><button type="button" data-close-collection-alerts>${returnView === 'edit' ? 'Back to editing' : returnView === 'details' ? 'Back to collection' : returnView === 'list' ? 'Back to collections' : 'Done'}</button></div>`;
  if (app.collectionNotificationBusy) $('collectionAlerts').querySelectorAll('input,select').forEach(control=>control.disabled=true);
  if (focusAlert) $('collectionAlerts').querySelector('[data-notify-collection]')?.focus();
  if (focusBack) $('collectionAlerts').querySelector('[data-close-collection-alerts]')?.focus();
  if (focusMode) $('collectionAlerts').querySelector('[data-collection-alert-mode]')?.focus();
  if (focusBudget) $('collectionAlerts').querySelector('[data-collection-budget]')?.focus();
}

function renderCollectionReadiness(force = false) {
  const selected = $('watchCollection').value;
  let collections = app.collections.filter((collection) => selected === 'all' ? !collection.archived : collection.id === selected);
  if (['ready','target'].includes(app.watchQuickFilter)) collections=[];
  if (app.watchQuickFilter==='collections') collections=collections.filter(item=>app.watchOverview?.collectionsReady.includes(item.id));
  if ($('groupCollectedWatches').checked && selected === 'all') {
    const query = $('watchSearch').value.trim().toLowerCase();
    const memberFilters = $('watchStatus').value !== 'all' || $('watchCategory').value !== 'all';
    if (query || memberFilters) {
      const matching = new Set(filteredWatchlist({ includeCollected:true, ignoreQuick:app.watchQuickFilter==='collections' }).map((product) => product.slug));
      collections = collections.filter((collection) => (!memberFilters && collection.name.toLowerCase().includes(query)) || collection.slugs.some((slug) => matching.has(slug)));
    }
  }
  renderCollectionDetails();
  renderCollectionAlerts();
  const key = JSON.stringify(collections.map(({ readiness, ...collection }) => ({ ...collection, readiness:{ ...readiness, checkedAt:null }, previews:collection.slugs.slice(0,4).map((slug) => { const product = app.products.find((item) => item.slug === slug); return [product?.imageUrl,product?.name]; }) })));
  if (!force && key === app.readinessRenderKey) return;
  app.readinessRenderKey = key;
  const focused = document.activeElement;
  const attribute = ['data-collection-detail','data-collection-alerts','data-edit-collection','data-view-collection'].find((name) => focused?.hasAttribute(name));
  const focusId = attribute && focused.closest('#collectionReadiness') ? focused.getAttribute(attribute) : null;
  const focusSelector = focused?.classList.contains('collection-preview') ? '.collection-preview' : focused?.classList.contains('product-name-button') ? '.product-name-button' : '.card-actions button';
  reconcileList($('collectionReadiness'), collections, 'data-collection-card', collectionCard);
  wireProductImages($('collectionReadiness'));
  if (focusId) ($('collectionReadiness').querySelector(`${focusSelector}[${attribute}="${CSS.escape(focusId)}"]`) || $('watchCollection')).focus();
}

async function requireCollectionPlanning() {
  const server = await api('/api/collections');
  if (!server.capabilities?.purchasePlanning) throw new Error('Update and restart GearBeacon to use purchase plans and collection-only alerts. Your changes have not been saved.');
}

async function setCollectionNotification(input) {
  if (app.collectionNotificationBusy) return;
  const id = input.dataset.notifyCollection || input.dataset.collectionAlertMode || input.dataset.collectionBudget;
  const region = app.currentRegion;
  const selector = input.hasAttribute('data-notify-collection') ? '[data-notify-collection]' : input.hasAttribute('data-collection-budget') ? '[data-collection-budget]' : '[data-collection-alert-mode]';
  const enabled = $('collectionAlerts').querySelector('[data-notify-collection]').checked;
  const alertsOnly = $('collectionAlerts').querySelector('[data-collection-alert-mode]').value === 'only';
  const budgetRequired = $('collectionAlerts').querySelector('[data-collection-budget]').checked;
  const controls = [...$('collectionAlerts').querySelectorAll('input,select')];
  controls.forEach(control=>control.disabled=true);
  app.collectionNotificationBusy = id;
  try {
    const server = await api('/api/collections');
    if (!server.capabilities?.budgetAlerts) throw new Error('Update and restart GearBeacon before saving these collection alert settings.');
    if (app.currentRegion !== region) return;
    const result = await api(`/api/collections/${encodeURIComponent(id)}`, { method:'PUT', body:JSON.stringify({ notifyReady:enabled, alertsOnly, budgetRequired }) });
    const saved = result.collections?.find(item=>item.id===id);
    if (!saved || saved.notifyReady !== enabled || saved.alertsOnly !== alertsOnly || saved.budgetRequired !== budgetRequired) throw new Error('The server did not confirm the collection alert settings. Restart after updating and try again.');
    if (app.currentRegion !== region) return;
    app.collections = result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview || app.watchOverview; renderProducts(true);
    toast(saved.archived ? 'Settings saved. This collection is archived, so its alerts and override stay inactive.' : !enabled ? 'Collection alerts disabled. Item rules apply unless another collection suppresses them.' : alertsOnly ? 'Collection-only alerts enabled. Individual item rules are preserved.' : 'Collection and item alerts enabled.');
  } catch (err) {
    toast(err.message,'error');
  } finally {
    app.collectionNotificationBusy = false;
    controls.forEach(control=>control.disabled=false);
    if (app.collectionAlertId) { app.collectionAlertsKey=null; renderCollectionAlerts(); }
    if (app.collectionAlertId === id && !$('collectionDialog').classList.contains('hidden')) $('collectionAlerts').querySelector(selector)?.focus();
  }
}

async function saveCollectionDelivery(form) {
  if (app.collectionNotificationBusy) return;
  const id = form.dataset.collectionDelivery, region = app.currentRegion;
  const policy = readAlertDelivery(form);
  const resultBox = form.querySelector('[data-delivery-result]');
  const controls = [...$('collectionAlerts').querySelectorAll('input,select,button')];
  app.collectionNotificationBusy = id; controls.forEach(control=>control.disabled=true);
  try {
    const server = await api('/api/collections');
    if (!server.capabilities?.alertDelivery) throw new Error('Update and restart GearBeacon before saving delivery options.');
    if (app.currentRegion !== region) return;
    const result = await api(`/api/collections/${encodeURIComponent(id)}`, { method:'PUT', body:JSON.stringify(policy) });
    const saved = result.collections?.find(item=>item.id===id);
    if (!saved || JSON.stringify(saved.channels) !== JSON.stringify(policy.channels) || saved.maxAlertAgeMinutes !== policy.maxAlertAgeMinutes) throw new Error('The server did not confirm the delivery options.');
    if (app.currentRegion !== region) return;
    app.collections=result.collections; updateWatchAlertSummaries(result); app.watchOverview=result.overview || app.watchOverview;
    app.collectionAlertsKey=null; app.collectionNotificationBusy=false; renderProducts(true); renderCollectionAlerts(); toast('Collection delivery options saved');
    if (app.collectionAlertId === id) $('collectionAlerts').querySelector('[data-collection-delivery] button[type="submit"]')?.focus();
  } catch (err) { resultBox.textContent=err.message; }
  finally {
    app.collectionNotificationBusy=false; controls.forEach(control=>control.disabled=false);
    form.querySelectorAll('[name="deliveryChannel"]').forEach(control=>control.disabled=form.querySelector('[name="deliveryMode"]').value==='defaults');
    if (app.collectionAlertId !== id || app.currentRegion !== region) { app.collectionAlertsKey=null; renderCollectionAlerts(); }
  }
}

document.addEventListener('change', event => {
  const mode = event.target.closest('[data-delivery-mode]');
  if (!mode) return;
  const choices = mode.closest('fieldset').querySelector('[data-delivery-choices]');
  choices.classList.toggle('hidden', mode.value === 'defaults');
  choices.querySelectorAll('input').forEach(input=>input.disabled=mode.value==='defaults');
});
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-collection-delivery]');
  if (!form) return;
  event.preventDefault(); saveCollectionDelivery(form);
});

async function openCollection(id, region) {
  if (region && region !== app.currentRegion) {
    app.currentRegion = region; localStorage.setItem('gearbeacon.region', region); await refresh();
  }
  if (!app.collections.some((collection) => collection.id === id)) { toast('This collection is no longer available.', 'error'); return; }
  closeActivityDialog(); activateTab('watchlist'); resetWatchFilters();
  app.pendingWatchCollection=id; renderProducts(true); persistUiState(); $('watchCollection').focus();
}

async function markPurchased(slug) {
  const product = app.products.find((item) => item.slug === slug);
  if (!product) return;
  const action = product.watchRule?.purchasedAt ? 'wanted' : 'purchased';
  try {
    const result = await api('/api/watch/bulk', { method:'POST', body:JSON.stringify({ action, slugs:[slug] }) });
    Object.assign(product, result.products[0]);
    const collections = await api('/api/collections'); app.collections = collections.collections; updateWatchAlertSummaries(collections); app.watchOverview=collections.overview || app.watchOverview;
    renderProducts(true);
    if (app.currentProductDetails?.product.slug === slug) {
      await openProductDialog(slug, true);
      document.querySelector('#productDialogBody [data-purchased]')?.focus();
    } else (document.querySelector(`#watchGrid [data-purchased="${CSS.escape(slug)}"]`) || $('watchStatus')).focus();
    toast(action === 'purchased' ? 'Marked purchased. Alerts stopped; history retained.' : 'Marked as still wanted. Saved alert rules apply.');
  } catch (err) { toast(err.message, 'error'); }
}

async function bulkWatchAction(action) {
  const slugs = [...app.selectedWatch];
  if (!slugs.length) return;
  if (action === 'remove' && !window.confirm(`Remove ${slugs.length} selected product${slugs.length === 1 ? '' : 's'} from the watchlist?`)) return;
  const buttons = [...$('bulkActions').querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api('/api/watch/bulk', { method:'POST', body:JSON.stringify({ action, slugs, minutes:Number($('bulkPauseDuration').value) }) });
    if (action === 'remove') for (const product of app.products.filter((item) => slugs.includes(item.slug))) { product.watched = false; product.watchRule = null; }
    else for (const changed of result.products || []) { const product = app.products.find((item) => item.slug === changed.slug); if (product) Object.assign(product, changed); }
    const workspace=await api('/api/collections'); app.collections=workspace.collections; updateWatchAlertSummaries(workspace); app.watchOverview=workspace.overview;
    app.selectedWatch.clear(); renderProducts(true); toast(`${result.affected} product${result.affected === 1 ? '' : 's'} ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'removed'}`);
  } catch (err) { toast(err.message, 'error'); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

document.addEventListener('click', (event) => {
  const purchased = event.target.closest('[data-purchased]');
  if (purchased) { markPurchased(purchased.dataset.purchased); return; }
  const preview = event.target.closest('[data-preview-rule]');
  if (preview) { previewProductRule(preview.closest('form')); return; }
  const itemEdit=event.target.closest('[data-collection-item-edit]');
  if (itemEdit) { openCollectionItem(itemEdit.dataset.collectionItemEdit); return; }
  const purchaseItem=event.target.closest('[data-collection-item-purchase]');
  if (purchaseItem) { openCollectionItem(purchaseItem.dataset.collectionItemPurchase,true); return; }
  const removeItem=event.target.closest('[data-collection-item-remove]');
  if (removeItem) { removeCollectionItem(removeItem.dataset.collectionItemRemove); return; }
  const edit = event.target.closest('[data-edit-collection]');
  if (edit) { if ($('collectionDialog').classList.contains('hidden')) openCollectionManager(); editCollection(edit.dataset.editCollection); return; }
  if (event.target.closest('[data-close-collection-alerts]')) { returnFromCollectionAlerts(); return; }
  const collectionAlerts = event.target.closest('[data-collection-alerts]');
  if (collectionAlerts) { openCollectionAlerts(collectionAlerts.dataset.collectionAlerts); return; }
  const collectionDetail = event.target.closest('[data-collection-detail]');
  if (collectionDetail && !event.target.closest('[data-image-retry]')) { openCollectionDetails(collectionDetail.dataset.collectionDetail); return; }
  const viewCollection = event.target.closest('[data-view-collection]');
  if (viewCollection) { closeCollectionManager(); openCollection(viewCollection.dataset.viewCollection, app.currentRegion); return; }
  const collectionImage = event.target.closest('[data-collection-image]');
  if (collectionImage) {
    const products = collectionImage.closest('#collectionDetails, #collectionItemSummary') ? app.products : (app.addWatchDraft?.products || app.collectionDraft?.products);
    const product = products?.find((item) => item.slug === collectionImage.dataset.collectionImage);
    if (product?.imageUrl) { app.brokenImages.delete(product.imageUrl); collectionImage.innerHTML = imageMarkup(product); wireProductImages(collectionImage); }
    return;
  }
  const copy = event.target.closest('[data-copy-text]');
  if (copy) { event.preventDefault(); copyText(copy.dataset.copyText, copy.dataset.copyLabel || 'Text'); return; }
  const imageRetry = event.target.closest('[data-image-retry]');
  if (imageRetry) {
    event.preventDefault(); event.stopPropagation();
    app.brokenImages.delete(imageRetry.dataset.imageRetry);
    const card = imageRetry.closest('[data-product-card],[data-collection-card]');
    if (card) renderedRows.delete(card);
    if (app.currentProductDetails?.product?.imageUrl === imageRetry.dataset.imageRetry) renderProductDialog(app.currentProductDetails);
    else if (imageRetry.closest('#collectionReadiness')) { renderCollectionReadiness(true); }
    else renderProducts(true);
    return;
  }
  const addWatch=event.target.closest('[data-add-watch]');
  if (addWatch) { openAddWatch(addWatch.dataset.addWatch); return; }
  const quickWatch=event.target.closest('[data-watch-overview]');
  if (quickWatch) { filterWatchOverview(quickWatch.dataset.watchOverview); return; }
  const archive=event.target.closest('[data-archive-collection]');
  if (archive) { archiveCollection(archive.dataset.archiveCollection); return; }
  const undo=event.target.closest('[data-undo-collection]');
  if (undo) { undoCollectionRemoval(undo.dataset.undoCollection); return; }
  const dismissUndo=event.target.closest('[data-dismiss-collection-undo]');
  if (dismissUndo) { app.collectionUndos=app.collectionUndos.filter(item=>item.key!==dismissUndo.dataset.dismissCollectionUndo); renderCollectionUndos(); $('closeCollectionManager').focus(); return; }
  const watch = event.target.closest('[data-watch]');
  if (watch) { event.preventDefault(); toggleWatch(watch.dataset.watch); return; }
  const activityEvent = event.target.closest('[data-activity-event]');
  if (activityEvent) { event.preventDefault(); openActivityDialog(activityEvent.dataset.activityEvent); return; }
  const activityProduct = event.target.closest('[data-activity-product]');
  if (activityProduct) { event.preventDefault(); openActivityProduct(activityProduct.dataset.activityProduct, activityProduct.dataset.activityRegion); return; }
  const activityCollection = event.target.closest('[data-activity-collection]');
  if (activityCollection) { event.preventDefault(); openCollection(activityCollection.dataset.activityCollection, activityCollection.dataset.activityRegion); return; }
  const category = event.target.closest('[data-category]');
  if (category) { selectBrowseCategory(category.dataset.category); return; }
  const details = event.target.closest('[data-product-detail]');
  if (details) { event.preventDefault(); openProductDialog(details.dataset.productDetail); return; }
  const go = event.target.closest('[data-goto]');
  if (go) activateTab(go.dataset.goto);
  const setting = event.target.closest('[data-settings-link]');
  if (setting) { activateTab('settings'); activateSettingsTab(setting.dataset.settingsLink); }
  const revoke = event.target.closest('[data-revoke-session]');
  if (revoke) revokeSession(revoke.dataset.revokeSession);
  const test = event.target.closest('[data-test-channel]');
  if (test) testChannel(test.dataset.testChannel, test);
  const retry = event.target.closest('[data-retry-failed]');
  if (retry) api('/api/notifications/retry-failed', { method:'POST' }).then((result) => { toast(`${result.queued} failed deliveries queued`); refreshOperations(); }).catch((err) => toast(err.message, 'error'));
});
document.addEventListener('change', (event) => {
  const days = event.target.closest('[data-insight-days]');
  if (days) { changeInsightWindow(Number(days.value)); return; }
  const notification = event.target.closest('[data-notify-collection], [data-collection-alert-mode], [data-collection-budget]');
  if (notification) { setCollectionNotification(notification); return; }
  const variant = event.target.closest('[data-variant-selector]');
  if (variant) { openProductDialog(variant.value, true).then(() => document.querySelector('[data-variant-selector]')?.focus()); return; }
  const selection = event.target.closest('[data-watch-select]');
  if (!selection) return;
  if (selection.checked) app.selectedWatch.add(selection.dataset.watchSelect); else app.selectedWatch.delete(selection.dataset.watchSelect);
  renderBulkActions();
});
document.addEventListener('submit', (event) => {
  const form = event.target.closest('#productRuleForm');
  if (!form) return;
  event.preventDefault(); saveProductRule(form);
});

function activateTab(tab) {
  if (tab === 'operations') {
    activateTab('settings');
    activateSettingsTab('operations');
    return;
  }
  if (!APP_TABS.includes(tab)) tab = 'watchlist';
  app.activeTab = tab;
  document.documentElement.classList.toggle('activity-active', tab === 'activity');
  if (tab === 'settings') {
    refreshDataInfo(); refreshNotificationPreferences(); refreshSessions(); refreshConfiguration();
    if (app.activeSettingsTab === 'operations') refreshOperations();
  }
  if (tab === 'activity') refreshActivity(app.activity.page || 1);
  history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.page').forEach((panel) => {
    const active = panel.id === tab;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (app.status && ['watchlist','browse'].includes(tab)) renderProducts();
  persistUiState();
}
function activateSettingsTab(tab, focus = false) {
  const selected = SETTINGS_TABS.includes(tab) ? tab : 'general';
  app.activeSettingsTab = selected;
  localStorage.setItem(SETTINGS_TAB_KEY, selected);
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    const active = panel.dataset.settingsPanel === selected;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (selected === 'operations') refreshOperations();
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = APP_TABS.indexOf(tab.dataset.tab);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? APP_TABS.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + APP_TABS.length) % APP_TABS.length;
    activateTab(APP_TABS[next]);
    document.querySelector(`.tab[data-tab="${APP_TABS[next]}"]`)?.focus();
  });
});
document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
  tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = SETTINGS_TABS.indexOf(tab.dataset.settingsTab);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? SETTINGS_TABS.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    activateSettingsTab(SETTINGS_TABS[next], true);
  });
});
$('themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
// Secondary controls remain in the page flow. Tab can leave, Escape closes,
// and dialog actions return focus to their visible toggle.
document.addEventListener('click', event => {
  const toggle = event.target.closest('[data-toolbar-toggle]');
  if (toggle) {
    toggle.focus({preventScroll:true});
    const panel = document.getElementById(toggle.dataset.toolbarToggle); const opening = panel.classList.contains('hidden');
    closeToolbarPanels(); panel.classList.toggle('hidden',!opening); toggle.setAttribute('aria-expanded',String(opening)); return;
  }
  const panel = event.target.closest('[data-toolbar-panel]');
  closeToolbarPanels(panel);
  if (panel && event.target.closest('button')) { closeToolbarPanels(); toolbarToggle(panel).focus({preventScroll:true}); }
}, true);
document.addEventListener('focusin', event => { const toggle=event.target.closest('[data-toolbar-toggle]'); closeToolbarPanels(toggle ? document.getElementById(toggle.dataset.toolbarToggle) : event.target.closest('[data-toolbar-panel]')); });
$('watchLayout').addEventListener('change', () => { persistUiState(); renderProducts(true); });
$('watchSavedView').addEventListener('change', event => applySavedView(event.target.value));
$('browseSavedView').addEventListener('change', event => applySavedView(event.target.value));
$('closeOwnerDialog').addEventListener('click', () => $('ownerDialog').close());
$('ownerDialog').addEventListener('close', () => { if ($('ownerDialog').open) return; app.viewDraft = null; app.alertExplanationRequest = null; if (app.ownerDialogFocus?.isConnected && !app.ownerDialogFocus.closest('[inert]')) app.ownerDialogFocus.focus({preventScroll:true}); else (document.querySelector('[role="dialog"]:not(.hidden) button') || $('tabWatchlist')).focus({preventScroll:true}); });
$('ownerDialog').addEventListener('submit', event => { if (event.target.id === 'savedViewForm') { event.preventDefault(); saveOwnerView(event.target); } });
document.addEventListener('click', event => {
  const save = event.target.closest('[data-save-view]'); if (save) showViewEditor(save.dataset.saveView);
  const manage = event.target.closest('[data-manage-views]'); if (manage) showViewManager(manage.dataset.manageViews);
  const edit = event.target.closest('[data-view-edit]'); if (edit) { const view = app.savedViews.find(view => view.id === edit.dataset.viewEdit); if (view) showViewEditor(view.scope, view.id); }
  const remove = event.target.closest('[data-view-delete]'); if (remove) deleteOwnerView(remove.dataset.viewDelete, Number(remove.dataset.viewRevision));
  if (event.target.closest('[data-owner-close]')) $('ownerDialog').close();
  const explanation = event.target.closest('[data-alert-explain]');
  if (explanation) showAlertExplanation(explanation.dataset.alertExplain, explanation.dataset.alertId);
});
$('toTop').addEventListener('click', scrollToTop);
window.addEventListener('scroll', updateToTopVisibility, { passive:true });
window.addEventListener('resize', updateToTopVisibility);
let browseSearchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(browseSearchTimer); browseSearchTimer = setTimeout(() => { app.browseVisibleCount = 48; persistUiState(); renderProducts(true); }, 180); });
$('browseFilters').addEventListener('submit', (event) => event.preventDefault());
for (const id of ['browseFilters','browseSort']) $(id).addEventListener('change', () => { app.browseVisibleCount = 48; persistUiState(); renderProducts(true); });
$('categoryTabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...$('categoryTabs').querySelectorAll('[data-category]')];
  const index = tabs.indexOf(event.target.closest('[data-category]'));
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectBrowseCategory(tabs[next].dataset.category);
});
const browseMobileLayout = window.matchMedia('(max-width: 820px)');
function adaptBrowseFilters() {
  if (browseMobileLayout.matches && $('browseFilterPanel').contains(document.activeElement)) $('browseFilterPanel').querySelector('summary').focus({ preventScroll:true });
  $('browseFilterPanel').open = !browseMobileLayout.matches;
}
browseMobileLayout.addEventListener('change', adaptBrowseFilters);
adaptBrowseFilters();
for (const id of ['watchSearch','watchStatus','watchCategory','watchSort','watchCollection']) $(id).addEventListener(id === 'watchSearch' ? 'input' : 'change', () => { persistUiState(); renderProducts(true); });
$('groupCollectedWatches').addEventListener('change', () => { persistUiState(); renderProducts(true); });
$('openCollectionManager').addEventListener('click', () => openCollectionManager());
$('closeCollectionManager').addEventListener('click', dismissCollectionManager);
$('collectionBackdrop').addEventListener('click', dismissCollectionManager);
for (const id of ['newCollection','firstCollection','newBulkCollection']) $(id).addEventListener('click', () => editCollection());
$('collectionForm').addEventListener('submit', (event) => { event.preventDefault(); saveCollection(); });
$('cancelCollectionEdit').addEventListener('click', () => showCollectionOverview(app.collectionDraft?.id));
$('collectionWatchSearch').addEventListener('input', renderCollectionChoices);
$('collectionArchiveFilter').addEventListener('change',()=>renderCollections(true));
$('archiveCollection').addEventListener('click',()=>archiveCollection(app.collectionDraft?.id));
$('addWatchForm').addEventListener('submit',event=>{event.preventDefault();saveAddedWatch();});
$('cancelAddWatch').addEventListener('click',closeCollectionManager);
for (const id of ['addWatchVariant','addWatchDestination']) $(id).addEventListener('change',renderAddWatch);
$('collectionItemForm').addEventListener('submit', (event) => { event.preventDefault(); saveCollectionItem(); });
$('cancelCollectionItem').addEventListener('click', closeCollectionItem);
$('editCollectionAlerts').addEventListener('click', () => openCollectionAlerts(app.collectionDraft?.id));
$('collectionWatchChoices').addEventListener('change', (event) => {
  const input = event.target.closest('[data-collection-watch]');
  if (!input || !app.collectionDraft) return;
  if (input.checked) app.collectionDraft.slugs.add(input.dataset.collectionWatch);
  else app.collectionDraft.slugs.delete(input.dataset.collectionWatch);
  $('collectionSelection').textContent = `${app.collectionDraft.slugs.size} selected`;
});
$('bulkAddCollection').addEventListener('click', () => openCollectionManager(true));
$('collectionBulkForm').addEventListener('submit', (event) => { event.preventDefault(); addSelectedToCollection(); });
$('cancelCollectionBulk').addEventListener('click', closeCollectionManager);
$('askDeleteCollection').addEventListener('click', confirmCollectionDeletion);
$('cancelDeleteCollection').addEventListener('click', () => { collectionView('edit'); $('collectionDialogTitle').textContent = 'Edit collection'; $('askDeleteCollection').focus(); });
$('confirmDeleteCollection').addEventListener('click', deleteCollection);
$('selectVisibleWatches').addEventListener('click', () => { app.selectedWatch = new Set(filteredWatchlist().map((product) => product.slug)); renderProducts(true); });
$('resetWatchFilters').addEventListener('click', resetWatchFilters);
$('resetWatchEmpty').addEventListener('click', resetWatchFilters);
$('resetBrowseFilters').addEventListener('click', resetBrowseFilters);
$('resetBrowseEmpty').addEventListener('click', resetBrowseFilters);
$('browseLoadMore').addEventListener('click', () => { app.browseVisibleCount += 48; renderProducts(true); });
$('bulkPause').addEventListener('click', () => bulkWatchAction('pause'));
$('bulkResume').addEventListener('click', () => bulkWatchAction('resume'));
$('bulkRemove').addEventListener('click', () => bulkWatchAction('remove'));
$('bulkClear').addEventListener('click', () => { app.selectedWatch.clear(); renderProducts(true); });
$('openWatchImport').addEventListener('click', openWatchImport);
$('closeWatchImport').addEventListener('click', closeWatchImport);
$('watchImportBackdrop').addEventListener('click', closeWatchImport);
$('chooseWatchImportFile').addEventListener('click', () => $('watchImportFile').click());
$('watchImportFile').addEventListener('change', () => loadWatchImportFile($('watchImportFile').files?.[0]));
$('previewWatchImport').addEventListener('click', previewWatchImport);
$('clearWatchImport').addEventListener('click', () => { clearWatchImport(true); $('watchImportInput').focus(); });
$('confirmWatchImport').addEventListener('click', confirmWatchImport);
$('watchImportResults').addEventListener('change', updateWatchImportSelection);
$('watchImportInput').addEventListener('input', () => {
  $('watchImportInput').dataset.fileName = '';
  $('watchImportFileName').textContent = 'No file selected';
  app.watchImportPreview = null;
  $('watchImportPreview').classList.add('hidden');
  setWatchImportError();
});
$('closeProductDialog').addEventListener('click', closeProductDialog);
$('productDialogBackdrop').addEventListener('click', closeProductDialog);
$('closeActivityDialog').addEventListener('click', closeActivityDialog);
$('activityDialogBackdrop').addEventListener('click', closeActivityDialog);
document.addEventListener('keydown', (event) => {
  if ($('ownerDialog').open) return;
  if (event.key === 'Escape') {
    const panel = document.querySelector('[data-toolbar-panel]:not(.hidden)');
    if (panel) { event.preventDefault(); closeToolbarPanels(); toolbarToggle(panel).focus({preventScroll:true}); return; }
  }
  if (event.key === 'Tab') {
    const dialog = [$('setupWizard'), $('collectionDialog'), $('watchImportDialog'), $('activityDialog'), $('productDialog')].find((item) => item && !item.classList.contains('hidden'));
    if (dialog) {
      const focusable = [...dialog.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not(:disabled):not([tabindex="-1"]),select:not(:disabled):not([tabindex="-1"]),textarea:not(:disabled):not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])')].filter((item) => item.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0]; const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    return;
  }
  if (event.key !== 'Escape') return;
  if (!$('collectionDialog').classList.contains('hidden')) dismissCollectionManager();
  else if (!$('watchImportDialog').classList.contains('hidden')) closeWatchImport();
  else if (!$('activityDialog').classList.contains('hidden')) closeActivityDialog();
  else if (!$('productDialog').classList.contains('hidden')) closeProductDialog();
});
$('checkBtn').addEventListener('click', async () => {
  $('checkBtn').disabled = true;
  $('checkBtn').textContent = 'Checking…';
  try { await api('/api/check', { method:'POST' }); await refresh(); toast('Store check complete'); }
  catch (err) { toast(err.message, 'error'); }
  finally { $('checkBtn').disabled = false; $('checkBtn').textContent = 'Check now'; }
});
$('backupBtn').addEventListener('click', async () => {
  const button = $('backupBtn');
  button.disabled = true;
  try {
    await api('/api/data/backup', { method: 'POST' });
    await refreshDataInfo();
    toast('Safety backup created');
  } catch (err) { toast(err.message, 'error'); }
  finally { button.disabled = false; }
});
$('testPrimaryBackup').addEventListener('click', () => testLatestBackup('primary'));
$('testSecondaryBackup').addEventListener('click', () => testLatestBackup('secondary'));
$('exportBtn').addEventListener('click', () => exportData(true));
$('exportPlainBtn').addEventListener('click', () => exportData(false));
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => importDataFile($('importFile').files?.[0]));
$('updateBtn').addEventListener('click', checkUpdates);
$('prepareUpdateBtn').addEventListener('click', prepareUpdate);
$('saveNotificationPrefs').addEventListener('click', saveNotificationPreferences);
$('testNotificationBtn').addEventListener('click', testServerNotification);
$('appConfigForm').addEventListener('submit', saveAppConfiguration);
$('dataScheduleForm').addEventListener('submit', saveDataConfiguration);
$('notificationDeliveryForm').addEventListener('submit', saveDeliveryConfiguration);
$('previewDelivery').addEventListener('click', previewDelivery);
$('emailAppearanceForm').addEventListener('submit', saveEmailConfiguration);
$('previewEmail').addEventListener('click', previewEmail);
$('sendTestEmail').addEventListener('click', sendTestEmail);
$('emailPreviewViewport').addEventListener('change', () => $('emailPreviewCanvas').classList.toggle('mobile', $('emailPreviewViewport').value === 'mobile'));
$('channelConfigForm').addEventListener('submit', (event) => { event.preventDefault(); saveChannelConfiguration(); });
$('saveChannels').addEventListener('click', saveChannelConfiguration);
$('refreshOperations').addEventListener('click', refreshOperations);
$('runDiagnostics').addEventListener('click', runInstallationDiagnostics);
$('attentionAction').addEventListener('click', () => { activateTab('settings'); activateSettingsTab('operations'); });
$('activityFilters').addEventListener('submit', (event) => { event.preventDefault(); persistUiState(); refreshActivity(1); });
$('activityPageSize').addEventListener('change', () => { persistUiState(); refreshActivity(1); });
$('clearActivityFilters').addEventListener('click', resetActivityFilters);
$('resetActivityEmpty').addEventListener('click', resetActivityFilters);
$('activityPrevious').addEventListener('click', () => refreshActivity(Math.max(1, app.activity.page - 1)));
$('activityNext').addEventListener('click', () => refreshActivity(Math.min(app.activity.pages, app.activity.page + 1)));
$('exportActivityCsv').addEventListener('click', () => exportActivity('csv'));
$('exportActivityJson').addEventListener('click', () => exportActivity('json'));
$('applyLogFilter').addEventListener('click', refreshLogs);
$('downloadLogs').addEventListener('click', async () => {
  try {
    const params = new URLSearchParams({ limit:'1000', download:'1' });
    if ($('logLevel').value) params.set('level', $('logLevel').value);
    if ($('logSearch').value.trim()) params.set('search', $('logSearch').value.trim());
    const res = await fetch(`/api/logs?${params}`, { credentials:'same-origin' });
    await saveDownloadResponse(res, `GearBeacon-Logs-${new Date().toISOString().slice(0,10)}.json`);
  } catch (err) { toast(err.message, 'error'); }
});
$('downloadSupportBundle').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/operations/support-bundle', { credentials:'same-origin', cache:'no-store' });
    await saveDownloadResponse(res, `GearBeacon-Support-${new Date().toISOString().slice(0,10)}.json`);
    toast('Redacted support bundle downloaded');
  } catch (err) { toast(err.message, 'error'); }
});
$('wizardNext').addEventListener('click', wizardNext);
$('wizardBack').addEventListener('click', () => { app.wizardStep -= 1; renderWizardStep(); });
$('wizardStoreTest').addEventListener('click', async () => {
  const result = $('wizardTestResult');
  try { await api('/api/check', { method:'POST' }); result.innerHTML = '<strong>Store check passed.</strong> The configured UniFi Store responded successfully.'; }
  catch (err) { result.textContent = `Store test failed: ${err.message}`; }
});
$('wizardNotificationTest').addEventListener('click', async () => {
  const result = $('wizardTestResult');
  try { const response = await api('/api/notifications/test', { method:'POST' }); const channels = response.outcomes.filter((x) => x.ok).map((x) => x.channel).join(', '); result.innerHTML = `<strong>Notification test passed.</strong> Delivered through ${escapeHtml(channels)}.`; }
  catch (err) { result.textContent = `Notification test skipped or failed: ${err.message}`; }
});
$('passwordForm').addEventListener('submit', updateOwnerPassword);
$('authForm').addEventListener('submit', submitAuth);
$('logoutBtn').addEventListener('click', logout);
$('regionPicker').addEventListener('change', async () => {
  app.currentRegion = $('regionPicker').value;
  app.latestEventId = null;
  app.selectedWatch.clear(); app.browseVisibleCount = 48; app.watchRenderKey = ''; app.browseRenderKey = '';
  clearWatchImport(true);
  localStorage.setItem('gearbeacon.region', app.currentRegion);
  await refresh();
  toast(`Switched to ${$('regionPicker').selectedOptions[0].textContent}`);
});

$('notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('This browser does not support notifications.');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? 'Browser restock alerts enabled' : 'Browser alerts were not enabled');
  $('notifyBtn').textContent = permission === 'granted' ? 'Browser alerts enabled ✓' : 'Enable browser alerts';
});
if ('Notification' in window && Notification.permission === 'granted') $('notifyBtn').textContent = 'Browser alerts enabled ✓';

restoreUiControls();
const initialTab = location.hash.slice(1);
const initialOperationsTab = initialTab === 'operations';
activateTab(initialOperationsTab ? 'settings' : APP_TABS.includes(initialTab) ? initialTab : app.activeTab);
activateSettingsTab(initialOperationsTab ? 'operations' : app.activeSettingsTab);

window.addEventListener('offline', () => {
  app.browserOffline = true;
  setActivityLiveStatus('Browser offline · Updates will resume automatically');
  $('statusDot').className = 'dot bad'; $('statusTitle').textContent = 'Browser offline'; $('statusSub').textContent = 'Waiting for the network to return';
  renderAttentionBanner();
});
window.addEventListener('online', () => { app.reconnectPending = app.browserOffline; app.browserOffline = false; renderAttentionBanner(); refreshActivity(app.activity.page, { background:true }); refresh(); });

initialize().finally(updateToTopVisibility);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('appShell').classList.contains('hidden')) { refreshActivity(app.activity.page, { background:true }); refresh(); }
});
setInterval(() => refreshActivity(app.activity.page, { background:true }), 1000);
setInterval(() => {
  if (!document.hidden) updateProductFreshness();
  if (!$('appShell').classList.contains('hidden')) refresh({ background:true });
}, 10000);
