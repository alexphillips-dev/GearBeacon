// GearBeacon V1.5 backend
// Private, owner-operated stock monitoring for local and self-hosted installs.
// @ts-nocheck
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { AsyncLocalStorage } = require('node:async_hooks');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const APP_VERSION = '1.5.0';
const DATABASE_SCHEMA_VERSION = 4;
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
const requestedRegions = String(process.env.REGIONS || process.env.REGION || 'us')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const ACTIVE_REGIONS = [...new Set(requestedRegions.filter((value) => REGIONS[value]))];
if (!ACTIVE_REGIONS.length)
    ACTIVE_REGIONS.push('us');
const DEFAULT_REGION = ACTIVE_REGIONS[0];
const regionContext = new AsyncLocalStorage();
function currentRegion() { return regionContext.getStore() || DEFAULT_REGION; }
const PORT = Number(process.env.PORT || 8787);
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_SECONDS || 60));
const NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim();
const NTFY_BASE_URL = String(process.env.NTFY_BASE_URL || 'https://ntfy.sh').trim().replace(/\/$/, '');
const NTFY_TOKEN = String(process.env.NTFY_TOKEN || '').trim();
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
const GENERIC_WEBHOOK_URL = String(process.env.GEARBEACON_WEBHOOK_URL || '').trim();
const GENERIC_WEBHOOK_TOKEN = String(process.env.GEARBEACON_WEBHOOK_TOKEN || '').trim();
const GOTIFY_BASE_URL = String(process.env.GOTIFY_BASE_URL || '').trim().replace(/\/$/, '');
const GOTIFY_TOKEN = String(process.env.GOTIFY_TOKEN || '').trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Math.max(1, Number(process.env.SMTP_PORT || 587));
const SMTP_SECURE = ['1', 'true', 'yes'].includes(String(process.env.SMTP_SECURE || '').toLowerCase()) || SMTP_PORT === 465;
const SMTP_USER = String(process.env.SMTP_USER || '');
const SMTP_PASSWORD = String(process.env.SMTP_PASSWORD || '');
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
const SMTP_TO = String(process.env.SMTP_TO || '').split(',').map((value) => value.trim()).filter(Boolean);
const MOCK_MODE = ['1', 'true', 'yes'].includes(String(process.env.MOCK_MODE || '').toLowerCase());
const UPDATE_MANIFEST_URL = String(process.env.GEARBEACON_UPDATE_MANIFEST_URL || '').trim();
const GITHUB_RELEASE_API = String(process.env.GEARBEACON_GITHUB_RELEASE_API !== undefined ? process.env.GEARBEACON_GITHUB_RELEASE_API : 'https://api.github.com/repos/alexphillips-dev/GearBeacon/releases/latest').trim();
const PUBLIC_BASE_URL = String(process.env.GEARBEACON_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const MIN_CATALOG_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.GEARBEACON_MIN_CATALOG_RATIO || 0.55)));
const STALE_AFTER_SECONDS = Math.max(POLL_SECONDS * 3, Number(process.env.GEARBEACON_STALE_AFTER_SECONDS || 180));
const BACKUP_RETENTION = Math.max(1, Math.min(100, Number(process.env.GEARBEACON_BACKUP_RETENTION || 10)));
const BACKUP_INTERVAL_HOURS = Math.max(0, Number(process.env.GEARBEACON_BACKUP_INTERVAL_HOURS || 24));
const rawAccessMode = String(process.env.GEARBEACON_ACCESS_MODE || 'local').trim().toLowerCase();
if (!['local', 'private', 'proxy'].includes(rawAccessMode))
    throw new Error('GEARBEACON_ACCESS_MODE must be local, private, or proxy.');
const ACCESS_MODE = rawAccessMode;
const BIND_HOST = String(process.env.GEARBEACON_BIND_HOST || (ACCESS_MODE === 'private' ? '0.0.0.0' : '127.0.0.1')).trim();
const ALLOW_INSECURE_REMOTE = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_ALLOW_INSECURE_REMOTE || '').toLowerCase());
const COOKIE_SECURE = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_COOKIE_SECURE || '').toLowerCase())
    || PUBLIC_BASE_URL.toLowerCase().startsWith('https://');
const SESSION_HOURS = Math.max(1, Math.min(24 * 90, Number(process.env.GEARBEACON_SESSION_HOURS || 168)));
const ALLOWED_ORIGINS = String(process.env.GEARBEACON_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const LEGACY_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RELEASE_MANIFEST_FILE = path.join(PROJECT_ROOT, 'release-manifest.json');
function defaultUserDataDir() {
    if (process.env.GEARBEACON_DATA_DIR)
        return path.resolve(process.env.GEARBEACON_DATA_DIR);
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GearBeacon');
    }
    if (process.platform === 'darwin')
        return path.join(os.homedir(), 'Library', 'Application Support', 'GearBeacon');
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
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
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
    if (!tableExists('meta'))
        return null;
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
    if (!tableExists('settings'))
        return fallback;
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
        if (typeof raw?.[key] === 'boolean')
            normalized[key] = raw[key];
    }
    return normalized;
}
function updateNotificationPreferences(input) {
    const current = notificationPreferences();
    for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
        if (typeof input?.[key] === 'boolean')
            current[key] = input[key];
    }
    setSetting('notification_preferences', JSON.stringify(current));
    return current;
}
function schemaVersion() {
    if (!tableExists('schema_migrations'))
        return 0;
    return Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version || 0);
}
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR))
        return [];
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
        try {
            fs.unlinkSync(old.path);
        }
        catch { }
    }
}
function databaseIntegrity(file = DB_FILE) {
    let target = db;
    let opened = false;
    try {
        if (path.resolve(file) !== path.resolve(DB_FILE)) {
            target = new DatabaseSync(file, { readOnly: true });
            opened = true;
        }
        const rows = target.prepare('PRAGMA integrity_check').all();
        const messages = rows.map((row) => String(row.integrity_check || '')).filter(Boolean);
        return { ok: messages.length === 1 && messages[0].toLowerCase() === 'ok', messages };
    }
    finally {
        if (opened)
            target.close();
    }
}
function createDatabaseBackup(reason = 'manual') {
    if (!fs.existsSync(DB_FILE))
        return null;
    const sourceIntegrity = databaseIntegrity();
    if (!sourceIntegrity.ok)
        throw new Error(`Database integrity check failed: ${sourceIntegrity.messages.join('; ')}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${safeFilePart(reason)}-${stamp}.sqlite3`;
    const destination = path.join(BACKUP_DIR, filename);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    db.exec(`VACUUM INTO '${sqliteQuote(destination)}'`);
    const backupIntegrity = databaseIntegrity(destination);
    if (!backupIntegrity.ok) {
        try {
            fs.unlinkSync(destination);
        }
        catch { }
        throw new Error(`Backup validation failed: ${backupIntegrity.messages.join('; ')}`);
    }
    trimBackups();
    return { filename, path: destination, createdAt: isoNow(), reason, validated: true };
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
    {
        version: 4,
        name: 'private-owner-authentication',
        sql: `
      CREATE TABLE IF NOT EXISTS owner_credentials (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        remote_address TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      DROP TABLE IF EXISTS push_tokens;
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
        if (migration.version <= current)
            continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(migration.sql);
            db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, isoNow());
            db.exec('COMMIT');
            current = migration.version;
            console.log(`[data] migrated schema to v${migration.version} (${migration.name})`);
        }
        catch (err) {
            try {
                db.exec('ROLLBACK');
            }
            catch { }
            throw err;
        }
    }
    if (current !== DATABASE_SCHEMA_VERSION)
        throw new Error(`Unexpected GearBeacon schema version ${current}; expected ${DATABASE_SCHEMA_VERSION}.`);
}
function findLegacyStateFile(region = currentRegion()) {
    if (['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_SKIP_LEGACY_IMPORT || '').toLowerCase()))
        return null;
    const explicit = String(process.env.GEARBEACON_LEGACY_DATA_FILE || '').trim();
    const filename = MOCK_MODE ? 'gear-beacon.mock.json' : `gear-beacon.${region}.json`;
    const candidates = [];
    if (explicit)
        candidates.push(path.resolve(explicit));
    candidates.push(path.join(LEGACY_DATA_DIR, filename));
    // Helps users who unzip a newer GearBeacon release beside an older V1.x folder instead of over it.
    try {
        const parent = path.dirname(PROJECT_ROOT);
        for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^GearBeacon-v1\.(?:0|1|2)(?:\.|$)/i.test(entry.name))
                continue;
            candidates.push(path.join(parent, entry.name, 'data', filename));
        }
    }
    catch { }
    const existing = [...new Set(candidates)].filter((file) => fs.existsSync(file));
    existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return existing[0] || null;
}
function importLegacyStateIfNeeded(region = currentRegion()) {
    if (getMeta(`legacy_imported_${MOCK_MODE ? 'mock' : region}`) === '1')
        return null;
    const existingRows = Number(db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE region=?').get(region)?.n || 0)
        + Number(db.prepare('SELECT COUNT(*) AS n FROM products WHERE region=?').get(region)?.n || 0);
    if (existingRows > 0) {
        setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : region}`, '1');
        return null;
    }
    const legacy = findLegacyStateFile(region);
    if (!legacy) {
        setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : region}`, '1');
        return null;
    }
    const parsed = safeJsonParse(fs.readFileSync(legacy, 'utf8'), null);
    if (!parsed || typeof parsed !== 'object')
        return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const legacyCopy = path.join(BACKUP_DIR, `legacy-json-${stamp}.json`);
    try {
        fs.copyFileSync(legacy, legacyCopy);
    }
    catch { }
    const legacyState = {
        watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist.filter(Boolean) : [],
        products: parsed.products && typeof parsed.products === 'object' ? parsed.products : {},
        events: Array.isArray(parsed.events) ? parsed.events.slice(-1000) : [],
    };
    persistState(legacyState, region);
    setMeta(`legacy_imported_${MOCK_MODE ? 'mock' : region}`, '1');
    setMeta('legacy_source', legacy);
    console.log(`[data] migrated legacy JSON data from ${legacy}`);
    return legacy;
}
function loadState(region = currentRegion()) {
    const watchlist = db.prepare('SELECT slug FROM watchlist WHERE region=? ORDER BY created_at').all(region).map((row) => row.slug);
    const products = {};
    for (const row of db.prepare('SELECT slug,data_json FROM products WHERE region=?').all(region)) {
        const value = safeJsonParse(row.data_json, null);
        if (value)
            products[row.slug] = value;
    }
    const events = db.prepare('SELECT data_json FROM events WHERE region=? ORDER BY detected_at DESC LIMIT 1000').all(region)
        .map((row) => safeJsonParse(row.data_json, null)).filter(Boolean).reverse();
    return { watchlist, products, events };
}
function persistState(nextState, region = currentRegion()) {
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('DELETE FROM watchlist WHERE region=?').run(region);
        const addWatch = db.prepare('INSERT INTO watchlist(region,slug,created_at) VALUES(?,?,?)');
        for (const slug of nextState.watchlist || [])
            addWatch.run(region, slug, isoNow());
        db.prepare('DELETE FROM products WHERE region=?').run(region);
        const addProduct = db.prepare('INSERT INTO products(region,slug,data_json,updated_at) VALUES(?,?,?,?)');
        for (const [slug, product] of Object.entries(nextState.products || {}))
            addProduct.run(region, slug, JSON.stringify(product), isoNow());
        db.prepare('DELETE FROM events WHERE region=?').run(region);
        const addEvent = db.prepare('INSERT INTO events(id,region,detected_at,data_json) VALUES(?,?,?,?)');
        for (const event of (nextState.events || []).slice(-1000))
            addEvent.run(event.id, region, event.detectedAt || isoNow(), JSON.stringify(event));
        db.exec('COMMIT');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch { }
        throw err;
    }
}
const previousAppVersion = dbExistedAtStartup ? getMeta('last_app_version') : null;
const previousSchemaVersion = dbExistedAtStartup ? schemaVersion() : 0;
if (dbExistedAtStartup && ((previousAppVersion && previousAppVersion !== APP_VERSION) || (previousSchemaVersion > 0 && previousSchemaVersion < DATABASE_SCHEMA_VERSION))) {
    const sourceVersion = previousAppVersion || `schema-${previousSchemaVersion}`;
    const backup = createDatabaseBackup(`pre-update-${sourceVersion}-to-${APP_VERSION}`);
    if (backup)
        console.log(`[data] safety backup created before version migration: ${backup.filename}`);
}
runMigrations();
for (const region of ACTIVE_REGIONS)
    importLegacyStateIfNeeded(region);
setMeta('last_app_version', APP_VERSION);
setMeta('last_started_at', isoNow());
const states = Object.fromEntries(ACTIVE_REGIONS.map((region) => [region, loadState(region)]));
function contextualProxy(values) {
    return new Proxy({}, {
        get(_target, property) { return values[currentRegion()][property]; },
        set(_target, property, value) { values[currentRegion()][property] = value; return true; },
        ownKeys() { return Reflect.ownKeys(values[currentRegion()]); },
        getOwnPropertyDescriptor(_target, property) {
            return Object.prototype.hasOwnProperty.call(values[currentRegion()], property)
                ? { enumerable: true, configurable: true }
                : undefined;
        },
    });
}
const state = contextualProxy(states);
const saveTimers = new Map();
function saveStateSoon() {
    const region = currentRegion();
    if (saveTimers.has(region))
        return;
    const timer = setTimeout(() => {
        saveTimers.delete(region);
        persistState(states[region], region);
    }, 100);
    saveTimers.set(region, timer);
}
function flushState(region = currentRegion()) {
    if (saveTimers.has(region)) {
        clearTimeout(saveTimers.get(region));
        saveTimers.delete(region);
    }
    persistState(states[region], region);
}
const buildIdCaches = Object.fromEntries(ACTIVE_REGIONS.map((region) => [region, { value: null, fetchedAt: 0 }]));
const monitors = Object.fromEntries(ACTIVE_REGIONS.map((region) => [region, {
        checking: false,
        lastCheckAt: null,
        lastSuccessAt: null,
        nextCheckAt: null,
        lastError: null,
        productCount: Object.keys(states[region].products).length,
        cycle: 0,
        consecutiveFailures: 0,
        lastDurationMs: null,
        catalogHealth: 'starting',
        partialErrors: [],
        lastAlertAt: null,
    }]));
const monitor = contextualProxy(monitors);
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
    const region = currentRegion();
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
            url: `${STORE_BASE}/${REGIONS[region].path}/products/${p.slug}`,
            region,
            lastSeenAt: isoNow(),
        };
    });
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function getBuildId(force = false) {
    const region = currentRegion();
    const buildIdCache = buildIdCaches[region];
    const freshForMs = 5 * 60 * 1000;
    if (!force && buildIdCache.value && Date.now() - buildIdCache.fetchedAt < freshForMs) {
        return buildIdCache.value;
    }
    const home = `${STORE_BASE}/${REGIONS[region].path}`;
    const res = await fetchWithTimeout(home, { headers: HEADERS });
    if (!res.ok)
        throw new Error(`Store homepage returned HTTP ${res.status}`);
    const html = await res.text();
    const match = html.match(/"buildId":"([^"]+)"/);
    if (!match)
        throw new Error('Could not discover the UniFi Store Next.js buildId.');
    buildIdCaches[region] = { value: match[1], fetchedAt: Date.now() };
    return match[1];
}
function redirectToPagePath(target, buildId) {
    const parsed = new URL(target, STORE_BASE);
    let pathname = parsed.pathname;
    const prefix = `/_next/data/${buildId}`;
    if (pathname.startsWith(prefix))
        pathname = pathname.slice(prefix.length);
    if (pathname.endsWith('.json'))
        pathname = pathname.slice(0, -5);
    return pathname;
}
async function fetchCategory(buildId, category) {
    const region = currentRegion();
    let pagePath = `/${REGIONS[region].path}/${category}`;
    for (let hop = 0; hop < 4; hop += 1) {
        const dataUrl = `${STORE_BASE}/_next/data/${buildId}${pagePath}.json`;
        const res = await fetchWithTimeout(dataUrl, { headers: HEADERS, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const target = res.headers.get('location') || res.headers.get('x-nextjs-redirect');
            if (!target)
                throw new Error(`${category}: redirect without target`);
            pagePath = redirectToPagePath(target, buildId);
            continue;
        }
        if (res.status === 404) {
            const err = new Error(`${category}: build or route returned 404`);
            err.code = 'BUILD_OR_ROUTE_404';
            throw err;
        }
        if (!res.ok)
            throw new Error(`${category}: HTTP ${res.status}`);
        const payload = await res.json();
        const props = payload.pageProps || {};
        if (props.__N_REDIRECT) {
            pagePath = redirectToPagePath(props.__N_REDIRECT, buildId);
            if (!pagePath.includes('/category/'))
                return [];
            continue;
        }
        const found = new Map();
        for (const subcat of props.subCategories || []) {
            for (const product of subcat.products || []) {
                if (product && product.slug)
                    found.set(product.slug, { ...product, _category: category });
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
    if (value == null)
        return null;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return `$${value.toFixed(2)}`;
    if (typeof value === 'object') {
        const amount = Number(value.amount || 0);
        if (!amount)
            return null;
        const currency = value.currency || REGIONS[currentRegion()].currency;
        try {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
        }
        catch {
            return `${(amount / 100).toFixed(2)} ${currency}`;
        }
    }
    return String(value);
}
function firstPrice(product) {
    for (const variant of product.variants || []) {
        const p = variant.displayPrice ?? variant.price;
        const text = moneyToText(p);
        if (text)
            return text;
    }
    return null;
}
function minIso(values) {
    const dates = values.filter(Boolean).map((x) => new Date(x)).filter((d) => !Number.isNaN(d.valueOf()));
    if (!dates.length)
        return null;
    return new Date(Math.min(...dates.map((d) => d.valueOf()))).toISOString();
}
function maxIso(values) {
    const dates = values.filter(Boolean).map((x) => new Date(x)).filter((d) => !Number.isNaN(d.valueOf()));
    if (!dates.length)
        return null;
    return new Date(Math.max(...dates.map((d) => d.valueOf()))).toISOString();
}
function normalizeImageUrl(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.trim();
    if (!text)
        return null;
    try {
        const url = new URL(text, STORE_BASE);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        if ((host === 'ui.com' || host.endsWith('.ui.com')) && /\.(png|jpe?g|webp|avif)(?:$|\/)/i.test(path))
            return url.href;
    }
    catch { }
    return null;
}
function collectImageCandidates(value, keyHint = '', depth = 0, out = []) {
    if (depth > 5 || value == null)
        return out;
    if (typeof value === 'string') {
        if (/image|img|thumb|media|src|url|poster/i.test(keyHint)) {
            const normalized = normalizeImageUrl(value);
            if (normalized)
                out.push(normalized);
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
    for (const [key, value] of roots)
        collectImageCandidates(value, key, 0, candidates);
    const unique = [...new Set(candidates)];
    const score = (url) => {
        let n = 0;
        if (url.includes('images.svc.ui.com'))
            n += 50;
        if (url.includes('cdn.ecomm.ui.com'))
            n += 40;
        if (url.includes('assets.ecomm.ui.com'))
            n += 10;
        if (/\.(png|webp|avif)(?:$|\?)/i.test(url))
            n += 5;
        if (/flag|icon|logo|swatch|badge/i.test(url))
            n -= 100;
        return n;
    };
    unique.sort((a, b) => score(b) - score(a));
    return unique[0] || null;
}
function normalizeProduct(product) {
    const region = currentRegion();
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
        url: `${STORE_BASE}/${REGIONS[region].path}/products/${product.slug}`,
        region,
        lastSeenAt: isoNow(),
    };
}
async function fetchCatalogWithBuild(buildId) {
    const results = await Promise.allSettled(CATEGORIES.map((category) => fetchCategory(buildId, category)));
    let saw404 = false;
    const raw = [];
    const errors = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled')
            raw.push(...result.value);
        else {
            if (result.reason && result.reason.code === 'BUILD_OR_ROUTE_404')
                saw404 = true;
            errors.push(`${CATEGORIES[index]}: ${result.reason?.message || result.reason}`);
        }
    });
    if (saw404) {
        const err = new Error('One or more category endpoints returned 404.');
        err.code = 'BUILD_OR_ROUTE_404';
        throw err;
    }
    if (!raw.length)
        throw new Error(`No products fetched. ${errors.join(' | ')}`);
    monitor.partialErrors = errors.slice(0, 8);
    const deduped = new Map();
    raw.forEach((p) => { if (p.slug)
        deduped.set(p.slug, p); });
    return [...deduped.values()].map(normalizeProduct);
}
async function fetchCatalog() {
    if (MOCK_MODE)
        return mockCatalog();
    let buildId = await getBuildId(false);
    try {
        return await fetchCatalogWithBuild(buildId);
    }
    catch (err) {
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
        region: currentRegion(),
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
    if (!res.ok)
        throw new Error(`HTTP ${res.status}${parsed?.errors?.[0]?.message ? `: ${parsed.errors[0].message}` : ''}`);
    return { res, data: parsed, text };
}
function notificationCopy(event) {
    const regionKey = event.region || currentRegion();
    const region = REGIONS[regionKey]?.label || String(regionKey).toUpperCase();
    if (event.type === 'sold_out')
        return {
            title: `${event.name} sold out`,
            body: `${event.price ? `${event.price} · ` : ''}${region}`,
            ntfyTags: 'package,x',
        };
    if (event.type === 'price_change')
        return {
            title: `${event.name} price changed`,
            body: `${event.previousPrice || 'Previous price'} → ${event.price || 'new price'} · ${region}`,
            ntfyTags: 'moneybag,package',
        };
    if (event.type === 'status_change')
        return {
            title: `${event.name} status changed`,
            body: `${event.previousStatus || 'Unknown'} → ${event.status || 'Unknown'} · ${region}`,
            ntfyTags: 'package',
        };
    if (event.type === 'new_product')
        return {
            title: `New UniFi product: ${event.name}`,
            body: `${event.price ? `${event.price} · ` : ''}${region}`,
            ntfyTags: 'new,package',
        };
    if (event.type === 'test')
        return {
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
    if (event.type === 'test')
        return true;
    if (event.type === 'new_product')
        return Boolean(prefs.newProduct);
    if (!event.watchedAtDetection)
        return false;
    if (event.type === 'restock')
        return Boolean(prefs.restock);
    if (event.type === 'sold_out')
        return Boolean(prefs.soldOut);
    if (event.type === 'price_change')
        return Boolean(prefs.priceChange);
    if (event.type === 'status_change')
        return Boolean(prefs.statusChange);
    return false;
}
function logNotification(eventId, channel, status, detail = null) {
    try {
        db.prepare('INSERT INTO notification_log(event_id,channel,status,detail,created_at) VALUES(?,?,?,?,?)')
            .run(eventId || null, channel, status, detail ? String(detail).slice(0, 1000) : null, isoNow());
        db.prepare('DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY id DESC LIMIT 2000)').run();
    }
    catch (err) {
        console.error('[alert-log]', err?.message || err);
    }
}
async function sendNtfy(event) {
    if (!NTFY_TOPIC)
        return null;
    const url = `${NTFY_BASE_URL}/${encodeURIComponent(NTFY_TOPIC)}`;
    const copy = notificationCopy(event);
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            Title: copy.title,
            Priority: event.type === 'restock' ? '5' : '3',
            Tags: copy.ntfyTags,
            ...(event.url ? { Click: event.url } : {}),
            ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
            'Content-Type': 'text/plain; charset=utf-8',
        },
        body: copy.body,
    }, 10000);
    if (!res.ok)
        throw new Error(`ntfy HTTP ${res.status}`);
    return true;
}
async function sendDiscord(event) {
    if (!DISCORD_WEBHOOK_URL)
        return null;
    const copy = notificationCopy(event);
    const suffix = event.url ? `\n${event.url}` : '';
    await postJson(DISCORD_WEBHOOK_URL, { content: `**GearBeacon:** ${copy.title}\n${copy.body}${suffix}` });
    return true;
}
async function sendGenericWebhook(event) {
    if (!GENERIC_WEBHOOK_URL)
        return null;
    const copy = notificationCopy(event);
    await postJson(GENERIC_WEBHOOK_URL, {
        source: 'GearBeacon',
        version: APP_VERSION,
        title: copy.title,
        message: copy.body,
        event,
        sentAt: isoNow(),
    }, GENERIC_WEBHOOK_TOKEN ? { Authorization: `Bearer ${GENERIC_WEBHOOK_TOKEN}` } : {});
    return true;
}
async function sendGotify(event) {
    if (!GOTIFY_BASE_URL || !GOTIFY_TOKEN)
        return null;
    const copy = notificationCopy(event);
    const url = `${GOTIFY_BASE_URL}/message?token=${encodeURIComponent(GOTIFY_TOKEN)}`;
    await postJson(url, {
        title: copy.title,
        message: `${copy.body}${event.url ? `\n${event.url}` : ''}`,
        priority: event.type === 'restock' ? 10 : 5,
        extras: event.url ? { 'client::display': { contentType: 'text/markdown' }, 'client::notification': { click: { url: event.url } } } : undefined,
    });
    return true;
}
function smtpConfigured() {
    return Boolean(SMTP_HOST && SMTP_FROM && SMTP_TO.length);
}
function smtpAddress(value) {
    const match = String(value || '').match(/<([^<>\r\n]+)>\s*$/);
    const address = (match ? match[1] : String(value || '')).trim();
    if (!address || /[\r\n<>]/.test(address))
        throw new Error('Invalid SMTP address configuration.');
    return address;
}
function smtpReader(socket) {
    let buffer = '';
    const lines = [];
    const waiters = [];
    let failure = null;
    const settle = () => {
        while (lines.length && waiters.length)
            waiters.shift().resolve(lines.shift());
        if (failure)
            while (waiters.length)
                waiters.shift().reject(failure);
    };
    const onData = (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            lines.push(buffer.slice(0, index + 1).replace(/\r?\n$/, ''));
            buffer = buffer.slice(index + 1);
        }
        settle();
    };
    const onError = (err) => { failure = err; settle(); };
    const onClose = () => { if (!failure)
        failure = new Error('SMTP connection closed unexpectedly.'); settle(); };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    return {
        readLine: () => lines.length ? Promise.resolve(lines.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => waiters.push({ resolve, reject })),
        detach: () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); },
    };
}
async function smtpResponse(reader, expectedCodes) {
    const lines = [];
    while (true) {
        const line = await reader.readLine();
        lines.push(line);
        if (/^\d{3} /.test(line))
            break;
        if (!/^\d{3}-/.test(line))
            throw new Error(`Invalid SMTP response: ${line}`);
    }
    const code = Number(lines[lines.length - 1].slice(0, 3));
    if (!expectedCodes.includes(code))
        throw new Error(`SMTP ${code}: ${lines.join(' | ').slice(0, 500)}`);
    return lines;
}
async function connectSmtp() {
    const options = { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: true };
    let socket;
    if (SMTP_SECURE) {
        socket = tls.connect(options);
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    }
    else {
        socket = net.connect(options);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    }
    socket.setTimeout(12000, () => socket.destroy(new Error('SMTP connection timed out.')));
    let reader = smtpReader(socket);
    await smtpResponse(reader, [220]);
    const command = async (value, codes) => {
        socket.write(`${value}\r\n`);
        return await smtpResponse(reader, codes);
    };
    let ehlo = await command(`EHLO ${os.hostname().replace(/[^a-zA-Z0-9.-]/g, '-') || 'gearbeacon'}`, [250]);
    if (!SMTP_SECURE && ehlo.some((line) => /STARTTLS/i.test(line))) {
        await command('STARTTLS', [220]);
        reader.detach();
        socket = tls.connect({ socket, servername: SMTP_HOST, rejectUnauthorized: true });
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        socket.setTimeout(12000, () => socket.destroy(new Error('SMTP connection timed out.')));
        reader = smtpReader(socket);
        ehlo = await command(`EHLO ${os.hostname().replace(/[^a-zA-Z0-9.-]/g, '-') || 'gearbeacon'}`, [250]);
    }
    if (SMTP_USER || SMTP_PASSWORD) {
        if (!(socket instanceof tls.TLSSocket) || !socket.encrypted)
            throw new Error('Refusing to send SMTP credentials without TLS.');
        const auth = Buffer.from(`\0${SMTP_USER}\0${SMTP_PASSWORD}`).toString('base64');
        await command(`AUTH PLAIN ${auth}`, [235]);
    }
    return { socket, reader, command };
}
async function sendSmtp(event) {
    if (!smtpConfigured())
        return null;
    const copy = notificationCopy(event);
    const { socket, reader, command } = await connectSmtp();
    try {
        await command(`MAIL FROM:<${smtpAddress(SMTP_FROM)}>`, [250]);
        for (const recipient of SMTP_TO)
            await command(`RCPT TO:<${smtpAddress(recipient)}>`, [250, 251]);
        await command('DATA', [354]);
        const subject = `=?UTF-8?B?${Buffer.from(copy.title, 'utf8').toString('base64')}?=`;
        const body = `${copy.body}${event.url ? `\r\n\r\n${event.url}` : ''}`.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        const message = [
            `From: ${SMTP_FROM.replace(/[\r\n]/g, '')}`,
            `To: ${SMTP_TO.join(', ').replace(/[\r\n]/g, '')}`,
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '', body, '.', '',
        ].join('\r\n');
        socket.write(message);
        await smtpResponse(reader, [250]);
        await command('QUIT', [221]);
    }
    finally {
        socket.end();
    }
    return true;
}
async function sendAlert(event) {
    const outcomes = [];
    if (NTFY_TOPIC) {
        try {
            await sendNtfy(event);
            outcomes.push({ channel: 'ntfy', ok: true });
            logNotification(event.id, 'ntfy', 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel: 'ntfy', ok: false, error: message });
            logNotification(event.id, 'ntfy', 'failed', message);
            console.error('[alert:ntfy]', message);
        }
    }
    if (DISCORD_WEBHOOK_URL) {
        try {
            await sendDiscord(event);
            outcomes.push({ channel: 'discord', ok: true });
            logNotification(event.id, 'discord', 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel: 'discord', ok: false, error: message });
            logNotification(event.id, 'discord', 'failed', message);
            console.error('[alert:discord]', message);
        }
    }
    if (GENERIC_WEBHOOK_URL) {
        try {
            await sendGenericWebhook(event);
            outcomes.push({ channel: 'webhook', ok: true });
            logNotification(event.id, 'webhook', 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel: 'webhook', ok: false, error: message });
            logNotification(event.id, 'webhook', 'failed', message);
            console.error('[alert:webhook]', message);
        }
    }
    if (GOTIFY_BASE_URL && GOTIFY_TOKEN) {
        try {
            await sendGotify(event);
            outcomes.push({ channel: 'gotify', ok: true });
            logNotification(event.id, 'gotify', 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel: 'gotify', ok: false, error: message });
            logNotification(event.id, 'gotify', 'failed', message);
            console.error('[alert:gotify]', message);
        }
    }
    if (smtpConfigured()) {
        try {
            await sendSmtp(event);
            outcomes.push({ channel: 'email', ok: true });
            logNotification(event.id, 'email', 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel: 'email', ok: false, error: message });
            logNotification(event.id, 'email', 'failed', message);
            console.error('[alert:email]', message);
        }
    }
    if (outcomes.some((item) => item.ok))
        monitor.lastAlertAt = isoNow();
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
        region: currentRegion(),
        detectedAt: isoNow(),
    };
    const outcomes = await sendAlert(event);
    const configured = (NTFY_TOPIC ? 1 : 0) + (DISCORD_WEBHOOK_URL ? 1 : 0)
        + (GENERIC_WEBHOOK_URL ? 1 : 0) + (GOTIFY_BASE_URL && GOTIFY_TOKEN ? 1 : 0) + (smtpConfigured() ? 1 : 0);
    return { ok: outcomes.some((item) => item.ok), configuredChannels: configured, outcomes };
}
function recordEvent(event) {
    state.events.push(event);
    if (state.events.length > 1000)
        state.events = state.events.slice(-1000);
    saveStateSoon();
}
async function checkStore(reason = 'timer') {
    if (monitor.checking)
        return { skipped: true, reason: 'already checking' };
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
                    if (shouldNotifyEvent(event, prefs))
                        notifications.push(event);
                }
                continue;
            }
            const watchedAtDetection = watch.has(product.slug);
            if (!previous.inStock && product.inStock) {
                const event = createEvent('restock', previous, product, watchedAtDetection);
                recordEvent(event);
                if (shouldNotifyEvent(event, prefs))
                    notifications.push(event);
            }
            else if (previous.inStock && !product.inStock) {
                const event = createEvent('sold_out', previous, product, watchedAtDetection);
                recordEvent(event);
                if (shouldNotifyEvent(event, prefs))
                    notifications.push(event);
            }
            else if (previous.status !== product.status) {
                const event = createEvent('status_change', previous, product, watchedAtDetection);
                recordEvent(event);
                if (shouldNotifyEvent(event, prefs))
                    notifications.push(event);
            }
            if (previous.price && product.price && previous.price !== product.price) {
                const event = createEvent('price_change', previous, product, watchedAtDetection);
                recordEvent(event);
                if (shouldNotifyEvent(event, prefs))
                    notifications.push(event);
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
        for (const event of notifications)
            await sendAlert(event);
        console.log(`[monitor] success: ${monitor.productCount} products, ${notifications.length} notification event(s)`);
        return { ok: true, products: monitor.productCount, notifications: notifications.length, catalogHealth: monitor.catalogHealth };
    }
    catch (err) {
        monitor.consecutiveFailures += 1;
        monitor.lastError = err?.message || String(err);
        const lastSuccessAge = monitor.lastSuccessAt ? (Date.now() - new Date(monitor.lastSuccessAt).getTime()) / 1000 : Infinity;
        monitor.catalogHealth = lastSuccessAge > STALE_AFTER_SECONDS ? 'stale' : 'error';
        console.error('[monitor] failed:', monitor.lastError);
        return { ok: false, error: monitor.lastError, consecutiveFailures: monitor.consecutiveFailures };
    }
    finally {
        monitor.checking = false;
        monitor.lastDurationMs = Date.now() - startedAt;
    }
}
const monitorTimers = new Map();
function monitorDelaySeconds() {
    if (!monitor.consecutiveFailures)
        return POLL_SECONDS;
    return Math.min(15 * 60, POLL_SECONDS * (2 ** Math.min(monitor.consecutiveFailures, 4)));
}
function scheduleMonitor() {
    const region = currentRegion();
    if (monitorTimers.has(region))
        clearTimeout(monitorTimers.get(region));
    const delaySeconds = monitorDelaySeconds();
    monitor.nextCheckAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const timer = setTimeout(() => regionContext.run(region, async () => {
        await checkStore('timer');
        scheduleMonitor();
    }), delaySeconds * 1000);
    monitorTimers.set(region, timer);
    timer.unref();
}
function productForApi(product) {
    if (!product)
        return null;
    return { ...product, watched: state.watchlist.includes(product.slug) };
}
function backupSummary() {
    const backups = listBackups().filter((item) => item.name.endsWith('.sqlite3'));
    return {
        count: backups.length,
        retention: BACKUP_RETENTION,
        intervalHours: BACKUP_INTERVAL_HOURS,
        latest: backups[0] || null,
    };
}
let backupTimer = null;
function scheduleBackups() {
    if (backupTimer)
        clearTimeout(backupTimer);
    if (!BACKUP_INTERVAL_HOURS)
        return;
    backupTimer = setTimeout(() => {
        try {
            for (const region of ACTIVE_REGIONS)
                flushState(region);
            const backup = createDatabaseBackup('scheduled');
            if (backup)
                console.log(`[data] scheduled backup created: ${backup.filename}`);
        }
        catch (err) {
            console.error('[data] scheduled backup failed:', err?.message || err);
        }
        finally {
            scheduleBackups();
        }
    }, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
    backupTimer.unref();
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
        integrity: databaseIntegrity(),
        backup: backupSummary(),
        legacySource: getMeta('legacy_source'),
    };
}
function exportSnapshot() {
    for (const region of ACTIVE_REGIONS)
        flushState(region);
    const settings = {};
    if (tableExists('settings')) {
        for (const row of db.prepare('SELECT key,value FROM settings').all()) {
            if (!/password|secret|token|credential|session/i.test(row.key))
                settings[row.key] = row.value;
        }
    }
    const regionData = {};
    for (const region of ACTIVE_REGIONS) {
        regionData[region] = {
            watchlist: [...states[region].watchlist],
            products: states[region].products,
            events: states[region].events,
        };
    }
    return {
        format: 'GearBeaconBackup',
        formatVersion: 2,
        exportedAt: isoNow(),
        appVersion: APP_VERSION,
        schemaVersion: schemaVersion(),
        defaultRegion: DEFAULT_REGION,
        activeRegions: [...ACTIVE_REGIONS],
        regions: regionData,
        settings,
    };
}
function encryptSnapshot(snapshot, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 12)
        throw new Error('Export passphrase must be at least 12 characters.');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
    return {
        format: 'GearBeaconEncryptedBackup',
        formatVersion: 1,
        encryption: 'AES-256-GCM',
        keyDerivation: 'scrypt',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: ciphertext.toString('base64'),
    };
}
function decryptSnapshot(wrapper, passphrase) {
    if (wrapper?.format !== 'GearBeaconEncryptedBackup')
        return wrapper;
    if (typeof passphrase !== 'string' || !passphrase)
        throw new Error('This backup is encrypted. Enter its passphrase.');
    try {
        const salt = Buffer.from(String(wrapper.salt || ''), 'base64');
        const iv = Buffer.from(String(wrapper.iv || ''), 'base64');
        const tag = Buffer.from(String(wrapper.tag || ''), 'base64');
        const ciphertext = Buffer.from(String(wrapper.data || ''), 'base64');
        const key = crypto.scryptSync(passphrase, salt, 32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    }
    catch {
        throw new Error('The backup passphrase is incorrect or the encrypted file is damaged.');
    }
}
function normalizeImportedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object')
        throw new Error('Backup file is not valid JSON data.');
    const isBackup = snapshot.format === 'GearBeaconBackup';
    const isLegacy = !snapshot.format && (Array.isArray(snapshot.watchlist) || snapshot.products || Array.isArray(snapshot.events));
    if (!isBackup && !isLegacy)
        throw new Error('This file is not a GearBeacon backup or legacy GearBeacon state file.');
    if (isBackup && Number(snapshot.formatVersion || 0) > 2)
        throw new Error(`This backup format (${snapshot.formatVersion}) is newer than GearBeacon ${APP_VERSION} supports.`);
    const normalizeRegion = (value) => ({
        watchlist: Array.isArray(value?.watchlist) ? value.watchlist.map(String).filter(Boolean) : [],
        products: value?.products && typeof value.products === 'object' && !Array.isArray(value.products) ? value.products : {},
        events: Array.isArray(value?.events) ? value.events.filter((event) => event && event.id).slice(-1000) : [],
    });
    const regions = {};
    if (snapshot.regions && typeof snapshot.regions === 'object' && !Array.isArray(snapshot.regions)) {
        for (const [region, value] of Object.entries(snapshot.regions)) {
            if (REGIONS[region])
                regions[region] = normalizeRegion(value);
        }
    }
    else {
        const region = REGIONS[snapshot.region] ? snapshot.region : currentRegion();
        regions[region] = normalizeRegion(snapshot);
    }
    return {
        regions,
        settings: snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings) ? snapshot.settings : {},
    };
}
function importSnapshot(snapshot) {
    const normalized = normalizeImportedSnapshot(snapshot);
    for (const region of ACTIVE_REGIONS)
        flushState(region);
    const safety = createDatabaseBackup('pre-import');
    let watchCount = 0;
    let eventCount = 0;
    const importedRegions = [];
    for (const [region, regionState] of Object.entries(normalized.regions)) {
        if (!ACTIVE_REGIONS.includes(region))
            continue;
        persistState(regionState, region);
        states[region] = loadState(region);
        monitors[region].productCount = Object.keys(states[region].products).length;
        watchCount += states[region].watchlist.length;
        eventCount += states[region].events.length;
        importedRegions.push(region);
    }
    if (!importedRegions.length)
        throw new Error(`This backup does not contain any configured region (${ACTIVE_REGIONS.join(', ')}).`);
    if (tableExists('settings')) {
        db.exec('DELETE FROM settings');
        const put = db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)');
        for (const [key, value] of Object.entries(normalized.settings)) {
            if (!/password|secret|token|credential|session/i.test(key))
                put.run(String(key), String(value), isoNow());
        }
    }
    setMeta('last_import_at', isoNow());
    return { ok: true, watchCount, eventCount, importedRegions, safetyBackup: safety };
}
function previewSnapshot(snapshot) {
    const normalized = normalizeImportedSnapshot(snapshot);
    const regions = Object.entries(normalized.regions).map(([region, value]) => ({
        region,
        configured: ACTIVE_REGIONS.includes(region),
        watchCount: value.watchlist.length,
        productCount: Object.keys(value.products).length,
        eventCount: value.events.length,
    }));
    return { ok: true, regions, willImport: regions.filter((item) => item.configured).map((item) => item.region) };
}
function compareVersions(a, b) {
    const pa = String(a || '0').replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
    const pb = String(b || '0').replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff)
            return diff;
    }
    return 0;
}
function normalizeReleasePayload(payload, source) {
    if (!payload || typeof payload !== 'object')
        return null;
    if (payload.latestVersion)
        return {
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
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const normalized = normalizeReleasePayload(payload, source);
    if (!normalized?.latestVersion)
        throw new Error('Release payload did not include a version.');
    return normalized;
}
async function readUpdateManifest() {
    const warnings = [];
    if (UPDATE_MANIFEST_URL) {
        try {
            const remote = await fetchReleaseJson(UPDATE_MANIFEST_URL, UPDATE_MANIFEST_URL);
            return { manifest: remote, source: UPDATE_MANIFEST_URL, warning: null };
        }
        catch (err) {
            warnings.push(`Configured update channel failed: ${err?.message || String(err)}.`);
        }
    }
    else if (GITHUB_RELEASE_API) {
        try {
            const github = await fetchReleaseJson(GITHUB_RELEASE_API, 'GitHub Releases');
            return { manifest: github, source: 'GitHub Releases', warning: null };
        }
        catch (err) {
            warnings.push(`GitHub Releases check failed: ${err?.message || String(err)}.`);
        }
    }
    if (!fs.existsSync(RELEASE_MANIFEST_FILE))
        throw new Error(`${warnings.join(' ')} No bundled GearBeacon release information is available.`);
    const payload = safeJsonParse(fs.readFileSync(RELEASE_MANIFEST_FILE, 'utf8'), null);
    const bundled = normalizeReleasePayload(payload, 'bundled');
    if (!bundled?.latestVersion)
        throw new Error('The bundled GearBeacon update manifest is invalid.');
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
function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}
function safeEqualText(left, right) {
    const a = crypto.createHash('sha256').update(String(left)).digest();
    const b = crypto.createHash('sha256').update(String(right)).digest();
    return crypto.timingSafeEqual(a, b);
}
function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
        throw new Error('Owner password must be between 12 and 1024 characters.');
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt-v1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
    try {
        const [version, saltText, hashText] = String(stored || '').split('$');
        if (version !== 'scrypt-v1' || !saltText || !hashText)
            return false;
        const expected = Buffer.from(hashText, 'base64');
        const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltText, 'base64'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    catch {
        return false;
    }
}
function ownerCredential() {
    return db.prepare('SELECT password_hash,created_at,updated_at FROM owner_credentials WHERE id=1').get() || null;
}
function setOwnerPassword(password) {
    const now = isoNow();
    db.prepare(`INSERT INTO owner_credentials(id,password_hash,created_at,updated_at) VALUES(1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,updated_at=excluded.updated_at`)
        .run(passwordHash(password), now, now);
}
let setupToken = null;
function configuredOwnerPassword() {
    const file = String(process.env.GEARBEACON_OWNER_PASSWORD_FILE || '').trim();
    if (file)
        return fs.readFileSync(path.resolve(file), 'utf8').replace(/[\r\n]+$/, '');
    return String(process.env.GEARBEACON_OWNER_PASSWORD || '');
}
function initializeOwnerAuthentication() {
    const configured = configuredOwnerPassword();
    const reset = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_RESET_OWNER_PASSWORD || '').toLowerCase());
    if (configured && (!ownerCredential() || reset)) {
        setOwnerPassword(configured);
        db.exec('DELETE FROM sessions');
        console.log(`[security] owner password ${reset ? 'reset' : 'initialized'} from server configuration`);
    }
    if ((ACCESS_MODE !== 'local' || ownerCredential()) && !ownerCredential()) {
        setupToken = String(process.env.GEARBEACON_SETUP_TOKEN || '').trim() || randomToken(18);
    }
}
function authenticationRequired() {
    return ACCESS_MODE !== 'local' || Boolean(ownerCredential());
}
function setupRequired() {
    return authenticationRequired() && !ownerCredential();
}
function cleanSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(isoNow());
}
function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 1)
            continue;
        const key = part.slice(0, index).trim();
        try {
            result[key] = decodeURIComponent(part.slice(index + 1).trim());
        }
        catch { }
    }
    return result;
}
function sessionForRequest(req) {
    if (!authenticationRequired())
        return { local: true, csrf_token: null };
    cleanSessions();
    const token = parseCookies(req).gearbeacon_session;
    if (!token)
        return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db.prepare('SELECT token_hash,csrf_token,created_at,last_used_at,expires_at,remote_address,user_agent FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash, isoNow());
    if (!session)
        return null;
    const now = isoNow();
    db.prepare('UPDATE sessions SET last_used_at=? WHERE token_hash=?').run(now, tokenHash);
    return { ...session, last_used_at: now, token };
}
function requestAddress(req) {
    if (ACCESS_MODE === 'proxy') {
        const forwardedValues = String(req.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
        const forwarded = forwardedValues[forwardedValues.length - 1] || '';
        if (forwarded)
            return forwarded.slice(0, 128);
    }
    return String(req.socket.remoteAddress || '').slice(0, 128);
}
function createSession(req) {
    cleanSessions();
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const createdAt = isoNow();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,csrf_token,created_at,last_used_at,expires_at,remote_address,user_agent) VALUES(?,?,?,?,?,?,?)')
        .run(tokenHash, csrfToken, createdAt, createdAt, expiresAt, requestAddress(req), String(req.headers['user-agent'] || '').slice(0, 300));
    return { token, csrfToken, tokenHash, createdAt, expiresAt };
}
function requestUsesHttps(req) {
    return COOKIE_SECURE || (ACCESS_MODE === 'proxy' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');
}
function sessionCookie(req, token, expiresAt) {
    return `gearbeacon_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${requestUsesHttps(req) ? '; Secure' : ''}`;
}
function expiredSessionCookie(req) {
    return `gearbeacon_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${requestUsesHttps(req) ? '; Secure' : ''}`;
}
const loginAttempts = new Map();
function loginRateState(req) {
    const key = requestAddress(req) || 'unknown';
    const now = Date.now();
    if (loginAttempts.size > 5000) {
        for (const [address, value] of loginAttempts) {
            if (now - value.startedAt > 30 * 60 * 1000)
                loginAttempts.delete(address);
        }
        while (loginAttempts.size > 5000)
            loginAttempts.delete(loginAttempts.keys().next().value);
    }
    let item = loginAttempts.get(key);
    if (!item || now - item.startedAt > 15 * 60 * 1000)
        item = { count: 0, startedAt: now, blockedUntil: 0 };
    loginAttempts.set(key, item);
    return { key, item, now };
}
function assertLoginAllowed(req) {
    const { item, now } = loginRateState(req);
    if (item.blockedUntil > now) {
        const err = new Error('Too many sign-in attempts. Try again later.');
        err.statusCode = 429;
        throw err;
    }
}
function recordLoginFailure(req) {
    const { item, now } = loginRateState(req);
    item.count += 1;
    if (item.count >= 5)
        item.blockedUntil = now + 15 * 60 * 1000;
}
function clearLoginFailures(req) {
    loginAttempts.delete(requestAddress(req) || 'unknown');
}
function authStatus(req) {
    const session = sessionForRequest(req);
    return {
        accessMode: ACCESS_MODE,
        authenticationRequired: authenticationRequired(),
        setupRequired: setupRequired(),
        authenticated: Boolean(session),
        csrfToken: session?.csrf_token || null,
        sessionExpiresAt: session?.expires_at || null,
    };
}
function listSessions(current) {
    cleanSessions();
    return db.prepare('SELECT token_hash,created_at,last_used_at,expires_at,remote_address,user_agent FROM sessions ORDER BY last_used_at DESC').all().map((item) => ({
        id: item.token_hash.slice(0, 16),
        current: item.token_hash === current?.token_hash,
        createdAt: item.created_at,
        lastUsedAt: item.last_used_at,
        expiresAt: item.expires_at,
        remoteAddress: item.remote_address,
        userAgent: item.user_agent,
    }));
}
function outboundConnections() {
    return [
        { name: 'UniFi Store', enabled: true, required: true, destination: STORE_BASE, purpose: 'Inventory checks' },
        { name: 'GitHub Releases', enabled: Boolean(GITHUB_RELEASE_API || UPDATE_MANIFEST_URL), required: false, destination: UPDATE_MANIFEST_URL || GITHUB_RELEASE_API || null, purpose: 'Manual update checks' },
        { name: 'ntfy', enabled: Boolean(NTFY_TOPIC), required: false, destination: NTFY_TOPIC ? NTFY_BASE_URL : null, purpose: 'Notifications' },
        { name: 'Discord', enabled: Boolean(DISCORD_WEBHOOK_URL), required: false, destination: DISCORD_WEBHOOK_URL ? 'Configured webhook' : null, purpose: 'Notifications' },
        { name: 'Generic webhook', enabled: Boolean(GENERIC_WEBHOOK_URL), required: false, destination: GENERIC_WEBHOOK_URL ? 'Configured webhook' : null, purpose: 'Notifications' },
        { name: 'Gotify', enabled: Boolean(GOTIFY_BASE_URL && GOTIFY_TOKEN), required: false, destination: GOTIFY_BASE_URL || null, purpose: 'Notifications' },
        { name: 'Email', enabled: smtpConfigured(), required: false, destination: smtpConfigured() ? SMTP_HOST : null, purpose: 'SMTP notifications' },
    ];
}
function apiStatus() {
    const stale = !monitor.lastSuccessAt || (Date.now() - new Date(monitor.lastSuccessAt).getTime()) / 1000 > STALE_AFTER_SECONDS;
    return {
        name: 'GearBeacon',
        version: APP_VERSION,
        region: currentRegion(),
        regionLabel: REGIONS[currentRegion()].label,
        regions: ACTIVE_REGIONS.map((key) => ({ key, label: REGIONS[key].label })),
        pollSeconds: POLL_SECONDS,
        mockMode: MOCK_MODE,
        deployment: { mode: ACCESS_MODE, bindHost: BIND_HOST, publicBaseUrl: PUBLIC_BASE_URL || null, authenticationRequired: authenticationRequired() },
        storage: { engine: 'SQLite', schemaVersion: schemaVersion(), userDataDir: USER_DATA_DIR },
        notifications: {
            ntfyConfigured: Boolean(NTFY_TOPIC),
            discordConfigured: Boolean(DISCORD_WEBHOOK_URL),
            webhookConfigured: Boolean(GENERIC_WEBHOOK_URL),
            gotifyConfigured: Boolean(GOTIFY_BASE_URL && GOTIFY_TOKEN),
            smtpConfigured: smtpConfigured(),
            preferences: notificationPreferences(),
        },
        privacy: { telemetry: false, publicCloudRequired: false, outboundConnections: outboundConnections() },
        health: {
            ok: Boolean(monitor.lastSuccessAt) && !stale && !monitor.lastError,
            stale,
            staleAfterSeconds: STALE_AFTER_SECONDS,
            minCatalogRatio: MIN_CATALOG_RATIO,
        },
        ...monitor,
    };
}
function requestHost(req) {
    if (ACCESS_MODE === 'proxy') {
        const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        if (forwarded)
            return forwarded.toLowerCase();
    }
    return String(req.headers.host || '').toLowerCase();
}
function allowedRequestOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin)
        return { allowed: true, origin: null };
    if (ALLOWED_ORIGINS.includes(origin))
        return { allowed: true, origin };
    try {
        const parsed = new URL(origin);
        if (parsed.host.toLowerCase() === requestHost(req))
            return { allowed: true, origin };
        if (PUBLIC_BASE_URL && new URL(PUBLIC_BASE_URL).origin === parsed.origin)
            return { allowed: true, origin };
    }
    catch { }
    return { allowed: false, origin };
}
function securityHeaders(req) {
    const origin = String(req.headers.origin || '').trim();
    return {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: https://ui.com https://*.ui.com; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        ...(requestUsesHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
        ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {}),
    };
}
function commonResponseHeaders(res) {
    return res.gearbeaconHeaders || {};
}
function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Cache-Control': 'no-store',
        ...commonResponseHeaders(res),
    });
    res.end(text);
}
function sendJsonDownload(res, body, filename) {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Content-Disposition': `attachment; filename="${safeFilePart(filename)}"`,
        'Cache-Control': 'no-store',
        ...commonResponseHeaders(res),
    });
    res.end(text);
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        ...commonResponseHeaders(res),
    });
    res.end(text);
}
function readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let body = '';
        let failed = false;
        req.on('data', (chunk) => {
            if (failed)
                return;
            size += chunk.length;
            if (size > maxBytes) {
                const err = new Error('Request body too large');
                err.statusCode = 413;
                failed = true;
                reject(err);
                return;
            }
            body += chunk;
        });
        req.on('end', () => { if (!failed)
            resolve(body); });
        req.on('error', reject);
    });
}
async function readJsonBody(req, maxBytes = 1024 * 1024) {
    const raw = await readBody(req, maxBytes);
    const parsed = raw ? safeJsonParse(raw, null) : {};
    if (raw && parsed == null) {
        const err = new Error('Request body is not valid JSON.');
        err.statusCode = 400;
        throw err;
    }
    return parsed;
}
function staticFileFor(urlPath) {
    const clean = urlPath === '/' ? '/index.html' : urlPath;
    const full = path.normalize(path.join(WEB_DIR, clean));
    if (!full.startsWith(path.normalize(WEB_DIR)))
        return null;
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
    if (req.method === 'OPTIONS')
        return sendJson(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
        return sendJson(res, 200, authStatus(req));
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
        if (!setupRequired())
            return sendJson(res, 409, { error: 'Owner setup has already been completed.' });
        try {
            assertLoginAllowed(req);
        }
        catch (err) {
            return sendJson(res, err.statusCode || 429, { error: err.message });
        }
        const body = await readJsonBody(req);
        if (!setupToken || !safeEqualText(body?.setupToken || '', setupToken)) {
            recordLoginFailure(req);
            return sendJson(res, 401, { error: 'The setup token is invalid.' });
        }
        try {
            setOwnerPassword(body?.password);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        setupToken = null;
        clearLoginFailures(req);
        const created = createSession(req);
        res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': sessionCookie(req, created.token, created.expiresAt) };
        return sendJson(res, 201, { ok: true, authenticated: true, csrfToken: created.csrfToken, sessionExpiresAt: created.expiresAt });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        if (!authenticationRequired())
            return sendJson(res, 409, { error: 'Authentication is not enabled for this local-only instance.' });
        if (setupRequired())
            return sendJson(res, 428, { error: 'Owner setup must be completed first.', setupRequired: true });
        try {
            assertLoginAllowed(req);
        }
        catch (err) {
            return sendJson(res, err.statusCode || 429, { error: err.message });
        }
        const body = await readJsonBody(req);
        if (!verifyPassword(body?.password, ownerCredential()?.password_hash)) {
            recordLoginFailure(req);
            return sendJson(res, 401, { error: 'The owner password is incorrect.' });
        }
        clearLoginFailures(req);
        const created = createSession(req);
        res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': sessionCookie(req, created.token, created.expiresAt) };
        return sendJson(res, 200, { ok: true, authenticated: true, csrfToken: created.csrfToken, sessionExpiresAt: created.expiresAt });
    }
    const session = sessionForRequest(req);
    if (!session)
        return sendJson(res, setupRequired() ? 428 : 401, { error: setupRequired() ? 'Owner setup is required.' : 'Authentication is required.', setupRequired: setupRequired() });
    const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET');
    if (changesState && authenticationRequired() && !safeEqualText(req.headers['x-csrf-token'] || '', session.csrf_token || '')) {
        return sendJson(res, 403, { error: 'The security token is missing or invalid. Refresh the page and try again.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        if (session.token_hash)
            db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
        res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': expiredSessionCookie(req) };
        return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/sessions') {
        return sendJson(res, 200, { sessions: listSessions(session) });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/auth/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/auth/sessions/'.length));
        if (!/^[a-f0-9]{16}$/.test(id))
            return sendJson(res, 400, { error: 'Invalid session identifier.' });
        db.prepare('DELETE FROM sessions WHERE substr(token_hash,1,16)=?').run(id);
        const currentRevoked = session.token_hash?.startsWith(id);
        if (currentRevoked)
            res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': expiredSessionCookie(req) };
        return sendJson(res, 200, { ok: true, currentRevoked });
    }
    if (req.method === 'PUT' && url.pathname === '/api/auth/password') {
        const body = await readJsonBody(req);
        const credential = ownerCredential();
        if (credential && !verifyPassword(body?.currentPassword, credential.password_hash))
            return sendJson(res, 401, { error: 'The current owner password is incorrect.' });
        try {
            setOwnerPassword(body?.newPassword);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        db.exec('DELETE FROM sessions');
        const created = createSession(req);
        res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': sessionCookie(req, created.token, created.expiresAt) };
        return sendJson(res, 200, { ok: true, csrfToken: created.csrfToken, sessionExpiresAt: created.expiresAt });
    }
    const requestedRegion = String(url.searchParams.get('region') || DEFAULT_REGION).toLowerCase();
    if (!ACTIVE_REGIONS.includes(requestedRegion))
        return sendJson(res, 400, { error: `Region must be one of: ${ACTIVE_REGIONS.join(', ')}.` });
    return await regionContext.run(requestedRegion, () => handleRegionApi(req, res, url));
}
async function handleRegionApi(req, res, url) {
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
    if (req.method === 'POST' && url.pathname === '/api/data/export/encrypted') {
        const body = await readJsonBody(req);
        let encrypted;
        try {
            encrypted = encryptSnapshot(exportSnapshot(), body?.passphrase);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        const stamp = new Date().toISOString().slice(0, 10);
        return sendJsonDownload(res, encrypted, `GearBeacon-Backup-${stamp}.encrypted.gearbeacon.json`);
    }
    if (req.method === 'POST' && url.pathname === '/api/data/preview') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        try {
            const snapshot = decryptSnapshot(body?.backup || body, body?.passphrase);
            return sendJson(res, 200, previewSnapshot(snapshot));
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'POST' && url.pathname === '/api/data/import') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        try {
            const snapshot = decryptSnapshot(body?.backup || body, body?.passphrase);
            return sendJson(res, 200, importSnapshot(snapshot));
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
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
        if (watchOnly)
            products = products.filter((p) => p.watched);
        if (search)
            products = products.filter((p) => `${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(search));
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
            url: `${STORE_BASE}/${REGIONS[currentRegion()].path}/products/${slug}`,
            region: currentRegion(),
            watched: true,
        });
        return sendJson(res, 200, { products: items, count: items.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/watch') {
        const body = await readJsonBody(req);
        const slug = String(body?.slug || '').trim();
        if (!slug)
            return sendJson(res, 400, { error: 'slug is required' });
        if (!state.watchlist.includes(slug))
            state.watchlist.push(slug);
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
    if (req.method === 'GET' && url.pathname === '/api/notifications/preferences') {
        return sendJson(res, 200, { preferences: notificationPreferences() });
    }
    if (req.method === 'PUT' && url.pathname === '/api/notifications/preferences') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, preferences: updateNotificationPreferences(body?.preferences || body || {}) });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/test') {
        const result = await sendTestNotification();
        if (!result.configuredChannels)
            return sendJson(res, 409, { error: 'No server-side notification channel is configured or registered.', ...result });
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
        if (!existing)
            return sendJson(res, 404, { error: 'mock product not found' });
        mockOverrides[slug] = existing.inStock ? 'SoldOut' : 'Available';
        return sendJson(res, 200, { ok: true, slug, status: mockOverrides[slug] });
    }
    return sendJson(res, 404, { error: 'Not found' });
}
const server = http.createServer(async (req, res) => {
    try {
        const origin = allowedRequestOrigin(req);
        res.gearbeaconHeaders = securityHeaders(req);
        if (!origin.allowed)
            return sendJson(res, 403, { error: 'Request origin is not allowed.' });
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/healthz')
            return sendJson(res, 200, { ok: true, name: 'GearBeacon', version: APP_VERSION });
        if (url.pathname === '/readyz') {
            const ready = MOCK_MODE || ACTIVE_REGIONS.every((region) => {
                const item = monitors[region];
                return item.lastSuccessAt && !item.lastError && (Date.now() - new Date(item.lastSuccessAt).getTime()) / 1000 <= STALE_AFTER_SECONDS;
            });
            return sendJson(res, ready ? 200 : 503, { ok: ready, version: APP_VERSION });
        }
        if (url.pathname.startsWith('/api/'))
            return await handleApi(req, res, url);
        if (!['GET', 'HEAD'].includes(req.method || 'GET'))
            return sendText(res, 405, 'Method not allowed');
        const file = staticFileFor(url.pathname);
        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return sendText(res, 404, 'Not found');
        }
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': body.length, 'Cache-Control': 'no-cache', ...commonResponseHeaders(res) });
        res.end(body);
    }
    catch (err) {
        console.error('[http]', err);
        if (!res.headersSent)
            sendJson(res, err?.statusCode || 500, { error: err?.message || String(err) });
        else
            res.end();
    }
});
async function start() {
    if (!isLoopbackHost(BIND_HOST) && ACCESS_MODE === 'local' && !ALLOW_INSECURE_REMOTE) {
        throw new Error('Refusing to expose an unauthenticated local-mode server on a non-loopback address. Use GEARBEACON_ACCESS_MODE=private or explicitly set GEARBEACON_ALLOW_INSECURE_REMOTE=1.');
    }
    initializeOwnerAuthentication();
    console.log('');
    console.log(`  GearBeacon V${APP_VERSION}`);
    console.log('  Know the second it\'s back.');
    console.log('');
    console.log(`  Regions:     ${ACTIVE_REGIONS.map((region) => REGIONS[region].label).join(', ')}`);
    console.log(`  Poll:        ${POLL_SECONDS}s`);
    console.log(`  Access:      ${ACCESS_MODE}${authenticationRequired() ? ' · owner authentication' : ' · loopback only'}`);
    console.log(`  Bind:        ${BIND_HOST}:${PORT}`);
    console.log(`  Mock mode:   ${MOCK_MODE ? 'ON' : 'off'}`);
    console.log(`  ntfy:        ${NTFY_TOPIC ? 'configured' : 'off'}`);
    console.log(`  Discord:     ${DISCORD_WEBHOOK_URL ? 'configured' : 'off'}`);
    console.log(`  Webhook:     ${GENERIC_WEBHOOK_URL ? 'configured' : 'off'}`);
    console.log(`  Gotify:      ${GOTIFY_BASE_URL && GOTIFY_TOKEN ? 'configured' : 'off'}`);
    console.log(`  Email:       ${smtpConfigured() ? 'configured' : 'off'}`);
    console.log(`  Data:        ${USER_DATA_DIR}`);
    console.log(`  Database:    ${path.basename(DB_FILE)} · schema v${schemaVersion()}`);
    console.log('');
    if (setupRequired()) {
        console.log('');
        console.log('  OWNER SETUP REQUIRED');
        console.log(`  Setup token: ${setupToken}`);
        console.log('  Enter this token in the dashboard once, then create your owner password.');
    }
    console.log('');
    server.listen(PORT, BIND_HOST, () => {
        console.log(`  Dashboard:   http://localhost:${PORT}`);
        if (!isLoopbackHost(BIND_HOST))
            console.log(`  Private URL: http://YOUR-SERVER-IP:${PORT} (use HTTPS through a reverse proxy outside a trusted LAN/VPN)`);
        console.log('');
    });
    await Promise.all(ACTIVE_REGIONS.map((region) => regionContext.run(region, async () => {
        await checkStore('startup');
        scheduleMonitor();
    })));
    scheduleBackups();
}
function shutdown(signal) {
    for (const timer of monitorTimers.values())
        clearTimeout(timer);
    if (backupTimer)
        clearTimeout(backupTimer);
    try {
        for (const region of ACTIVE_REGIONS)
            flushState(region);
    }
    catch (err) {
        console.error('[data] final save failed:', err?.message || err);
    }
    try {
        db.exec('PRAGMA wal_checkpoint(FULL)');
    }
    catch { }
    server.close(() => {
        try {
            db.close();
        }
        catch { }
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
