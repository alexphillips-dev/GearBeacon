const $ = (id) => document.getElementById(id);
const THEME_KEY = 'gearbeacon.theme';
const SETTINGS_TAB_KEY = 'gearbeacon.settingsTab';
const UI_STATE_KEY = 'gearbeacon.uiState.v1';
const SETTINGS_TABS = ['general', 'notifications', 'data', 'security', 'privacy'];
const APP_TABS = ['watchlist', 'browse', 'activity', 'operations', 'settings'];
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
  auth: null,
  currentRegion: initialDeepLink.get('region') || localStorage.getItem('gearbeacon.region') || null,
  pendingProductSlug: initialDeepLink.get('product') || null,
  status: null,
  products: [],
  events: [],
  activity: { events:[], count:0, page:1, pages:1, limit:50, loaded:false },
  dataInfo: null,
  config: null,
  operations: null,
  wizardStep: 1,
  notificationPreferences: { restock:true, soldOut:false, priceChange:false, statusChange:false, newProduct:false },
  activeTab: APP_TABS.includes(savedUiState.activeTab) ? savedUiState.activeTab : 'watchlist',
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
  setControlValue('watchSearch', savedUiState.watch?.search);
  setControlValue('watchStatus', savedUiState.watch?.status);
  setControlValue('watchSort', savedUiState.watch?.sort);
  setControlValue('activitySearch', savedUiState.activity?.search);
  setControlValue('activityType', savedUiState.activity?.type);
  setControlValue('activityDelivery', savedUiState.activity?.delivery);
  setControlValue('activityFrom', savedUiState.activity?.from);
  setControlValue('activityTo', savedUiState.activity?.to);
}
function persistUiState() {
  const state = {
    activeTab:app.activeTab,
    browse:{ search:$('search')?.value || '', category:app.browseCategory },
    watch:{ search:$('watchSearch')?.value || '', status:$('watchStatus')?.value || 'all', category:app.pendingWatchCategory || $('watchCategory')?.value || 'all', sort:$('watchSort')?.value || 'changed' },
    activity:{ search:$('activitySearch')?.value || '', scope:app.pendingActivityRegion || $('activityRegion')?.value || 'all', type:$('activityType')?.value || 'all', delivery:$('activityDelivery')?.value || 'all', from:$('activityFrom')?.value || '', to:$('activityTo')?.value || '' },
  };
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch {}
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
  if (event.type === 'restock') parts.push({ text:`${event.previousStatus ? previousStatus : 'Sold out'} → In stock`, className:'event-meta-transition' });
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
      parts.push({ text:`${Number(difference) < 0 ? '↓' : '↑'} ${activityMoney(event, Number(difference))}`, extra:Number.isFinite(Number(percent)) ? `(${Math.abs(Number(percent)).toFixed(1)}%)` : '', className:'event-meta-delta' });
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
  return data;
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
  else if (app.pendingProductSlug && app.products.some((product) => product.slug === app.pendingProductSlug)) {
    const slug = app.pendingProductSlug;
    app.pendingProductSlug = null;
    activateTab('browse');
    await openProductDialog(slug);
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
  if (p.inStock) return 'Available now';
  if (p.restockEtaAt) return `Store ETA ${new Date(p.restockEtaAt).toLocaleDateString()}`;
  if (p.comingSoon) return 'Coming soon';
  if (p.soldOutAt) return `Sold out ${relativeTime(p.soldOutAt)}`;
  return 'Waiting for restock';
}
function priceNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9,.-]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function watchPaused(p) {
  const until = p.watchRule?.pausedUntil;
  return p.watchRule?.enabled === false || until === 'indefinite' || Boolean(until && new Date(until).getTime() > Date.now());
}
function ruleSummary(p) {
  if (watchPaused(p)) return '<span class="rule-chip paused">Alerts paused</span>';
  const rule = p.watchRule || {};
  const chips = [];
  if (rule.targetPrice !== null && rule.targetPrice !== undefined) chips.push(`Target $${Number(rule.targetPrice).toFixed(2)}`);
  else if (rule.priceDropOnly) chips.push('Price drops');
  if (rule.immediateRestock) chips.push('Immediate restock');
  return (chips.length ? chips : ['Global alert rules']).map((text) => `<span class="rule-chip">${escapeHtml(text)}</span>`).join('');
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
    <button class="watch-image media-shell product-detail-trigger" type="button" data-product-detail="${escapeHtml(p.slug)}">${imageMarkup(p)}</button>
    <div class="card-top"><span class="badge ${badgeClass}">${badgeText}</span><span class="meta">${escapeHtml(p.category)}</span></div>
    <button class="product-name-button" type="button" data-product-detail="${escapeHtml(p.slug)}"><h3>${escapeHtml(p.name)}</h3></button>
    <div class="meta">${escapeHtml(p.slug)}</div>
    <div class="price">${escapeHtml(p.price || 'Price unavailable')}</div>
    <div class="detail">${escapeHtml(productDetail(p))}${changedRecently ? ' · changed recently' : ''}</div>
    <div class="rule-chips">${ruleSummary(p)}</div>
    <div class="card-actions">
      <button data-product-detail="${escapeHtml(p.slug)}">Alert rules</button>
      <button class="watching" data-watch="${escapeHtml(p.slug)}">Remove</button>
    </div>
  </article>`;
}
function storeCard(p) {
  const statusClass = p.unlisted ? 'out unlisted' : p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out sold-out';
  const status = p.unlisted ? 'Unlisted' : p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out';
  return `<article class="store-card" data-product-card="${escapeHtml(p.slug)}">
    <button class="store-image media-shell product-detail-trigger" type="button" data-product-detail="${escapeHtml(p.slug)}">${imageMarkup(p)}</button>
    <div class="store-card-body">
      <div class="store-card-heading">
        <button type="button" data-product-detail="${escapeHtml(p.slug)}" class="store-product-link"><h3>${escapeHtml(p.name)}</h3></button>
        <button class="watch-icon ${p.watched ? 'watching' : ''}" data-watch="${escapeHtml(p.slug)}" title="${p.watched ? 'Remove from watchlist' : 'Watch this product'}" aria-label="${p.watched ? 'Remove from watchlist' : 'Watch this product'}">${p.watched ? '✓' : '+'}</button>
      </div>
      <div class="store-sku">${escapeHtml(p.slug)}</div>
      <div class="store-price-row"><strong>${escapeHtml(p.price || 'Price unavailable')}</strong><span class="stock-label ${statusClass}">${status}</span></div>
      <button class="store-watch ${p.watched ? 'watching' : ''}" data-watch="${escapeHtml(p.slug)}">${p.watched ? 'Watching · alert enabled' : 'Notify me when available'}</button>
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
function renderCategoryTabs() {
  const tabs = categories();
  if (!tabs.includes(app.browseCategory)) app.browseCategory = 'All';
  $('categoryTabs').innerHTML = tabs.map((category) => {
    const count = category === 'All' ? app.products.length : app.products.filter((p) => p.category === category).length;
    return `<button class="store-category-tab ${app.browseCategory === category ? 'active' : ''}" data-category="${escapeHtml(category)}" role="tab" aria-selected="${app.browseCategory === category}">${escapeHtml(category)} <span>${count}</span></button>`;
  }).join('');
}
function filteredWatchlist() {
  const query = $('watchSearch').value.trim().toLowerCase();
  const status = $('watchStatus').value;
  const category = $('watchCategory').value;
  const sort = $('watchSort').value;
  const products = app.products.filter((p) => p.watched).filter((p) => {
    if (query && !`${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(query)) return false;
    if (category !== 'all' && p.category !== category) return false;
    if (status === 'in' && !p.inStock) return false;
    if (status === 'out' && p.inStock) return false;
    if (status === 'paused' && !watchPaused(p)) return false;
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
  const selected = app.pendingWatchCategory || $('watchCategory').value || 'all';
  const choices = [...new Set(watched.map((p) => p.category).filter(Boolean))].sort();
  $('watchCategory').innerHTML = '<option value="all">All categories</option>' + choices.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  $('watchCategory').value = choices.includes(selected) ? selected : 'all';
  if (choices.includes(selected) || watched.length) app.pendingWatchCategory = null;
}
function watchFiltersActive() { return Boolean($('watchSearch').value.trim() || $('watchStatus').value !== 'all' || $('watchCategory').value !== 'all' || $('watchSort').value !== 'changed'); }
function browseFiltersActive() { return Boolean($('search').value.trim() || app.browseCategory !== 'All'); }
function activityFiltersActive() { return Boolean($('activitySearch').value.trim() || $('activityRegion').value !== 'all' || $('activityType').value !== 'all' || $('activityDelivery').value !== 'all' || $('activityFrom').value || $('activityTo').value); }
function resetWatchFilters() {
  $('watchSearch').value = ''; $('watchStatus').value = 'all'; $('watchCategory').value = 'all'; $('watchSort').value = 'changed'; app.pendingWatchCategory = null;
  persistUiState(); renderProducts(true);
}
function resetBrowseFilters() {
  $('search').value = ''; app.browseCategory = 'All'; app.browseVisibleCount = 48; persistUiState(); renderProducts(true);
}
function resetActivityFilters() {
  $('activityFilters').reset(); $('activityRegion').value = 'all'; app.pendingActivityRegion = null; persistUiState(); refreshActivity(1);
}
function renderBulkActions() {
  const count = app.selectedWatch.size;
  $('bulkCount').textContent = `${count} selected`;
  $('bulkActions').classList.toggle('hidden', count === 0);
}
function renderProducts(force = false) {
  const allWatched = app.products.filter((p) => p.watched);
  renderWatchFilters(allWatched);
  const watched = filteredWatchlist();
  $('watchCount').textContent = allWatched.length;
  if ($('settingsWatchCount')) $('settingsWatchCount').textContent = `${allWatched.length} product${allWatched.length === 1 ? '' : 's'}`;
  const watchKey = JSON.stringify([watched.map((p) => [p.slug,p.status,p.price,p.lastChangedAt,p.watchRule]), [...app.selectedWatch]]);
  if (force || watchKey !== app.watchRenderKey) {
    $('watchGrid').innerHTML = watched.map(watchCard).join('');
    app.watchRenderKey = watchKey;
    wireProductImages($('watchGrid'));
  }
  const watchEmpty = $('watchEmpty');
  watchEmpty.querySelector('h3').textContent = allWatched.length ? 'No watched products match these filters' : 'No products watched yet';
  watchEmpty.querySelector('p').textContent = allWatched.length ? 'Clear or change a filter to see the rest of your watchlist.' : 'Open Browse and add the gear you are waiting for.';
  watchEmpty.querySelector('[data-goto]').classList.toggle('hidden', allWatched.length > 0);
  $('resetWatchEmpty').classList.toggle('hidden', !allWatched.length || !watchFiltersActive());
  $('resetWatchFilters').classList.toggle('hidden', !watchFiltersActive());
  watchEmpty.classList.toggle('hidden', watched.length > 0);
  $('watchGrid').classList.toggle('hidden', watched.length === 0);
  renderBulkActions();

  renderCategoryTabs();
  const q = $('search').value.trim().toLowerCase();
  const filtered = app.products.filter((p) => {
    const categoryMatch = app.browseCategory === 'All' || p.category === app.browseCategory;
    const searchMatch = !q || `${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(q);
    return categoryMatch && searchMatch;
  });
  const visible = filtered.slice(0, app.browseVisibleCount);
  const browseKey = JSON.stringify([visible.map((p) => [p.slug,p.status,p.price,p.watched,p.imageUrl]), app.browseCategory,q,app.browseVisibleCount]);
  if (force || browseKey !== app.browseRenderKey) {
    $('browseGrid').innerHTML = visible.map(storeCard).join('');
    app.browseRenderKey = browseKey;
    wireProductImages($('browseGrid'));
  }
  $('browseEmpty').classList.toggle('hidden', filtered.length > 0);
  $('resetBrowseFilters').classList.toggle('hidden', !browseFiltersActive());
  $('browseTitle').textContent = app.browseCategory === 'All' ? 'All products' : app.browseCategory;
  $('browseCount').textContent = filtered.length > visible.length ? `Showing ${visible.length} of ${filtered.length} products` : `${filtered.length} product${filtered.length === 1 ? '' : 's'}`;
  $('browseLoadMore').classList.toggle('hidden', visible.length >= filtered.length);
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
    const details = item.slug ? `${item.slug} · ${item.detail}` : item.detail;
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

function historyChart(history) {
  const values = [...history].reverse().filter((item) => Number.isFinite(Number(item.priceValue)));
  if (values.length < 2) return '<div class="history-empty">Price history will appear after GearBeacon detects a change.</div>';
  const width = 620; const height = 170; const pad = 18;
  const prices = values.map((item) => Number(item.priceValue));
  const min = Math.min(...prices); const max = Math.max(...prices); const range = Math.max(1, max - min);
  const points = values.map((item, index) => {
    const x = pad + index * (width - pad * 2) / Math.max(1, values.length - 1);
    const y = height - pad - ((Number(item.priceValue) - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<div class="history-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Price history from ${escapeHtml(values[0].price)} to ${escapeHtml(values.at(-1).price)}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke"/></svg><div><span>${escapeHtml(values[0].price)} · ${escapeHtml(new Date(values[0].observedAt).toLocaleDateString())}</span><span>${escapeHtml(values.at(-1).price)} · now</span></div></div>`;
}

function ruleSelect(name, label, value) {
  const selected = value === null || value === undefined ? 'inherit' : String(Boolean(value));
  return `<label class="field"><span>${label}</span><select name="${name}"><option value="inherit" ${selected === 'inherit' ? 'selected' : ''}>Use global setting</option><option value="true" ${selected === 'true' ? 'selected' : ''}>Enabled</option><option value="false" ${selected === 'false' ? 'selected' : ''}>Disabled</option></select></label>`;
}

function renderProductDialog(details) {
  app.currentProductDetails = details;
  const p = details.product;
  const rule = p.watchRule || {};
  $('productDialogCategory').textContent = `${p.category} · ${String(p.region || app.currentRegion || '').toUpperCase()}`;
  $('productDialogTitle').textContent = p.name;
  const currentPause = rule.pausedUntil && rule.pausedUntil !== 'indefinite' ? `<option value="existing:${escapeHtml(rule.pausedUntil)}" selected>Paused until ${escapeHtml(new Date(rule.pausedUntil).toLocaleString())}</option>` : '';
  const ruleForm = p.watched ? `<form id="productRuleForm" class="product-rule-form" data-rule-slug="${escapeHtml(p.slug)}">
    <h3>Product-specific alert rules</h3><p>Use global settings unless this product needs different behavior.</p>
    <div class="form-row">${ruleSelect('restock','Restock alerts',rule.restock)}${ruleSelect('soldOut','Sold-out alerts',rule.soldOut)}${ruleSelect('priceChange','Price-change alerts',rule.priceChange)}${ruleSelect('statusChange','Other status alerts',rule.statusChange)}</div>
    <div class="form-row"><label class="field"><span>Target price</span><input name="targetPrice" type="number" min="0" step="0.01" value="${rule.targetPrice ?? ''}" placeholder="No target" /></label><label class="field"><span>Pause alerts</span><select name="pause"><option value="active" ${!rule.pausedUntil ? 'selected' : ''}>Active</option>${currentPause}<option value="60">For 1 hour</option><option value="1440">For 1 day</option><option value="10080">For 1 week</option><option value="indefinite" ${rule.pausedUntil === 'indefinite' ? 'selected' : ''}>Until resumed</option></select></label></div>
    <div class="inline-checks"><label><input name="priceDropOnly" type="checkbox" ${rule.priceDropOnly ? 'checked' : ''}/> Only alert when price drops</label><label><input name="immediateRestock" type="checkbox" ${rule.immediateRestock ? 'checked' : ''}/> Deliver restocks immediately</label></div>
    <div class="settings-actions wrap"><button class="primary" type="submit">Save alert rules</button><button type="button" data-watch="${escapeHtml(p.slug)}">Remove from watchlist</button></div>
    <div class="settings-result hidden" data-rule-result></div>
  </form>` : `<div class="product-watch-prompt"><p>Add this product to your watchlist to configure its alert rules.</p><button class="primary button-link" data-watch="${escapeHtml(p.slug)}">Watch this product</button></div>`;
  const changes = details.history.slice(0, 12).map((item) => `<div class="product-change"><span class="connection-dot ${item.inStock ? 'enabled' : ''}"></span><div><strong>${escapeHtml(item.changeType.replaceAll('-', ' '))}</strong><small>${escapeHtml(item.status || 'Unknown')}${item.price ? ` · ${escapeHtml(item.price)}` : ''}</small></div><time>${escapeHtml(relativeTime(item.observedAt))}</time></div>`).join('');
  $('productDialogBody').innerHTML = `<div class="product-hero"><div class="product-hero-image media-shell">${imageMarkup(p, 'product-image')}</div><div><div class="product-status-row"><span class="badge ${p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out'}">${p.unlisted ? 'Unlisted' : p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out'}</span><strong>${escapeHtml(p.price || 'Price unavailable')}</strong></div><div class="product-sku-row"><p>${escapeHtml(p.slug)}</p><button class="copy-button" type="button" data-copy-text="${escapeHtml(p.slug)}" data-copy-label="SKU">Copy SKU</button></div><dl class="settings-details"><div><dt>Store region</dt><dd>${escapeHtml(String(p.region || app.currentRegion || '').toUpperCase())}</dd></div><div><dt>First observed</dt><dd>${escapeHtml(relativeTime(details.firstObservedAt))}</dd></div><div><dt>Last checked</dt><dd>${escapeHtml(relativeTime(p.lastSeenAt))}</dd></div><div><dt>Last changed</dt><dd>${escapeHtml(relativeTime(details.lastChangedAt))}</dd></div><div><dt>History retention</dt><dd>${details.historyRetentionDays} days</dd></div></dl><div class="product-link-actions"><a class="button-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open UniFi Store ↗</a><button class="copy-button" type="button" data-copy-text="${escapeHtml(p.url)}" data-copy-label="Store link">Copy link</button></div></div></div>
    ${ruleForm}<section class="product-history"><h3>Price history</h3>${historyChart(details.history)}<h3>Recent changes</h3><div class="product-change-list">${changes || '<div class="history-empty">No changes recorded yet.</div>'}</div></section>`;
  wireProductImages($('productDialogBody'));
}

async function openProductDialog(slug, preserveFocus = false) {
  if (!preserveFocus) app.lastFocusedProduct = document.activeElement;
  $('productDialog').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  $('productDialogTitle').textContent = 'Loading product…';
  $('productDialogBody').innerHTML = '<div class="dialog-loading">Loading product history and alert rules…</div>';
  $('closeProductDialog').focus();
  try { renderProductDialog(await api(`/api/products/${encodeURIComponent(slug)}`)); }
  catch (err) { $('productDialogBody').innerHTML = `<div class="settings-result error">${escapeHtml(err.message)}</div>`; }
}

function closeProductDialog() {
  $('productDialog').classList.add('hidden');
  document.body.classList.remove('dialog-open');
  app.currentProductDetails = null;
  app.lastFocusedProduct?.focus?.();
}

async function saveProductRule(form) {
  const readOverride = (name) => { const value = form.elements[name].value; return value === 'inherit' ? null : value === 'true'; };
  const pause = form.elements.pause.value;
  const pausedUntil = pause === 'active' ? null : pause === 'indefinite' ? 'indefinite' : pause.startsWith('existing:') ? pause.slice(9) : new Date(Date.now() + Number(pause) * 60000).toISOString();
  const rule = { restock:readOverride('restock'), soldOut:readOverride('soldOut'), priceChange:readOverride('priceChange'), statusChange:readOverride('statusChange'), targetPrice:form.elements.targetPrice.value || null, priceDropOnly:form.elements.priceDropOnly.checked, immediateRestock:form.elements.immediateRestock.checked, pausedUntil };
  const resultBox = form.querySelector('[data-rule-result]');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Saving…';
  try {
    const result = await api(`/api/watch/${encodeURIComponent(form.dataset.ruleSlug)}/rules`, { method:'PUT', body:JSON.stringify({ rule }) });
    const product = app.products.find((item) => item.slug === form.dataset.ruleSlug); if (product) product.watchRule = result.rule;
    renderProducts(true); await openProductDialog(form.dataset.ruleSlug, true); toast('Product alert rules saved');
  } catch (err) { resultBox.classList.remove('hidden'); resultBox.textContent = err.message; button.disabled = false; button.textContent = 'Save alert rules'; }
}

function renderEvents() {
  const icon = { restock:'↑', sold_out:'↓', price_change:'$', status_change:'↔', new_product:'+' };
  const events = app.activity.events || [];
  $('activityList').innerHTML = events.map((e) => {
    const metadata = activityMeta(e);
    const metadataText = metadata.map((part) => `${part.text}${part.extra ? ` ${part.extra}` : ''}`).join(' · ');
    const metadataHtml = metadata.map((part) => `<span class="event-meta-part ${escapeHtml(part.className)}">${escapeHtml(part.text)}${part.extra ? ` <span class="event-delta-percent">${escapeHtml(part.extra)}</span>` : ''}</span>`).join('');
    const alert = e.serverAlert || { state:'no-channel', label:'No channel' };
    const exactTime = exactEventTime(e);
    const activityLabel = `Open ${e.name} activity details. ${metadataText}. Server alert: ${alert.label}. Detected ${exactTime}.`;
    return `<button class="event event-button ${escapeHtml(e.type)}" type="button" data-activity-event="${escapeHtml(e.id)}" aria-label="${escapeHtml(activityLabel)}">
      <span class="event-icon" aria-hidden="true">${icon[e.type] || '•'}</span>
      <span class="event-main"><strong>${escapeHtml(e.name)}</strong><span class="event-meta" title="${escapeHtml(metadataText)}">${metadataHtml}</span></span>
      <span class="event-side"><span class="event-alert ${escapeHtml(alert.state)}" title="${escapeHtml(serverAlertTitle(e))}"><span class="event-alert-dot" aria-hidden="true"></span><span class="event-alert-label">${escapeHtml(alert.label)}</span></span><time datetime="${escapeHtml(e.detectedAt)}" title="${escapeHtml(exactTime)}">${escapeHtml(relativeTime(e.detectedAt))}</time></span>
    </button>`;
  }).join('');
  $('activityEmpty').classList.toggle('hidden', events.length > 0 || !app.activity.loaded);
  const filteredEmpty = activityFiltersActive();
  $('activityEmpty').querySelector('h3').textContent = filteredEmpty ? 'No activity matches these filters' : 'No stock changes detected yet';
  $('activityEmpty').querySelector('p').textContent = filteredEmpty ? 'Reset or change a filter to see retained stock activity.' : 'The first check establishes a baseline. Changes appear here after that.';
  $('resetActivityEmpty').classList.toggle('hidden', !filteredEmpty);
  $('activityResultCount').textContent = app.activity.loaded ? `${app.activity.count} matching event${app.activity.count === 1 ? '' : 's'}` : 'Loading activity…';
  const retention = app.config?.config?.eventRetentionDays;
  $('activityRetention').textContent = retention === 0 ? 'Activity retained until manually changed' : retention ? `${retention}-day activity retention` : 'Retained activity';
  $('activityPagination').classList.toggle('hidden', !app.activity.loaded || app.activity.pages <= 1);
  $('activityPage').textContent = `Page ${app.activity.page} of ${app.activity.pages}`;
  $('activityPrevious').disabled = app.activity.page <= 1;
  $('activityNext').disabled = app.activity.page >= app.activity.pages;
}

function activityQueryParameters(page = app.activity.page || 1) {
  const params = new URLSearchParams({
    scope:$('activityRegion').value || 'all',
    type:$('activityType').value || 'all',
    delivery:$('activityDelivery').value || 'all',
    page:String(page),
    limit:'50',
  });
  if ($('activitySearch').value.trim()) params.set('search', $('activitySearch').value.trim());
  if ($('activityFrom').value) params.set('from', $('activityFrom').value);
  if ($('activityTo').value) params.set('to', $('activityTo').value);
  return params;
}

async function refreshActivity(page = app.activity.page || 1) {
  $('activityResultCount').textContent = 'Loading activity…';
  try {
    const result = await api(`/api/activity?${activityQueryParameters(page)}`);
    app.activity = { ...result, loaded:true };
    renderEvents();
  } catch (err) {
    $('activityResultCount').textContent = `Activity unavailable: ${err.message}`;
    app.activity = { ...app.activity, events:[], loaded:true };
    renderEvents();
  }
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
  $('activityDialogBody').innerHTML = `<section class="activity-detail-hero"><span class="settings-kicker">${escapeHtml(String(event.region || '').toUpperCase())} · ${escapeHtml(humanStatus(event.type))}</span><h3>${escapeHtml(event.name || event.slug)}</h3><p>${escapeHtml(metadata)}</p></section><div class="activity-evidence"><article class="settings-card"><span class="settings-kicker">Monitor evidence</span><h3>Confirmation</h3><dl class="settings-details"><div><dt>Policy</dt><dd>${escapeHtml(humanStatus(confirmation.policy || 'legacy event'))}</dd></div><div><dt>Observations</dt><dd>${escapeHtml(confirmation.observations || 1)} of ${escapeHtml(confirmation.required || 1)}</dd></div><div><dt>First observed</dt><dd>${escapeHtml(confirmation.firstObservedAt ? new Date(confirmation.firstObservedAt).toLocaleString() : exactEventTime(event))}</dd></div><div><dt>Confirmed</dt><dd>${escapeHtml(confirmation.confirmedAt ? new Date(confirmation.confirmedAt).toLocaleString() : exactEventTime(event))}</dd></div></dl></article><article class="settings-card"><span class="settings-kicker">Server notification</span><h3>${escapeHtml(alert.label || 'No delivery')}</h3><p>${escapeHtml(serverAlertTitle(event))}</p><dl class="settings-details"><div><dt>Outcome</dt><dd>${escapeHtml(humanStatus(alert.state || 'not recorded'))}</dd></div><div><dt>Channels</dt><dd>${escapeHtml((alert.channels || []).join(', ') || 'None')}</dd></div><div><dt>Detected</dt><dd>${escapeHtml(exactEventTime(event))}</dd></div></dl></article></div><div class="settings-actions wrap activity-detail-actions"><button class="primary button-link" type="button" data-activity-product="${escapeHtml(event.slug)}" data-activity-region="${escapeHtml(event.region || app.currentRegion || '')}">Open product details</button>${event.url ? `<a class="button-link" href="${escapeHtml(event.url)}" target="_blank" rel="noopener">Open UniFi Store ↗</a>` : ''}</div>`;
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
  picker.innerHTML = s.regions.map((region) => `<option value="${escapeHtml(region.key)}" ${region.key === app.currentRegion ? 'selected' : ''}>${escapeHtml(region.label)}</option>`).join('');
  $('regionPickerWrap').classList.toggle('hidden', s.regions.length < 2);
  const activityRegion = $('activityRegion');
  const activitySelection = app.pendingActivityRegion || activityRegion.value || 'all';
  activityRegion.innerHTML = `<option value="all">All enabled stores</option>${s.regions.map((region) => `<option value="${escapeHtml(region.key)}">${escapeHtml(region.label)}</option>`).join('')}`;
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

function renderSettings() {
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
  renderNotificationSettings();
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
  const selected = select.value;
  const products = [...app.products].sort((a, b) => Number(b.watched) - Number(a.watched) || a.name.localeCompare(b.name));
  select.innerHTML = products.length ? products.map((product) => `<option value="${escapeHtml(product.slug)}" ${product.slug === selected ? 'selected' : ''}>${escapeHtml(product.name)}${product.watched ? ' · watched' : ''}</option>`).join('') : '<option value="">Example product</option>';
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
  const config = { ...current, regions: selectedRegions('wizardRegions'), accessMode, bindHost: accessMode === 'local' ? '127.0.0.1' : '0.0.0.0', publicBaseUrl: $('wizardPublicUrl').value.trim(), backupIntervalHours: Number($('wizardBackupHours').value), backupRetention: Number($('wizardBackupRetention').value), ntfyBaseUrl: $('wizardNtfyBaseUrl').value.trim(), ntfyTopic: $('wizardNtfyTopic').value.trim(), gotifyBaseUrl: $('wizardGotifyUrl').value.trim(), smtpHost:$('wizardSmtpHost').value.trim(), smtpPort:Number($('wizardSmtpPort').value), smtpUser:$('wizardSmtpUser').value, smtpFrom:$('wizardSmtpFrom').value.trim(), smtpTo:$('wizardSmtpTo').value.split(',').map((x) => x.trim()).filter(Boolean) };
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
    const titles = { restock:`${e.name} is back in stock`, sold_out:`${e.name} sold out`, price_change:`${e.name} price changed`, status_change:`${e.name} status changed`, new_product:`New UniFi product: ${e.name}` };
    const n = new Notification(`GearBeacon: ${titles[e.type] || e.name}`, { body: `${e.price ? `${e.price} · ` : ''}Detected ${relativeTime(e.detectedAt)}` });
    if (e.url) n.onclick = () => window.open(e.url, '_blank');
  });
}

async function refresh() {
  try {
    const wasDisconnected = app.serverFailures > 0 || app.browserOffline || app.reconnectPending;
    const [status, products, events] = await Promise.all([api('/api/status'), api('/api/products'), api('/api/events?limit=100')]);
    app.serverFailures = 0;
    app.browserOffline = false;
    app.reconnectPending = false;
    app.status = status;
    app.products = products.products || [];
    maybeBrowserNotify(events.events || []);
    app.events = events.events || [];
    renderStatus(); renderProducts(); renderEvents(); renderSettings(); renderEmailPreviewProducts();
    renderAttentionBanner();
    if (wasDisconnected) toast('Connection restored', 'success');
    if (app.activeTab === 'activity') await refreshActivity(app.activity.page || 1);
    if (Date.now() - app.lastOperationsRefresh > 60000 && app.activeTab !== 'operations') refreshOperations();
  } catch (err) {
    if (/Region must be one of/i.test(err.message) && app.currentRegion) {
      app.currentRegion = null;
      localStorage.removeItem('gearbeacon.region');
      return refresh();
    }
    $('statusDot').className = 'dot bad';
    app.serverFailures += 1;
    $('statusTitle').textContent = 'Reconnecting to GearBeacon…';
    $('statusSub').textContent = app.browserOffline ? 'Waiting for this browser to reconnect' : `${err.message} · automatic retry ${app.serverFailures}`;
    renderAttentionBanner();
  }
}

async function toggleWatch(slug) {
  const product = app.products.find((p) => p.slug === slug);
  if (!product) return;
  try {
    if (product.watched) {
      await api(`/api/watch/${encodeURIComponent(slug)}`, { method:'DELETE' });
      product.watched = false; product.watchRule = null; app.selectedWatch.delete(slug);
    } else {
      const result = await api('/api/watch', { method:'POST', body:JSON.stringify({ slug }) });
      Object.assign(product, result.product || {}, { watched:true });
    }
    renderProducts(true);
    toast(product.watched ? `Watching ${product.name}` : `Stopped watching ${product.name}`);
    if (!$('productDialog').classList.contains('hidden')) openProductDialog(slug, true);
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
    app.selectedWatch.clear(); renderProducts(true); toast(`${result.affected} product${result.affected === 1 ? '' : 's'} ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'removed'}`);
  } catch (err) { toast(err.message, 'error'); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

document.addEventListener('click', (event) => {
  const copy = event.target.closest('[data-copy-text]');
  if (copy) { event.preventDefault(); copyText(copy.dataset.copyText, copy.dataset.copyLabel || 'Text'); return; }
  const imageRetry = event.target.closest('[data-image-retry]');
  if (imageRetry) {
    event.preventDefault(); event.stopPropagation();
    app.brokenImages.delete(imageRetry.dataset.imageRetry);
    if (app.currentProductDetails?.product?.imageUrl === imageRetry.dataset.imageRetry) renderProductDialog(app.currentProductDetails);
    else renderProducts(true);
    return;
  }
  const watch = event.target.closest('[data-watch]');
  if (watch) { event.preventDefault(); toggleWatch(watch.dataset.watch); return; }
  const activityEvent = event.target.closest('[data-activity-event]');
  if (activityEvent) { event.preventDefault(); openActivityDialog(activityEvent.dataset.activityEvent); return; }
  const activityProduct = event.target.closest('[data-activity-product]');
  if (activityProduct) { event.preventDefault(); openActivityProduct(activityProduct.dataset.activityProduct, activityProduct.dataset.activityRegion); return; }
  const category = event.target.closest('[data-category]');
  if (category) { app.browseCategory = category.dataset.category; app.browseVisibleCount = 48; persistUiState(); renderProducts(true); return; }
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
  if (!APP_TABS.includes(tab)) tab = 'watchlist';
  app.activeTab = tab;
  if (tab === 'settings') { refreshDataInfo(); refreshNotificationPreferences(); refreshSessions(); refreshConfiguration(); }
  if (tab === 'operations') refreshOperations();
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
  persistUiState();
}
function activateSettingsTab(tab, focus = false) {
  const selected = SETTINGS_TABS.includes(tab) ? tab : 'general';
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
let browseSearchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(browseSearchTimer); browseSearchTimer = setTimeout(() => { app.browseVisibleCount = 48; persistUiState(); renderProducts(true); }, 180); });
for (const id of ['watchSearch','watchStatus','watchCategory','watchSort']) $(id).addEventListener(id === 'watchSearch' ? 'input' : 'change', () => { persistUiState(); renderProducts(true); });
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
  if (event.key === 'Tab') {
    const dialog = [$('setupWizard'), $('watchImportDialog'), $('activityDialog'), $('productDialog')].find((item) => item && !item.classList.contains('hidden'));
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
  if (!$('watchImportDialog').classList.contains('hidden')) closeWatchImport();
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
$('attentionAction').addEventListener('click', () => activateTab('operations'));
$('activityFilters').addEventListener('submit', (event) => { event.preventDefault(); persistUiState(); refreshActivity(1); });
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
activateTab(APP_TABS.includes(initialTab) ? initialTab : app.activeTab);
activateSettingsTab(localStorage.getItem(SETTINGS_TAB_KEY) || 'general');

window.addEventListener('offline', () => {
  app.browserOffline = true;
  $('statusDot').className = 'dot bad'; $('statusTitle').textContent = 'Browser offline'; $('statusSub').textContent = 'Waiting for the network to return';
  renderAttentionBanner();
});
window.addEventListener('online', () => { app.reconnectPending = app.browserOffline; app.browserOffline = false; renderAttentionBanner(); refresh(); });

initialize();
setInterval(() => {
  if (!$('appShell').classList.contains('hidden')) refresh();
}, 10000);
