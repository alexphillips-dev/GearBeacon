// GearBeacon V1.9 backend
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
const { renderEmail, buildMimeEmail } = require('./email');
const APP_VERSION = '1.9.0';
const DATABASE_SCHEMA_VERSION = 7;
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
let DEFAULT_REGION = ACTIVE_REGIONS[0];
const regionContext = new AsyncLocalStorage();
function currentRegion() { return regionContext.getStore() || DEFAULT_REGION; }
const PORT = Number(process.env.PORT || 8787);
let POLL_SECONDS = Math.max(30, Number(process.env.POLL_SECONDS || 60));
let NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim();
let NTFY_BASE_URL = String(process.env.NTFY_BASE_URL || 'https://ntfy.sh').trim().replace(/\/$/, '');
let NTFY_TOKEN = String(process.env.NTFY_TOKEN || '').trim();
let DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
let GENERIC_WEBHOOK_URL = String(process.env.GEARBEACON_WEBHOOK_URL || '').trim();
let GENERIC_WEBHOOK_TOKEN = String(process.env.GEARBEACON_WEBHOOK_TOKEN || '').trim();
let GENERIC_WEBHOOK_HMAC_SECRET = String(process.env.GEARBEACON_WEBHOOK_HMAC_SECRET || '').trim();
let GOTIFY_BASE_URL = String(process.env.GOTIFY_BASE_URL || '').trim().replace(/\/$/, '');
let GOTIFY_TOKEN = String(process.env.GOTIFY_TOKEN || '').trim();
let SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
let SMTP_PORT = Math.max(1, Number(process.env.SMTP_PORT || 587));
let SMTP_SECURE = ['1', 'true', 'yes'].includes(String(process.env.SMTP_SECURE || '').toLowerCase()) || SMTP_PORT === 465;
let SMTP_STARTTLS = !['0', 'false', 'no'].includes(String(process.env.SMTP_STARTTLS || '1').toLowerCase());
let SMTP_REJECT_UNAUTHORIZED = !['0', 'false', 'no'].includes(String(process.env.SMTP_REJECT_UNAUTHORIZED || '1').toLowerCase());
let SMTP_USER = String(process.env.SMTP_USER || '');
let SMTP_PASSWORD = String(process.env.SMTP_PASSWORD || '');
let SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
let SMTP_TO = String(process.env.SMTP_TO || '').split(',').map((value) => value.trim()).filter(Boolean);
const MOCK_MODE = ['1', 'true', 'yes'].includes(String(process.env.MOCK_MODE || '').toLowerCase());
const UPDATE_MANIFEST_URL = String(process.env.GEARBEACON_UPDATE_MANIFEST_URL || '').trim();
const GITHUB_RELEASE_API = String(process.env.GEARBEACON_GITHUB_RELEASE_API !== undefined ? process.env.GEARBEACON_GITHUB_RELEASE_API : 'https://api.github.com/repos/alexphillips-dev/GearBeacon/releases/latest').trim();
let PUBLIC_BASE_URL = String(process.env.GEARBEACON_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const MIN_CATALOG_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.GEARBEACON_MIN_CATALOG_RATIO || 0.55)));
const STALE_AFTER_SECONDS = Math.max(POLL_SECONDS * 3, Number(process.env.GEARBEACON_STALE_AFTER_SECONDS || 180));
let BACKUP_RETENTION = Math.max(1, Math.min(100, Number(process.env.GEARBEACON_BACKUP_RETENTION || 10)));
let BACKUP_INTERVAL_HOURS = Math.max(0, Number(process.env.GEARBEACON_BACKUP_INTERVAL_HOURS || 24));
let EVENT_RETENTION_DAYS = Math.max(0, Math.min(3650, Number(process.env.GEARBEACON_EVENT_RETENTION_DAYS || 365)));
let SECONDARY_BACKUP_DIR = String(process.env.GEARBEACON_SECONDARY_BACKUP_DIR || '').trim();
let SECONDARY_ENCRYPTED_EXPORTS = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_SECONDARY_ENCRYPTED_EXPORTS || '').toLowerCase());
const rawAccessMode = String(process.env.GEARBEACON_ACCESS_MODE || 'local').trim().toLowerCase();
if (!['local', 'private', 'proxy'].includes(rawAccessMode))
    throw new Error('GEARBEACON_ACCESS_MODE must be local, private, or proxy.');
let ACCESS_MODE = rawAccessMode;
let BIND_HOST = String(process.env.GEARBEACON_BIND_HOST || (ACCESS_MODE === 'private' ? '0.0.0.0' : '127.0.0.1')).trim();
const ALLOW_INSECURE_REMOTE = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_ALLOW_INSECURE_REMOTE || '').toLowerCase());
let COOKIE_SECURE = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_COOKIE_SECURE || '').toLowerCase())
    || PUBLIC_BASE_URL.toLowerCase().startsWith('https://');
const SESSION_HOURS = Math.max(1, Math.min(24 * 90, Number(process.env.GEARBEACON_SESSION_HOURS || 168)));
let ALLOWED_ORIGINS = String(process.env.GEARBEACON_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
let NOTIFICATION_MAX_ATTEMPTS = Math.max(1, Math.min(10, Number(process.env.GEARBEACON_NOTIFICATION_MAX_ATTEMPTS || 5)));
let NOTIFICATION_GROUP_SECONDS = Math.max(0, Math.min(3600, Number(process.env.GEARBEACON_NOTIFICATION_GROUP_SECONDS || 0)));
let HISTORY_RETENTION_DAYS = Math.max(30, Math.min(3650, Number(process.env.GEARBEACON_HISTORY_RETENTION_DAYS || 365)));
let NOTIFICATION_TIME_ZONE = String(process.env.GEARBEACON_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').trim();
let QUIET_HOURS_ENABLED = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_QUIET_HOURS_ENABLED || '').toLowerCase());
let QUIET_HOURS_START = String(process.env.GEARBEACON_QUIET_HOURS_START || '22:00').trim();
let QUIET_HOURS_END = String(process.env.GEARBEACON_QUIET_HOURS_END || '07:00').trim();
let DIGEST_ENABLED = ['1', 'true', 'yes'].includes(String(process.env.GEARBEACON_DIGEST_ENABLED || '').toLowerCase());
let DIGEST_TIME = String(process.env.GEARBEACON_DIGEST_TIME || '09:00').trim();
let NOTIFICATION_COOLDOWN_MINUTES = Math.max(0, Math.min(10080, Number(process.env.GEARBEACON_NOTIFICATION_COOLDOWN_MINUTES || 30)));
let EMAIL_DETAIL_LEVEL = ['compact', 'standard', 'detailed'].includes(String(process.env.GEARBEACON_EMAIL_DETAIL_LEVEL || '').toLowerCase()) ? String(process.env.GEARBEACON_EMAIL_DETAIL_LEVEL).toLowerCase() : 'standard';
let EMAIL_EMBED_IMAGES = !['0', 'false', 'no'].includes(String(process.env.GEARBEACON_EMAIL_EMBED_IMAGES ?? '1').toLowerCase());
let EMAIL_EXPLAIN_REASON = !['0', 'false', 'no'].includes(String(process.env.GEARBEACON_EMAIL_EXPLAIN_REASON ?? '1').toLowerCase());
let EMAIL_PRICE_CALCULATIONS = !['0', 'false', 'no'].includes(String(process.env.GEARBEACON_EMAIL_PRICE_CALCULATIONS ?? '1').toLowerCase());
let EMAIL_DIGEST_MAX_ITEMS = Math.max(1, Math.min(50, Number(process.env.GEARBEACON_EMAIL_DIGEST_MAX_ITEMS || 12)));
let EMAIL_SUBJECT_PREFIX = String(process.env.GEARBEACON_EMAIL_SUBJECT_PREFIX ?? '[GearBeacon]').trim().slice(0, 60);
let EMAIL_THEME = ['auto', 'light', 'dark'].includes(String(process.env.GEARBEACON_EMAIL_THEME || '').toLowerCase()) ? String(process.env.GEARBEACON_EMAIL_THEME).toLowerCase() : 'auto';
if (/[\r\n]/.test(EMAIL_SUBJECT_PREFIX))
    throw new Error('GEARBEACON_EMAIL_SUBJECT_PREFIX must not contain line breaks.');
try {
    new Intl.DateTimeFormat('en-US', { timeZone: NOTIFICATION_TIME_ZONE }).format();
}
catch {
    throw new Error('GEARBEACON_TIME_ZONE must be a valid IANA timezone, such as America/New_York.');
}
if (![QUIET_HOURS_START, QUIET_HOURS_END, DIGEST_TIME].every((value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error('Quiet-hours and digest environment times must use 24-hour HH:MM format.');
}
const operationalAlertEnabled = (name) => !['0', 'false', 'no'].includes(String(process.env[name] ?? '1').toLowerCase());
let OPERATIONAL_ALERTS = {
    monitorFailures: operationalAlertEnabled('GEARBEACON_ALERT_MONITOR_FAILURES'),
    notificationFailures: operationalAlertEnabled('GEARBEACON_ALERT_NOTIFICATION_FAILURES'),
    backupFailures: operationalAlertEnabled('GEARBEACON_ALERT_BACKUP_FAILURES'),
    lowDiskSpace: operationalAlertEnabled('GEARBEACON_ALERT_LOW_DISK'),
};
const CHANNEL_NAMES = ['ntfy', 'discord', 'gotify', 'webhook', 'email'];
let CHANNEL_ENABLED = Object.fromEntries(CHANNEL_NAMES.map((name) => [name, true]));
let runningAsSea = false;
try {
    runningAsSea = Boolean(require('node:sea').isSea());
}
catch { }
const PROJECT_ROOT = runningAsSea ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const LEGACY_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const RELEASE_MANIFEST_FILE = path.join(PROJECT_ROOT, 'release-manifest.json');
const BUILD_INFO_FILE = path.join(PROJECT_ROOT, 'build-info.json');
const BUILD_INFO = fs.existsSync(BUILD_INFO_FILE) ? safeJsonParse(fs.readFileSync(BUILD_INFO_FILE, 'utf8'), {}) : {};
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
const SECRET_KEY_FILE = path.join(USER_DATA_DIR, 'secrets.key');
fs.mkdirSync(USER_DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
try {
    if (process.platform !== 'win32') {
        fs.chmodSync(USER_DATA_DIR, 0o700);
        fs.chmodSync(BACKUP_DIR, 0o700);
    }
}
catch { }
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
const DEFAULT_WATCH_RULE = Object.freeze({
    enabled: true,
    restock: null,
    soldOut: null,
    priceChange: null,
    statusChange: null,
    priceDropOnly: false,
    targetPrice: null,
    immediateRestock: false,
    pausedUntil: null,
});
function priceValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    const normalized = String(value || '').replace(/[^0-9,.-]/g, '').replace(/,/g, '');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
function normalizeWatchRule(input, base = DEFAULT_WATCH_RULE) {
    const value = input && typeof input === 'object' ? input : {};
    const normalized = { ...base };
    if (typeof value.enabled === 'boolean')
        normalized.enabled = value.enabled;
    for (const key of ['restock', 'soldOut', 'priceChange', 'statusChange']) {
        if (value[key] === null || typeof value[key] === 'boolean')
            normalized[key] = value[key];
    }
    if (typeof value.priceDropOnly === 'boolean')
        normalized.priceDropOnly = value.priceDropOnly;
    if (typeof value.immediateRestock === 'boolean')
        normalized.immediateRestock = value.immediateRestock;
    if (value.targetPrice === null || value.targetPrice === '')
        normalized.targetPrice = null;
    else if (value.targetPrice !== undefined) {
        const target = Number(value.targetPrice);
        if (!Number.isFinite(target) || target < 0 || target > 1000000)
            throw new Error('Target price must be a positive number.');
        normalized.targetPrice = Math.round(target * 100) / 100;
    }
    if (value.pausedUntil === null || value.pausedUntil === '')
        normalized.pausedUntil = null;
    else if (value.pausedUntil === 'indefinite')
        normalized.pausedUntil = 'indefinite';
    else if (value.pausedUntil !== undefined) {
        const paused = new Date(value.pausedUntil);
        if (Number.isNaN(paused.valueOf()))
            throw new Error('Pause end must be a valid date and time.');
        normalized.pausedUntil = paused.toISOString();
    }
    return normalized;
}
function watchRule(slug, region = currentRegion()) {
    if (!tableExists('watch_rules'))
        return { ...DEFAULT_WATCH_RULE };
    const row = db.prepare('SELECT rule_json FROM watch_rules WHERE region=? AND slug=?').get(region, slug);
    return normalizeWatchRule(safeJsonParse(row?.rule_json || '', {}));
}
function saveWatchRule(slug, input, region = currentRegion()) {
    const next = normalizeWatchRule(input, watchRule(slug, region));
    db.prepare(`INSERT INTO watch_rules(region,slug,rule_json,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(region,slug) DO UPDATE SET rule_json=excluded.rule_json,updated_at=excluded.updated_at`)
        .run(region, slug, JSON.stringify(next), isoNow());
    return next;
}
function rulePaused(rule, at = Date.now()) {
    if (!rule.enabled || rule.pausedUntil === 'indefinite')
        return true;
    return Boolean(rule.pausedUntil && new Date(rule.pausedUntil).getTime() > at);
}
function productObservations(slug, region = currentRegion(), limit = 180) {
    if (!tableExists('product_observations'))
        return [];
    return db.prepare(`SELECT observed_at AS observedAt,change_type AS changeType,status,in_stock AS inStock,price_text AS price,price_value AS priceValue
    FROM product_observations WHERE region=? AND slug=? ORDER BY observed_at DESC,id DESC LIMIT ?`).all(region, slug, limit)
        .map((row) => ({ ...row, inStock: Boolean(row.inStock) }));
}
function recordProductObservation(product, changeType = 'observed', region = currentRegion()) {
    if (!product || !tableExists('product_observations'))
        return;
    const previous = db.prepare('SELECT status,in_stock,price_text FROM product_observations WHERE region=? AND slug=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(region, product.slug);
    if (previous && previous.status === product.status && Boolean(previous.in_stock) === Boolean(product.inStock) && (previous.price_text || null) === (product.price || null))
        return;
    db.prepare(`INSERT INTO product_observations(region,slug,observed_at,change_type,status,in_stock,price_text,price_value)
    VALUES(?,?,?,?,?,?,?,?)`).run(region, product.slug, isoNow(), changeType, product.status || null, product.inStock ? 1 : 0, product.price || null, priceValue(product.price));
}
function pruneProductObservations() {
    if (!tableExists('product_observations'))
        return;
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM product_observations WHERE observed_at<?').run(cutoff);
}
function schemaVersion() {
    if (!tableExists('schema_migrations'))
        return 0;
    return Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version || 0);
}
function listBackups(directory = BACKUP_DIR) {
    if (!directory || !fs.existsSync(directory))
        return [];
    try {
        return fs.readdirSync(directory)
            .filter((name) => name.endsWith('.sqlite3') || name.endsWith('.json'))
            .map((name) => {
            const full = path.join(directory, name);
            const stat = fs.statSync(full);
            return { name, path: full, size: stat.size, createdAt: stat.mtime.toISOString() };
        })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    catch {
        return [];
    }
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
function ensureSecondaryBackupDirectory() {
    if (!SECONDARY_BACKUP_DIR)
        return null;
    fs.mkdirSync(SECONDARY_BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(SECONDARY_BACKUP_DIR);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Secondary backup destination is not a regular directory.');
    fs.accessSync(SECONDARY_BACKUP_DIR, fs.constants.R_OK | fs.constants.W_OK);
    try {
        if (process.platform !== 'win32')
            fs.chmodSync(SECONDARY_BACKUP_DIR, 0o700);
    }
    catch { }
    return SECONDARY_BACKUP_DIR;
}
function backupLocationsShareDevice() {
    if (!SECONDARY_BACKUP_DIR || !fs.existsSync(SECONDARY_BACKUP_DIR))
        return null;
    try {
        return fs.statSync(BACKUP_DIR).dev === fs.statSync(SECONDARY_BACKUP_DIR).dev;
    }
    catch {
        return null;
    }
}
function trimSecondaryBackups() {
    if (!SECONDARY_BACKUP_DIR)
        return;
    for (const old of listBackups(SECONDARY_BACKUP_DIR).slice(BACKUP_RETENTION)) {
        try {
            fs.unlinkSync(old.path);
        }
        catch { }
    }
}
let runtimeReadyForRecoveryCopies = false;
function createSecondaryRecoveryCopy(primaryBackup, reason) {
    if (!SECONDARY_BACKUP_DIR || !runtimeReadyForRecoveryCopies)
        return null;
    let temporary = null;
    try {
        ensureSecondaryBackupDirectory();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let filename;
        let destination;
        if (SECONDARY_ENCRYPTED_EXPORTS) {
            const passphrase = String(storedSecrets().secondaryBackupPassphrase || '');
            if (passphrase.length < 12)
                throw new Error('Scheduled encrypted recovery copies require a saved passphrase of at least 12 characters.');
            filename = `${safeFilePart(reason)}-${stamp}.encrypted.gearbeacon.json`;
            destination = path.join(SECONDARY_BACKUP_DIR, filename);
            temporary = `${destination}.tmp-${process.pid}`;
            const encrypted = encryptSnapshot(exportSnapshot(), passphrase);
            fs.writeFileSync(temporary, JSON.stringify(encrypted), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            const verified = decryptSnapshot(safeJsonParse(fs.readFileSync(temporary, 'utf8'), null), passphrase);
            previewSnapshot(verified);
            fs.renameSync(temporary, destination);
        }
        else {
            if (!primaryBackup?.path)
                throw new Error('A validated primary backup is required for the recovery copy.');
            filename = primaryBackup.filename;
            destination = path.join(SECONDARY_BACKUP_DIR, filename);
            temporary = `${destination}.tmp-${process.pid}`;
            fs.copyFileSync(primaryBackup.path, temporary, fs.constants.COPYFILE_EXCL);
            const integrity = databaseIntegrity(temporary);
            if (!integrity.ok)
                throw new Error(`Secondary copy integrity failed: ${integrity.messages.join('; ')}`);
            fs.renameSync(temporary, destination);
        }
        trimSecondaryBackups();
        return { configured: true, ok: true, filename, size: fs.statSync(destination).size, createdAt: isoNow(), encrypted: SECONDARY_ENCRYPTED_EXPORTS, sameFilesystem: backupLocationsShareDevice() };
    }
    catch (err) {
        writeAppLog('error', 'backups', 'Secondary recovery copy failed.', { error: String(err?.message || err), directory: SECONDARY_BACKUP_DIR });
        return { configured: true, ok: false, error: String(err?.message || err) };
    }
    finally {
        if (temporary && fs.existsSync(temporary)) {
            try {
                fs.unlinkSync(temporary);
            }
            catch { }
        }
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
    try {
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
        const size = fs.statSync(destination).size;
        const primary = { filename, path: destination, size, createdAt: isoNow(), reason, validated: true };
        const secondary = createSecondaryRecoveryCopy(primary, reason);
        if (tableExists('backup_log'))
            db.prepare('INSERT INTO backup_log(filename,reason,status,size,detail,created_at) VALUES(?,?,?,?,?,?)').run(filename, reason, 'validated', size, secondary ? JSON.stringify({ secondary }) : null, isoNow());
        return { ...primary, secondary };
    }
    catch (err) {
        if (tableExists('backup_log'))
            db.prepare('INSERT INTO backup_log(filename,reason,status,size,detail,created_at) VALUES(?,?,?,?,?,?)').run(null, reason, 'failed', null, String(err?.message || err).slice(0, 1000), isoNow());
        throw err;
    }
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
    {
        version: 5,
        name: 'guided-setup-operations-and-reliable-delivery',
        sql: `
      CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        region TEXT NOT NULL,
        channel TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_queue_due ON notification_queue(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS app_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_log_created ON app_log(created_at);
      CREATE TABLE IF NOT EXISTS backup_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        size INTEGER,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backup_log_created ON backup_log(created_at);
    `,
    },
    {
        version: 6,
        name: 'watch-intelligence-and-scheduled-alerts',
        sql: `
      CREATE TABLE IF NOT EXISTS product_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        change_type TEXT NOT NULL,
        status TEXT,
        in_stock INTEGER NOT NULL DEFAULT 0,
        price_text TEXT,
        price_value REAL
      );
      CREATE INDEX IF NOT EXISTS idx_product_observations_lookup ON product_observations(region,slug,observed_at DESC);
      CREATE TABLE IF NOT EXISTS watch_rules (
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        rule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(region,slug)
      );
      CREATE TABLE IF NOT EXISTS notification_cooldowns (
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        event_type TEXT NOT NULL,
        last_notified_at TEXT NOT NULL,
        PRIMARY KEY(region,slug,event_type)
      );
    `,
    },
    {
        version: 7,
        name: 'monitor-confidence-activity-and-recovery',
        sql: `
      ALTER TABLE events ADD COLUMN type TEXT;
      ALTER TABLE events ADD COLUMN slug TEXT;
      ALTER TABLE events ADD COLUMN name TEXT;
      ALTER TABLE events ADD COLUMN alert_kind TEXT;
      CREATE INDEX IF NOT EXISTS idx_events_detected ON events(detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_region_type_detected ON events(region,type,detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_region_slug_detected ON events(region,slug,detected_at DESC);
      CREATE TABLE IF NOT EXISTS pending_transitions (
        region TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(region,slug,kind)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_transitions_region ON pending_transitions(region,last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS monitor_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        catalog_count INTEGER,
        duration_ms INTEGER,
        detail TEXT,
        partial_errors_json TEXT,
        retry_after_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_checks_region_checked ON monitor_checks(region,checked_at DESC);
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
function backfillEventColumns() {
    if (!tableExists('events') || !db.prepare("SELECT name FROM pragma_table_info('events') WHERE name='type'").get())
        return;
    const update = db.prepare('UPDATE events SET type=?,slug=?,name=?,alert_kind=? WHERE id=?');
    for (const row of db.prepare("SELECT id,data_json FROM events WHERE type IS NULL OR slug IS NULL OR name IS NULL").all()) {
        const event = safeJsonParse(row.data_json, {});
        update.run(event.type || null, event.slug || null, event.name || null, event.alertKind || event.type || null, row.id);
    }
}
function writeAppLog(level, source, message, detail = null) {
    const normalizedLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    const text = String(message || '').slice(0, 2000);
    try {
        if (tableExists('app_log')) {
            db.prepare('INSERT INTO app_log(level,source,message,detail_json,created_at) VALUES(?,?,?,?,?)')
                .run(normalizedLevel, String(source || 'app').slice(0, 80), text, detail ? JSON.stringify(detail).slice(0, 10000) : null, isoNow());
            db.prepare('DELETE FROM app_log WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT 5000)').run();
        }
    }
    catch { }
}
function secretKey() {
    try {
        if (fs.existsSync(SECRET_KEY_FILE)) {
            const stat = fs.lstatSync(SECRET_KEY_FILE);
            if (stat.isSymbolicLink() || !stat.isFile())
                throw new Error('Secret key path is not a regular file.');
            const key = Buffer.from(fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64');
            if (key.length !== 32)
                throw new Error('Secret key file is invalid.');
            try {
                fs.chmodSync(SECRET_KEY_FILE, 0o600);
            }
            catch { }
            return key;
        }
        const key = crypto.randomBytes(32);
        fs.writeFileSync(SECRET_KEY_FILE, key.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return key;
    }
    catch (err) {
        throw new Error(`Unable to load the local notification encryption key: ${err?.message || err}`);
    }
}
function encryptLocalSecrets(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
    cipher.setAAD(Buffer.from('GearBeacon:notification-secrets:v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}
function decryptLocalSecrets(value) {
    if (!value)
        return {};
    try {
        const [version, ivText, tagText, dataText] = String(value).split(':');
        if (version !== 'v1')
            throw new Error('unsupported secret format');
        const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivText, 'base64'));
        decipher.setAAD(Buffer.from('GearBeacon:notification-secrets:v1'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8'));
    }
    catch (err) {
        throw new Error(`Stored notification credentials could not be decrypted: ${err?.message || err}`);
    }
}
const DEFAULT_APP_CONFIG = Object.freeze({
    regions: [...ACTIVE_REGIONS],
    pollSeconds: POLL_SECONDS,
    accessMode: ACCESS_MODE,
    bindHost: BIND_HOST,
    publicBaseUrl: PUBLIC_BASE_URL,
    cookieSecure: COOKIE_SECURE,
    allowedOrigins: [...ALLOWED_ORIGINS],
    backupIntervalHours: BACKUP_INTERVAL_HOURS,
    backupRetention: BACKUP_RETENTION,
    historyRetentionDays: HISTORY_RETENTION_DAYS,
    eventRetentionDays: EVENT_RETENTION_DAYS,
    secondaryBackupDir: SECONDARY_BACKUP_DIR,
    secondaryEncryptedExports: SECONDARY_ENCRYPTED_EXPORTS,
    notificationMaxAttempts: NOTIFICATION_MAX_ATTEMPTS,
    notificationGroupSeconds: NOTIFICATION_GROUP_SECONDS,
    notificationTimeZone: NOTIFICATION_TIME_ZONE,
    quietHoursEnabled: QUIET_HOURS_ENABLED,
    quietHoursStart: QUIET_HOURS_START,
    quietHoursEnd: QUIET_HOURS_END,
    digestEnabled: DIGEST_ENABLED,
    digestTime: DIGEST_TIME,
    notificationCooldownMinutes: NOTIFICATION_COOLDOWN_MINUTES,
    emailDetailLevel: EMAIL_DETAIL_LEVEL,
    emailEmbedImages: EMAIL_EMBED_IMAGES,
    emailExplainReason: EMAIL_EXPLAIN_REASON,
    emailPriceCalculations: EMAIL_PRICE_CALCULATIONS,
    emailDigestMaxItems: EMAIL_DIGEST_MAX_ITEMS,
    emailSubjectPrefix: EMAIL_SUBJECT_PREFIX,
    emailTheme: EMAIL_THEME,
    operationalAlerts: { ...OPERATIONAL_ALERTS },
    channelEnabled: { ...CHANNEL_ENABLED },
    ntfyBaseUrl: NTFY_BASE_URL,
    ntfyTopic: NTFY_TOPIC,
    gotifyBaseUrl: GOTIFY_BASE_URL,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    smtpSecure: SMTP_SECURE,
    smtpStarttls: SMTP_STARTTLS,
    smtpRejectUnauthorized: SMTP_REJECT_UNAUTHORIZED,
    smtpUser: SMTP_USER,
    smtpFrom: SMTP_FROM,
    smtpTo: [...SMTP_TO],
});
function validHttpUrl(value, { httpsOnly = false, allowEmpty = true } = {}) {
    if (!value && allowEmpty)
        return '';
    let parsed;
    try {
        parsed = new URL(String(value));
    }
    catch {
        throw new Error(`Invalid URL: ${value}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || (httpsOnly && parsed.protocol !== 'https:'))
        throw new Error(`URL must use ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'}.`);
    if (parsed.username || parsed.password)
        throw new Error('URLs must not contain embedded credentials.');
    return parsed.toString().replace(/\/$/, '');
}
function validTimeOfDay(value, label) {
    const text = String(value || '').trim();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text))
        throw new Error(`${label} must use 24-hour HH:MM format.`);
    return text;
}
function validTimeZone(value) {
    const text = String(value || '').trim();
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: text }).format();
    }
    catch {
        throw new Error('Notification timezone must be a valid IANA timezone, such as America/New_York.');
    }
    return text;
}
function validBackupDirectory(value) {
    const text = String(value || '').trim();
    if (!text)
        return '';
    if (!path.isAbsolute(text))
        throw new Error('Secondary backup directory must be an absolute path or mounted network path.');
    const resolved = path.resolve(text);
    const within = (parent, child) => {
        const relative = path.relative(path.resolve(parent), path.resolve(child));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (within(USER_DATA_DIR, resolved) || within(resolved, USER_DATA_DIR))
        throw new Error('Secondary backups must use a directory separate from the GearBeacon data directory.');
    if (fs.existsSync(resolved)) {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error('Secondary backup directory must be a real directory, not a file or symbolic link.');
    }
    return resolved;
}
function normalizeAppConfig(input, base = DEFAULT_APP_CONFIG) {
    const body = input && typeof input === 'object' ? input : {};
    const regions = Array.isArray(body.regions) ? [...new Set(body.regions.map((x) => String(x).toLowerCase()).filter((x) => REGIONS[x]))] : [...base.regions];
    if (!regions.length)
        throw new Error('Select at least one supported store region.');
    const pollSeconds = Number(body.pollSeconds ?? base.pollSeconds);
    if (!Number.isFinite(pollSeconds) || pollSeconds < 30 || pollSeconds > 86400)
        throw new Error('Polling interval must be between 30 and 86400 seconds.');
    const accessMode = String(body.accessMode ?? base.accessMode).toLowerCase();
    if (!['local', 'private', 'proxy'].includes(accessMode))
        throw new Error('Access mode must be local, private, or proxy.');
    const bindHost = String(body.bindHost ?? base.bindHost).trim();
    const bindNameValid = bindHost === 'localhost' || /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(bindHost);
    if (!bindHost || (!net.isIP(bindHost.replace(/^\[|\]$/g, '')) && !bindNameValid))
        throw new Error('Bind host must be a valid IP address or hostname.');
    if (accessMode === 'local' && !isLoopbackHost(bindHost))
        throw new Error('Local mode must bind to a loopback address. Choose private or proxy mode for remote access.');
    const publicBaseUrl = validHttpUrl(String(body.publicBaseUrl ?? base.publicBaseUrl).trim());
    if (accessMode === 'proxy' && !publicBaseUrl.startsWith('https://'))
        throw new Error('Proxy mode requires an HTTPS public URL.');
    const backupIntervalHours = Number(body.backupIntervalHours ?? base.backupIntervalHours);
    if (!Number.isFinite(backupIntervalHours) || backupIntervalHours < 0 || backupIntervalHours > 720)
        throw new Error('Backup interval must be between 0 and 720 hours.');
    const backupRetention = Number(body.backupRetention ?? base.backupRetention);
    if (!Number.isInteger(backupRetention) || backupRetention < 1 || backupRetention > 100)
        throw new Error('Backup retention must be between 1 and 100.');
    const historyRetentionDays = Number(body.historyRetentionDays ?? base.historyRetentionDays);
    if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 30 || historyRetentionDays > 3650)
        throw new Error('Product history retention must be between 30 and 3650 days.');
    const eventRetentionDays = Number(body.eventRetentionDays ?? base.eventRetentionDays);
    if (!Number.isInteger(eventRetentionDays) || (eventRetentionDays !== 0 && (eventRetentionDays < 30 || eventRetentionDays > 3650)))
        throw new Error('Activity retention must be 0 for unlimited, or between 30 and 3650 days.');
    const notificationMaxAttempts = Number(body.notificationMaxAttempts ?? base.notificationMaxAttempts);
    if (!Number.isInteger(notificationMaxAttempts) || notificationMaxAttempts < 1 || notificationMaxAttempts > 10)
        throw new Error('Notification attempts must be between 1 and 10.');
    const notificationGroupSeconds = Number(body.notificationGroupSeconds ?? base.notificationGroupSeconds);
    if (!Number.isFinite(notificationGroupSeconds) || notificationGroupSeconds < 0 || notificationGroupSeconds > 3600)
        throw new Error('Notification grouping must be between 0 and 3600 seconds.');
    const notificationCooldownMinutes = Number(body.notificationCooldownMinutes ?? base.notificationCooldownMinutes);
    if (!Number.isFinite(notificationCooldownMinutes) || notificationCooldownMinutes < 0 || notificationCooldownMinutes > 10080)
        throw new Error('Notification cooldown must be between 0 and 10080 minutes.');
    const emailDetailLevel = String(body.emailDetailLevel ?? base.emailDetailLevel).toLowerCase();
    if (!['compact', 'standard', 'detailed'].includes(emailDetailLevel))
        throw new Error('Email detail level must be compact, standard, or detailed.');
    const emailTheme = String(body.emailTheme ?? base.emailTheme).toLowerCase();
    if (!['auto', 'light', 'dark'].includes(emailTheme))
        throw new Error('Email theme must be auto, light, or dark.');
    const emailDigestMaxItems = Number(body.emailDigestMaxItems ?? base.emailDigestMaxItems);
    if (!Number.isInteger(emailDigestMaxItems) || emailDigestMaxItems < 1 || emailDigestMaxItems > 50)
        throw new Error('Email digest items must be between 1 and 50.');
    const emailSubjectPrefix = String(body.emailSubjectPrefix ?? base.emailSubjectPrefix).trim();
    if (/[\r\n]/.test(emailSubjectPrefix))
        throw new Error('Email subject prefix must not contain line breaks.');
    if (emailSubjectPrefix.length > 60)
        throw new Error('Email subject prefix must be 60 characters or fewer.');
    const operationalAlerts = { ...base.operationalAlerts };
    for (const key of Object.keys(operationalAlerts))
        if (typeof body.operationalAlerts?.[key] === 'boolean')
            operationalAlerts[key] = body.operationalAlerts[key];
    const smtpPort = Number(body.smtpPort ?? base.smtpPort);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
        throw new Error('SMTP port must be between 1 and 65535.');
    const smtpTo = Array.isArray(body.smtpTo) ? body.smtpTo.map(String).map((x) => x.trim()).filter(Boolean) : String(body.smtpTo ?? base.smtpTo.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
    for (const address of smtpTo)
        smtpAddress(address);
    if (body.smtpFrom ?? base.smtpFrom)
        smtpAddress(body.smtpFrom ?? base.smtpFrom);
    const allowedOrigins = Array.isArray(body.allowedOrigins) ? body.allowedOrigins.map(String).map((x) => x.trim()).filter(Boolean).map((x) => new URL(validHttpUrl(x)).origin) : [...base.allowedOrigins];
    const channelEnabled = { ...base.channelEnabled };
    for (const name of CHANNEL_NAMES)
        if (typeof body.channelEnabled?.[name] === 'boolean')
            channelEnabled[name] = body.channelEnabled[name];
    return {
        regions,
        pollSeconds: Math.round(pollSeconds),
        accessMode,
        bindHost,
        publicBaseUrl,
        cookieSecure: Boolean(body.cookieSecure ?? base.cookieSecure),
        allowedOrigins,
        backupIntervalHours,
        backupRetention,
        historyRetentionDays,
        eventRetentionDays,
        secondaryBackupDir: validBackupDirectory(body.secondaryBackupDir ?? base.secondaryBackupDir),
        secondaryEncryptedExports: Boolean(body.secondaryEncryptedExports ?? base.secondaryEncryptedExports),
        notificationMaxAttempts,
        notificationGroupSeconds,
        notificationTimeZone: validTimeZone(body.notificationTimeZone ?? base.notificationTimeZone),
        quietHoursEnabled: Boolean(body.quietHoursEnabled ?? base.quietHoursEnabled),
        quietHoursStart: validTimeOfDay(body.quietHoursStart ?? base.quietHoursStart, 'Quiet-hours start'),
        quietHoursEnd: validTimeOfDay(body.quietHoursEnd ?? base.quietHoursEnd, 'Quiet-hours end'),
        digestEnabled: Boolean(body.digestEnabled ?? base.digestEnabled),
        digestTime: validTimeOfDay(body.digestTime ?? base.digestTime, 'Digest time'),
        notificationCooldownMinutes,
        emailDetailLevel,
        emailEmbedImages: Boolean(body.emailEmbedImages ?? base.emailEmbedImages),
        emailExplainReason: Boolean(body.emailExplainReason ?? base.emailExplainReason),
        emailPriceCalculations: Boolean(body.emailPriceCalculations ?? base.emailPriceCalculations),
        emailDigestMaxItems,
        emailSubjectPrefix,
        emailTheme,
        operationalAlerts,
        channelEnabled,
        ntfyBaseUrl: validHttpUrl(String(body.ntfyBaseUrl ?? base.ntfyBaseUrl).trim()),
        ntfyTopic: String(body.ntfyTopic ?? base.ntfyTopic).trim().slice(0, 256),
        gotifyBaseUrl: validHttpUrl(String(body.gotifyBaseUrl ?? base.gotifyBaseUrl).trim()),
        smtpHost: String(body.smtpHost ?? base.smtpHost).trim().slice(0, 253),
        smtpPort,
        smtpSecure: Boolean(body.smtpSecure ?? base.smtpSecure),
        smtpStarttls: Boolean(body.smtpStarttls ?? base.smtpStarttls),
        smtpRejectUnauthorized: Boolean(body.smtpRejectUnauthorized ?? base.smtpRejectUnauthorized),
        smtpUser: String(body.smtpUser ?? base.smtpUser).slice(0, 320),
        smtpFrom: String(body.smtpFrom ?? base.smtpFrom).trim().slice(0, 320),
        smtpTo,
    };
}
function storedAppConfig() {
    return normalizeAppConfig(safeJsonParse(getSetting('app_config', ''), {}), DEFAULT_APP_CONFIG);
}
function storedSecrets() {
    return decryptLocalSecrets(getSetting('encrypted_notification_secrets', ''));
}
function applyAppConfig(config, secrets, { startup = false } = {}) {
    POLL_SECONDS = config.pollSeconds;
    PUBLIC_BASE_URL = config.publicBaseUrl;
    COOKIE_SECURE = config.cookieSecure || PUBLIC_BASE_URL.startsWith('https://');
    ALLOWED_ORIGINS = [...config.allowedOrigins];
    BACKUP_INTERVAL_HOURS = config.backupIntervalHours;
    BACKUP_RETENTION = config.backupRetention;
    HISTORY_RETENTION_DAYS = config.historyRetentionDays;
    EVENT_RETENTION_DAYS = config.eventRetentionDays;
    SECONDARY_BACKUP_DIR = config.secondaryBackupDir;
    SECONDARY_ENCRYPTED_EXPORTS = config.secondaryEncryptedExports;
    NOTIFICATION_MAX_ATTEMPTS = config.notificationMaxAttempts;
    NOTIFICATION_GROUP_SECONDS = config.notificationGroupSeconds;
    NOTIFICATION_TIME_ZONE = config.notificationTimeZone;
    QUIET_HOURS_ENABLED = config.quietHoursEnabled;
    QUIET_HOURS_START = config.quietHoursStart;
    QUIET_HOURS_END = config.quietHoursEnd;
    DIGEST_ENABLED = config.digestEnabled;
    DIGEST_TIME = config.digestTime;
    NOTIFICATION_COOLDOWN_MINUTES = config.notificationCooldownMinutes;
    EMAIL_DETAIL_LEVEL = config.emailDetailLevel;
    EMAIL_EMBED_IMAGES = config.emailEmbedImages;
    EMAIL_EXPLAIN_REASON = config.emailExplainReason;
    EMAIL_PRICE_CALCULATIONS = config.emailPriceCalculations;
    EMAIL_DIGEST_MAX_ITEMS = config.emailDigestMaxItems;
    EMAIL_SUBJECT_PREFIX = config.emailSubjectPrefix;
    EMAIL_THEME = config.emailTheme;
    OPERATIONAL_ALERTS = { ...config.operationalAlerts };
    CHANNEL_ENABLED = { ...config.channelEnabled };
    NTFY_BASE_URL = config.ntfyBaseUrl || 'https://ntfy.sh';
    NTFY_TOPIC = config.ntfyTopic;
    GOTIFY_BASE_URL = config.gotifyBaseUrl;
    SMTP_HOST = config.smtpHost;
    SMTP_PORT = config.smtpPort;
    SMTP_SECURE = config.smtpSecure;
    SMTP_STARTTLS = config.smtpStarttls;
    SMTP_REJECT_UNAUTHORIZED = config.smtpRejectUnauthorized;
    SMTP_USER = config.smtpUser;
    SMTP_FROM = config.smtpFrom;
    SMTP_TO = [...config.smtpTo];
    NTFY_TOKEN = String(secrets.ntfyToken ?? NTFY_TOKEN);
    DISCORD_WEBHOOK_URL = String(secrets.discordWebhookUrl ?? DISCORD_WEBHOOK_URL);
    GOTIFY_TOKEN = String(secrets.gotifyToken ?? GOTIFY_TOKEN);
    GENERIC_WEBHOOK_URL = String(secrets.webhookUrl ?? GENERIC_WEBHOOK_URL);
    GENERIC_WEBHOOK_TOKEN = String(secrets.webhookToken ?? GENERIC_WEBHOOK_TOKEN);
    GENERIC_WEBHOOK_HMAC_SECRET = String(secrets.webhookHmacSecret ?? GENERIC_WEBHOOK_HMAC_SECRET);
    SMTP_PASSWORD = String(secrets.smtpPassword ?? SMTP_PASSWORD);
    if (startup) {
        ACCESS_MODE = config.accessMode;
        BIND_HOST = config.bindHost;
        ACTIVE_REGIONS.splice(0, ACTIVE_REGIONS.length, ...config.regions);
        DEFAULT_REGION = ACTIVE_REGIONS[0];
    }
}
function secretStatus(secrets = storedSecrets()) {
    return {
        ntfyToken: Boolean(secrets.ntfyToken || NTFY_TOKEN),
        discordWebhookUrl: Boolean(secrets.discordWebhookUrl || DISCORD_WEBHOOK_URL),
        gotifyToken: Boolean(secrets.gotifyToken || GOTIFY_TOKEN),
        webhookUrl: Boolean(secrets.webhookUrl || GENERIC_WEBHOOK_URL),
        webhookToken: Boolean(secrets.webhookToken || GENERIC_WEBHOOK_TOKEN),
        webhookHmacSecret: Boolean(secrets.webhookHmacSecret || GENERIC_WEBHOOK_HMAC_SECRET),
        smtpPassword: Boolean(secrets.smtpPassword || SMTP_PASSWORD),
        secondaryBackupPassphrase: Boolean(secrets.secondaryBackupPassphrase),
    };
}
function saveBrowserConfig(input) {
    const current = storedAppConfig();
    const next = normalizeAppConfig(input, current);
    const currentSecrets = storedSecrets();
    const nextSecrets = { ...currentSecrets };
    const incomingSecrets = input?.secrets && typeof input.secrets === 'object' ? input.secrets : {};
    for (const key of ['ntfyToken', 'discordWebhookUrl', 'gotifyToken', 'webhookUrl', 'webhookToken', 'webhookHmacSecret', 'smtpPassword', 'secondaryBackupPassphrase']) {
        if (incomingSecrets[key] === null || incomingSecrets[key] === undefined)
            continue;
        const value = String(incomingSecrets[key]).trim();
        if (['discordWebhookUrl', 'webhookUrl'].includes(key) && value)
            validHttpUrl(value);
        nextSecrets[key] = value;
    }
    if (next.secondaryBackupDir) {
        fs.mkdirSync(next.secondaryBackupDir, { recursive: true, mode: 0o700 });
        const stat = fs.lstatSync(next.secondaryBackupDir);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error('Secondary backup destination is not a regular directory.');
        fs.accessSync(next.secondaryBackupDir, fs.constants.R_OK | fs.constants.W_OK);
    }
    if (nextSecrets.secondaryBackupPassphrase && String(nextSecrets.secondaryBackupPassphrase).length < 12)
        throw new Error('Secondary backup passphrase must be at least 12 characters.');
    if (next.secondaryEncryptedExports && String(nextSecrets.secondaryBackupPassphrase || '').length < 12)
        throw new Error('Save a secondary backup passphrase of at least 12 characters before enabling encrypted recovery copies.');
    const encryptedSecrets = encryptLocalSecrets(nextSecrets);
    db.exec('BEGIN IMMEDIATE');
    try {
        setSetting('app_config', JSON.stringify(next));
        setSetting('encrypted_notification_secrets', encryptedSecrets);
        db.exec('COMMIT');
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch { }
        throw err;
    }
    const restartRequired = next.accessMode !== ACCESS_MODE || next.bindHost !== BIND_HOST || JSON.stringify(next.regions) !== JSON.stringify(ACTIVE_REGIONS);
    applyAppConfig(next, nextSecrets);
    pruneProductObservations();
    pruneEvents();
    scheduleBackups();
    for (const region of ACTIVE_REGIONS)
        if (monitors?.[region])
            regionContext.run(region, scheduleMonitor);
    writeAppLog('info', 'configuration', 'Owner saved application configuration.', { restartRequired });
    return { config: next, secretsConfigured: secretStatus(nextSecrets), restartRequired };
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
    persistState(legacyState, region, { replaceEvents: true });
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
function persistState(nextState, region = currentRegion(), { replaceEvents = false } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const wanted = new Set(nextState.watchlist || []);
        for (const row of db.prepare('SELECT slug FROM watchlist WHERE region=?').all(region)) {
            if (!wanted.has(row.slug))
                db.prepare('DELETE FROM watchlist WHERE region=? AND slug=?').run(region, row.slug);
        }
        const addWatch = db.prepare('INSERT INTO watchlist(region,slug,created_at) VALUES(?,?,?) ON CONFLICT(region,slug) DO NOTHING');
        for (const slug of nextState.watchlist || [])
            addWatch.run(region, slug, isoNow());
        db.prepare('DELETE FROM products WHERE region=?').run(region);
        const addProduct = db.prepare('INSERT INTO products(region,slug,data_json,updated_at) VALUES(?,?,?,?)');
        for (const [slug, product] of Object.entries(nextState.products || {}))
            addProduct.run(region, slug, JSON.stringify(product), isoNow());
        if (replaceEvents) {
            db.prepare('DELETE FROM events WHERE region=?').run(region);
            const addEvent = db.prepare('INSERT INTO events(id,region,detected_at,data_json,type,slug,name,alert_kind) VALUES(?,?,?,?,?,?,?,?)');
            for (const event of (nextState.events || []).slice(-100000)) {
                addEvent.run(event.id, region, event.detectedAt || isoNow(), JSON.stringify(event), event.type || null, event.slug || null, event.name || null, event.alertKind || event.type || null);
            }
        }
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
let startupSafetyBackup = null;
if (dbExistedAtStartup && ((previousAppVersion && previousAppVersion !== APP_VERSION) || (previousSchemaVersion > 0 && previousSchemaVersion < DATABASE_SCHEMA_VERSION))) {
    const sourceVersion = previousAppVersion || `schema-${previousSchemaVersion}`;
    startupSafetyBackup = createDatabaseBackup(`pre-update-${sourceVersion}-to-${APP_VERSION}`);
    if (startupSafetyBackup)
        console.log(`[data] safety backup created before version migration: ${startupSafetyBackup.filename}`);
}
runMigrations();
backfillEventColumns();
if (startupSafetyBackup && tableExists('backup_log')) {
    const logged = db.prepare('SELECT id FROM backup_log WHERE filename=? LIMIT 1').get(startupSafetyBackup.filename);
    if (!logged)
        db.prepare('INSERT INTO backup_log(filename,reason,status,size,detail,created_at) VALUES(?,?,?,?,?,?)')
            .run(startupSafetyBackup.filename, startupSafetyBackup.reason, 'validated', startupSafetyBackup.size, 'Created before schema migration.', startupSafetyBackup.createdAt);
}
if (previousSchemaVersion > 0 && previousSchemaVersion < 5 && getSetting('onboarding_complete') == null) {
    setSetting('onboarding_complete', '1');
}
try {
    applyAppConfig(storedAppConfig(), storedSecrets(), { startup: true });
}
catch (err) {
    console.error('[configuration] saved settings could not be applied:', err?.message || err);
    writeAppLog('error', 'configuration', 'Saved configuration could not be applied; environment defaults are active.', { error: err?.message || String(err) });
}
for (const region of ACTIVE_REGIONS)
    importLegacyStateIfNeeded(region);
setMeta('last_app_version', APP_VERSION);
setMeta('last_started_at', isoNow());
const states = Object.fromEntries(ACTIVE_REGIONS.map((region) => [region, loadState(region)]));
for (const region of ACTIVE_REGIONS) {
    for (const product of Object.values(states[region].products))
        recordProductObservation(product, 'migration-baseline', region);
}
runtimeReadyForRecoveryCopies = true;
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
        pendingChanges: 0,
        retryAfterAt: null,
        lastAlertAt: null,
    }]));
const monitor = contextualProxy(monitors);
const mockOverrides = {};
if (MOCK_MODE && process.env.GEARBEACON_MOCK_OVERRIDES_JSON) {
    try {
        const startupOverrides = JSON.parse(process.env.GEARBEACON_MOCK_OVERRIDES_JSON);
        if (!startupOverrides || typeof startupOverrides !== 'object' || Array.isArray(startupOverrides))
            throw new Error('expected an object');
        Object.assign(mockOverrides, startupOverrides);
    }
    catch (err) {
        throw new Error(`GEARBEACON_MOCK_OVERRIDES_JSON is invalid: ${err?.message || err}`);
    }
}
const requestedMockCatalogSize = Number(process.env.GEARBEACON_MOCK_CATALOG_SIZE || 6);
const defaultMockCatalogSize = Number.isInteger(requestedMockCatalogSize) ? Math.max(6, Math.min(1000, requestedMockCatalogSize)) : 6;
let mockFaults = { rateLimitOnceSeconds: 0, partialOmitSlugs: [], catalogSize: defaultMockCatalogSize };
const MOCK_CATEGORIES = ['Cloud Gateways', 'Switching', 'WiFi', 'Cameras & Physical Security', 'Door Access', 'Accessories & Cables', 'Network Storage'];
const MOCK_PRODUCTS = [
    { slug: 'u7-pro-xgs', name: 'U7 Pro XGS', category: 'WiFi', price: '$299.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F1604d78c-6e51-4fe8-a8e5-0110cc332ba0%2F73d680d3-c54b-48fb-a5f5-51c31c97b5d6.png&w=256' },
    { slug: 'uvc-ai-turret', name: 'AI Turret', category: 'Cameras & Physical Security', price: '$399.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F995b6a91-fab1-4c15-b5b9-6dfdede19bab%2Fc5c464e2-6c87-4397-9f9a-6dc09d7afca3.png&w=256' },
    { slug: 'unas-pro', name: 'UNAS Pro', category: 'Network Storage', price: '$499.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2Fc73f5f36-f1af-4eb2-bf44-8a9f31eb3e3b%2F12fd2396-b8ae-4bb5-8898-16f400afaed0.png&w=256' },
    { slug: 'usw-pro-max-24-poe', name: 'Pro Max 24 PoE', category: 'Switching', price: '$799.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F58922518-88f6-4c75-89c1-f57ba3d8253a%2F9a68d63e-39cf-4d14-83ff-79d2c35b1b8c.png&w=256' },
    { slug: 'udm-se', name: 'Dream Machine Special Edition', category: 'Cloud Gateways', price: '$499.00', status: 'Available', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2F1b6fcc08-a6b8-4496-a831-6125a47c412f%2Fc1d1e0e0-4ec6-4760-9bc2-81cdfdf3eaa5.png&w=256' },
    { slug: 'uvc-g5-ptz', name: 'G5 PTZ', category: 'Cameras & Physical Security', price: '$299.00', status: 'SoldOut', imageUrl: 'https://images.svc.ui.com/?q=75&u=https%3A%2F%2Fcdn.ecomm.ui.com%2Fproducts%2Fe3cbecf3-07dc-4f09-82e1-b88dca942d7a%2F8db989da-7174-4288-8d46-b486a20e11c3.png&w=256' },
];
function mockCatalogSource() {
    const products = [...MOCK_PRODUCTS];
    for (let index = products.length + 1; index <= mockFaults.catalogSize; index += 1) {
        products.push({
            slug: `mock-product-${String(index).padStart(4, '0')}`,
            name: `Mock Product ${String(index).padStart(4, '0')}`,
            category: MOCK_CATEGORIES[(index - 1) % MOCK_CATEGORIES.length],
            price: `$${(49 + index).toFixed(2)}`,
            status: index % 4 === 0 ? 'SoldOut' : 'Available',
            imageUrl: null,
        });
    }
    return products;
}
function mockCatalog() {
    const region = currentRegion();
    return mockCatalogSource().filter((p) => mockOverrides[p.slug]?.present !== false).map((p) => {
        const override = mockOverrides[p.slug] || {};
        const status = override.status || p.status;
        return {
            ...p,
            price: override.price === undefined ? p.price : override.price,
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
function storeHttpError(response, context) {
    const error = new Error(`${context} returned HTTP ${response.status}`);
    const retryAfter = String(response.headers.get('retry-after') || '').trim();
    if (retryAfter) {
        const seconds = Number(retryAfter);
        const date = new Date(retryAfter);
        const delayMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Number.isNaN(date.valueOf()) ? 0 : Math.max(0, date.valueOf() - Date.now());
        if (delayMs)
            error.retryAfterAt = new Date(Date.now() + Math.min(delayMs, 24 * 60 * 60 * 1000)).toISOString();
    }
    error.statusCode = response.status;
    return error;
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
        throw storeHttpError(res, 'Store homepage');
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
            throw storeHttpError(res, category);
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
        let hostname = '';
        try {
            hostname = new URL(url).hostname.toLowerCase();
        }
        catch { }
        if (hostname === 'images.svc.ui.com')
            n += 50;
        if (hostname === 'cdn.ecomm.ui.com')
            n += 40;
        if (hostname === 'assets.ecomm.ui.com')
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
    let retryableResponse = null;
    const raw = [];
    const errors = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled')
            raw.push(...result.value);
        else {
            if (result.reason && result.reason.code === 'BUILD_OR_ROUTE_404')
                saw404 = true;
            if (result.reason?.statusCode === 429 || result.reason?.retryAfterAt)
                retryableResponse = result.reason;
            errors.push(`${CATEGORIES[index]}: ${result.reason?.message || result.reason}`);
        }
    });
    if (retryableResponse)
        throw retryableResponse;
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
    if (MOCK_MODE) {
        if (mockFaults.rateLimitOnceSeconds > 0) {
            const seconds = mockFaults.rateLimitOnceSeconds;
            mockFaults.rateLimitOnceSeconds = 0;
            const error = new Error(`Mock UniFi Store returned HTTP 429; retry after ${seconds} seconds.`);
            error.statusCode = 429;
            error.retryAfterAt = new Date(Date.now() + seconds * 1000).toISOString();
            throw error;
        }
        const omitted = new Set(mockFaults.partialOmitSlugs);
        if (omitted.size)
            monitor.partialErrors = [`Mock partial catalog omitted ${omitted.size} product${omitted.size === 1 ? '' : 's'}.`];
        return mockCatalog().filter((product) => !omitted.has(product.slug));
    }
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
function productDashboardUrl(slug, region = currentRegion()) {
    if (!PUBLIC_BASE_URL || !slug)
        return null;
    try {
        const url = new URL(PUBLIC_BASE_URL);
        url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
        url.search = new URLSearchParams({ region, product: slug }).toString();
        url.hash = 'browse';
        return url.toString();
    }
    catch {
        return null;
    }
}
function eventPriceSnapshot(previous, current) {
    const currentValue = priceValue(current?.price);
    const previousValue = priceValue(previous?.price);
    const difference = currentValue !== null && previousValue !== null ? Math.round((currentValue - previousValue) * 100) / 100 : null;
    const differencePercent = difference !== null && previousValue ? Math.round((difference / previousValue) * 1000) / 10 : null;
    return { currentValue, previousValue, difference, differencePercent };
}
function eventAlertKind(type, previous, current, rule) {
    if (type !== 'price_change')
        return type;
    const prices = eventPriceSnapshot(previous, current);
    const crossedTarget = rule?.targetPrice !== null && rule?.targetPrice !== undefined && prices.currentValue !== null
        && prices.currentValue <= rule.targetPrice && (prices.previousValue === null || prices.previousValue > rule.targetPrice);
    if (crossedTarget)
        return 'target_price';
    if (prices.difference !== null && prices.difference < 0)
        return 'price_drop';
    return 'price_change';
}
function eventTriggerReason(type, alertKind, rule, watchedAtDetection) {
    if (alertKind === 'target_price')
        return `Price reached the configured target of ${rule.targetPrice}.`;
    if (alertKind === 'price_drop')
        return rule?.priceDropOnly ? 'Price-drop-only monitoring detected a lower price.' : 'The price decreased on a watched product.';
    if (type === 'price_change')
        return 'The price changed on a watched product.';
    if (type === 'restock')
        return rule?.immediateRestock ? 'Immediate restock alerts are enabled for this product.' : 'A watched product became available.';
    if (type === 'sold_out')
        return 'A watched product became unavailable.';
    if (type === 'status_change')
        return 'The store status changed on a watched product.';
    if (type === 'new_product')
        return 'New-product alerts are enabled for this store region.';
    return watchedAtDetection ? 'A watched product changed on the UniFi Store.' : 'GearBeacon detected a store change.';
}
function createEvent(type, previous, current, watchedAtDetection, confirmation = null) {
    const region = currentRegion();
    const rule = watchedAtDetection ? watchRule(current.slug, region) : { ...DEFAULT_WATCH_RULE };
    const prices = eventPriceSnapshot(previous, current);
    const alertKind = eventAlertKind(type, previous, current, rule);
    const detectedAt = isoNow();
    const previousStateSince = previous?.lastChangedAt || previous?.lastSeenAt || previous?.firstDiscoveredAt || null;
    const previousStateStartedAt = previousStateSince ? new Date(previousStateSince).getTime() : NaN;
    const previousStateDurationSeconds = Number.isFinite(previousStateStartedAt)
        ? Math.max(0, Math.round((new Date(detectedAt).getTime() - previousStateStartedAt) / 1000))
        : null;
    const event = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        slug: current.slug,
        name: current.name,
        category: current.category,
        imageUrl: current.imageUrl || null,
        price: current.price,
        priceValue: prices.currentValue,
        previousPrice: previous?.price || null,
        previousPriceValue: prices.previousValue,
        priceDifference: prices.difference,
        priceDifferencePercent: prices.differencePercent,
        previousStatus: previous?.status || null,
        status: current.status,
        inStock: current.inStock,
        watchedAtDetection,
        alertKind,
        triggerReason: eventTriggerReason(type, alertKind, rule, watchedAtDetection),
        targetPrice: rule.targetPrice,
        immediateRestock: rule.immediateRestock,
        url: current.url,
        dashboardUrl: productDashboardUrl(current.slug, region),
        notificationTimeZone: NOTIFICATION_TIME_ZONE,
        previousStateSince,
        previousStateDurationSeconds,
        confirmation: confirmation || { policy: 'single-valid-observation', observations: 1, required: 1, firstObservedAt: detectedAt, confirmedAt: detectedAt },
        region,
        detectedAt,
    };
    const decision = notificationDecision(event);
    if (!decision.allowed)
        event.serverAlert = { recordedAt: detectedAt, state: 'muted', reason: decision.reason };
    return event;
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
    if (event.type === 'digest')
        return {
            title: `${event.events?.length || 0} GearBeacon stock updates`,
            body: `${(event.events || []).slice(0, 8).map((item) => `${item.name}: ${item.status || item.type}`).join(' · ')}${event.events?.length > 8 ? ' · more…' : ''} · ${region}`,
            ntfyTags: 'package,bell',
        };
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
    if (event.type === 'operational')
        return {
            title: `GearBeacon needs attention: ${event.name}`,
            body: `${event.detail || 'Open Operations for details.'} · ${region}`,
            ntfyTags: 'warning,gear',
        };
    return {
        title: `🚨 ${event.name} is back in stock`,
        body: `${event.price ? `${event.price} · ` : ''}${region} · detected now`,
        ntfyTags: 'rotating_light,package',
    };
}
function notificationDecision(event, prefs = notificationPreferences()) {
    if (event.type === 'test' || event.type === 'operational')
        return { allowed: true, reason: 'immediate', rule: { ...DEFAULT_WATCH_RULE } };
    if (event.type === 'new_product')
        return { allowed: Boolean(prefs.newProduct), reason: prefs.newProduct ? 'enabled' : 'disabled', rule: { ...DEFAULT_WATCH_RULE } };
    if (!event.watchedAtDetection)
        return { allowed: false, reason: 'not-watched', rule: { ...DEFAULT_WATCH_RULE } };
    const rule = watchRule(event.slug, event.region || currentRegion());
    if (rulePaused(rule))
        return { allowed: false, reason: 'paused', rule };
    const preferenceKey = ({ restock: 'restock', sold_out: 'soldOut', price_change: 'priceChange', status_change: 'statusChange' })[event.type];
    if (!preferenceKey)
        return { allowed: false, reason: 'unsupported-event', rule };
    let enabled = rule[preferenceKey] === null ? Boolean(prefs[preferenceKey]) : Boolean(rule[preferenceKey]);
    if (event.type === 'price_change') {
        const current = priceValue(event.price);
        const previous = priceValue(event.previousPrice);
        const dropped = current !== null && previous !== null && current < previous;
        const crossedTarget = rule.targetPrice !== null && current !== null && current <= rule.targetPrice && (previous === null || previous > rule.targetPrice);
        if (rule.targetPrice !== null)
            enabled = crossedTarget;
        else if (rule.priceDropOnly)
            enabled = enabled && dropped;
    }
    return { allowed: enabled, reason: enabled ? 'enabled' : 'disabled', rule };
}
function shouldNotifyEvent(event, prefs = notificationPreferences()) {
    return notificationDecision(event, prefs).allowed;
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
    const payload = {
        source: 'GearBeacon',
        version: APP_VERSION,
        title: copy.title,
        message: copy.body,
        event,
        sentAt: isoNow(),
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
        'Content-Type': 'application/json',
        ...(GENERIC_WEBHOOK_TOKEN ? { Authorization: `Bearer ${GENERIC_WEBHOOK_TOKEN}` } : {}),
        ...(GENERIC_WEBHOOK_HMAC_SECRET ? {
            'X-GearBeacon-Timestamp': timestamp,
            'X-GearBeacon-Signature': `sha256=${crypto.createHmac('sha256', GENERIC_WEBHOOK_HMAC_SECRET).update(`${timestamp}.${body}`).digest('hex')}`,
        } : {}),
    };
    const response = await fetchWithTimeout(GENERIC_WEBHOOK_URL, { method: 'POST', headers, body }, 10000);
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
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
function emailRenderOptions(overrides = {}) {
    return {
        detailLevel: EMAIL_DETAIL_LEVEL,
        embedImages: EMAIL_EMBED_IMAGES,
        explainReason: EMAIL_EXPLAIN_REASON,
        priceCalculations: EMAIL_PRICE_CALCULATIONS,
        digestMaxItems: EMAIL_DIGEST_MAX_ITEMS,
        subjectPrefix: EMAIL_SUBJECT_PREFIX,
        theme: EMAIL_THEME,
        timeZone: NOTIFICATION_TIME_ZONE,
        regions: REGIONS,
        ...overrides,
    };
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
    const options = { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: SMTP_REJECT_UNAUTHORIZED };
    let socket;
    try {
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
        const offersStartTls = ehlo.some((line) => /STARTTLS/i.test(line));
        if (!SMTP_SECURE && SMTP_STARTTLS && !offersStartTls)
            throw new Error('SMTP server does not offer STARTTLS. Disable STARTTLS only for a trusted local relay.');
        if (!SMTP_SECURE && SMTP_STARTTLS && offersStartTls) {
            await command('STARTTLS', [220]);
            reader.detach();
            socket = tls.connect({ socket, servername: SMTP_HOST, rejectUnauthorized: SMTP_REJECT_UNAUTHORIZED });
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
    catch (err) {
        try {
            socket?.destroy();
        }
        catch { }
        throw err;
    }
}
async function sendSmtp(event) {
    if (!smtpConfigured())
        return null;
    const rendered = await buildMimeEmail(event, emailRenderOptions({
        iconPath: path.join(WEB_DIR, 'assets', 'icon.png'),
        from: SMTP_FROM,
        to: SMTP_TO.join(', '),
        messageIdHost: SMTP_HOST,
    }));
    for (const warning of rendered.warnings)
        writeAppLog('warn', 'email', warning, { eventId: event.id });
    const { socket, reader, command } = await connectSmtp();
    try {
        await command(`MAIL FROM:<${smtpAddress(SMTP_FROM)}>`, [250]);
        for (const recipient of SMTP_TO)
            await command(`RCPT TO:<${smtpAddress(recipient)}>`, [250, 251]);
        await command('DATA', [354]);
        const message = rendered.message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        socket.write(`${message}\r\n.\r\n`);
        await smtpResponse(reader, [250]);
        await command('QUIT', [221]);
    }
    finally {
        socket.end();
    }
    return true;
}
function channelConfigured(channel) {
    if (!CHANNEL_ENABLED[channel])
        return false;
    if (channel === 'ntfy')
        return Boolean(NTFY_TOPIC);
    if (channel === 'discord')
        return Boolean(DISCORD_WEBHOOK_URL);
    if (channel === 'webhook')
        return Boolean(GENERIC_WEBHOOK_URL);
    if (channel === 'gotify')
        return Boolean(GOTIFY_BASE_URL && GOTIFY_TOKEN);
    if (channel === 'email')
        return smtpConfigured();
    return false;
}
async function sendChannel(channel, event) {
    if (!channelConfigured(channel))
        return null;
    if (channel === 'ntfy')
        return await sendNtfy(event);
    if (channel === 'discord')
        return await sendDiscord(event);
    if (channel === 'webhook')
        return await sendGenericWebhook(event);
    if (channel === 'gotify')
        return await sendGotify(event);
    if (channel === 'email')
        return await sendSmtp(event);
    throw new Error(`Unknown notification channel: ${channel}`);
}
async function sendAlert(event, selectedChannel = null) {
    const outcomes = [];
    const channels = selectedChannel ? [selectedChannel] : CHANNEL_NAMES.filter(channelConfigured);
    for (const channel of channels) {
        if (!CHANNEL_NAMES.includes(channel)) {
            outcomes.push({ channel, ok: false, error: 'Unknown notification channel.' });
            continue;
        }
        if (!channelConfigured(channel)) {
            outcomes.push({ channel, ok: false, error: 'Channel is disabled or incomplete.' });
            continue;
        }
        try {
            await sendChannel(channel, event);
            outcomes.push({ channel, ok: true });
            logNotification(event.id, channel, 'sent');
        }
        catch (err) {
            const message = err?.message || String(err);
            outcomes.push({ channel, ok: false, error: message });
            logNotification(event.id, channel, 'failed', message);
            console.error(`[alert:${channel}]`, message);
        }
    }
    if (outcomes.some((item) => item.ok) && monitors[event.region])
        monitors[event.region].lastAlertAt = isoNow();
    return outcomes;
}
function testEvent() {
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
        dashboardUrl: PUBLIC_BASE_URL || null,
        notificationTimeZone: NOTIFICATION_TIME_ZONE,
        alertKind: 'test',
        triggerReason: 'You requested a test from GearBeacon notification settings.',
        region: currentRegion(),
        detectedAt: isoNow(),
    };
    return event;
}
const EMAIL_PREVIEW_TYPES = new Set(['restock', 'target_price', 'price_drop', 'price_change', 'sold_out', 'status_change', 'new_product', 'digest', 'operational', 'test']);
function previewNotificationEvent(slug, requestedType = 'restock') {
    if (!EMAIL_PREVIEW_TYPES.has(requestedType))
        throw new Error('Unsupported email preview type.');
    if (requestedType === 'test')
        return testEvent();
    if (requestedType === 'operational')
        return {
            id: 'preview-operational', type: 'operational', alertKind: 'operational', code: 'monitor', slug: null,
            name: 'Store monitoring needs attention', detail: 'The UniFi Store could not be checked after several attempts. Open Operations to review the latest diagnostic details.',
            triggerReason: 'Operational alerts are enabled for this GearBeacon installation.', region: currentRegion(), detectedAt: isoNow(),
            notificationTimeZone: NOTIFICATION_TIME_ZONE, watchedAtDetection: false, url: PUBLIC_BASE_URL || null, dashboardUrl: PUBLIC_BASE_URL || null,
        };
    if (requestedType === 'digest') {
        const preferred = slug && state.products[slug] ? [state.products[slug]] : [];
        const products = [...preferred, ...Object.values(state.products).filter((item) => item.slug !== slug)].slice(0, 6);
        const kinds = ['restock', 'target_price', 'price_drop', 'new_product', 'sold_out', 'status_change'];
        const events = products.map((item, index) => previewNotificationEvent(item.slug, kinds[index % kinds.length]));
        if (events[0])
            events.push({ ...events[0], id: 'preview-duplicate' });
        return { id: 'preview-digest', type: 'digest', alertKind: 'digest', events, region: currentRegion(), detectedAt: isoNow(), notificationTimeZone: NOTIFICATION_TIME_ZONE, url: PUBLIC_BASE_URL || null, dashboardUrl: PUBLIC_BASE_URL || null };
    }
    const product = (slug && state.products[slug]) || Object.values(state.products)[0] || null;
    const currentPriceValue = priceValue(product?.price) ?? 199;
    const isAvailable = !['sold_out'].includes(requestedType);
    const underlyingType = ['target_price', 'price_drop'].includes(requestedType) ? 'price_change' : requestedType;
    const previousPriceValue = ['target_price', 'price_drop', 'price_change'].includes(requestedType) ? currentPriceValue + 50 : null;
    const priceDifference = previousPriceValue === null ? null : Math.round((currentPriceValue - previousPriceValue) * 100) / 100;
    const priceDifferencePercent = previousPriceValue ? Math.round((priceDifference / previousPriceValue) * 1000) / 10 : null;
    const targetPrice = requestedType === 'target_price' ? currentPriceValue : null;
    const event = {
        id: 'preview', type: underlyingType, alertKind: requestedType, slug: product?.slug || slug || 'example-product',
        name: product?.name || 'Example UniFi product', category: product?.category || 'WiFi', imageUrl: product?.imageUrl || null,
        price: product?.price || '$199.00', priceValue: currentPriceValue,
        previousPrice: previousPriceValue === null ? null : `$${previousPriceValue.toFixed(2)}`, previousPriceValue, priceDifference, priceDifferencePercent,
        previousStatus: requestedType === 'status_change' ? 'ComingSoon' : requestedType === 'restock' ? 'SoldOut' : null,
        status: requestedType === 'sold_out' ? 'SoldOut' : requestedType === 'status_change' ? 'Available' : product?.status || 'Available',
        inStock: isAvailable, watchedAtDetection: Boolean(product ? state.watchlist.includes(product.slug) : true),
        targetPrice, immediateRestock: requestedType === 'restock',
        triggerReason: eventTriggerReason(underlyingType, requestedType, { targetPrice, priceDropOnly: requestedType === 'price_drop', immediateRestock: requestedType === 'restock' }, true),
        url: product?.url || `${STORE_BASE}/${REGIONS[currentRegion()].path}/products/${product?.slug || slug || 'example-product'}`,
        dashboardUrl: productDashboardUrl(product?.slug || slug || 'example-product'), region: currentRegion(), detectedAt: isoNow(), notificationTimeZone: NOTIFICATION_TIME_ZONE,
    };
    return event;
}
async function sendTestNotification(selectedChannel = null) {
    const outcomes = await sendAlert(testEvent(), selectedChannel);
    const configured = CHANNEL_NAMES.filter(channelConfigured).length;
    return { ok: outcomes.some((item) => item.ok), configuredChannels: configured, outcomes };
}
function zonedClock(date = new Date(), timeZone = NOTIFICATION_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(date).reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}
function timeMinutes(value) {
    const [hour, minute] = String(value).split(':').map(Number);
    return hour * 60 + minute;
}
function quietAt(date) {
    if (!QUIET_HOURS_ENABLED || QUIET_HOURS_START === QUIET_HOURS_END)
        return false;
    const minute = timeMinutes(zonedClock(date).time);
    const start = timeMinutes(QUIET_HOURS_START);
    const end = timeMinutes(QUIET_HOURS_END);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
function findNextDeliveryTime(start, predicate, maxMinutes = 3 * 24 * 60) {
    const rounded = new Date(Math.ceil(start.getTime() / 60000) * 60000);
    for (let minute = 0; minute <= maxMinutes; minute += 1) {
        const candidate = new Date(rounded.getTime() + minute * 60000);
        if (predicate(candidate))
            return candidate;
    }
    return start;
}
function deliveryPlan(event, rule = event.slug ? watchRule(event.slug, event.region || currentRegion()) : DEFAULT_WATCH_RULE) {
    const now = new Date();
    if (event.type === 'restock' && rule.immediateRestock)
        return { deliverAt: now.toISOString(), mode: 'immediate-restock', timeZone: NOTIFICATION_TIME_ZONE };
    if (DIGEST_ENABLED && !['test', 'operational'].includes(event.type)) {
        const deliverAt = findNextDeliveryTime(new Date(now.getTime() + 60000), (candidate) => zonedClock(candidate).time === DIGEST_TIME && !quietAt(candidate));
        return { deliverAt: deliverAt.toISOString(), mode: 'digest', timeZone: NOTIFICATION_TIME_ZONE };
    }
    if (quietAt(now)) {
        const deliverAt = findNextDeliveryTime(new Date(now.getTime() + 60000), (candidate) => !quietAt(candidate));
        return { deliverAt: deliverAt.toISOString(), mode: 'after-quiet-hours', timeZone: NOTIFICATION_TIME_ZONE };
    }
    return { deliverAt: new Date(now.getTime() + NOTIFICATION_GROUP_SECONDS * 1000).toISOString(), mode: NOTIFICATION_GROUP_SECONDS ? 'grouped' : 'immediate', timeZone: NOTIFICATION_TIME_ZONE };
}
function cooldownAllows(event, rule) {
    if (!NOTIFICATION_COOLDOWN_MINUTES || (event.type === 'restock' && rule.immediateRestock) || event.type === 'test')
        return true;
    const slug = event.slug || `operational:${event.code || event.name}`;
    const row = db.prepare('SELECT last_notified_at FROM notification_cooldowns WHERE region=? AND slug=? AND event_type=?').get(event.region || currentRegion(), slug, event.type);
    return !row || Date.now() - new Date(row.last_notified_at).getTime() >= NOTIFICATION_COOLDOWN_MINUTES * 60000;
}
function markCooldown(event) {
    if (event.type === 'test')
        return;
    const slug = event.slug || `operational:${event.code || event.name}`;
    db.prepare(`INSERT INTO notification_cooldowns(region,slug,event_type,last_notified_at) VALUES(?,?,?,?)
    ON CONFLICT(region,slug,event_type) DO UPDATE SET last_notified_at=excluded.last_notified_at`)
        .run(event.region || currentRegion(), slug, event.type, isoNow());
}
function enqueueAlert(event, options = {}) {
    const decision = notificationDecision(event);
    const rule = decision.rule || DEFAULT_WATCH_RULE;
    const rememberPlan = (serverAlert) => {
        event.serverAlert = { recordedAt: isoNow(), ...serverAlert };
        const stored = state.events.find((item) => item.id === event.id);
        if (stored && stored !== event)
            stored.serverAlert = event.serverAlert;
        if (stored)
            db.prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(stored), event.id);
    };
    if (!decision.allowed) {
        rememberPlan({ state: 'muted', reason: decision.reason });
        return 0;
    }
    if (!cooldownAllows(event, rule)) {
        rememberPlan({ state: 'muted', reason: 'cooldown' });
        return 0;
    }
    const excluded = new Set(options.excludeChannels || []);
    const channels = CHANNEL_NAMES.filter((channel) => channelConfigured(channel) && !excluded.has(channel));
    const now = isoNow();
    const plan = deliveryPlan(event, rule);
    if (!channels.length) {
        rememberPlan({ state: 'no-channel', reason: 'no-channel', mode: plan.mode, deliverAt: plan.deliverAt, channels: [] });
        return 0;
    }
    const insert = db.prepare(`INSERT INTO notification_queue(event_id,region,channel,payload_json,attempts,max_attempts,next_attempt_at,status,last_error,created_at,updated_at)
    VALUES(?,?,?,?,0,?,?,'pending',NULL,?,?) ON CONFLICT(event_id,channel) DO NOTHING`);
    for (const channel of channels)
        insert.run(event.id, event.region || currentRegion(), channel, JSON.stringify(event), NOTIFICATION_MAX_ATTEMPTS, plan.deliverAt, now, now);
    if (channels.length) {
        rememberPlan({ state: 'queued', reason: 'enabled', mode: plan.mode, deliverAt: plan.deliverAt, channels });
        markCooldown(event);
        writeAppLog('info', 'notifications', `Queued ${channels.length} notification delivery job(s).`, { eventId: event.id, region: event.region, channels, delivery: plan });
    }
    return channels.length;
}
function enqueueOperationalAlert(code, name, detail, region = currentRegion(), options = {}) {
    const preference = ({ monitor: 'monitorFailures', notifications: 'notificationFailures', backup: 'backupFailures', disk: 'lowDiskSpace' })[code];
    if (preference && !OPERATIONAL_ALERTS[preference])
        return 0;
    return enqueueAlert({ id: `operational-${code}-${region}-${Date.now()}`, type: 'operational', alertKind: 'operational', code, slug: null, name, detail, triggerReason: 'Operational alerts are enabled for this GearBeacon installation.', notificationTimeZone: NOTIFICATION_TIME_ZONE, region, detectedAt: isoNow(), watchedAtDetection: false, url: PUBLIC_BASE_URL || null, dashboardUrl: PUBLIC_BASE_URL || null }, options);
}
function notificationQueueSummary() {
    const rows = db.prepare('SELECT status,COUNT(*) AS count FROM notification_queue GROUP BY status').all();
    const summary = { pending: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const row of rows)
        summary[row.status] = Number(row.count);
    const recentFailures = db.prepare("SELECT id,event_id,region,channel,attempts,max_attempts,last_error,updated_at FROM notification_queue WHERE status='failed' ORDER BY updated_at DESC LIMIT 20").all();
    const next = db.prepare("SELECT next_attempt_at FROM notification_queue WHERE status='pending' ORDER BY next_attempt_at LIMIT 1").get();
    return { ...summary, recentFailures, nextDeliveryAt: next?.next_attempt_at || null };
}
function eventServerAlertSummary(event, decision, queueRows = [], logRows = []) {
    const displayChannel = (channel) => channel === 'email' ? 'Email' : channel === 'ntfy' ? 'ntfy' : channel === 'discord' ? 'Discord' : channel === 'gotify' ? 'Gotify' : channel === 'webhook' ? 'Webhook' : channel;
    const channels = [...new Set([...queueRows, ...logRows].map((row) => row.channel).filter(Boolean))];
    const channelText = channels.length ? channels.map(displayChannel).join(', ') : '';
    const currentByChannel = new Map();
    for (const row of logRows)
        if (!currentByChannel.has(row.channel))
            currentByChannel.set(row.channel, row);
    for (const row of queueRows)
        currentByChannel.set(row.channel, row);
    const currentRows = [...currentByChannel.values()];
    const statuses = new Set(currentRows.map((row) => row.status));
    const sentChannels = currentRows.filter((row) => row.status === 'sent').map((row) => row.channel);
    const failedChannels = currentRows.filter((row) => row.status === 'failed').map((row) => row.channel);
    if (sentChannels.length && failedChannels.length)
        return { state: 'partial', label: 'Partial', detail: `Sent through ${sentChannels.map(displayChannel).join(', ')}; failed through ${failedChannels.map(displayChannel).join(', ')}.`, channels, mode: event.serverAlert?.mode || null, deliverAt: event.serverAlert?.deliverAt || null };
    if (statuses.has('failed') || (!queueRows.length && failedChannels.length))
        return { state: 'failed', label: 'Failed', detail: `Server delivery failed${channelText ? ` through ${channelText}` : ''}. Open Operations for details.`, channels, mode: event.serverAlert?.mode || null, deliverAt: event.serverAlert?.deliverAt || null };
    if (statuses.has('processing'))
        return { state: 'sending', label: 'Sending', detail: `Sending the server alert${channelText ? ` through ${channelText}` : ''}.`, channels, mode: event.serverAlert?.mode || null, deliverAt: event.serverAlert?.deliverAt || null };
    if (statuses.has('pending')) {
        const attempts = Math.max(0, ...queueRows.map((row) => Number(row.attempts) || 0));
        const mode = event.serverAlert?.mode || null;
        const label = attempts ? 'Retrying' : mode === 'digest' ? 'Digest' : mode === 'after-quiet-hours' ? 'Quiet hours' : 'Queued';
        const next = queueRows.map((row) => row.next_attempt_at).filter(Boolean).sort()[0] || event.serverAlert?.deliverAt || null;
        const explanation = mode === 'digest' ? 'Queued for the daily digest' : mode === 'after-quiet-hours' ? 'Held until quiet hours end' : attempts ? 'Waiting for another delivery attempt' : 'Server alert queued';
        return { state: attempts ? 'retrying' : mode === 'digest' ? 'digest' : mode === 'after-quiet-hours' ? 'quiet' : 'queued', label, detail: `${explanation}${channelText ? ` through ${channelText}` : ''}.`, channels, mode, deliverAt: next };
    }
    if (sentChannels.length || statuses.has('sent'))
        return { state: 'sent', label: 'Sent', detail: `Server alert sent${channelText ? ` through ${channelText}` : ''}.`, channels, mode: event.serverAlert?.mode || null, deliverAt: event.serverAlert?.deliverAt || null };
    if (statuses.has('cancelled'))
        return { state: 'muted', label: 'Cancelled', detail: 'Server delivery was cancelled because the channel was disabled or incomplete.', channels, mode: event.serverAlert?.mode || null, deliverAt: event.serverAlert?.deliverAt || null };
    const snapshot = event.serverAlert;
    if (snapshot?.state === 'no-channel')
        return { state: 'no-channel', label: 'No channel', detail: 'This event matched your alert rules, but no server notification channel was configured.', channels: [], mode: snapshot.mode || null, deliverAt: snapshot.deliverAt || null };
    const reason = snapshot?.reason || decision.reason;
    if (!decision.allowed || snapshot?.state === 'muted') {
        const reasons = {
            'not-watched': 'The product was not watched when this change was detected.',
            paused: 'Alerts for this product were paused when the change was detected.',
            disabled: 'This event type was disabled by your alert rules.',
            cooldown: 'The alert was suppressed by the configured cooldown.',
            'unsupported-event': 'This event type does not send server alerts.',
        };
        return { state: 'muted', label: reason === 'not-watched' ? 'No alert' : 'Muted', detail: reasons[reason] || 'No server alert was sent for this event.', channels: [], mode: null, deliverAt: null };
    }
    if (snapshot?.state === 'queued')
        return { state: 'queued', label: 'Alerted', detail: 'A server alert was queued when this change was detected; detailed delivery history is no longer available.', channels: snapshot.channels || [], mode: snapshot.mode || null, deliverAt: snapshot.deliverAt || null };
    return { state: 'no-channel', label: 'No channel', detail: 'No server-side notification delivery was recorded for this event.', channels: [], mode: null, deliverAt: null };
}
function retryDelaySeconds(attempts) {
    return Math.min(30 * 60, 30 * (2 ** Math.max(0, attempts - 1)));
}
let notificationWorkerRunning = false;
async function processNotificationQueue() {
    if (notificationWorkerRunning)
        return;
    notificationWorkerRunning = true;
    try {
        db.prepare("UPDATE notification_queue SET status='pending',updated_at=? WHERE status='processing' AND updated_at<?")
            .run(isoNow(), new Date(Date.now() - 5 * 60 * 1000).toISOString());
        const due = db.prepare("SELECT * FROM notification_queue WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 50").all(isoNow());
        const groups = new Map();
        for (const row of due) {
            const key = (NOTIFICATION_GROUP_SECONDS > 0 || DIGEST_ENABLED) ? `${row.channel}:${row.region}` : String(row.id);
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(row);
        }
        for (const rows of groups.values()) {
            const ids = rows.map((row) => row.id);
            const marks = ids.map(() => '?').join(',');
            if (!channelConfigured(rows[0].channel)) {
                db.prepare(`UPDATE notification_queue SET status='cancelled',last_error='Channel disabled or no longer configured.',updated_at=? WHERE id IN (${marks})`).run(isoNow(), ...ids);
                continue;
            }
            db.prepare(`UPDATE notification_queue SET status='processing',updated_at=? WHERE id IN (${marks})`).run(isoNow(), ...ids);
            const events = rows.map((row) => safeJsonParse(row.payload_json, {}));
            const event = events.length > 1 ? { id: `digest-${rows[0].id}`, type: 'digest', alertKind: 'digest', events, region: rows[0].region, detectedAt: isoNow(), notificationTimeZone: NOTIFICATION_TIME_ZONE, url: PUBLIC_BASE_URL || null, dashboardUrl: PUBLIC_BASE_URL || null } : events[0];
            try {
                await regionContext.run(rows[0].region, () => sendChannel(rows[0].channel, event));
                db.prepare(`UPDATE notification_queue SET status='sent',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id IN (${marks})`).run(isoNow(), ...ids);
                for (const row of rows)
                    logNotification(row.event_id, row.channel, 'sent', `attempt ${row.attempts + 1}${events.length > 1 ? `; grouped ${events.length}` : ''}`);
                if (monitors[rows[0].region])
                    monitors[rows[0].region].lastAlertAt = isoNow();
            }
            catch (err) {
                const message = String(err?.message || err).slice(0, 1000);
                let terminalFailure = false;
                for (const row of rows) {
                    const attempts = Number(row.attempts) + 1;
                    const failed = attempts >= Number(row.max_attempts);
                    terminalFailure ||= failed;
                    db.prepare('UPDATE notification_queue SET status=?,attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?')
                        .run(failed ? 'failed' : 'pending', attempts, new Date(Date.now() + retryDelaySeconds(attempts) * 1000).toISOString(), message, isoNow(), row.id);
                    logNotification(row.event_id, row.channel, failed ? 'failed' : 'retrying', `${message}; attempt ${attempts}/${row.max_attempts}`);
                }
                writeAppLog('warn', 'notifications', `Notification delivery failed for ${rows[0].channel}.`, { error: message, jobs: ids });
                if (terminalFailure)
                    enqueueOperationalAlert('notifications', 'Notification delivery failed', `${rows[0].channel} exhausted its retry limit.`, rows[0].region, { excludeChannels: [rows[0].channel] });
            }
        }
        db.prepare("DELETE FROM notification_queue WHERE status='sent' AND updated_at<?").run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    }
    finally {
        notificationWorkerRunning = false;
    }
}
let notificationWorkerTimer = null;
function scheduleNotificationWorker() {
    if (notificationWorkerTimer)
        clearInterval(notificationWorkerTimer);
    notificationWorkerTimer = setInterval(() => processNotificationQueue().catch((err) => writeAppLog('error', 'notifications', 'Queue worker failed.', { error: err?.message || String(err) })), 10000);
    notificationWorkerTimer.unref();
    processNotificationQueue().catch(() => { });
}
function recordEvent(event) {
    db.prepare(`INSERT INTO events(id,region,detected_at,data_json,type,slug,name,alert_kind) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,type=excluded.type,slug=excluded.slug,name=excluded.name,alert_kind=excluded.alert_kind`)
        .run(event.id, event.region || currentRegion(), event.detectedAt || isoNow(), JSON.stringify(event), event.type || null, event.slug || null, event.name || null, event.alertKind || event.type || null);
    state.events.push(event);
    if (state.events.length > 1000)
        state.events = state.events.slice(-1000);
    pruneEvents();
}
function pruneEvents() {
    if (!EVENT_RETENTION_DAYS)
        return;
    const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM events WHERE detected_at<?').run(cutoff);
}
function clearPendingTransition(slug, kind, region = currentRegion()) {
    db.prepare('DELETE FROM pending_transitions WHERE region=? AND slug=? AND kind=?').run(region, slug, kind);
}
function clearPendingTransitions(slug, kinds = null, region = currentRegion()) {
    if (!kinds)
        return db.prepare('DELETE FROM pending_transitions WHERE region=? AND slug=?').run(region, slug);
    for (const kind of kinds)
        clearPendingTransition(slug, kind, region);
}
function observePendingTransition(slug, kind, candidate, required = 2, region = currentRegion()) {
    const serialized = JSON.stringify(candidate);
    const existing = db.prepare('SELECT candidate_json,first_seen_at,observations FROM pending_transitions WHERE region=? AND slug=? AND kind=?').get(region, slug, kind);
    const same = existing?.candidate_json === serialized;
    const observations = same ? Number(existing.observations || 0) + 1 : 1;
    const firstObservedAt = same ? existing.first_seen_at : isoNow();
    const lastObservedAt = isoNow();
    db.prepare(`INSERT INTO pending_transitions(region,slug,kind,candidate_json,first_seen_at,last_seen_at,observations) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(region,slug,kind) DO UPDATE SET candidate_json=excluded.candidate_json,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,observations=excluded.observations`)
        .run(region, slug, kind, serialized, firstObservedAt, lastObservedAt, observations);
    const evidence = { policy: 'consecutive-valid-observations', kind, observations, required, firstObservedAt, confirmedAt: observations >= required ? lastObservedAt : null };
    if (observations >= required)
        clearPendingTransition(slug, kind, region);
    return { confirmed: observations >= required, evidence };
}
function pendingTransitions(region = null, limit = 100) {
    const rows = region
        ? db.prepare('SELECT region,slug,kind,candidate_json,first_seen_at,last_seen_at,observations FROM pending_transitions WHERE region=? ORDER BY last_seen_at DESC LIMIT ?').all(region, limit)
        : db.prepare('SELECT region,slug,kind,candidate_json,first_seen_at,last_seen_at,observations FROM pending_transitions ORDER BY last_seen_at DESC LIMIT ?').all(limit);
    return rows.map((row) => ({ region: row.region, slug: row.slug, kind: row.kind, candidate: safeJsonParse(row.candidate_json, {}), firstObservedAt: row.first_seen_at, lastObservedAt: row.last_seen_at, observations: Number(row.observations) }));
}
function recordMonitorCheck(outcome, startedAt, detail = null) {
    if (!tableExists('monitor_checks'))
        return;
    const duration = Math.max(0, Date.now() - startedAt);
    db.prepare(`INSERT INTO monitor_checks(region,checked_at,outcome,catalog_count,duration_ms,detail,partial_errors_json,retry_after_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(currentRegion(), isoNow(), outcome, monitor.productCount || null, duration, detail ? String(detail).slice(0, 2000) : null, JSON.stringify(monitor.partialErrors || []), monitor.retryAfterAt || null);
    db.prepare('DELETE FROM monitor_checks WHERE id NOT IN (SELECT id FROM monitor_checks ORDER BY id DESC LIMIT 2000)').run();
}
async function checkStore(reason = 'timer') {
    if (monitor.checking)
        return { skipped: true, reason: 'already checking' };
    const startedAt = Date.now();
    monitor.checking = true;
    monitor.lastCheckAt = isoNow();
    monitor.lastError = null;
    monitor.partialErrors = [];
    monitor.retryAfterAt = null;
    monitor.cycle += 1;
    console.log(`[monitor] ${monitor.lastCheckAt} check #${monitor.cycle} (${reason})`);
    try {
        const catalog = await fetchCatalog();
        const knownCount = Object.values(state.products).filter((product) => !product.unlisted).length;
        if (!MOCK_MODE && knownCount >= 20 && catalog.length < Math.max(10, Math.floor(knownCount * MIN_CATALOG_RATIO))) {
            throw new Error(`Catalog health guard rejected ${catalog.length} products; previous baseline has ${knownCount}. No stock state was changed.`);
        }
        const incoming = {};
        const notifications = [];
        const prefs = notificationPreferences();
        const watch = new Set(state.watchlist);
        const hadBaseline = knownCount > 0;
        const queueEvent = (event) => {
            recordEvent(event);
            if (shouldNotifyEvent(event, prefs))
                notifications.push(event);
        };
        for (const product of catalog) {
            const previous = state.products[product.slug];
            if (!previous) {
                clearPendingTransitions(product.slug);
                product.firstDiscoveredAt = product.lastSeenAt;
                product.lastChangedAt = product.lastSeenAt;
                product.unlisted = false;
                incoming[product.slug] = product;
                recordProductObservation(product, 'discovered');
                if (hadBaseline) {
                    const event = createEvent('new_product', null, product, false);
                    queueEvent(event);
                }
                continue;
            }
            clearPendingTransition(product.slug, 'unlisted');
            const watchedAtDetection = watch.has(product.slug);
            const changeTypes = [];
            let effective = {
                ...previous,
                name: product.name,
                category: product.category,
                imageUrl: product.imageUrl || previous.imageUrl || null,
                url: product.url,
                region: product.region,
                lastSeenAt: product.lastSeenAt,
                firstDiscoveredAt: previous.firstDiscoveredAt || previous.lastSeenAt || product.lastSeenAt,
            };
            if (previous.unlisted) {
                clearPendingTransitions(product.slug);
                effective = { ...product, firstDiscoveredAt: effective.firstDiscoveredAt, lastChangedAt: product.lastSeenAt, unlisted: false };
                changeTypes.push('relisted');
                queueEvent(createEvent(product.inStock ? 'restock' : 'status_change', previous, effective, watchedAtDetection, {
                    policy: 'catalog-reappearance', kind: 'relisted', observations: 1, required: 1, firstObservedAt: product.lastSeenAt, confirmedAt: product.lastSeenAt,
                }));
            }
            else {
                const availabilityChanged = Boolean(previous.inStock) !== Boolean(product.inStock);
                if (availabilityChanged && product.inStock) {
                    clearPendingTransition(product.slug, 'availability');
                    effective = { ...effective, inStock: true, status: product.status, comingSoon: product.comingSoon, restockEtaAt: product.restockEtaAt, soldOutAt: product.soldOutAt, unlisted: false };
                    changeTypes.push('restock');
                    queueEvent(createEvent('restock', previous, effective, watchedAtDetection, {
                        policy: 'restock-fast-path', kind: 'availability', observations: 1, required: 1, firstObservedAt: product.lastSeenAt, confirmedAt: product.lastSeenAt,
                    }));
                }
                else if (availabilityChanged) {
                    const pending = observePendingTransition(product.slug, 'availability', { inStock: false, status: product.status, comingSoon: product.comingSoon });
                    if (pending.confirmed) {
                        effective = { ...effective, inStock: false, status: product.status, comingSoon: product.comingSoon, restockEtaAt: product.restockEtaAt, soldOutAt: product.soldOutAt || product.lastSeenAt, unlisted: false };
                        changeTypes.push('sold-out');
                        queueEvent(createEvent('sold_out', previous, effective, watchedAtDetection, pending.evidence));
                    }
                }
                else {
                    clearPendingTransition(product.slug, 'availability');
                    effective.inStock = product.inStock;
                    effective.restockEtaAt = product.restockEtaAt;
                    effective.soldOutAt = product.soldOutAt;
                }
                if (!availabilityChanged && previous.status !== product.status) {
                    const pending = observePendingTransition(product.slug, 'status', { status: product.status, comingSoon: product.comingSoon });
                    if (pending.confirmed) {
                        effective = { ...effective, status: product.status, comingSoon: product.comingSoon, unlisted: false };
                        changeTypes.push('status');
                        queueEvent(createEvent('status_change', previous, effective, watchedAtDetection, pending.evidence));
                    }
                }
                else if (!availabilityChanged) {
                    clearPendingTransition(product.slug, 'status');
                    effective.status = product.status;
                    effective.comingSoon = product.comingSoon;
                }
                else {
                    clearPendingTransition(product.slug, 'status');
                }
                if (previous.price && product.price && previous.price !== product.price) {
                    const pending = observePendingTransition(product.slug, 'price', { price: product.price });
                    if (pending.confirmed) {
                        effective.price = product.price;
                        changeTypes.push('price');
                        queueEvent(createEvent('price_change', previous, effective, watchedAtDetection, pending.evidence));
                    }
                }
                else {
                    clearPendingTransition(product.slug, 'price');
                    if (!previous.price && product.price)
                        effective.price = product.price;
                }
            }
            effective.lastChangedAt = changeTypes.length ? product.lastSeenAt : (previous.lastChangedAt || previous.lastSeenAt || product.lastSeenAt);
            incoming[product.slug] = effective;
            recordProductObservation(effective, changeTypes.join('+') || 'observed');
        }
        // Missing products are never treated as sold out. Two complete, valid
        // catalogs are required before a product is classified as unlisted.
        if (!monitor.partialErrors.length) {
            for (const previous of Object.values(state.products)) {
                if (incoming[previous.slug] || previous.unlisted)
                    continue;
                clearPendingTransitions(previous.slug, ['availability', 'status', 'price']);
                const pending = observePendingTransition(previous.slug, 'unlisted', { status: 'Unlisted', unlisted: true });
                if (!pending.confirmed)
                    continue;
                const unlisted = { ...previous, status: 'Unlisted', inStock: false, comingSoon: false, unlisted: true, lastChangedAt: isoNow() };
                incoming[previous.slug] = unlisted;
                recordProductObservation(unlisted, 'unlisted');
                queueEvent(createEvent('status_change', previous, unlisted, watch.has(previous.slug), pending.evidence));
            }
        }
        // Preserve last-known-good data for partial catalogs and pending changes.
        state.products = { ...state.products, ...incoming };
        monitor.productCount = catalog.length;
        monitor.lastSuccessAt = isoNow();
        monitor.consecutiveFailures = 0;
        monitor.catalogHealth = monitor.partialErrors.length ? 'degraded' : 'healthy';
        monitor.pendingChanges = Number(db.prepare('SELECT COUNT(*) AS count FROM pending_transitions WHERE region=?').get(currentRegion())?.count || 0);
        pruneProductObservations();
        pruneEvents();
        saveStateSoon();
        for (const event of notifications)
            enqueueAlert(event);
        try {
            const stat = typeof fs.statfsSync === 'function' ? fs.statfsSync(USER_DATA_DIR) : null;
            const free = stat ? Number(stat.bavail) * Number(stat.bsize) : null;
            if (free !== null && free < 1024 * 1024 * 1024)
                enqueueOperationalAlert('disk', 'Storage space is low', `Only ${Math.max(0, Math.round(free / 1024 / 1024))} MB remains in the GearBeacon data filesystem.`);
        }
        catch { }
        console.log(`[monitor] success: ${monitor.productCount} products, ${notifications.length} notification event(s)`);
        writeAppLog('info', 'monitor', `Store check succeeded for ${currentRegion()}.`, { reason, products: monitor.productCount, notificationEvents: notifications.length, catalogHealth: monitor.catalogHealth, pendingChanges: monitor.pendingChanges });
        recordMonitorCheck('success', startedAt, monitor.partialErrors.length ? 'Catalog was usable but one or more categories failed.' : null);
        return { ok: true, products: monitor.productCount, notifications: notifications.length, catalogHealth: monitor.catalogHealth, pendingChanges: monitor.pendingChanges };
    }
    catch (err) {
        monitor.consecutiveFailures += 1;
        monitor.lastError = err?.message || String(err);
        monitor.retryAfterAt = err?.retryAfterAt || null;
        const lastSuccessAge = monitor.lastSuccessAt ? (Date.now() - new Date(monitor.lastSuccessAt).getTime()) / 1000 : Infinity;
        monitor.catalogHealth = lastSuccessAge > STALE_AFTER_SECONDS ? 'stale' : 'error';
        console.error('[monitor] failed:', monitor.lastError);
        writeAppLog('error', 'monitor', `Store check failed for ${currentRegion()}.`, { reason, error: monitor.lastError, consecutiveFailures: monitor.consecutiveFailures });
        recordMonitorCheck('failed', startedAt, monitor.lastError);
        if (monitor.consecutiveFailures === 3)
            enqueueOperationalAlert('monitor', 'Store monitoring is unhealthy', `${REGIONS[currentRegion()].label} has failed three consecutive checks: ${monitor.lastError}`);
        return { ok: false, error: monitor.lastError, consecutiveFailures: monitor.consecutiveFailures };
    }
    finally {
        monitor.checking = false;
        monitor.lastDurationMs = Date.now() - startedAt;
    }
}
const monitorTimers = new Map();
function monitorDelaySeconds() {
    let delay = monitor.consecutiveFailures ? Math.min(15 * 60, POLL_SECONDS * (2 ** Math.min(monitor.consecutiveFailures, 4))) : POLL_SECONDS;
    if (monitor.retryAfterAt)
        delay = Math.max(delay, Math.ceil((new Date(monitor.retryAfterAt).getTime() - Date.now()) / 1000));
    // Never jitter earlier than an upstream Retry-After deadline.
    const jitter = monitor.retryAfterAt ? 1 + Math.random() * 0.1 : 0.95 + Math.random() * 0.1;
    return Math.max(5, Math.round(delay * jitter));
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
    const watched = state.watchlist.includes(product.slug);
    const watch = watched ? db.prepare('SELECT created_at FROM watchlist WHERE region=? AND slug=?').get(currentRegion(), product.slug) : null;
    return { ...product, watched, watchedAt: watch?.created_at || null, watchRule: watched ? watchRule(product.slug) : null };
}
const WATCH_IMPORT_FIELD_ORDER = ['url', 'producturl', 'storeurl', 'slug', 'sku', 'product', 'model', 'modelnumber', 'identifier', 'name'];
const WATCH_IMPORT_FIELDS = new Set(WATCH_IMPORT_FIELD_ORDER);
const WATCH_IMPORT_CONTAINERS = new Set(['watchlist', 'products', 'items', 'entries']);
function watchImportKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function watchImportError(message) {
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
}
function collectWatchImportJson(value, output, parentKey = 'items', depth = 0) {
    if (depth > 8 || value == null)
        return;
    if (typeof value === 'string' || typeof value === 'number') {
        if (depth <= 1 || WATCH_IMPORT_FIELDS.has(watchImportKey(parentKey)) || WATCH_IMPORT_CONTAINERS.has(watchImportKey(parentKey)))
            output.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectWatchImportJson(item, output, parentKey, depth + 1));
        return;
    }
    if (typeof value !== 'object')
        return;
    const entries = Object.entries(value);
    const containers = entries.filter(([key]) => WATCH_IMPORT_CONTAINERS.has(watchImportKey(key)));
    if (containers.length) {
        for (const [key, item] of containers)
            collectWatchImportJson(item, output, key, depth + 1);
        return;
    }
    for (const wanted of WATCH_IMPORT_FIELD_ORDER) {
        const entry = entries.find(([key, item]) => watchImportKey(key) === wanted && item != null && (typeof item !== 'string' || item.trim()));
        if (entry) {
            collectWatchImportJson(entry[1], output, entry[0], depth + 1);
            return;
        }
    }
}
function parseWatchImportCsv(text) {
    const rows = [[]];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"') {
            if (quoted && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            }
            else
                quoted = !quoted;
        }
        else if (character === ',' && !quoted) {
            rows.at(-1).push(cell);
            cell = '';
        }
        else if ((character === '\n' || character === '\r') && !quoted) {
            if (character === '\r' && text[index + 1] === '\n')
                index += 1;
            rows.at(-1).push(cell);
            cell = '';
            rows.push([]);
        }
        else
            cell += character;
    }
    rows.at(-1).push(cell);
    const populated = rows.filter((row) => row.some((value) => String(value).trim()));
    if (!populated.length)
        return [];
    const importColumns = populated[0].map((value, index) => ({ index, key: watchImportKey(value) }))
        .filter((item) => WATCH_IMPORT_FIELDS.has(item.key))
        .sort((a, b) => WATCH_IMPORT_FIELD_ORDER.indexOf(a.key) - WATCH_IMPORT_FIELD_ORDER.indexOf(b.key));
    const values = importColumns.length
        ? populated.slice(1).map((row) => importColumns.map((item) => row[item.index]).find((value) => String(value ?? '').trim()))
        : populated.flat();
    return values;
}
function parseWatchImportContent(content, fileName = '') {
    const text = String(content || '').replace(/^\uFEFF/, '').trim();
    if (!text)
        watchImportError('Paste at least one Store link, product SKU, or slug.');
    if (Buffer.byteLength(text) > 200 * 1024)
        watchImportError('Watchlist imports must be 200 KB or smaller.');
    let references = [];
    const looksJson = /^\s*[\[{]/.test(text) || /\.json$/i.test(String(fileName));
    if (looksJson) {
        const parsed = safeJsonParse(text, null);
        if (parsed == null)
            watchImportError('The selected JSON file is not valid JSON.');
        collectWatchImportJson(parsed, references);
    }
    else if (/\.csv$/i.test(String(fileName)) || text.includes(',')) {
        references = parseWatchImportCsv(text);
    }
    else {
        references = text.split(/[\r\n;\t]+/);
    }
    references = references.map((value) => String(value ?? '').trim()).filter(Boolean);
    const ignoredHeaders = new Set([...WATCH_IMPORT_FIELDS, ...WATCH_IMPORT_CONTAINERS]);
    references = references.filter((value) => !ignoredHeaders.has(watchImportKey(value)));
    if (!references.length)
        watchImportError('No product links, SKUs, or slugs were found in that import.');
    if (references.length > 1000)
        watchImportError('A watchlist import can contain at most 1,000 entries.');
    return references.map((value) => value.slice(0, 500));
}
function normalizedWatchImportIdentifier(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/^(?:slug|sku|product|model|identifier)\s*[:=]\s*/i, '')
        .replace(/^['"]|['"]$/g, '')
        .replace(/[_\s]+/g, '-')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
function watchImportReference(value) {
    const input = String(value || '').trim();
    let candidate = input;
    let sourceRegion = null;
    let invalidUrl = false;
    const urlCandidate = /^(?:https?:\/\/|store\.ui\.com\/)/i.test(input) ? (/^https?:\/\//i.test(input) ? input : `https://${input}`) : null;
    if (urlCandidate) {
        try {
            const url = new URL(urlCandidate);
            if (url.hostname.toLowerCase() !== 'store.ui.com')
                invalidUrl = true;
            const segments = url.pathname.split('/').map((part) => decodeURIComponent(part)).filter(Boolean);
            if (REGIONS[String(segments[0] || '').toLowerCase()])
                sourceRegion = String(segments[0]).toLowerCase();
            const productIndex = segments.lastIndexOf('products');
            candidate = productIndex >= 0 && segments[productIndex + 1] ? segments[productIndex + 1] : '';
        }
        catch {
            invalidUrl = true;
            candidate = '';
        }
    }
    return { input, identifier: normalizedWatchImportIdentifier(candidate), sourceRegion, invalidUrl };
}
function previewWatchImport(content, fileName = '') {
    const region = currentRegion();
    const references = parseWatchImportContent(content, fileName);
    const products = Object.values(state.products);
    const bySlug = new Map(products.map((product) => [String(product.slug).toLowerCase(), product]));
    const byName = new Map(products.map((product) => [normalizedWatchImportIdentifier(product.name), product]));
    const slugPrefixes = products.map((product) => String(product.slug).toLowerCase()).sort((a, b) => b.length - a.length);
    const seenProducts = new Set();
    const items = references.map((value, index) => {
        const reference = watchImportReference(value);
        let product = bySlug.get(reference.identifier) || byName.get(reference.identifier) || null;
        if (!product && reference.identifier) {
            const prefix = slugPrefixes.find((slug) => reference.identifier.startsWith(`${slug}-`));
            if (prefix)
                product = bySlug.get(prefix) || null;
        }
        const base = { id: index + 1, input: reference.input, identifier: reference.identifier || null, sourceRegion: reference.sourceRegion, destinationRegion: region };
        if (reference.invalidUrl)
            return { ...base, status: 'unrecognized', label: 'Unsupported URL', detail: 'Only links from store.ui.com can be imported.' };
        if (!product)
            return { ...base, status: 'unrecognized', label: 'Not in catalog', detail: `No matching product is currently listed in the ${REGIONS[region].label} catalog. It may be discontinued or use a different identifier.` };
        const productData = { slug: product.slug, name: product.name, category: product.category, price: product.price || null, imageUrl: product.imageUrl || null };
        if (reference.sourceRegion && reference.sourceRegion !== region)
            return { ...base, ...productData, status: 'region-mismatch', label: 'Other region', detail: `This link is for ${REGIONS[reference.sourceRegion].label}. Switch GearBeacon to that Store region to import it.` };
        if (seenProducts.has(product.slug))
            return { ...base, ...productData, status: 'duplicate', label: 'Duplicate', detail: 'This product appears more than once in the import and will only be considered once.' };
        seenProducts.add(product.slug);
        if (state.watchlist.includes(product.slug))
            return { ...base, ...productData, status: 'already', label: 'Already watched', detail: 'Already on this watchlist. Its existing alert rules will be preserved.' };
        return { ...base, ...productData, status: 'addable', label: 'Ready', detail: `${product.category}${product.price ? ` · ${product.price}` : ''} · Add to ${REGIONS[region].label}.` };
    });
    const count = (status) => items.filter((item) => item.status === status).length;
    return {
        region,
        regionLabel: REGIONS[region].label,
        items,
        summary: {
            submitted: items.length,
            matched: items.filter((item) => item.slug).length,
            addable: count('addable'),
            alreadyWatched: count('already'),
            duplicates: count('duplicate'),
            regionMismatch: count('region-mismatch'),
            unrecognized: count('unrecognized'),
        },
    };
}
function productDetailsForApi(slug) {
    const product = state.products[slug];
    if (!product)
        return null;
    const history = productObservations(slug);
    return {
        product: productForApi(product),
        history,
        historyRetentionDays: HISTORY_RETENTION_DAYS,
        firstObservedAt: history.length ? history[history.length - 1].observedAt : product.firstDiscoveredAt || product.lastSeenAt || null,
        lastChangedAt: product.lastChangedAt || history[0]?.observedAt || null,
        notificationDecision: state.watchlist.includes(slug) ? notificationDecision({ type: 'restock', slug, region: currentRegion(), watchedAtDetection: true }) : null,
    };
}
function backupSummary() {
    const backups = listBackups().filter((item) => item.name.endsWith('.sqlite3'));
    const secondaryBackups = SECONDARY_BACKUP_DIR ? listBackups(SECONDARY_BACKUP_DIR) : [];
    return {
        count: backups.length,
        retention: BACKUP_RETENTION,
        intervalHours: BACKUP_INTERVAL_HOURS,
        latest: backups[0] || null,
        secondary: {
            configured: Boolean(SECONDARY_BACKUP_DIR),
            directory: SECONDARY_BACKUP_DIR || null,
            encrypted: SECONDARY_ENCRYPTED_EXPORTS,
            count: secondaryBackups.length,
            latest: secondaryBackups[0] || null,
            sameFilesystem: backupLocationsShareDevice(),
        },
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
            if (backup) {
                console.log(`[data] scheduled backup created: ${backup.filename}`);
                writeAppLog('info', 'backups', 'Scheduled backup created and validated.', { filename: backup.filename, size: backup.size, secondary: backup.secondary || null });
                if (backup.secondary?.ok === false)
                    enqueueOperationalAlert('backup', 'Secondary recovery copy failed', backup.secondary.error || 'The primary backup succeeded but its secondary copy did not.');
            }
        }
        catch (err) {
            console.error('[data] scheduled backup failed:', err?.message || err);
            writeAppLog('error', 'backups', 'Scheduled backup failed.', { error: err?.message || String(err) });
            enqueueOperationalAlert('backup', 'Scheduled backup failed', String(err?.message || err));
        }
        finally {
            scheduleBackups();
        }
    }, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
    backupTimer.unref();
}
function dataInfo() {
    let databaseSize = 0;
    try {
        databaseSize = fs.statSync(DB_FILE).size;
    }
    catch { }
    return {
        persistent: true,
        engine: 'SQLite',
        databasePath: DB_FILE,
        userDataDir: USER_DATA_DIR,
        backupDir: BACKUP_DIR,
        schemaVersion: schemaVersion(),
        expectedSchemaVersion: DATABASE_SCHEMA_VERSION,
        integrity: databaseIntegrity(),
        databaseSize,
        freeSpace: typeof fs.statfsSync === 'function' ? (() => { try {
            const stat = fs.statfsSync(USER_DATA_DIR);
            return Number(stat.bavail) * Number(stat.bsize);
        }
        catch {
            return null;
        } })() : null,
        backup: backupSummary(),
        history: {
            observations: tableExists('product_observations') ? Number(db.prepare('SELECT COUNT(*) AS count FROM product_observations').get()?.count || 0) : 0,
            retentionDays: HISTORY_RETENTION_DAYS,
        },
        activity: {
            events: Number(db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count || 0),
            retentionDays: EVENT_RETENTION_DAYS,
        },
        legacySource: getMeta('legacy_source'),
    };
}
function securityWarnings() {
    const warnings = [];
    if (ACCESS_MODE === 'local' && !isLoopbackHost(BIND_HOST))
        warnings.push({ severity: 'high', code: 'local-remote', settingsTab: 'general', message: 'Local mode is exposed beyond loopback without owner authentication.' });
    if (ACCESS_MODE !== 'local' && !ownerCredential())
        warnings.push({ severity: 'high', code: 'owner-setup', settingsTab: 'security', message: 'Owner password setup is incomplete.' });
    if (ACCESS_MODE === 'private' && !COOKIE_SECURE && !PUBLIC_BASE_URL.startsWith('https://'))
        warnings.push({ severity: 'medium', code: 'plain-http', settingsTab: 'general', message: 'Remote access is using HTTP. Prefer a private VPN or authenticated HTTPS reverse proxy.' });
    if (ACCESS_MODE === 'proxy' && !PUBLIC_BASE_URL.startsWith('https://'))
        warnings.push({ severity: 'high', code: 'proxy-url', settingsTab: 'general', message: 'Proxy mode should use an HTTPS public URL.' });
    if (!SMTP_REJECT_UNAUTHORIZED && smtpConfigured())
        warnings.push({ severity: 'medium', code: 'smtp-certificates', settingsTab: 'notifications', message: 'SMTP certificate verification is disabled.' });
    if (setupRequired())
        warnings.push({ severity: 'high', code: 'setup-token', settingsTab: 'security', message: 'Complete owner setup and remove any configured setup token.' });
    if (SECONDARY_BACKUP_DIR && backupLocationsShareDevice() === true)
        warnings.push({ severity: 'medium', code: 'backup-same-device', settingsTab: 'data', message: 'Primary and secondary backups are on the same storage device. Use a NAS share or separately mounted volume for stronger recovery.' });
    return warnings;
}
function appConfigurationForApi() {
    const config = storedAppConfig();
    return {
        config,
        secretsConfigured: secretStatus(),
        availableRegions: Object.entries(REGIONS).map(([key, value]) => ({ key, label: value.label, currency: value.currency })),
        runtime: { regions: [...ACTIVE_REGIONS], accessMode: ACCESS_MODE, bindHost: BIND_HOST },
        restartPending: config.accessMode !== ACCESS_MODE || config.bindHost !== BIND_HOST || JSON.stringify(config.regions) !== JSON.stringify(ACTIVE_REGIONS),
    };
}
function operationsSummary() {
    const backupRows = tableExists('backup_log') ? db.prepare('SELECT id,filename,reason,status,size,detail,created_at FROM backup_log ORDER BY id DESC LIMIT 30').all() : [];
    const notificationRows = db.prepare('SELECT id,event_id,channel,status,detail,created_at FROM notification_log ORDER BY id DESC LIMIT 50').all();
    const storage = dataInfo();
    const warnings = securityWarnings();
    const queue = notificationQueueSummary();
    const unhealthyRegions = ACTIVE_REGIONS.filter((region) => !monitors[region].lastSuccessAt || monitors[region].lastError || monitors[region].catalogHealth === 'stale');
    const pending = pendingTransitions(null, 100);
    const latestSecondaryAttempt = backupRows.map((row) => safeJsonParse(row.detail, null)?.secondary).find((item) => item?.configured);
    const secondaryUnavailable = storage.backup.secondary.configured && storage.backup.latest && !storage.backup.secondary.latest;
    const issues = [
        ...warnings.map((item) => ({ severity: item.severity === 'high' ? 'action' : 'degraded', message: item.message, settingsTab: item.settingsTab })),
        ...(queue.failed ? [{ severity: 'action', message: `${queue.failed} notification delivery job${queue.failed === 1 ? '' : 's'} failed.`, settingsTab: 'notifications' }] : []),
        ...(!storage.integrity.ok ? [{ severity: 'action', message: 'Database integrity check failed.', settingsTab: 'data' }] : []),
        ...(latestSecondaryAttempt?.ok === false || secondaryUnavailable ? [{ severity: 'degraded', message: 'The latest primary backup succeeded, but the secondary recovery copy is unavailable.', settingsTab: 'data' }] : []),
        ...(unhealthyRegions.length ? [{ severity: 'degraded', message: `${unhealthyRegions.length} store region${unhealthyRegions.length === 1 ? ' is' : 's are'} unhealthy.` }] : []),
    ];
    const overall = issues.some((item) => item.severity === 'action') ? 'action' : issues.length ? 'degraded' : 'healthy';
    return {
        generatedAt: isoNow(),
        uptimeSeconds: Math.floor(process.uptime()),
        runtime: {
            version: APP_VERSION,
            commit: String(process.env.GEARBEACON_BUILD_COMMIT || BUILD_INFO.commit || '').trim() || null,
            image: String(process.env.GEARBEACON_IMAGE || BUILD_INFO.image || '').trim() || null,
            node: process.version,
            platform: `${process.platform}/${process.arch}`,
            standalone: runningAsSea,
        },
        regions: ACTIVE_REGIONS.map((region) => ({ region, label: REGIONS[region].label, ...monitors[region], watchCount: states[region].watchlist.length, storedProductCount: Object.keys(states[region].products).length })),
        summary: { state: overall, label: overall === 'action' ? 'Action required' : overall === 'degraded' ? 'Degraded' : 'Healthy', issues },
        notifications: { queue, recent: notificationRows },
        backups: { ...backupSummary(), history: backupRows, integrity: storage.integrity },
        monitoringConfidence: { pending, count: Number(db.prepare('SELECT COUNT(*) AS count FROM pending_transitions').get()?.count || 0), recentChecks: db.prepare('SELECT region,checked_at AS checkedAt,outcome,catalog_count AS catalogCount,duration_ms AS durationMs,detail,partial_errors_json AS partialErrors,retry_after_at AS retryAfterAt FROM monitor_checks ORDER BY id DESC LIMIT 30').all().map((row) => ({ ...row, partialErrors: safeJsonParse(row.partialErrors, []) })) },
        storage: { databasePath: storage.databasePath, databaseSize: storage.databaseSize, freeSpace: storage.freeSpace, userDataDir: storage.userDataDir },
        securityWarnings: warnings,
        onboardingComplete: getSetting('onboarding_complete', '0') === '1',
    };
}
function activityFilterSql(url) {
    const scope = String(url.searchParams.get('scope') || url.searchParams.get('region') || DEFAULT_REGION).toLowerCase();
    const regions = scope === 'all' ? [...ACTIVE_REGIONS] : ACTIVE_REGIONS.includes(scope) ? [scope] : null;
    if (!regions)
        throw new Error(`Activity region must be all or one of: ${ACTIVE_REGIONS.join(', ')}.`);
    const conditions = [`e.region IN (${regions.map(() => '?').join(',')})`];
    const parameters = [...regions];
    const type = String(url.searchParams.get('type') || 'all').toLowerCase();
    const allowedTypes = ['restock', 'sold_out', 'price_change', 'status_change', 'new_product'];
    if (type !== 'all') {
        if (!allowedTypes.includes(type))
            throw new Error('Activity type is not supported.');
        conditions.push('e.type=?');
        parameters.push(type);
    }
    const search = String(url.searchParams.get('search') || '').trim().toLowerCase().slice(0, 200);
    if (search) {
        conditions.push("(lower(COALESCE(e.name,'')) LIKE ? OR lower(COALESCE(e.slug,'')) LIKE ?)");
        parameters.push(`%${search}%`, `%${search}%`);
    }
    const normalizeDate = (value, end = false) => {
        if (!value)
            return null;
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
        const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
        if (Number.isNaN(date.valueOf()))
            throw new Error('Activity dates must be valid ISO dates.');
        if (end && dateOnly)
            date.setUTCDate(date.getUTCDate() + 1);
        return date.toISOString();
    };
    const from = normalizeDate(String(url.searchParams.get('from') || ''));
    const to = normalizeDate(String(url.searchParams.get('to') || ''), true);
    if (from) {
        conditions.push('e.detected_at>=?');
        parameters.push(from);
    }
    if (to) {
        conditions.push('e.detected_at<?');
        parameters.push(to);
    }
    const delivery = String(url.searchParams.get('delivery') || 'all').toLowerCase();
    if (!['all', 'sent', 'pending', 'failed', 'not-sent'].includes(delivery))
        throw new Error('Activity delivery filter is not supported.');
    if (delivery === 'sent')
        conditions.push("(EXISTS (SELECT 1 FROM notification_queue nq WHERE nq.event_id=e.id AND nq.status='sent') OR EXISTS (SELECT 1 FROM notification_log nl WHERE nl.event_id=e.id AND nl.status='sent'))");
    if (delivery === 'pending')
        conditions.push("EXISTS (SELECT 1 FROM notification_queue nq WHERE nq.event_id=e.id AND nq.status IN ('pending','processing'))");
    if (delivery === 'failed')
        conditions.push("(EXISTS (SELECT 1 FROM notification_queue nq WHERE nq.event_id=e.id AND nq.status='failed') OR EXISTS (SELECT 1 FROM notification_log nl WHERE nl.event_id=e.id AND nl.status='failed'))");
    if (delivery === 'not-sent')
        conditions.push('NOT EXISTS (SELECT 1 FROM notification_queue nq WHERE nq.event_id=e.id) AND NOT EXISTS (SELECT 1 FROM notification_log nl WHERE nl.event_id=e.id)');
    return { where: conditions.join(' AND '), parameters, filters: { scope, type, search, from, to, delivery } };
}
function enrichActivityEvents(events) {
    const eventIds = events.map((event) => event.id).filter(Boolean);
    const queueByEvent = new Map();
    const logsByEvent = new Map();
    if (eventIds.length) {
        for (let offset = 0; offset < eventIds.length; offset += 500) {
            const ids = eventIds.slice(offset, offset + 500);
            const placeholders = ids.map(() => '?').join(',');
            for (const row of db.prepare(`SELECT event_id,channel,status,attempts,max_attempts,next_attempt_at,last_error,updated_at FROM notification_queue WHERE event_id IN (${placeholders})`).all(...ids)) {
                if (!queueByEvent.has(row.event_id))
                    queueByEvent.set(row.event_id, []);
                queueByEvent.get(row.event_id).push(row);
            }
            for (const row of db.prepare(`SELECT event_id,channel,status,detail,created_at FROM notification_log WHERE event_id IN (${placeholders}) ORDER BY id DESC`).all(...ids)) {
                if (!logsByEvent.has(row.event_id))
                    logsByEvent.set(row.event_id, []);
                logsByEvent.get(row.event_id).push(row);
            }
        }
    }
    return events.map((event) => regionContext.run(event.region || DEFAULT_REGION, () => {
        const decision = notificationDecision(event);
        return { ...event, notificationDecision: decision, serverAlert: eventServerAlertSummary(event, decision, queueByEvent.get(event.id) || [], logsByEvent.get(event.id) || []) };
    }));
}
function activityQuery(url, { exportLimit = null } = {}) {
    const filter = activityFilterSql(url);
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM events e WHERE ${filter.where}`).get(...filter.parameters)?.count || 0);
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const requestedPage = Number(url.searchParams.get('page') || 1);
    const limit = exportLimit || (Number.isInteger(requestedLimit) ? Math.min(100, Math.max(10, requestedLimit)) : 50);
    const page = exportLimit ? 1 : Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
    const offset = exportLimit ? 0 : (page - 1) * limit;
    const rows = db.prepare(`SELECT e.data_json FROM events e WHERE ${filter.where} ORDER BY e.detected_at DESC,e.id DESC LIMIT ? OFFSET ?`).all(...filter.parameters, limit, offset);
    const events = enrichActivityEvents(rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean));
    return { events, count, page, limit, pages: Math.max(1, Math.ceil(count / limit)), filters: filter.filters, truncated: Boolean(exportLimit && count > exportLimit) };
}
function csvCell(value) {
    const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replaceAll('"', '""')}"`;
}
function activityCsv(events) {
    const columns = ['detectedAt', 'region', 'type', 'alertKind', 'name', 'slug', 'previousStatus', 'status', 'previousPrice', 'price', 'delivery', 'confirmationPolicy', 'confirmationObservations'];
    const rows = events.map((event) => [event.detectedAt, event.region, event.type, event.alertKind, event.name, event.slug, event.previousStatus, event.status, event.previousPrice, event.price, event.serverAlert?.state, event.confirmation?.policy, event.confirmation?.observations]);
    return `${columns.map(csvCell).join(',')}\r\n${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
function backupFileForTest(input = {}) {
    const location = input.location === 'secondary' ? 'secondary' : 'primary';
    const directory = location === 'secondary' ? SECONDARY_BACKUP_DIR : BACKUP_DIR;
    if (!directory)
        throw new Error('The secondary backup destination is not configured.');
    const available = listBackups(directory);
    const requested = String(input.filename || '').trim();
    const backup = requested ? available.find((item) => item.name === path.basename(requested) && item.name === requested) : available[0];
    if (!backup)
        throw new Error(`No ${location} backup is available to test.`);
    return { ...backup, location };
}
function testBackupRestore(input = {}) {
    const backup = backupFileForTest(input);
    if (backup.name.endsWith('.sqlite3')) {
        const integrity = databaseIntegrity(backup.path);
        const target = new DatabaseSync(backup.path, { readOnly: true });
        try {
            const schema = Number(target.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version || 0);
            const required = ['watchlist', 'products', 'events', 'settings'];
            const tables = new Set(target.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
            const missing = required.filter((name) => !tables.has(name));
            return { ok: integrity.ok && schema > 0 && schema <= DATABASE_SCHEMA_VERSION && !missing.length, testedAt: isoNow(), filename: backup.name, location: backup.location, format: 'sqlite', integrity, schemaVersion: schema, compatible: schema > 0 && schema <= DATABASE_SCHEMA_VERSION, missingTables: missing, size: backup.size };
        }
        finally {
            target.close();
        }
    }
    const wrapper = safeJsonParse(fs.readFileSync(backup.path, 'utf8'), null);
    const encrypted = wrapper?.format === 'GearBeaconEncryptedBackup';
    const passphrase = input.passphrase || (backup.location === 'secondary' ? storedSecrets().secondaryBackupPassphrase : '');
    const snapshot = decryptSnapshot(wrapper, passphrase);
    const preview = previewSnapshot(snapshot);
    return { ok: true, testedAt: isoNow(), filename: backup.name, location: backup.location, format: encrypted ? 'encrypted-json' : 'json', encrypted, size: backup.size, preview };
}
function diagnosticItem(id, label, status, detail, action = null) {
    return { id, label, status, detail, ...(action ? { action } : {}) };
}
async function runDiagnostics({ network = true } = {}) {
    const checks = [];
    const integrity = databaseIntegrity();
    checks.push(diagnosticItem('database', 'Database integrity', integrity.ok ? 'pass' : 'fail', integrity.ok ? 'SQLite integrity check returned OK.' : integrity.messages.join('; '), 'data'));
    try {
        fs.accessSync(USER_DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
        fs.accessSync(BACKUP_DIR, fs.constants.R_OK | fs.constants.W_OK);
        checks.push(diagnosticItem('storage-write', 'Data and backup access', 'pass', 'The process can read and write both primary directories.', 'data'));
    }
    catch (err) {
        checks.push(diagnosticItem('storage-write', 'Data and backup access', 'fail', String(err?.message || err), 'data'));
    }
    try {
        const key = secretKey();
        if (getSetting('encrypted_notification_secrets', ''))
            storedSecrets();
        checks.push(diagnosticItem('secret-key', 'Local encryption key', key.length === 32 ? 'pass' : 'fail', 'The separate key file is readable and saved credentials can be decrypted.', 'notifications'));
    }
    catch (err) {
        checks.push(diagnosticItem('secret-key', 'Local encryption key', 'fail', String(err?.message || err), 'notifications'));
    }
    try {
        const tested = testBackupRestore({ location: 'primary' });
        checks.push(diagnosticItem('restore', 'Latest primary backup', tested.ok ? 'pass' : 'fail', tested.ok ? `${tested.filename} passed a non-destructive restore-read test.` : `${tested.filename} is not compatible or complete.`, 'data'));
    }
    catch (err) {
        checks.push(diagnosticItem('restore', 'Latest primary backup', 'warn', String(err?.message || err), 'data'));
    }
    if (SECONDARY_BACKUP_DIR) {
        try {
            ensureSecondaryBackupDirectory();
            const same = backupLocationsShareDevice();
            checks.push(diagnosticItem('secondary', 'Secondary recovery destination', same ? 'warn' : 'pass', same ? 'The destination is writable but appears to use the same storage device as the primary database.' : 'The destination is writable and appears to use separate storage.', 'data'));
            try {
                const tested = testBackupRestore({ location: 'secondary' });
                checks.push(diagnosticItem('secondary-restore', 'Latest secondary recovery copy', tested.ok ? 'pass' : 'fail', tested.ok ? `${tested.filename} passed its restore-read test.` : 'The latest secondary recovery copy failed validation.', 'data'));
            }
            catch (err) {
                checks.push(diagnosticItem('secondary-restore', 'Latest secondary recovery copy', 'warn', String(err?.message || err), 'data'));
            }
        }
        catch (err) {
            checks.push(diagnosticItem('secondary', 'Secondary recovery destination', 'fail', String(err?.message || err), 'data'));
        }
    }
    else
        checks.push(diagnosticItem('secondary', 'Secondary recovery destination', 'warn', 'No secondary destination is configured. Primary backups remain on the GearBeacon data filesystem.', 'data'));
    const storage = dataInfo();
    checks.push(diagnosticItem('disk', 'Free storage', storage.freeSpace === null ? 'warn' : storage.freeSpace >= 1024 * 1024 * 1024 ? 'pass' : 'fail', storage.freeSpace === null ? 'Free-space reporting is unavailable on this platform.' : `${Math.round(storage.freeSpace / 1024 / 1024)} MB is available.`, 'data'));
    const queue = notificationQueueSummary();
    checks.push(diagnosticItem('delivery', 'Notification queue', queue.failed ? 'fail' : 'pass', queue.failed ? `${queue.failed} delivery job${queue.failed === 1 ? '' : 's'} exhausted the retry limit.` : `${queue.pending + queue.processing} jobs pending; no terminal failures.`, 'notifications'));
    for (const region of ACTIVE_REGIONS) {
        const current = monitors[region];
        let status = current.lastSuccessAt && !current.lastError ? 'pass' : 'warn';
        let detail = current.lastSuccessAt ? `Last successful catalog check: ${current.lastSuccessAt}.` : 'This region has not completed a successful catalog check.';
        if (network && !MOCK_MODE) {
            try {
                const response = await regionContext.run(region, () => fetchWithTimeout(`${STORE_BASE}/${REGIONS[region].path}`, { headers: HEADERS }, 8000));
                if (!response.ok)
                    throw storeHttpError(response, 'Store reachability probe');
                try {
                    await response.body?.cancel();
                }
                catch { }
                status = 'pass';
                detail = 'DNS, TLS, and the UniFi Store endpoint responded successfully.';
            }
            catch (err) {
                status = 'fail';
                detail = String(err?.message || err);
            }
        }
        else if (MOCK_MODE) {
            status = 'pass';
            detail = 'Mock catalog endpoint is available.';
        }
        checks.push(diagnosticItem(`store-${region}`, `${REGIONS[region].label} store`, status, detail));
    }
    for (const warning of securityWarnings())
        checks.push(diagnosticItem(`security-${warning.code}`, 'Access configuration', warning.severity === 'high' ? 'fail' : 'warn', warning.message, warning.settingsTab));
    const failed = checks.filter((item) => item.status === 'fail').length;
    const warned = checks.filter((item) => item.status === 'warn').length;
    const result = { ok: failed === 0, generatedAt: isoNow(), summary: { status: failed ? 'fail' : warned ? 'warn' : 'pass', failed, warned, passed: checks.length - failed - warned }, checks };
    writeAppLog(failed ? 'error' : warned ? 'warn' : 'info', 'diagnostics', 'Owner ran installation diagnostics.', result.summary);
    return result;
}
function scrubSupportValue(value, key = '') {
    if (/password|secret|token|credential|session|cookie|authorization|path$|directory$|dir$/i.test(key))
        return '[redacted]';
    if (Array.isArray(value))
        return value.map((item) => scrubSupportValue(item));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrubSupportValue(item, name)]));
    if (typeof value === 'string')
        return value
            .replace(/(bearer\s+)[^\s,;]+/ig, '$1[redacted]')
            .replace(/(password|secret|token|authorization)(["'=:\s]+)[^\s,"'}]+/ig, '$1$2[redacted]')
            .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/ig, '[url redacted]')
            .replace(/\b[A-Z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/ig, '[local path redacted]')
            .replace(/(^|[\s("'=])\/(?:Users|home|var|data|mnt|srv|opt|tmp|private|Library)(?:\/[^\s"',;)}]+)*/g, '$1[local path redacted]')
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address redacted]')
            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig, '[address redacted]');
    return value;
}
function supportBundle() {
    const config = storedAppConfig();
    const safeConfig = {
        ...config,
        bindHost: '[redacted]',
        publicBaseUrl: config.publicBaseUrl ? '[configured]' : '',
        allowedOrigins: (config.allowedOrigins || []).length ? [`${config.allowedOrigins.length} configured`] : [],
        secondaryBackupDir: config.secondaryBackupDir ? '[configured]' : '',
        ntfyBaseUrl: config.ntfyBaseUrl ? '[configured]' : '',
        ntfyTopic: config.ntfyTopic ? '[configured]' : '',
        gotifyBaseUrl: config.gotifyBaseUrl ? '[configured]' : '',
        smtpHost: config.smtpHost ? '[configured]' : '',
        smtpUser: config.smtpUser ? '[configured]' : '',
        smtpFrom: config.smtpFrom ? '[configured]' : '',
        smtpTo: (config.smtpTo || []).length ? ['[configured]'] : [],
    };
    const logs = db.prepare('SELECT level,source,message,detail_json,created_at FROM app_log ORDER BY id DESC LIMIT 500').all().map((row) => ({ ...row, detail: safeJsonParse(row.detail_json, null), detail_json: undefined }));
    return scrubSupportValue({
        format: 'GearBeaconSupportBundle', formatVersion: 1, generatedAt: isoNow(),
        note: 'Secrets, credentials, sessions, recipient addresses, and notification destinations are excluded or redacted.',
        runtime: operationsSummary().runtime,
        configuration: safeConfig,
        operations: operationsSummary(),
        data: { ...dataInfo(), databasePath: '[local path redacted]', userDataDir: '[local path redacted]', backupDir: '[local path redacted]' },
        logs,
    });
}
function updatePreparation() {
    for (const region of ACTIVE_REGIONS)
        flushState(region);
    const backup = createDatabaseBackup(`pre-update-${APP_VERSION}`);
    const commands = {
        win32: '.\\update-windows.ps1 -Version <new-version> -BackupConfirmed',
        darwin: './update-mac-linux.sh <new-version> --backup-confirmed',
        linux: './update-mac-linux.sh <new-version> --backup-confirmed',
        docker: './update-docker.sh <new-version> --backup-confirmed',
    };
    writeAppLog('info', 'updates', 'Owner prepared a validated pre-update backup.', { backup: backup?.filename });
    return {
        ok: true,
        backup,
        command: commands[process.platform] || null,
        dockerCommand: commands.docker,
        warning: 'GearBeacon will never install an update silently. Review the release notes, stop the service, and run the matching helper yourself.',
        rollback: 'Stop GearBeacon, restore the validated pre-update SQLite file to the data directory, then reinstall the previous version.',
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
        const watchRules = {};
        for (const row of db.prepare('SELECT slug,rule_json FROM watch_rules WHERE region=?').all(region))
            watchRules[row.slug] = normalizeWatchRule(safeJsonParse(row.rule_json, {}));
        const watchCreatedAt = {};
        for (const row of db.prepare('SELECT slug,created_at FROM watchlist WHERE region=?').all(region))
            watchCreatedAt[row.slug] = row.created_at;
        regionData[region] = {
            watchlist: [...states[region].watchlist],
            watchCreatedAt,
            products: states[region].products,
            events: db.prepare('SELECT data_json FROM events WHERE region=? ORDER BY detected_at').all(region)
                .map((row) => safeJsonParse(row.data_json, null)).filter(Boolean),
            watchRules,
            productHistory: db.prepare(`SELECT slug,observed_at AS observedAt,change_type AS changeType,status,in_stock AS inStock,price_text AS price,price_value AS priceValue
        FROM product_observations WHERE region=? ORDER BY observed_at`).all(region).map((row) => ({ ...row, inStock: Boolean(row.inStock) })),
        };
    }
    return {
        format: 'GearBeaconBackup',
        formatVersion: 3,
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
    if (isBackup && Number(snapshot.formatVersion || 0) > 3)
        throw new Error(`This backup format (${snapshot.formatVersion}) is newer than GearBeacon ${APP_VERSION} supports.`);
    const normalizeRegion = (value) => ({
        watchlist: Array.isArray(value?.watchlist) ? value.watchlist.map(String).filter(Boolean) : [],
        watchCreatedAt: value?.watchCreatedAt && typeof value.watchCreatedAt === 'object' && !Array.isArray(value.watchCreatedAt) ? value.watchCreatedAt : {},
        products: value?.products && typeof value.products === 'object' && !Array.isArray(value.products) ? value.products : {},
        events: Array.isArray(value?.events) ? value.events.filter((event) => event && event.id).slice(-100000) : [],
        watchRules: value?.watchRules && typeof value.watchRules === 'object' && !Array.isArray(value.watchRules) ? value.watchRules : {},
        productHistory: Array.isArray(value?.productHistory) ? value.productHistory.filter((item) => item?.slug && item?.observedAt).slice(-100000) : [],
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
        persistState(regionState, region, { replaceEvents: true });
        const restoreWatchCreatedAt = db.prepare('UPDATE watchlist SET created_at=? WHERE region=? AND slug=?');
        for (const [slug, createdAt] of Object.entries(regionState.watchCreatedAt || {})) {
            const parsed = new Date(String(createdAt));
            if (regionState.watchlist.includes(slug) && !Number.isNaN(parsed.valueOf()))
                restoreWatchCreatedAt.run(parsed.toISOString(), region, slug);
        }
        db.prepare('DELETE FROM watch_rules WHERE region=?').run(region);
        for (const [slug, rule] of Object.entries(regionState.watchRules || {}))
            saveWatchRule(String(slug), rule, region);
        db.prepare('DELETE FROM product_observations WHERE region=?').run(region);
        const addHistory = db.prepare(`INSERT INTO product_observations(region,slug,observed_at,change_type,status,in_stock,price_text,price_value) VALUES(?,?,?,?,?,?,?,?)`);
        for (const item of regionState.productHistory || []) {
            const observed = new Date(item.observedAt);
            if (Number.isNaN(observed.valueOf()))
                continue;
            addHistory.run(region, String(item.slug), observed.toISOString(), String(item.changeType || 'imported').slice(0, 80), item.status ? String(item.status) : null, item.inStock ? 1 : 0, item.price ? String(item.price) : null, priceValue(item.priceValue ?? item.price));
        }
        states[region] = loadState(region);
        monitors[region].productCount = Object.keys(states[region].products).length;
        watchCount += states[region].watchlist.length;
        eventCount += states[region].events.length;
        importedRegions.push(region);
    }
    if (!importedRegions.length)
        throw new Error(`This backup does not contain any configured region (${ACTIVE_REGIONS.join(', ')}).`);
    if (tableExists('settings')) {
        const importedKeys = new Set(Object.keys(normalized.settings));
        const remove = db.prepare('DELETE FROM settings WHERE key=?');
        for (const row of db.prepare('SELECT key FROM settings').all()) {
            if (!/password|secret|token|credential|session/i.test(row.key) && !importedKeys.has(row.key))
                remove.run(row.key);
        }
        const put = db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
        for (const [key, value] of Object.entries(normalized.settings)) {
            if (!/password|secret|token|credential|session/i.test(key))
                put.run(String(key), String(value), isoNow());
        }
        applyAppConfig(storedAppConfig(), storedSecrets());
        scheduleBackups();
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
        historyCount: value.productHistory.length,
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
            minimumSchemaVersion: Number(payload.minimumSchemaVersion || 0) || null,
            maximumSchemaVersion: Number(payload.maximumSchemaVersion || 0) || null,
            minimumNodeVersion: payload.minimumNodeVersion || null,
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
    const compatibilityWarnings = [];
    if (Number(latestVersion.split('.')[0] || 0) > Number(APP_VERSION.split('.')[0] || 0))
        compatibilityWarnings.push('This is a major-version update. Review migration and rollback notes before continuing.');
    if (manifest.minimumSchemaVersion && schemaVersion() < manifest.minimumSchemaVersion)
        compatibilityWarnings.push(`The release requires database schema v${manifest.minimumSchemaVersion}; GearBeacon will create a validated backup before migration.`);
    if (manifest.maximumSchemaVersion && schemaVersion() > manifest.maximumSchemaVersion)
        compatibilityWarnings.push(`This database schema is newer than the release supports. Do not downgrade without restoring a compatible backup.`);
    if (!runningAsSea && manifest.minimumNodeVersion && compareVersions(process.versions.node, manifest.minimumNodeVersion) < 0)
        compatibilityWarnings.push(`Source installs require Node.js ${manifest.minimumNodeVersion} or newer for this release.`);
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
        compatibilityWarnings,
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
        onboardingComplete: getSetting('onboarding_complete', '0') === '1',
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
        { name: 'ntfy', enabled: channelConfigured('ntfy'), required: false, destination: NTFY_TOPIC ? NTFY_BASE_URL : null, purpose: 'Notifications' },
        { name: 'Discord', enabled: channelConfigured('discord'), required: false, destination: DISCORD_WEBHOOK_URL ? 'Configured webhook' : null, purpose: 'Notifications' },
        { name: 'Generic webhook', enabled: channelConfigured('webhook'), required: false, destination: GENERIC_WEBHOOK_URL ? 'Configured webhook' : null, purpose: 'Notifications' },
        { name: 'Gotify', enabled: channelConfigured('gotify'), required: false, destination: GOTIFY_BASE_URL || null, purpose: 'Notifications' },
        { name: 'Email', enabled: channelConfigured('email'), required: false, destination: smtpConfigured() ? SMTP_HOST : null, purpose: 'SMTP notifications' },
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
            ntfyConfigured: channelConfigured('ntfy'),
            discordConfigured: channelConfigured('discord'),
            webhookConfigured: channelConfigured('webhook'),
            gotifyConfigured: channelConfigured('gotify'),
            smtpConfigured: channelConfigured('email'),
            channelEnabled: { ...CHANNEL_ENABLED },
            queue: notificationQueueSummary(),
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
function publicErrorMessage(err, status = 500) {
    if (status >= 500)
        return 'GearBeacon could not complete that request. Check Operations logs for details.';
    return String(err?.message || 'The request could not be completed.').slice(0, 500);
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
function sendTextDownload(res, text, filename, type = 'text/plain; charset=utf-8') {
    res.writeHead(200, {
        'Content-Type': type,
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
function sendEmailPreviewHtml(res, html) {
    const headers = { ...commonResponseHeaders(res) };
    delete headers['X-Frame-Options'];
    headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data: https://ui.com https://*.ui.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    headers['Cross-Origin-Resource-Policy'] = 'same-origin';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store', ...headers });
    res.end(html);
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
    let decoded;
    try {
        decoded = decodeURIComponent(clean);
    }
    catch {
        return null;
    }
    const full = path.resolve(WEB_DIR, `.${decoded}`);
    const root = path.resolve(WEB_DIR);
    if (full !== root && !full.startsWith(`${root}${path.sep}`))
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
            writeAppLog('warn', 'security', 'Rejected invalid owner setup token.', { remoteAddress: requestAddress(req) });
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
        writeAppLog('info', 'security', 'Owner password setup completed.', { remoteAddress: requestAddress(req) });
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
            writeAppLog('warn', 'security', 'Rejected owner sign-in.', { remoteAddress: requestAddress(req) });
            return sendJson(res, 401, { error: 'The owner password is incorrect.' });
        }
        clearLoginFailures(req);
        const created = createSession(req);
        writeAppLog('info', 'security', 'Owner signed in.', { remoteAddress: requestAddress(req) });
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
        writeAppLog('info', 'security', 'Owner signed out.', { remoteAddress: requestAddress(req) });
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
        writeAppLog('info', 'security', 'Owner password changed; other sessions were revoked.', { remoteAddress: requestAddress(req) });
        res.gearbeaconHeaders = { ...commonResponseHeaders(res), 'Set-Cookie': sessionCookie(req, created.token, created.expiresAt) };
        return sendJson(res, 200, { ok: true, csrfToken: created.csrfToken, sessionExpiresAt: created.expiresAt });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, appConfigurationForApi());
    }
    if (req.method === 'POST' && url.pathname === '/api/config/validate') {
        const body = await readJsonBody(req);
        try {
            const config = normalizeAppConfig(body?.config || body, storedAppConfig());
            return sendJson(res, 200, { ok: true, config });
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'PUT' && url.pathname === '/api/config') {
        const body = await readJsonBody(req);
        try {
            return sendJson(res, 200, { ok: true, ...saveBrowserConfig(body?.config ? { ...body.config, secrets: body.secrets } : body) });
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'POST' && url.pathname === '/api/onboarding/complete') {
        const hasSuccessfulStoreCheck = ACTIVE_REGIONS.some((region) => Boolean(monitors[region]?.lastSuccessAt));
        if (!hasSuccessfulStoreCheck && !MOCK_MODE)
            return sendJson(res, 409, { error: 'Run at least one successful store check before finishing setup.' });
        setSetting('onboarding_complete', '1');
        writeAppLog('info', 'onboarding', 'Guided first-run setup completed.');
        return sendJson(res, 200, { ok: true, summary: { url: PUBLIC_BASE_URL || `http://localhost:${PORT}`, accessMode: ACCESS_MODE, regions: [...ACTIVE_REGIONS], securityWarnings: securityWarnings() } });
    }
    if (req.method === 'GET' && url.pathname === '/api/operations') {
        return sendJson(res, 200, operationsSummary());
    }
    if (req.method === 'POST' && url.pathname === '/api/operations/diagnostics') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await runDiagnostics({ network: body?.network !== false }));
    }
    if (req.method === 'GET' && url.pathname === '/api/operations/support-bundle') {
        return sendJsonDownload(res, supportBundle(), `GearBeacon-Support-${new Date().toISOString().slice(0, 10)}.json`);
    }
    if (req.method === 'POST' && url.pathname === '/api/data/test-restore') {
        const body = await readJsonBody(req);
        try {
            const result = testBackupRestore(body || {});
            writeAppLog(result.ok ? 'info' : 'error', 'backups', 'Owner completed a non-destructive backup restore test.', { filename: result.filename, location: result.location, ok: result.ok });
            return sendJson(res, result.ok ? 200 : 409, result.ok ? result : { error: 'The selected backup did not pass its restore test.', ...result });
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'GET' && url.pathname === '/api/activity') {
        try {
            return sendJson(res, 200, activityQuery(url));
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'GET' && url.pathname === '/api/activity/export') {
        try {
            const result = activityQuery(url, { exportLimit: 10000 });
            const format = String(url.searchParams.get('format') || 'csv').toLowerCase();
            const stamp = new Date().toISOString().slice(0, 10);
            if (format === 'json')
                return sendJsonDownload(res, { exportedAt: isoNow(), ...result }, `GearBeacon-Activity-${stamp}.json`);
            if (format !== 'csv')
                return sendJson(res, 400, { error: 'Activity export format must be csv or json.' });
            return sendTextDownload(res, activityCsv(result.events), `GearBeacon-Activity-${stamp}.csv`, 'text/csv; charset=utf-8');
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/activity/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/activity/'.length));
        const row = db.prepare('SELECT data_json FROM events WHERE id=?').get(id);
        if (!row)
            return sendJson(res, 404, { error: 'Activity event not found.' });
        const event = safeJsonParse(row.data_json, null);
        return sendJson(res, 200, { event: enrichActivityEvents(event ? [event] : [])[0] || null });
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
        const level = String(url.searchParams.get('level') || '').toLowerCase();
        const source = String(url.searchParams.get('source') || '').toLowerCase();
        const search = String(url.searchParams.get('search') || '').toLowerCase();
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
        let rows = db.prepare('SELECT id,level,source,message,detail_json,created_at FROM app_log ORDER BY id DESC LIMIT ?').all(limit);
        if (level)
            rows = rows.filter((row) => row.level === level);
        if (source)
            rows = rows.filter((row) => row.source.toLowerCase() === source);
        if (search)
            rows = rows.filter((row) => `${row.message} ${row.detail_json || ''}`.toLowerCase().includes(search));
        if (url.searchParams.get('download') === '1')
            return sendJsonDownload(res, { exportedAt: isoNow(), logs: rows }, `GearBeacon-Logs-${new Date().toISOString().slice(0, 10)}.json`);
        return sendJson(res, 200, { logs: rows, count: rows.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/retry-failed') {
        const result = db.prepare("UPDATE notification_queue SET status='pending',attempts=0,next_attempt_at=?,last_error=NULL,updated_at=? WHERE status='failed'").run(isoNow(), isoNow());
        processNotificationQueue().catch(() => { });
        return sendJson(res, 200, { ok: true, queued: Number(result.changes || 0) });
    }
    if (req.method === 'POST' && url.pathname === '/api/update/prepare') {
        try {
            return sendJson(res, 200, updatePreparation());
        }
        catch (err) {
            writeAppLog('error', 'updates', 'Update preparation failed.', { error: String(err?.message || err) });
            return sendJson(res, 500, { error: publicErrorMessage(err, 500) });
        }
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
    if (req.method === 'GET' && url.pathname === '/api/notifications/preview') {
        const slug = String(url.searchParams.get('slug') || '').trim();
        const eventType = String(url.searchParams.get('eventType') || 'restock').trim();
        let event;
        try {
            event = previewNotificationEvent(slug, eventType);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        const product = event.slug ? state.products[event.slug] : null;
        const decision = product ? notificationDecision(event) : { allowed: true, reason: 'preview', rule: { ...DEFAULT_WATCH_RULE } };
        const email = renderEmail(event, emailRenderOptions({ allowRemoteImages: !EMAIL_EMBED_IMAGES, logoSource: '/assets/icon.png' }));
        return sendJson(res, 200, { event, decision, delivery: deliveryPlan(event, decision.rule), copy: notificationCopy(event), email: { subject: email.subject, text: email.text }, configuredChannels: CHANNEL_NAMES.filter(channelConfigured) });
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications/email-preview') {
        const slug = String(url.searchParams.get('slug') || '').trim();
        const eventType = String(url.searchParams.get('eventType') || 'restock').trim();
        const theme = String(url.searchParams.get('theme') || EMAIL_THEME).trim().toLowerCase();
        if (!['auto', 'light', 'dark'].includes(theme))
            return sendJson(res, 400, { error: 'Email preview theme must be auto, light, or dark.' });
        let event;
        try {
            event = previewNotificationEvent(slug, eventType);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        let previewConfig;
        try {
            const current = storedAppConfig();
            previewConfig = normalizeAppConfig({
                ...current,
                emailDetailLevel: url.searchParams.get('detailLevel') ?? current.emailDetailLevel,
                emailTheme: theme,
                emailSubjectPrefix: url.searchParams.has('subjectPrefix') ? url.searchParams.get('subjectPrefix') : current.emailSubjectPrefix,
                emailDigestMaxItems: url.searchParams.get('digestMaxItems') ?? current.emailDigestMaxItems,
                emailExplainReason: url.searchParams.has('explainReason') ? url.searchParams.get('explainReason') === '1' : current.emailExplainReason,
                emailPriceCalculations: url.searchParams.has('priceCalculations') ? url.searchParams.get('priceCalculations') === '1' : current.emailPriceCalculations,
            }, current);
        }
        catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        const email = renderEmail(event, emailRenderOptions({
            theme: previewConfig.emailTheme,
            detailLevel: previewConfig.emailDetailLevel,
            subjectPrefix: previewConfig.emailSubjectPrefix,
            digestMaxItems: previewConfig.emailDigestMaxItems,
            explainReason: previewConfig.emailExplainReason,
            priceCalculations: previewConfig.emailPriceCalculations,
            allowRemoteImages: true,
            logoSource: '/assets/icon.png',
        }));
        return sendEmailPreviewHtml(res, email.html);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/products/')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/products/'.length));
        const details = productDetailsForApi(slug);
        return details ? sendJson(res, 200, details) : sendJson(res, 404, { error: 'Product not found.' });
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
    if (req.method === 'POST' && url.pathname === '/api/watch/import/preview') {
        const body = await readJsonBody(req, 256 * 1024);
        return sendJson(res, 200, previewWatchImport(body?.content, body?.fileName));
    }
    if (req.method === 'POST' && url.pathname === '/api/watch/import') {
        const body = await readJsonBody(req, 256 * 1024);
        if (!Array.isArray(body?.slugs))
            return sendJson(res, 400, { error: 'slugs must be an array.' });
        if (body.slugs.length > 1000)
            return sendJson(res, 400, { error: 'A watchlist import can add at most 1,000 products.' });
        const slugs = [...new Set(body.slugs.map((value) => String(value || '').trim()).filter(Boolean))];
        if (!slugs.length)
            return sendJson(res, 400, { error: 'Select at least one matched product to import.' });
        const hasProduct = (slug) => Object.hasOwn(state.products, slug);
        const notFound = slugs.filter((slug) => !hasProduct(slug));
        const alreadyWatched = slugs.filter((slug) => hasProduct(slug) && state.watchlist.includes(slug));
        const additions = slugs.filter((slug) => hasProduct(slug) && !state.watchlist.includes(slug));
        if (additions.length) {
            const insert = db.prepare('INSERT INTO watchlist(region,slug,created_at) VALUES(?,?,?) ON CONFLICT(region,slug) DO NOTHING');
            const createdAt = isoNow();
            db.exec('BEGIN IMMEDIATE');
            try {
                for (const slug of additions)
                    insert.run(currentRegion(), slug, createdAt);
                db.exec('COMMIT');
            }
            catch (err) {
                try {
                    db.exec('ROLLBACK');
                }
                catch { }
                throw err;
            }
            state.watchlist.push(...additions);
            saveStateSoon();
            writeAppLog('info', 'watchlist', `Imported ${additions.length} product${additions.length === 1 ? '' : 's'} into the ${REGIONS[currentRegion()].label} watchlist.`, { slugs: additions });
        }
        return sendJson(res, 200, {
            ok: true,
            region: currentRegion(),
            added: additions.length,
            alreadyWatched,
            notFound,
            products: additions.map((slug) => productForApi(state.products[slug])),
            watchlist: state.watchlist,
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/watch') {
        const body = await readJsonBody(req);
        const slug = String(body?.slug || '').trim();
        if (!slug)
            return sendJson(res, 400, { error: 'slug is required' });
        if (!state.products[slug])
            return sendJson(res, 404, { error: 'Product not found in this region.' });
        if (!state.watchlist.includes(slug)) {
            db.prepare('INSERT INTO watchlist(region,slug,created_at) VALUES(?,?,?) ON CONFLICT(region,slug) DO NOTHING').run(currentRegion(), slug, isoNow());
            state.watchlist.push(slug);
        }
        if (body?.rule)
            saveWatchRule(slug, body.rule);
        saveStateSoon();
        return sendJson(res, 200, { ok: true, product: productForApi(state.products[slug]), watchlist: state.watchlist });
    }
    if (req.method === 'POST' && url.pathname === '/api/watch/bulk') {
        const body = await readJsonBody(req);
        const slugs = [...new Set((Array.isArray(body?.slugs) ? body.slugs : []).map(String).filter((slug) => state.watchlist.includes(slug)))].slice(0, 1000);
        const action = String(body?.action || '');
        if (!slugs.length)
            return sendJson(res, 400, { error: 'Select at least one watched product.' });
        if (!['pause', 'resume', 'remove'].includes(action))
            return sendJson(res, 400, { error: 'Bulk action must be pause, resume, or remove.' });
        let pausedUntil = null;
        if (action === 'pause') {
            const minutes = Number(body?.minutes || 0);
            pausedUntil = minutes > 0 ? new Date(Date.now() + Math.min(minutes, 525600) * 60000).toISOString() : 'indefinite';
            for (const slug of slugs)
                saveWatchRule(slug, { pausedUntil });
        }
        else if (action === 'resume') {
            for (const slug of slugs)
                saveWatchRule(slug, { enabled: true, pausedUntil: null });
        }
        else {
            state.watchlist = state.watchlist.filter((slug) => !slugs.includes(slug));
            const removeWatch = db.prepare('DELETE FROM watchlist WHERE region=? AND slug=?');
            for (const slug of slugs)
                removeWatch.run(currentRegion(), slug);
        }
        saveStateSoon();
        return sendJson(res, 200, { ok: true, action, affected: slugs.length, pausedUntil, products: slugs.map((slug) => productForApi(state.products[slug])).filter(Boolean) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/watch/') && url.pathname.endsWith('/rules')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/watch/'.length, -'/rules'.length));
        if (!state.watchlist.includes(slug))
            return sendJson(res, 404, { error: 'Product is not on the watchlist.' });
        return sendJson(res, 200, { slug, rule: watchRule(slug), globalPreferences: notificationPreferences() });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/watch/') && url.pathname.endsWith('/rules')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/watch/'.length, -'/rules'.length));
        if (!state.watchlist.includes(slug))
            return sendJson(res, 404, { error: 'Product is not on the watchlist.' });
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, slug, rule: saveWatchRule(slug, body?.rule || body || {}) });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/watch/')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/watch/'.length));
        state.watchlist = state.watchlist.filter((x) => x !== slug);
        db.prepare('DELETE FROM watchlist WHERE region=? AND slug=?').run(currentRegion(), slug);
        saveStateSoon();
        return sendJson(res, 200, { ok: true, watchlist: state.watchlist });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
        const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const recentEvents = state.events.slice(-limit).reverse();
        const eventIds = recentEvents.map((event) => event.id).filter(Boolean);
        const queueByEvent = new Map();
        const logsByEvent = new Map();
        if (eventIds.length) {
            const placeholders = eventIds.map(() => '?').join(',');
            for (const row of db.prepare(`SELECT event_id,channel,status,attempts,max_attempts,next_attempt_at,last_error,updated_at FROM notification_queue WHERE event_id IN (${placeholders})`).all(...eventIds)) {
                if (!queueByEvent.has(row.event_id))
                    queueByEvent.set(row.event_id, []);
                queueByEvent.get(row.event_id).push(row);
            }
            for (const row of db.prepare(`SELECT event_id,channel,status,detail,created_at FROM notification_log WHERE event_id IN (${placeholders}) ORDER BY id DESC`).all(...eventIds)) {
                if (!logsByEvent.has(row.event_id))
                    logsByEvent.set(row.event_id, []);
                logsByEvent.get(row.event_id).push(row);
            }
        }
        const events = recentEvents.map((event) => {
            const decision = notificationDecision(event);
            return { ...event, notificationDecision: decision, serverAlert: eventServerAlertSummary(event, decision, queueByEvent.get(event.id) || [], logsByEvent.get(event.id) || []) };
        });
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
        const body = await readJsonBody(req);
        const channel = body?.channel ? String(body.channel).toLowerCase() : null;
        if (channel && !CHANNEL_NAMES.includes(channel))
            return sendJson(res, 400, { error: `Channel must be one of: ${CHANNEL_NAMES.join(', ')}.` });
        const result = await sendTestNotification(channel);
        if (!result.configuredChannels || (channel && !channelConfigured(channel)))
            return sendJson(res, 409, { error: channel ? `${channel} is disabled or incomplete.` : 'No server-side notification channel is configured.', ...result });
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
        mockOverrides[slug] = { ...(mockOverrides[slug] || {}), status: existing.inStock ? 'SoldOut' : 'Available', present: true };
        return sendJson(res, 200, { ok: true, slug, status: mockOverrides[slug].status });
    }
    if (MOCK_MODE && req.method === 'POST' && url.pathname.startsWith('/api/mock/product/')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/mock/product/'.length));
        const source = MOCK_PRODUCTS.find((product) => product.slug === slug);
        if (!source)
            return sendJson(res, 404, { error: 'mock product not found' });
        const body = await readJsonBody(req);
        const status = body?.status === undefined ? (mockOverrides[slug]?.status || source.status) : String(body.status);
        if (!['Available', 'SoldOut', 'ComingSoon'].includes(status))
            return sendJson(res, 400, { error: 'Mock status must be Available, SoldOut, or ComingSoon.' });
        const price = body?.price === undefined ? (mockOverrides[slug]?.price ?? source.price) : String(body.price);
        mockOverrides[slug] = { status, price, present: body?.present !== false };
        return sendJson(res, 200, { ok: true, slug, ...mockOverrides[slug] });
    }
    if (MOCK_MODE && req.method === 'POST' && url.pathname === '/api/mock/fault') {
        const body = await readJsonBody(req);
        if (body?.reset === true)
            mockFaults = { rateLimitOnceSeconds: 0, partialOmitSlugs: [], catalogSize: defaultMockCatalogSize };
        if (body?.rateLimitOnceSeconds !== undefined) {
            const seconds = Number(body.rateLimitOnceSeconds);
            if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
                return sendJson(res, 400, { error: 'Mock rate-limit delay must be between 0 and 86400 seconds.' });
            mockFaults.rateLimitOnceSeconds = Math.round(seconds);
        }
        if (body?.partialOmitSlugs !== undefined) {
            if (!Array.isArray(body.partialOmitSlugs) || body.partialOmitSlugs.length > 1000)
                return sendJson(res, 400, { error: 'Mock partial omissions must be an array of at most 1,000 slugs.' });
            mockFaults.partialOmitSlugs = [...new Set(body.partialOmitSlugs.map((slug) => String(slug).trim()).filter(Boolean))];
        }
        if (body?.catalogSize !== undefined) {
            const size = Number(body.catalogSize);
            if (!Number.isInteger(size) || size < 6 || size > 1000)
                return sendJson(res, 400, { error: 'Mock catalog size must be an integer from 6 to 1,000.' });
            mockFaults.catalogSize = size;
        }
        return sendJson(res, 200, { ok: true, faults: { ...mockFaults } });
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
        const status = Number(err?.statusCode) || 500;
        writeAppLog('error', 'http', 'Unhandled request failure.', { method: req.method, path: req.url, error: String(err?.message || err) });
        if (!res.headersSent)
            sendJson(res, status, { error: publicErrorMessage(err, status) });
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
    scheduleNotificationWorker();
    writeAppLog('info', 'app', `GearBeacon V${APP_VERSION} started.`, { regions: ACTIVE_REGIONS, accessMode: ACCESS_MODE, platform: `${process.platform}/${process.arch}` });
}
function shutdown(signal) {
    for (const timer of monitorTimers.values())
        clearTimeout(timer);
    if (backupTimer)
        clearTimeout(backupTimer);
    if (notificationWorkerTimer)
        clearInterval(notificationWorkerTimer);
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
