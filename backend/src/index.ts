// GearBeacon V1.4 backend
// Production notifications, GitHub release updates, cloud-ready deployment,
// monitor health guards, and CI/release infrastructure.
// @ts-nocheck

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const APP_VERSION = '1.4.0';
const DATABASE_SCHEMA_VERSION = 3;
const BACKUP_RETENTION = 5;
const STORE_BASE = 'https://store.ui.com';
const REGIONS = {
  us: { label: 'United States', path: 'us/en', currency: 'USD' },
  eu: { label: 'Europe', path: 'eu/en', currency: 'EUR' },
  uk: { label: 'United Kingdom', path: 'uk/en', currency: 'GBP' },
  ca: { label: 'Canada', path: 'ca/en', currency: 'CAD' },
};

// Current broad UniFi Store category pages. GearBeacon only requests these
// centrally once per poll cycle and deduplicates products by slug.
const CATEGORIES = [
  'category/all-cloud-gateways',
  'category/all-switching',
  'category/all-wifi',
  'category/all-physical-security',
  'category/all-door-access',
  'category/all-integrations',
  'category/accessories-cables-dacs',
  'category/network-storage',
];

const CATEGORY_LABELS = {
  'category/all-cloud-gateways': 'Cloud Gateways',
  'category/all-switching': 'Switching',
  'category/all-wifi': 'WiFi',
  'category/all-physical-security': 'Cameras & Physical Security',
  'category/all-door-access': 'Door Access',
  'category/all-integrations': 'Integrations',
  'category/accessories-cables-dacs': 'Accessories & Cables',
  'category/network-storage': 'Network Storage',
};

const regionKey = String(process.env.REGION || 'us').toLowerCase();
const REGION = REGIONS[regionKey] ? regionKey : 'us';
const PORT = Number(process.env.PORT || 8787);
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_SECONDS || 60));
const NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim();
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
const EXPO_ACCESS_TOKEN = String(process.env.EXPO_ACCESS_TOKEN || '').trim();
const MOCK_MODE = ['1', 'true', 'yes'].includes(String(process.env.MOCK_MODE || '').toLowerCase());
const UPDATE_MANIFEST_URL = String(process.env.GEARBEACON_UPDATE_MANIFEST_URL || '').trim();
const GITHUB_RELEASE_API = String(process.env.GEARBEACON_GITHUB_RELEASE_API !== undefined ? process.env.GEARBEACON_GITHUB_RELEASE_API : 'https://api.github.com/repos/alexphillips-dev/GearBeacon/releases/latest').trim();
const DEPLOYMENT_MODE = String(process.env.GEARBEACON_DEPLOYMENT || 'local').toLowerCase() === 'cloud' ? 'cloud' : 'local';
const PUBLIC_BASE_URL = String(process.env.GEARBEACON_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const MIN_CATALOG_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.GEARBEACON_MIN_CATALOG_RATIO || 0.55)));
const STALE_AFTER_SECONDS = Math.max(POLL_SECONDS * 3, Number(process.env.GEARBEACON_STALE_AFTER_SECONDS || 180));

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const LEGACY_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RELEASE_MANIFEST_FILE = path.join(PROJECT_ROOT, 'release-manifest.json');

function defaultUserDataDir() {
  if (process.env.GEARBEACON_DATA_DIR) return path.resolve(process.env.GEARBEACON_DATA_DIR);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GearBeacon');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'GearBeacon');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'GearBeacon');
}

const USER_DATA_DIR = defaultUserDataDir();
const BACKUP_DIR = path.join(USER_DATA_DIR, 'backups');
const DB_FILE = path.join(USER_DATA_DIR, MOCK_MODE ? 'gearbeacon.mock.sqlite3' : 'gearbeacon.sqlite3');
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const HEADERS = {
  'User-Agent': `GearBeacon/${APP_VERSION} (+local stock monitor; contact via project owner)`,
  Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
};

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function safeFilePart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function sqliteQuote(value) {
  return String(value).replaceAll("'", "''");
}

const dbExistedAtStartup = fs.existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

function tableExists(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

function getMeta(key) {
  if (!tableExists('meta')) return null;
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  restock: true,
  soldOut: false,
  priceChange: false,
  statusChange: false,
  newProduct: false,
});

function getSetting(key, fallback = null) {
  if (!tableExists('settings')) return fallback;
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), isoNow());
}

function notificationPreferences() {
  const raw = safeJsonParse(getSetting('notification_preferences', ''), {});
  const normalized = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const key of Object.keys(normalized)) {
    if (typeof raw?.[key] === 'boolean') normalized[key] = raw[key];
  }
  return normalized;
}

function updateNotificationPreferences(input) {
  const current = notificationPreferences();
  for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
    if (typeof input?.[key] === 'boolean') current[key] = input[key];
  }
  setSetting('notification_preferences', JSON.stringify(current));
  return current;
}

function schemaVersion() {
  if (!tableExists('schema_migrations')) return 0;
  return Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version || 0);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.sqlite3') || name.endsWith('.json'))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function trimBackups() {
  const databaseBackups = listBackups().filter((item) => item.name.endsWith('.sqlite3'));
  for (const old of databaseBackups.slice(BACKUP_RETENTION)) {
    try { fs.unlinkSync(old.path); } catch {}
  }
}

function createDatabaseBackup(reason = 'manual') {
  if (!fs.existsSync(DB_FILE)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${safeFilePart(reason)}-${stamp}.sqlite3`;
  const destination = path.join(BACKUP_DIR, filename);
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO '${sqliteQuote(destination)}'`);
  trimBackups();
  return { filename, path: destination, createdAt: isoNow(), reason };
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'core-persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchlist (
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(region, slug)
      );
      CREATE TABLE IF NOT EXISTS products (
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(region, slug)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        region TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_region_detected ON events(region, detected_at);
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'settings-and-data-metadata',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_region ON products(region);
    `,
  },
  {
    version: 3,
    name: 'production-notifications-and-health',
    sql: `
      CREATE TABLE IF NOT EXISTS notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_log_event ON notification_log(event_id);
    `,
  },
];

function runMigrations() {
  // Bootstrap the migration ledger before querying it on a brand-new database.
  if (!tableExists('schema_migrations')) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  }
  let current = schemaVersion();
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, isoNow());
      db.exec('COMMIT');
      current = migration.version;
      console.log(`[data] migrated schema to v${migration.version} (${migration.name})`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }
  if (current !== DATABASE_SCHEMA_VERSION) throw new Error(`Unexpected GearBeacon schema version ${current}; expected ${DATABASE_SCHEMA_VERSION}.`);
}

function findLegacyStateFile() {
  if (['1','true','yes'].includes(String(process.env.GEARBEACON_SKIP_LEGACY_IMPORT || '').toLowerCase())) return null;
  const explicit = String(process.env.GEARBEACON_LEGACY_DATA_FILE || '').trim();
  const filename = MOCK_MODE ? 'gear-beacon.mock.json' : `gear-beacon.${REGION}.json`;
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(path.join(LEGACY_DATA_DIR, filename));

  // Helps users who unzip a newer GearBeacon release beside an older V1.x folder instead of over it.
  try {
    const parent = path.dirname(PROJECT_ROOT);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^GearBeacon-v1\.(?:0|1|2)(?:\.|$)/i.test(entry.name)) continue;
      candidates.push(path.join(parent, entry.name, 'data', filename));
    }
  } catch {}

  const existing = [...new Set(candidates)].filter((file) => fs.existsSync(file));
  existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return existing[0] || null;
}

function importLegacyStateIfNeeded() {
  if (getMeta(`legacy_imported_${MOCK_MODE ? 'mock' : REGION}`) === '1') return null;
  const existingRows = Number(db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE region=?').get(REGION)?.n || 0)
    + Number(db.prepare('SELECT COUNT(*) AS n FROM products WHERE region=?').get(REGION)?.n || 0);
  if (existingRows > 0) {
    setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : REGION}`, '1');
    return null;
  }

  const legacy = findLegacyStateFile();
  if (!legacy) {
    setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : REGION}`, '1');
    return null;
  }
  const parsed = safeJsonParse(fs.readFileSync(legacy, 'utf8'), null);
  if (!parsed || typeof parsed !== 'object') return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const legacyCopy = path.join(BACKUP_DIR, `legacy-json-${stamp}.json`);
  try { fs.copyFileSync(legacy, legacyCopy); } catch {}

  const legacyState = {
    watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist.filter(Boolean) : [],
    products: parsed.products && typeof parsed.products === 'object' ? parsed.products : {},
    events: Array.isArray(parsed.events) ? parsed.events.slice(-1000) : [],
    pushTokens: Array.isArray(parsed.pushTokens) ? parsed.pushTokens.filter(Boolean) : [],
  };
  persistState(legacyState);
  setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : REGION}`, '1');
  setMeta('legacy_source', legacy);
  console.log(`[data] migrated legacy JSON data from ${legacy}`);
  return legacy;
}

function loadState() {
  const watchlist = db.prepare('SELECT slug FROM watchlist WHERE region=? ORDER BY created_at').all(REGION).map((row) => row.slug);
  const products = {};
  for (const row of db.prepare('SELECT slug,data_json FROM products WHERE region=?').all(REGION)) {
    const value = safeJsonParse(row.data_json, null);
    if (value) products[row.slug] = value;
  }
  const events = db.prepare('SELECT data_json FROM events WHERE region=? ORDER BY detected_at DESC LIMIT 1000').all(REGION)
    .map((row) => safeJsonParse(row.data_json, null)).filter(Boolean).reverse();
  const pushTokens = db.prepare('SELECT token FROM push_tokens ORDER BY created_at').all().map((row) => row.token);
  return { watchlist, products, events, pushTokens };
}

function persistState(nextState) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM watchlist WHERE region=?').run(REGION);
    const addWatch = db.prepare('INSERT INTO watchlist(region,slug,created_at) VALUES(?,?,?)');
    for (const slug of nextState.watchlist || []) addWatch.run(REGION, slug, isoNow());

    db.prepare('DELETE FROM products WHERE region=?').run(REGION);
    const addProduct = db.prepare('INSERT INTO products(region,slug,data_json,updated_at) VALUES(?,?,?,?)');
    for (const [slug, product] of Object.entries(nextState.products || {})) addProduct.run(REGION, slug, JSON.stringify(product), isoNow());

    db.prepare('DELETE FROM events WHERE region=?').run(REGION);
    const addEvent = db.prepare('INSERT INTO events(id,region,detected_at,data_json) VALUES(?,?,?,?)');
    for (const event of (nextState.events || []).slice(-1000)) addEvent.run(event.id, REGION, event.detectedAt || isoNow(), JSON.stringify(event));

    db.exec('DELETE FROM push_tokens');
    const addToken = db.prepare('INSERT INTO push_tokens(token,created_at) VALUES(?,?)');
    for (const token of nextState.pushTokens || []) addToken.run(token, isoNow());
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

const previousAppVersion = dbExistedAtStartup ? getMeta('last_app_version') : null;
if (dbExistedAtStartup && previousAppVersion && previousAppVersion !== APP_VERSION) {
  const backup = createDatabaseBackup(`pre-update-${previousAppVersion}-to-${APP_VERSION}`);
  if (backup) console.log(`[data] safety backup created before version migration: ${backup.filename}`);
}
runMigrations();
importLegacyStateIfNeeded();
setMeta('last_app_version', APP_VERSION);
setMeta('last_started_at', isoNow());

let state = loadState();
let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistState(state);
  }, 100);
}

function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistState(state);
}

let buildIdCache = { value: null, fetchedAt: 0 };
let monitor = {
  checking: false,
  lastCheckAt: null,
  lastSuccessAt: null,
  nextCheckAt: null,
  lastError: null,
  productCount: Object.keys(state.products).length,
  cycle: 0,
  consecutiveFailures: 0,
  lastDurationMs: null,
  catalogHealth: 'starting',
  partialErrors: [],
  lastAlertAt: null,
};

const mockOverrides = {};
const MOCK_PRODUCTS = [
  { slug: 'u7-pro-xgs', name: 'U7 Pro XGS', category: 'WiFi', price: '$299.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F1604d78c-6e51-4fe8-a8e5-0110cc332ba0%2F73d680d3-c54b-48fb-a5f5-51c31c97b5d6.png&w=256' },
  { slug: 'uvc-ai-turret', name: 'AI Turret', category: 'Cameras & Physical Security', price: '$399.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F995b6a91-fab1-4c15-b5b9-6dfdede19bab%2Fc5c464e2-6c87-4397-9f9a-6dc09d7afca3.png&w=256' },
  { slug: 'unas-pro', name: 'UNAS Pro', category: 'Network Storage', price: '$499.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2Fc73f5f36-f1af-4eb2-bf44-8a9f31eb3e3b%2F12fd2396-b8ae-4bb5-8898-16f400afaed0.png&w=256' },
  { slug: 'usw-pro-max-24-poe', name: 'Pro Max 24 PoE', category: 'Switching', price: '$799.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F58922518-88f6-4c75-89c1-f57ba3d8253a%2F9a68d63e-39cf-4d14-83ff-79d2c35b1b8c.png&w=256' },
  { slug: 'udm-se', name: 'Dream Machine Special Edition', category: 'Cloud Gateways', price: '$499.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F1b6fcc08-a6b8-4496-a831-6125a47c412f%2Fc1d1e0e0-4ec6-4760-9bc2-81cdfdf3eaa5.png&w=256' },
  { slug: 'uvc-g5-ptz', name: 'G5 PTZ', category: 'Cameras & Physical Security', price: '$299.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2Fe3cbecf3-07dc-4f09-82e1-b88dca942d7a%2F8db989da-7174-4288-8d46-b486a20e11c3.png&w=256' },
];

function mockCatalog() {
  return MOCK_PRODUCTS.map((p) => {
    const status = mockOverrides[p.slug] || p.status;
    return {
      ...p,
      status,
      imageUrl: p.imageUrl || null,
      inStock: status === 'Available',
      comingSoon: status === 'ComingSoon',
      restockEtaAt: null,
      soldOutAt: status === 'SoldOut' ? isoNow() : null,
      url: `${STORE_BASE}/${REGIONS[REGION].path}/products/${p.slug}`,
      region: REGION,
      lastSeenAt: isoNow(),
    };
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getBuildId(force = false) {
  const freshForMs = 5 * 60 * 1000;
  if (!force && buildIdCache.value && Date.now() - buildIdCache.fetchedAt < freshForMs) {
    return buildIdCache.value;
  }
  const home = `${STORE_BASE}/${REGIONS[REGION].path}`;
  const res = await fetchWithTimeout(home, { headers: HEADERS });
  if (!res.ok) throw new Error(`Store homepage returned HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/"buildId":"([^"]+)"/);
  if (!match) throw new Error('Could not discover the UniFi Store Next.js buildId.');
  buildIdCache = { value: match[1], fetchedAt: Date.now() };
  return match[1];
}

function redirectToPagePath(target, buildId) {
  const parsed = new URL(target, STORE_BASE);
  let pathname = parsed.pathname;
  const prefix = `/_next/data/${buildId}`;
  if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length);
  if (pathname.endsWith('.json')) pathname = pathname.slice(0, -5);
  return pathname;
}

async function fetchCategory(buildId, category) {
  let pagePath = `/${REGIONS[REGION].path}/${category}`;
  for (let hop = 0; hop < 4; hop += 1) {
    const dataUrl = `${STORE_BASE}/_next/data/${buildId}${pagePath}.json`;
    const res = await fetchWithTimeout(dataUrl, { headers: HEADERS, redirect: 'manual' });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const target = res.headers.get('location') || res.headers.get('x-nextjs-redirect');
      if (!target) throw new Error(`${category}: redirect without target`);
      pagePath = redirectToPagePath(target, buildId);
      continue;
    }
    if (res.status === 404) {
      const err = new Error(`${category}: build or route returned 404`);
      err.code = 'BUILD_OR_ROUTE_404';
      throw err;
    }
    if (!res.ok) throw new Error(`${category}: HTTP ${res.status}`);

    const payload = await res.json();
    const props = payload.pageProps || {};
    if (props.__N_REDIRECT) {
      pagePath = redirectToPagePath(props.__N_REDIRECT, buildId);
      if (!pagePath.includes('/category/')) return [];
      continue;
    }

    const found = new Map();
    for (const subcat of props.subCategories || []) {
      for (const product of subcat.products || []) {
        if (product && product.slug) found.set(product.slug, { ...product, _category: category });
      }
    }
    for (const product of props.products || []) {
      if (product && product.slug && !found.has(product.slug)) {
        found.set(product.slug, { ...product, _category: category });
      }
    }
    return [...found.values()];
  }
  throw new Error(`${category}: too many redirects`);
}

function moneyToText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return `$${value.toFixed(2)}`;
  if (typeof value === 'object') {
    const amount = Number(value.amount || 0);
    if (!amount) return null;
    const currency = value.currency || REGIONS[REGION].currency;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
    } catch {
      return `${(amount / 100).toFixed(2)} ${currency}`;
    }
  }
  return String(value);
}

function firstPrice(product) {
  for (const variant of product.variants || []) {
    const p = variant.displayPrice ?? variant.price;
    const text = moneyToText(p);
    if (text) return text;
  }
  return null;
}

function minIso(values) {
  const dates = values.filter(Boolean).map((x) => new Date(x)).filter((d) => !Number.isNaN(d.valueOf()));
  if (!dates.length) return null;
  return new Date(Math.min(...dates.map((d) => d.valueOf()))).toISOString();
}

function maxIso(values) {
  const dates = values.filter(Boolean).map((x) => new Date(x)).filter((d) => !Number.isNaN(d.valueOf()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.valueOf()))).toISOString();
}


function normalizeImageUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(text, STORE_BASE);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (['images.svc.ui.com', 'cdn.ecomm.ui.com', 'assets.ecomm.ui.com'].includes(host) || /\.(png|jpe?g|webp|avif)$/i.test(path)) return url.href;
  } catch {}
  return null;
}

function collectImageCandidates(value, keyHint = '', depth = 0, out = []) {
  if (depth > 5 || value == null) return out;
  if (typeof value === 'string') {
    if (/image|img|thumb|media|src|url|poster/i.test(keyHint)) {
      const normalized = normalizeImageUrl(value);
      if (normalized) out.push(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 24).forEach((item) => collectImageCandidates(item, keyHint, depth + 1, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (/image|img|thumb|media|src|url|poster|gallery|asset/i.test(key) || depth < 2) {
        collectImageCandidates(item, key, depth + 1, out);
      }
    });
  }
  return out;
}

function firstImage(product) {
  const roots = [
    ['thumbnail', product.thumbnail],
    ['thumbnailUrl', product.thumbnailUrl],
    ['image', product.image],
    ['imageUrl', product.imageUrl],
    ['images', product.images],
    ['media', product.media],
    ['gallery', product.gallery],
    ['variants', product.variants],
    ['product', product],
  ];
  const candidates = [];
  for (const [key, value] of roots) collectImageCandidates(value, key, 0, candidates);
  const unique = [...new Set(candidates)];
  const score = (url) => {
    let n = 0;
    if (url.includes('images.svc.ui.com')) n += 50;
    if (url.includes('cdn.ecomm.ui.com')) n += 40;
    if (url.includes('assets.ecomm.ui.com')) n += 10;
    if (/\.(png|webp|avif)(?:$|\?)/i.test(url)) n += 5;
    if (/flag|icon|logo|swatch|badge/i.test(url)) n -= 100;
    return n;
  };
  unique.sort((a, b) => score(b) - score(a));
  return unique[0] || null;
}

function normalizeProduct(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const statuses = variants.map((v) => v.status).filter(Boolean);
  const inStock = statuses.includes('Available');
  const comingSoon = !inStock && statuses.includes('ComingSoon');
  const status = inStock ? 'Available' : comingSoon ? 'ComingSoon' : (statuses[0] || 'SoldOut');
  const name = product.title || product.name || product.displayName || product.slug;
  const category = CATEGORY_LABELS[product._category] || String(product._category || '').replace('category/', '') || 'Other';
  return {
    slug: product.slug,
    name,
    category,
    imageUrl: firstImage(product),
    price: firstPrice(product),
    status,
    inStock,
    comingSoon,
    restockEtaAt: minIso(variants.map((v) => v.restockEtaAt)),
    soldOutAt: maxIso(variants.map((v) => v.soldOutAt)),
    url: `${STORE_BASE}/${REGIONS[REGION].path}/products/${product.slug}`,
    region: REGION,
    lastSeenAt: isoNow(),
  };
}

async function fetchCatalogWithBuild(buildId) {
  const results = await Promise.allSettled(CATEGORIES.map((category) => fetchCategory(buildId, category)));
  let saw404 = false;
  const raw = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') raw.push(...result.value);
    else {
      if (result.reason && result.reason.code === 'BUILD_OR_ROUTE_404') saw404 = true;
      errors.push(`${CATEGORIES[index]}: ${result.reason?.message || result.reason}`);
    }
  });
  if (saw404) {
    const err = new Error('One or more category endpoints returned 404.');
    err.code = 'BUILD_OR_ROUTE_404';
    throw err;
  }
  if (!raw.length) throw new Error(`No products fetched. ${errors.join(' | ')}`);
  monitor.partialErrors = errors.slice(0, 8);
  const deduped = new Map();
  raw.forEach((p) => { if (p.slug) deduped.set(p.slug, p); });
  return [...deduped.values()].map(normalizeProduct);
}

async function fetchCatalog() {
  if (MOCK_MODE) return mockCatalog();
  let buildId = await getBuildId(false);
  try {
    return await fetchCatalogWithBuild(buildId);
  } catch (err) {
    if (err && err.code === 'BUILD_OR_ROUTE_404') {
      buildId = await getBuildId(true);
      return await fetchCatalogWithBuild(buildId);
    }
    throw err;
  }
}

function createEvent(type, previous, current, watchedAtDetection) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    slug: current.slug,
    name: current.name,
    category: current.category,
    price: current.price,
    previousPrice: previous?.price || null,
    previousStatus: previous?.status || null,
    status: current.status,
    inStock: current.inStock,
    watchedAtDetection,
    url: current.url,
    region: REGION,
    detectedAt: isoNow(),
  };
}

async function postJson(url, body, headers = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, 10000);
  const text = await res.text();
  const parsed = safeJsonParse(text, null);
  if (!res.ok) throw new Error(`HTTP ${res.status}${parsed?.errors?.[0]?.message ? `: ${parsed.errors[0].message}` : ''}`);
  return { res, data: parsed, text };
}

function notificationCopy(event) {
  const region = REGIONS[event.region || REGION]?.label || String(event.region || REGION).toUpperCase();
  if (event.type === 'sold_out') return {
    title: `${event.name} sold out`,
    body: `${event.price ? `${event.price} · ` : ''}${region}`,
    ntfyTags: 'package,x',
  };
  if (event.type === 'price_change') return {
    title: `${event.name} price changed`,
    body: `${event.previousPrice || 'Previous price'} → ${event.price || 'new price'} · ${region}`,
    ntfyTags: 'moneybag,package',
  };
  if (event.type === 'status_change') return {
    title: `${event.name} status changed`,
    body: `${event.previousStatus || 'Unknown'} → ${event.status || 'Unknown'} · ${region}`,
    ntfyTags: 'package',
  };
  if (event.type === 'new_product') return {
    title: `New UniFi product: ${event.name}`,
    body: `${event.price ? `${event.price} · ` : ''}${region}`,
    ntfyTags: 'new,package',
  };
  if (event.type === 'test') return {
    title: 'GearBeacon test notification',
    body: `Notifications are working · ${region}`,
    ntfyTags: 'white_check_mark,package',
  };
  return {
    title: `🚨 ${event.name} is back in stock`,
    body: `${event.price ? `${event.price} · ` : ''}${region} · detected now`,
    ntfyTags: 'rotating_light,package',
  };
}

function shouldNotifyEvent(event, prefs = notificationPreferences()) {
  if (event.type === 'test') return true;
  if (event.type === 'new_product') return Boolean(prefs.newProduct);
  if (!event.watchedAtDetection) return false;
  if (event.type === 'restock') return Boolean(prefs.restock);
  if (event.type === 'sold_out') return Boolean(prefs.soldOut);
  if (event.type === 'price_change') return Boolean(prefs.priceChange);
  if (event.type === 'status_change') return Boolean(prefs.statusChange);
  return false;
}

function logNotification(eventId, channel, status, detail = null) {
  try {
    db.prepare('INSERT INTO notification_log(event_id,channel,status,detail,created_at) VALUES(?,?,?,?,?)')
      .run(eventId || null, channel, status, detail ? String(detail).slice(0, 1000) : null, isoNow());
    db.prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY id DESC LIMIT 2000)').run();
  } catch (err) {
    console.error('[alert-log]', err?.message || err);
  }
}

async function sendExpoPush(token, event) {
  const copy = notificationCopy(event);
  const payload = {
    to: token,
    sound: 'default',
    priority: 'high',
    title: copy.title,
    body: copy.body,
    data: { url: event.url || null, slug: event.slug || null, eventId: event.id, type: event.type },
  };
  const { data } = await postJson('https://exp.host/--/api/v2/push/send', payload, {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...(EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${EXPO_ACCESS_TOKEN}` } : {}),
  });
  const ticket = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (ticket?.status === 'error') {
    const code = ticket?.details?.error || 'ExpoPushError';
    const err = new Error(`${code}: ${ticket.message || 'Expo rejected push'}`);
    err.code = code;
    throw err;
  }
  return ticket?.id || null;
}

async function sendNtfy(event) {
  if (!NTFY_TOPIC) return null;
  const url = `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`;
  const copy = notificationCopy(event);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Title: copy.title,
      Priority: event.type === 'restock' ? '5' : '3',
      Tags: copy.ntfyTags,
      ...(event.url ? { Click: event.url } : {}),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: copy.body,
  }, 10000);
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  return true;
}

async function sendDiscord(event) {
  if (!DISCORD_WEBHOOK_URL) return null;
  const copy = notificationCopy(event);
  const suffix = event.url ? `\n${event.url}` : '';
  await postJson(DISCORD_WEBHOOK_URL, { content: `**GearBeacon:** ${copy.title}\n${copy.body}${suffix}` });
  return true;
}

async function sendAlert(event) {
  const outcomes = [];
  for (const token of [...state.pushTokens]) {
    try {
      const ticket = await sendExpoPush(token, event);
      outcomes.push({ channel: 'expo', ok: true, ticket });
      logNotification(event.id, 'expo', 'sent', ticket || token.slice(0, 22));
    } catch (err) {
      const message = err?.message || String(err);
      outcomes.push({ channel: 'expo', ok: false, error: message });
      logNotification(event.id, 'expo', 'failed', message);
      console.error('[alert:expo]', message);
      if (err?.code === 'DeviceNotRegistered') {
        state.pushTokens = state.pushTokens.filter((value) => value !== token);
        db.prepare('DELETE FROM push_tokens WHERE token=?').run(token);
      }
    }
  }
  if (NTFY_TOPIC) {
    try { await sendNtfy(event); outcomes.push({ channel: 'ntfy', ok: true }); logNotification(event.id, 'ntfy', 'sent'); }
    catch (err) { const message = err?.message || String(err); outcomes.push({ channel: 'ntfy', ok: false, error: message }); logNotification(event.id, 'ntfy', 'failed', message); console.error('[alert:ntfy]', message); }
  }
  if (DISCORD_WEBHOOK_URL) {
    try { await sendDiscord(event); outcomes.push({ channel: 'discord', ok: true }); logNotification(event.id, 'discord', 'sent'); }
    catch (err) { const message = err?.message || String(err); outcomes.push({ channel: 'discord', ok: false, error: message }); logNotification(event.id, 'discord', 'failed', message); console.error('[alert:discord]', message); }
  }
  if (outcomes.some((item) => item.ok)) monitor.lastAlertAt = isoNow();
  return outcomes;
}

async function sendTestNotification() {
  const event = {
    id: `test-${Date.now()}`,
    type: 'test',
    slug: null,
    name: 'GearBeacon',
    price: null,
    previousPrice: null,
    previousStatus: null,
    status: 'test',
    inStock: false,
    watchedAtDetection: false,
    url: PUBLIC_BASE_URL || null,
    region: REGION,
    detectedAt: isoNow(),
  };
  const outcomes = await sendAlert(event);
  const configured = state.pushTokens.length + (NTFY_TOPIC ? 1 : 0) + (DISCORD_WEBHOOK_URL ? 1 : 0);
  return { ok: outcomes.some((item) => item.ok), configuredChannels: configured, outcomes };
}

function recordEvent(event) {
  state.events.push(event);
  if (state.events.length > 1000) state.events = state.events.slice(-1000);
  saveStateSoon();
}

async function checkStore(reason = 'timer') {
  if (monitor.checking) return { skipped: true, reason: 'already checking' };
  const startedAt = Date.now();
  monitor.checking = true;
  monitor.lastCheckAt = isoNow();
  monitor.lastError = null;
  monitor.cycle += 1;
  console.log(`[monitor] ${monitor.lastCheckAt} check #${monitor.cycle} (${reason})`);

  try {
    const catalog = await fetchCatalog();
    const knownCount = Object.keys(state.products).length;
    if (!MOCK_MODE && knownCount >= 20 && catalog.length < Math.max(10, Math.floor(knownCount * MIN_CATALOG_RATIO))) {
      throw new Error(`Catalog health guard rejected ${catalog.length} products; previous baseline has ${knownCount}. No stock state was changed.`);
    }

    const incoming = {};
    const notifications = [];
    const prefs = notificationPreferences();
    const watch = new Set(state.watchlist);
    const hadBaseline = knownCount > 0;

    for (const product of catalog) {
      incoming[product.slug] = product;
      const previous = state.products[product.slug];
      if (!previous) {
        if (hadBaseline) {
          const event = createEvent('new_product', null, product, false);
          recordEvent(event);
          if (shouldNotifyEvent(event, prefs)) notifications.push(event);
        }
        continue;
      }
      const watchedAtDetection = watch.has(product.slug);

      if (!previous.inStock && product.inStock) {
        const event = createEvent('restock', previous, product, watchedAtDetection);
        recordEvent(event);
        if (shouldNotifyEvent(event, prefs)) notifications.push(event);
      } else if (previous.inStock && !product.inStock) {
        const event = createEvent('sold_out', previous, product, watchedAtDetection);
        recordEvent(event);
        if (shouldNotifyEvent(event, prefs)) notifications.push(event);
      } else if (previous.status !== product.status) {
        const event = createEvent('status_change', previous, product, watchedAtDetection);
        recordEvent(event);
        if (shouldNotifyEvent(event, prefs)) notifications.push(event);
      }

      if (previous.price && product.price && previous.price !== product.price) {
        const event = createEvent('price_change', previous, product, watchedAtDetection);
        recordEvent(event);
        if (shouldNotifyEvent(event, prefs)) notifications.push(event);
      }
    }

    // Preserve products that temporarily disappear from a partial catalog fetch.
    // GearBeacon never infers a sellout from a missing response.
    state.products = { ...state.products, ...incoming };
    monitor.productCount = Object.keys(incoming).length;
    monitor.lastSuccessAt = isoNow();
    monitor.consecutiveFailures = 0;
    monitor.catalogHealth = monitor.partialErrors.length ? 'degraded' : 'healthy';
    saveStateSoon();

    for (const event of notifications) await sendAlert(event);
    console.log(`[monitor] success: ${monitor.productCount} products, ${notifications.length} notification event(s)`);
    return { ok: true, products: monitor.productCount, notifications: notifications.length, catalogHealth: monitor.catalogHealth };
  } catch (err) {
    monitor.consecutiveFailures += 1;
    monitor.lastError = err?.message || String(err);
    const lastSuccessAge = monitor.lastSuccessAt ? (Date.now() - new Date(monitor.lastSuccessAt).getTime()) / 1000 : Infinity;
    monitor.catalogHealth = lastSuccessAge > STALE_AFTER_SECONDS ? 'stale' : 'error';
    console.error('[monitor] failed:', monitor.lastError);
    return { ok: false, error: monitor.lastError, consecutiveFailures: monitor.consecutiveFailures };
  } finally {
    monitor.checking = false;
    monitor.lastDurationMs = Date.now() - startedAt;
  }
}

let monitorTimer = null;
function monitorDelaySeconds() {
  if (!monitor.consecutiveFailures) return POLL_SECONDS;
  return Math.min(15 * 60, POLL_SECONDS * (2 ** Math.min(monitor.consecutiveFailures, 4)));
}

function scheduleMonitor() {
  if (monitorTimer) clearTimeout(monitorTimer);
  const delaySeconds = monitorDelaySeconds();
  monitor.nextCheckAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  monitorTimer = setTimeout(async () => {
    await checkStore('timer');
    scheduleMonitor();
  }, delaySeconds * 1000);
  monitorTimer.unref();
}

function productForApi(product) {
  if (!product) return null;
  return { ...product, watched: state.watchlist.includes(product.slug) };
}

function backupSummary() {
  const backups = listBackups().filter((item) => item.name.endsWith('.sqlite3'));
  return {
    count: backups.length,
    retention: BACKUP_RETENTION,
    latest: backups[0] || null,
  };
}

function dataInfo() {
  return {
    persistent: true,
    engine: 'SQLite',
    databasePath: DB_FILE,
    userDataDir: USER_DATA_DIR,
    backupDir: BACKUP_DIR,
    schemaVersion: schemaVersion(),
    expectedSchemaVersion: DATABASE_SCHEMA_VERSION,
    backup: backupSummary(),
    legacySource: getMeta('legacy_source'),
  };
}

function exportSnapshot() {
  flushState();
  const settings = {};
  if (tableExists('settings')) {
    for (const row of db.prepare('SELECT key,value FROM settings').all()) settings[row.key] = row.value;
  }
  return {
    format: 'GearBeaconBackup',
    formatVersion: 1,
    exportedAt: isoNow(),
    appVersion: APP_VERSION,
    schemaVersion: schemaVersion(),
    region: REGION,
    watchlist: [...state.watchlist],
    products: state.products,
    events: state.events,
    pushTokens: [...state.pushTokens],
    settings,
  };
}

function normalizeImportedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Backup file is not valid JSON data.');
  const isBackup = snapshot.format === 'GearBeaconBackup';
  const isLegacy = !snapshot.format && (Array.isArray(snapshot.watchlist) || snapshot.products || Array.isArray(snapshot.events));
  if (!isBackup && !isLegacy) throw new Error('This file is not a GearBeacon backup or legacy GearBeacon state file.');
  if (isBackup && Number(snapshot.formatVersion || 0) > 1) throw new Error(`This backup format (${snapshot.formatVersion}) is newer than GearBeacon ${APP_VERSION} supports.`);
  return {
    watchlist: Array.isArray(snapshot.watchlist) ? snapshot.watchlist.map(String).filter(Boolean) : [],
    products: snapshot.products && typeof snapshot.products === 'object' && !Array.isArray(snapshot.products) ? snapshot.products : {},
    events: Array.isArray(snapshot.events) ? snapshot.events.filter((e) => e && e.id).slice(-1000) : [],
    pushTokens: Array.isArray(snapshot.pushTokens) ? snapshot.pushTokens.map(String).filter(Boolean) : [],
    settings: snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings) ? snapshot.settings : {},
  };
}

function importSnapshot(snapshot) {
  const normalized = normalizeImportedSnapshot(snapshot);
  flushState();
  const safety = createDatabaseBackup('pre-import');
  persistState(normalized);
  if (tableExists('settings')) {
    db.exec('DELETE FROM settings');
    const put = db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)');
    for (const [key, value] of Object.entries(normalized.settings)) put.run(String(key), String(value), isoNow());
  }
  state = loadState();
  monitor.productCount = Object.keys(state.products).length;
  setMeta('last_import_at', isoNow());
  return { ok: true, watchCount: state.watchlist.length, eventCount: state.events.length, safetyBackup: safety };
}

function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function normalizeReleasePayload(payload, source) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.latestVersion) return {
    latestVersion: String(payload.latestVersion),
    downloadUrl: payload.downloadUrl || null,
    releaseNotes: payload.releaseNotes || payload.notes || null,
    publishedAt: payload.publishedAt || null,
    releasePageUrl: payload.releasePageUrl || null,
    source,
  };
  if (payload.tag_name) {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const zipAsset = assets.find((a) => /gearbeacon.*\.zip$/i.test(String(a?.name || '')))
      || assets.find((a) => /\.zip$/i.test(String(a?.name || '')));
    return {
      latestVersion: String(payload.tag_name).replace(/^v/i, ''),
      downloadUrl: zipAsset?.browser_download_url || payload.html_url || null,
      releaseNotes: payload.body || null,
      publishedAt: payload.published_at || payload.created_at || null,
      releasePageUrl: payload.html_url || null,
      source,
    };
  }
  return null;
}

async function fetchReleaseJson(url, source) {
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.github+json, application/json',
      'User-Agent': `GearBeacon/${APP_VERSION}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const normalized = normalizeReleasePayload(payload, source);
  if (!normalized?.latestVersion) throw new Error('Release payload did not include a version.');
  return normalized;
}

async function readUpdateManifest() {
  const warnings = [];
  if (UPDATE_MANIFEST_URL) {
    try {
      const remote = await fetchReleaseJson(UPDATE_MANIFEST_URL, UPDATE_MANIFEST_URL);
      return { manifest: remote, source: UPDATE_MANIFEST_URL, warning: null };
    } catch (err) {
      warnings.push(`Configured update channel failed: ${err?.message || String(err)}.`);
    }
  } else if (GITHUB_RELEASE_API) {
    try {
      const github = await fetchReleaseJson(GITHUB_RELEASE_API, 'GitHub Releases');
      return { manifest: github, source: 'GitHub Releases', warning: null };
    } catch (err) {
      warnings.push(`GitHub Releases check failed: ${err?.message || String(err)}.`);
    }
  }

  if (!fs.existsSync(RELEASE_MANIFEST_FILE)) throw new Error(`${warnings.join(' ')} No bundled GearBeacon release information is available.`);
  const payload = safeJsonParse(fs.readFileSync(RELEASE_MANIFEST_FILE, 'utf8'), null);
  const bundled = normalizeReleasePayload(payload, 'bundled');
  if (!bundled?.latestVersion) throw new Error('The bundled GearBeacon update manifest is invalid.');
  return { manifest: bundled, source: 'bundled', warning: warnings.length ? `${warnings.join(' ')} Using bundled release information.` : null };
}

async function checkForUpdates() {
  const { manifest, source, warning } = await readUpdateManifest();
  const latestVersion = String(manifest.latestVersion);
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    downloadUrl: manifest.downloadUrl || null,
    releasePageUrl: manifest.releasePageUrl || null,
    releaseNotes: manifest.releaseNotes || null,
    publishedAt: manifest.publishedAt || null,
    source,
    warning,
    checkedAt: isoNow(),
  };
}

function apiStatus() {
  const stale = !monitor.lastSuccessAt || (Date.now() - new Date(monitor.lastSuccessAt).getTime()) / 1000 > STALE_AFTER_SECONDS;
  return {
    name: 'GearBeacon',
    version: APP_VERSION,
    region: REGION,
    regionLabel: REGIONS[REGION].label,
    pollSeconds: POLL_SECONDS,
    mockMode: MOCK_MODE,
    deployment: { mode: DEPLOYMENT_MODE, publicBaseUrl: PUBLIC_BASE_URL || null },
    storage: { engine: 'SQLite', schemaVersion: schemaVersion(), userDataDir: USER_DATA_DIR },
    notifications: {
      expoPushDevices: state.pushTokens.length,
      ntfyConfigured: Boolean(NTFY_TOPIC),
      discordConfigured: Boolean(DISCORD_WEBHOOK_URL),
      preferences: notificationPreferences(),
    },
    health: {
      ok: Boolean(monitor.lastSuccessAt) && !stale && !monitor.lastError,
      stale,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      minCatalogRatio: MIN_CATALOG_RATIO,
    },
    ...monitor,
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendJsonDownload(res, body, filename) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Content-Disposition': `attachment; filename="${safeFilePart(filename)}"`,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readBody(req, maxBytes);
  const parsed = raw ? safeJsonParse(raw, null) : {};
  if (raw && parsed == null) throw new Error('Request body is not valid JSON.');
  return parsed;
}

function staticFileFor(urlPath) {
  const clean = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(WEB_DIR, clean));
  if (!full.startsWith(path.normalize(WEB_DIR))) return null;
  return full;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  })[ext] || 'application/octet-stream';
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, apiStatus());
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const status = apiStatus();
    return sendJson(res, status.health.ok || MOCK_MODE ? 200 : 503, { ok: status.health.ok || MOCK_MODE, health: status.health, monitor: { lastSuccessAt: status.lastSuccessAt, lastError: status.lastError, consecutiveFailures: status.consecutiveFailures, catalogHealth: status.catalogHealth } });
  }

  if (req.method === 'GET' && url.pathname === '/api/data/info') {
    return sendJson(res, 200, dataInfo());
  }

  if (req.method === 'GET' && url.pathname === '/api/data/export') {
    const stamp = new Date().toISOString().slice(0, 10);
    return sendJsonDownload(res, exportSnapshot(), `GearBeacon-Backup-${stamp}.gearbeacon.json`);
  }

  if (req.method === 'POST' && url.pathname === '/api/data/import') {
    const body = await readJsonBody(req, 25 * 1024 * 1024);
    const result = importSnapshot(body);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/data/backup') {
    flushState();
    const backup = createDatabaseBackup('manual');
    return sendJson(res, 200, { ok: true, backup, summary: backupSummary() });
  }

  if (req.method === 'GET' && url.pathname === '/api/update/check') {
    return sendJson(res, 200, await checkForUpdates());
  }

  if (req.method === 'GET' && url.pathname === '/api/products') {
    const search = String(url.searchParams.get('search') || '').toLowerCase().trim();
    const watchOnly = url.searchParams.get('watchOnly') === '1';
    let products = Object.values(state.products).map(productForApi);
    if (watchOnly) products = products.filter((p) => p.watched);
    if (search) products = products.filter((p) => `${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(search));
    products.sort((a, b) => Number(b.watched) - Number(a.watched) || a.name.localeCompare(b.name));
    return sendJson(res, 200, { products, count: products.length });
  }

  if (req.method === 'GET' && url.pathname === '/api/watchlist') {
    const items = state.watchlist.map((slug) => productForApi(state.products[slug]) || {
      slug,
      name: slug,
      category: 'Unknown',
      status: 'Unknown',
      inStock: false,
      comingSoon: false,
      price: null,
      url: `${STORE_BASE}/${REGIONS[REGION].path}/products/${slug}`,
      region: REGION,
      watched: true,
    });
    return sendJson(res, 200, { products: items, count: items.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/watch') {
    const body = await readJsonBody(req);
    const slug = String(body?.slug || '').trim();
    if (!slug) return sendJson(res, 400, { error: 'slug is required' });
    if (!state.watchlist.includes(slug)) state.watchlist.push(slug);
    saveStateSoon();
    return sendJson(res, 200, { ok: true, product: productForApi(state.products[slug]), watchlist: state.watchlist });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/watch/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/watch/'.length));
    state.watchlist = state.watchlist.filter((x) => x !== slug);
    saveStateSoon();
    return sendJson(res, 200, { ok: true, watchlist: state.watchlist });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const events = state.events.slice(-limit).reverse();
    return sendJson(res, 200, { events, count: events.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    const result = await checkStore('manual');
    scheduleMonitor();
    return sendJson(res, result.ok === false ? 502 : 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/push/register') {
    const body = await readJsonBody(req);
    const token = String(body?.token || '').trim();
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
      return sendJson(res, 400, { error: 'A valid Expo push token is required.' });
    }
    if (!state.pushTokens.includes(token)) state.pushTokens.push(token);
    db.prepare('INSERT INTO push_tokens(token,created_at) VALUES(?,?) ON CONFLICT(token) DO NOTHING').run(token, isoNow());
    return sendJson(res, 200, { ok: true, registeredDevices: state.pushTokens.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/push/unregister') {
    const body = await readJsonBody(req);
    const token = String(body?.token || '').trim();
    if (!token) return sendJson(res, 400, { error: 'token is required' });
    state.pushTokens = state.pushTokens.filter((value) => value !== token);
    db.prepare('DELETE FROM push_tokens WHERE token=?').run(token);
    return sendJson(res, 200, { ok: true, registeredDevices: state.pushTokens.length });
  }

  if (req.method === 'GET' && url.pathname === '/api/notifications/preferences') {
    return sendJson(res, 200, { preferences: notificationPreferences() });
  }

  if (req.method === 'PUT' && url.pathname === '/api/notifications/preferences') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, preferences: updateNotificationPreferences(body?.preferences || body || {}) });
  }

  if (req.method === 'POST' && url.pathname === '/api/notifications/test') {
    const result = await sendTestNotification();
    if (!result.configuredChannels) return sendJson(res, 409, { error: 'No server-side notification channel is configured or registered.', ...result });
    return sendJson(res, result.ok ? 200 : 502, result.ok ? result : { error: 'All configured notification channels failed.', ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/notifications/log') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
    const rows = db.prepare('SELECT id,event_id,channel,status,detail,created_at FROM notification_log ORDER BY id DESC LIMIT ?').all(limit);
    return sendJson(res, 200, { notifications: rows, count: rows.length });
  }

  if (MOCK_MODE && req.method === 'POST' && url.pathname.startsWith('/api/mock/toggle/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/mock/toggle/'.length));
    const existing = mockCatalog().find((p) => p.slug === slug);
    if (!existing) return sendJson(res, 404, { error: 'mock product not found' });
    mockOverrides[slug] = existing.inStock ? 'SoldOut' : 'Available';
    return sendJson(res, 200, { ok: true, slug, status: mockOverrides[slug] });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, name: 'GearBeacon', version: APP_VERSION });
    if (url.pathname === '/readyz') {
      const status = apiStatus();
      const ready = MOCK_MODE || status.health.ok;
      return sendJson(res, ready ? 200 : 503, { ok: ready, version: APP_VERSION, health: status.health, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    const file = staticFileFor(url.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return sendText(res, 404, 'Not found');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
    else res.end();
  }
});

async function start() {
  console.log('');
  console.log(`  GearBeacon V${APP_VERSION}`);
  console.log('  Know the second it\'s back.');
  console.log('');
  console.log(`  Region:      ${REGIONS[REGION].label}`);
  console.log(`  Poll:        ${POLL_SECONDS}s`);
  console.log(`  Deployment:  ${DEPLOYMENT_MODE}`);
  console.log(`  Mock mode:   ${MOCK_MODE ? 'ON' : 'off'}`);
  console.log(`  ntfy:        ${NTFY_TOPIC ? 'configured' : 'off'}`);
  console.log(`  Discord:     ${DISCORD_WEBHOOK_URL ? 'configured' : 'off'}`);
  console.log(`  Data:        ${USER_DATA_DIR}`);
  console.log(`  Database:    ${path.basename(DB_FILE)} · schema v${schemaVersion()}`);
  console.log('');

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`  Dashboard:   http://localhost:${PORT}`);
    console.log(`  LAN API:     http://YOUR-COMPUTER-IP:${PORT}`);
    console.log('');
  });

  await checkStore('startup');
  scheduleMonitor();
}

function shutdown(signal) {
  if (monitorTimer) clearTimeout(monitorTimer);
  try { flushState(); } catch (err) { console.error('[data] final save failed:', err?.message || err); }
  try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch {}
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
