const $ = (id) => document.getElementById(id);
const THEME_KEY = 'gearbeacon.theme';

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
  await Promise.all([refreshDataInfo(), refreshNotificationPreferences(), refreshSessions()]);
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
  return `${fallback}<img class="${className}" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy" onload="this.parentElement.classList.add('image-loaded')" onerror="this.remove()" />`;
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
      resultEl.innerHTML = `<strong>GearBeacon V${escapeHtml(result.latestVersion)} is available.</strong>${link}${result.releaseNotes ? `<br>${escapeHtml(result.releaseNotes)}` : ''}`;
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
});

function activateTab(tab) {
  app.activeTab = tab;
  if (tab === 'settings') { refreshDataInfo(); refreshNotificationPreferences(); refreshSessions(); }
  if (['watchlist','browse','activity','settings'].includes(tab)) history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.page').forEach((x) => x.classList.toggle('active', x.id === tab));
}
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
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
$('saveNotificationPrefs').addEventListener('click', saveNotificationPreferences);
$('testNotificationBtn').addEventListener('click', testServerNotification);
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
if (['watchlist','browse','activity','settings'].includes(initialTab)) activateTab(initialTab);

initialize();
setInterval(() => {
  if (!$('appShell').classList.contains('hidden')) refresh();
}, 10000);
