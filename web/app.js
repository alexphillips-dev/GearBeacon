const $ = (id) => document.getElementById(id);
const THEME_KEY = 'gearbeacon.theme';
const SETTINGS_TAB_KEY = 'gearbeacon.settingsTab';
const SETTINGS_TABS = ['general', 'notifications', 'data', 'security', 'privacy'];

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
  currentRegion: localStorage.getItem('gearbeacon.region') || null,
  status: null,
  products: [],
  events: [],
  dataInfo: null,
  config: null,
  operations: null,
  wizardStep: 1,
  notificationPreferences: { restock:true, soldOut:false, priceChange:false, statusChange:false, newProduct:false },
  activeTab: 'watchlist',
  browseCategory: 'All',
  latestEventId: null,
};

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
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 2600);
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
  await refresh();
  await Promise.all([refreshDataInfo(), refreshNotificationPreferences(), refreshSessions(), refreshConfiguration()]);
  if (!app.auth?.onboardingComplete) showWizard();
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
  if (p.inStock) return 'Available now';
  if (p.restockEtaAt) return `Store ETA ${new Date(p.restockEtaAt).toLocaleDateString()}`;
  if (p.comingSoon) return 'Coming soon';
  if (p.soldOutAt) return `Sold out ${relativeTime(p.soldOutAt)}`;
  return 'Waiting for restock';
}
function imageMarkup(p, className = 'product-image') {
  const fallback = `<div class="image-placeholder" aria-hidden="true"></div>`;
  if (!p.imageUrl) return fallback;
  return `${fallback}<img class="${className}" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy" data-product-image />`;
}
function wireProductImages(root = document) {
  root.querySelectorAll('img[data-product-image]').forEach((image) => {
    if (image.dataset.imageWired === 'true') return;
    image.dataset.imageWired = 'true';
    const showImage = () => image.parentElement?.classList.add('image-loaded');
    const removeBrokenImage = () => image.remove();
    image.addEventListener('load', showImage, { once: true });
    image.addEventListener('error', removeBrokenImage, { once: true });
    if (image.complete) {
      if (image.naturalWidth > 0) showImage();
      else removeBrokenImage();
    }
  });
}
function watchCard(p) {
  const badgeClass = p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out';
  const badgeText = p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out';
  return `<article class="card watch-card">
    <a class="watch-image media-shell" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${imageMarkup(p)}</a>
    <div class="card-top"><span class="badge ${badgeClass}">${badgeText}</span><span class="meta">${escapeHtml(p.category)}</span></div>
    <h3>${escapeHtml(p.name)}</h3>
    <div class="meta">${escapeHtml(p.slug)}</div>
    <div class="price">${escapeHtml(p.price || 'Price unavailable')}</div>
    <div class="detail">${escapeHtml(productDetail(p))}</div>
    <div class="card-actions">
      <button class="${p.watched ? 'watching' : ''}" data-watch="${escapeHtml(p.slug)}">${p.watched ? 'Watching ✓' : 'Watch'}</button>
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open store ↗</a>
    </div>
  </article>`;
}
function storeCard(p) {
  const statusClass = p.inStock ? 'in' : p.comingSoon ? 'soon' : 'out';
  const status = p.inStock ? 'In stock' : p.comingSoon ? 'Coming soon' : 'Sold out';
  return `<article class="store-card">
    <a class="store-image media-shell" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${imageMarkup(p)}</a>
    <div class="store-card-body">
      <div class="store-card-heading">
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="store-product-link"><h3>${escapeHtml(p.name)}</h3></a>
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
function renderProducts() {
  const watched = app.products.filter((p) => p.watched);
  $('watchCount').textContent = watched.length;
  if ($('settingsWatchCount')) $('settingsWatchCount').textContent = `${watched.length} product${watched.length === 1 ? '' : 's'}`;
  $('watchGrid').innerHTML = watched.map(watchCard).join('');
  $('watchEmpty').classList.toggle('hidden', watched.length > 0);
  $('watchGrid').classList.toggle('hidden', watched.length === 0);

  renderCategoryTabs();
  const q = $('search').value.trim().toLowerCase();
  const filtered = app.products.filter((p) => {
    const categoryMatch = app.browseCategory === 'All' || p.category === app.browseCategory;
    const searchMatch = !q || `${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(q);
    return categoryMatch && searchMatch;
  });
  $('browseGrid').innerHTML = filtered.map(storeCard).join('');
  $('browseEmpty').classList.toggle('hidden', filtered.length > 0);
  $('browseTitle').textContent = app.browseCategory === 'All' ? 'All products' : app.browseCategory;
  $('browseCount').textContent = `${filtered.length} product${filtered.length === 1 ? '' : 's'}`;
  wireProductImages($('watchGrid'));
  wireProductImages($('browseGrid'));
}

function renderEvents() {
  const icon = { restock:'↑', sold_out:'↓', price_change:'$', status_change:'↔' };
  $('activityList').innerHTML = app.events.map((e) => `<article class="event ${escapeHtml(e.type)}">
    <div class="event-icon">${icon[e.type] || '•'}</div>
    <div><strong>${escapeHtml(e.name)}</strong><span class="event-meta">${escapeHtml(e.type.replace('_',' '))}${e.price ? ` · ${escapeHtml(e.price)}` : ''}${e.watchedAtDetection ? ' · watched' : ''}</span></div>
    <time title="${escapeHtml(e.detectedAt)}">${escapeHtml(relativeTime(e.detectedAt))}</time>
  </article>`).join('');
  $('activityEmpty').classList.toggle('hidden', app.events.length > 0);
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
    $('statusSub').textContent = `Last successful check ${relativeTime(s.lastSuccessAt)}`;
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
    };
    const result = await api('/api/notifications/preferences', { method:'PUT', body: JSON.stringify({ preferences }) });
    app.notificationPreferences = result.preferences;
    renderNotificationSettings();
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = '<strong>Notification settings saved.</strong> Future stock events will use these preferences.';
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
  $('configMaxAttempts').value = c.notificationMaxAttempts;
  $('configGroupSeconds').value = c.notificationGroupSeconds;
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
    backupIntervalHours: Number($('configBackupHours').value),
    backupRetention: Number($('configBackupRetention').value),
    notificationMaxAttempts: Number($('configMaxAttempts').value),
    notificationGroupSeconds: Number($('configGroupSeconds').value),
  };
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
  } catch (err) { toast(`${channel} test failed: ${err.message}`); }
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
    $('runtimeBadge').textContent = `${ops.runtime.platform} · ${ops.runtime.standalone ? 'standalone' : ops.runtime.node}`;
    $('securityWarnings').innerHTML = ops.securityWarnings.length ? ops.securityWarnings.map((item) => `<div class="warning ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.severity.toUpperCase())}</strong><span>${escapeHtml(item.message)}</span></div>`).join('') : '<div class="warning good"><strong>SECURE</strong><span>No configuration warnings detected.</span></div>';
    const queue = ops.notifications.queue;
    const failures = (queue.recentFailures || []).map((item) => `<div class="failure-row"><strong class="bad-text">${escapeHtml(item.channel)} · ${escapeHtml(item.region.toUpperCase())}</strong><small>${escapeHtml(item.last_error || 'Unknown delivery error')} · ${item.attempts}/${item.max_attempts} attempts</small></div>`).join('');
    const backupHistory = (ops.backups.history || []).slice(0, 6).map((item) => `<div class="failure-row"><strong class="${item.status === 'failed' ? 'bad-text' : ''}">${escapeHtml(item.reason)} · ${escapeHtml(item.status)}</strong><small>${escapeHtml(item.filename || item.detail || 'No file')} · ${escapeHtml(relativeTime(item.created_at))}</small></div>`).join('');
    $('operationsGrid').innerHTML = `<article class="settings-card"><span class="settings-kicker">Regions</span><h3>Store health</h3>${ops.regions.map((r) => `<div class="ops-row"><span class="connection-dot ${r.lastSuccessAt && !r.lastError ? 'enabled' : ''}"></span><div><strong>${escapeHtml(r.label)}</strong><small>${r.lastError ? escapeHtml(r.lastError) : `Last check ${escapeHtml(relativeTime(r.lastSuccessAt))} · next ${escapeHtml(relativeTime(r.nextCheckAt))}`}</small></div><b>${r.productCount || 0} products</b></div>`).join('')}</article><article class="settings-card"><span class="settings-kicker">Delivery</span><h3>Notification queue</h3><dl class="settings-details"><div><dt>Pending</dt><dd>${queue.pending}</dd></div><div><dt>Delivered</dt><dd>${queue.sent}</dd></div><div><dt>Failed</dt><dd>${queue.failed}</dd></div></dl>${failures ? `<div class="failure-list">${failures}</div>` : ''}${queue.failed ? '<div class="settings-actions"><button data-retry-failed>Retry failed</button></div>' : ''}</article><article class="settings-card"><span class="settings-kicker">Data safety</span><h3>Backups</h3><dl class="settings-details"><div><dt>Validated</dt><dd>${ops.backups.count}</dd></div><div><dt>Integrity</dt><dd>${ops.backups.integrity.ok ? 'OK' : 'Failed'}</dd></div><div><dt>Latest</dt><dd>${ops.backups.latest ? escapeHtml(relativeTime(ops.backups.latest.createdAt)) : 'None'}</dd></div></dl>${backupHistory ? `<div class="failure-list">${backupHistory}</div>` : ''}</article><article class="settings-card"><span class="settings-kicker">Storage & build</span><h3>Installation</h3><dl class="settings-details"><div><dt>Database</dt><dd>${bytes(ops.storage.databaseSize)}</dd></div><div><dt>Free space</dt><dd>${bytes(ops.storage.freeSpace)}</dd></div><div><dt>Version</dt><dd>V${escapeHtml(ops.runtime.version)}</dd></div><div><dt>Commit / image</dt><dd>${escapeHtml(ops.runtime.commit || ops.runtime.image || 'Source checkout')}</dd></div></dl></article>`;
    await refreshLogs();
  } catch (err) { $('operationsGrid').textContent = `Operations unavailable: ${err.message}`; }
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
      $('setupWizard').classList.add('hidden'); $('appShell').classList.remove('wizard-blur');
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
  } catch (err) { toast(err.message); }
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
  } catch (err) { toast(`Import failed: ${err.message}`); }
  finally { button.disabled = false; $('importFile').value = ''; }
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
  } catch (err) { toast(err.message); }
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
  const prefs = app.notificationPreferences || {};
  fresh.filter((e) => {
    if (e.type === 'new_product') return prefs.newProduct;
    if (!e.watchedAtDetection) return false;
    if (e.type === 'restock') return prefs.restock !== false;
    if (e.type === 'sold_out') return prefs.soldOut;
    if (e.type === 'price_change') return prefs.priceChange;
    if (e.type === 'status_change') return prefs.statusChange;
    return false;
  }).reverse().forEach((e) => {
    const titles = { restock:`${e.name} is back in stock`, sold_out:`${e.name} sold out`, price_change:`${e.name} price changed`, status_change:`${e.name} status changed`, new_product:`New UniFi product: ${e.name}` };
    const n = new Notification(`GearBeacon: ${titles[e.type] || e.name}`, { body: `${e.price ? `${e.price} · ` : ''}Detected ${relativeTime(e.detectedAt)}` });
    if (e.url) n.onclick = () => window.open(e.url, '_blank');
  });
}

async function refresh() {
  try {
    const [status, products, events] = await Promise.all([api('/api/status'), api('/api/products'), api('/api/events?limit=100')]);
    app.status = status;
    app.products = products.products || [];
    maybeBrowserNotify(events.events || []);
    app.events = events.events || [];
    renderStatus(); renderProducts(); renderEvents(); renderSettings();
  } catch (err) {
    if (/Region must be one of/i.test(err.message) && app.currentRegion) {
      app.currentRegion = null;
      localStorage.removeItem('gearbeacon.region');
      return refresh();
    }
    $('statusDot').className = 'dot bad';
    $('statusTitle').textContent = 'GearBeacon server unavailable';
    $('statusSub').textContent = err.message;
  }
}

async function toggleWatch(slug) {
  const product = app.products.find((p) => p.slug === slug);
  if (!product) return;
  try {
    if (product.watched) await api(`/api/watch/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    else await api('/api/watch', { method: 'POST', body: JSON.stringify({ slug }) });
    product.watched = !product.watched;
    renderProducts();
    toast(product.watched ? `Watching ${product.name}` : `Stopped watching ${product.name}`);
  } catch (err) { toast(err.message); }
}

document.addEventListener('click', (event) => {
  const watch = event.target.closest('[data-watch]');
  if (watch) { event.preventDefault(); toggleWatch(watch.dataset.watch); return; }
  const category = event.target.closest('[data-category]');
  if (category) { app.browseCategory = category.dataset.category; renderProducts(); return; }
  const go = event.target.closest('[data-goto]');
  if (go) activateTab(go.dataset.goto);
  const revoke = event.target.closest('[data-revoke-session]');
  if (revoke) revokeSession(revoke.dataset.revokeSession);
  const test = event.target.closest('[data-test-channel]');
  if (test) testChannel(test.dataset.testChannel, test);
  const retry = event.target.closest('[data-retry-failed]');
  if (retry) api('/api/notifications/retry-failed', { method:'POST' }).then((result) => { toast(`${result.queued} failed deliveries queued`); refreshOperations(); }).catch((err) => toast(err.message));
});

function activateTab(tab) {
  app.activeTab = tab;
  if (tab === 'settings') { refreshDataInfo(); refreshNotificationPreferences(); refreshSessions(); refreshConfiguration(); }
  if (tab === 'operations') refreshOperations();
  if (['watchlist','browse','activity','operations','settings'].includes(tab)) history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.page').forEach((x) => x.classList.toggle('active', x.id === tab));
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
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
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
$('search').addEventListener('input', renderProducts);
$('checkBtn').addEventListener('click', async () => {
  $('checkBtn').disabled = true;
  $('checkBtn').textContent = 'Checking…';
  try { await api('/api/check', { method:'POST' }); await refresh(); toast('Store check complete'); }
  catch (err) { toast(err.message); }
  finally { $('checkBtn').disabled = false; $('checkBtn').textContent = 'Check now'; }
});
$('backupBtn').addEventListener('click', async () => {
  const button = $('backupBtn');
  button.disabled = true;
  try {
    await api('/api/data/backup', { method: 'POST' });
    await refreshDataInfo();
    toast('Safety backup created');
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; }
});
$('exportBtn').addEventListener('click', () => exportData(true));
$('exportPlainBtn').addEventListener('click', () => exportData(false));
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', () => importDataFile($('importFile').files?.[0]));
$('updateBtn').addEventListener('click', checkUpdates);
$('prepareUpdateBtn').addEventListener('click', prepareUpdate);
$('saveNotificationPrefs').addEventListener('click', saveNotificationPreferences);
$('testNotificationBtn').addEventListener('click', testServerNotification);
$('appConfigForm').addEventListener('submit', saveAppConfiguration);
$('channelConfigForm').addEventListener('submit', (event) => { event.preventDefault(); saveChannelConfiguration(); });
$('saveChannels').addEventListener('click', saveChannelConfiguration);
$('refreshOperations').addEventListener('click', refreshOperations);
$('applyLogFilter').addEventListener('click', refreshLogs);
$('downloadLogs').addEventListener('click', async () => {
  try {
    const params = new URLSearchParams({ limit:'1000', download:'1' });
    if ($('logLevel').value) params.set('level', $('logLevel').value);
    if ($('logSearch').value.trim()) params.set('search', $('logSearch').value.trim());
    const res = await fetch(`/api/logs?${params}`, { credentials:'same-origin' });
    await saveDownloadResponse(res, `GearBeacon-Logs-${new Date().toISOString().slice(0,10)}.json`);
  } catch (err) { toast(err.message); }
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

const initialTab = location.hash.slice(1);
if (['watchlist','browse','activity','operations','settings'].includes(initialTab)) activateTab(initialTab);
activateSettingsTab(localStorage.getItem(SETTINGS_TAB_KEY) || 'general');

initialize();
setInterval(() => {
  if (!$('appShell').classList.contains('hidden')) refresh();
}, 10000);
