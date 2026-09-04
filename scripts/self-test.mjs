import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const port = 8899;
const base = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-v14-test-'));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let child = null;

function startServer() {
  child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOCK_MODE: '1',
      PORT: String(port),
      POLL_SECONDS: '60',
      GEARBEACON_DATA_DIR: dataDir,
      GEARBEACON_SKIP_LEGACY_IMPORT: '1',
      GEARBEACON_GITHUB_RELEASE_API: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill('SIGINT');
  await Promise.race([
    new Promise((resolve) => current.once('exit', resolve)),
    delay(2000),
  ]);
}

async function request(path, options = {}) {
  const res = await fetch(base + path, { headers: { 'Content-Type':'application/json', ...(options.headers || {}) }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error || res.status}`);
  return body;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { return await request('/api/status'); } catch { await delay(100); }
  }
  throw new Error('GearBeacon test server did not start');
}

try {
  startServer();
  const status = await waitForServer();
  if (status.version !== '1.4.0') throw new Error(`Unexpected app version: ${status.version}`);
  if (status.storage?.engine !== 'SQLite' || status.storage?.schemaVersion !== 3) throw new Error('SQLite schema v3 was not initialized');

  await delay(150);
  const products = await request('/api/products');
  if (products.count < 5) throw new Error('Mock catalog did not load');
  const target = products.products.find((p) => p.slug === 'u7-pro-xgs');
  if (!target) throw new Error('Target mock product missing');

  // Ensure target starts sold out, then watch it and simulate a restock.
  if (target.inStock) await request('/api/mock/toggle/u7-pro-xgs', { method:'POST' });
  await request('/api/check', { method:'POST' });
  await request('/api/watch', { method:'POST', body: JSON.stringify({ slug:'u7-pro-xgs' }) });
  await request('/api/mock/toggle/u7-pro-xgs', { method:'POST' });
  await request('/api/check', { method:'POST' });
  const events = await request('/api/events?limit=20');
  const restock = events.events.find((e) => e.slug === 'u7-pro-xgs' && e.type === 'restock' && e.watchedAtDetection);
  if (!restock) throw new Error('Watched restock event was not generated');

  // V1.4 notification controls persist in SQLite.
  const prefs0 = await request('/api/notifications/preferences');
  if (!prefs0.preferences.restock || prefs0.preferences.soldOut) throw new Error('Default notification preferences are wrong');
  const prefs1 = await request('/api/notifications/preferences', { method:'PUT', body: JSON.stringify({ preferences: { restock:true, soldOut:true, priceChange:true, statusChange:false, newProduct:true } }) });
  if (!prefs1.preferences.soldOut || !prefs1.preferences.priceChange || !prefs1.preferences.newProduct) throw new Error('Notification preferences did not save');

  const health = await request('/api/health');
  if (!health.ok || health.monitor.catalogHealth !== 'healthy') throw new Error('V1.4 monitor health endpoint failed');

  // Export, mutate, and import to prove watchlists can be transferred/restored.
  const exportRes = await fetch(base + '/api/data/export');
  if (!exportRes.ok) throw new Error('Export endpoint failed');
  const snapshot = await exportRes.json();
  if (snapshot.format !== 'GearBeaconBackup' || !snapshot.watchlist.includes('u7-pro-xgs')) throw new Error('Export did not contain the watchlist');
  await request('/api/watch/u7-pro-xgs', { method:'DELETE' });
  let watchlist = await request('/api/watchlist');
  if (watchlist.count !== 0) throw new Error('Watchlist mutation before import failed');
  const imported = await request('/api/data/import', { method:'POST', body: JSON.stringify(snapshot) });
  if (imported.watchCount !== 1) throw new Error('Import did not restore watched products');
  watchlist = await request('/api/watchlist');
  if (!watchlist.products.some((p) => p.slug === 'u7-pro-xgs')) throw new Error('Imported watchlist missing target');

  // Manual backups are visible through data info.
  await request('/api/data/backup', { method:'POST' });
  const info = await request('/api/data/info');
  if (info.engine !== 'SQLite' || info.schemaVersion !== 3 || info.backup.count < 2) throw new Error('Backup/data-info foundation failed');

  await stopServer();

  // Prove data survives a full application/server restart.
  startServer();
  await waitForServer();
  watchlist = await request('/api/watchlist');
  if (!watchlist.products.some((p) => p.slug === 'u7-pro-xgs')) throw new Error('Watchlist did not survive restart');
  const persistedPrefs = await request('/api/notifications/preferences');
  if (!persistedPrefs.preferences.soldOut || !persistedPrefs.preferences.newProduct) throw new Error('Notification preferences did not survive restart');
  const beforeUpgrade = (await request('/api/data/info')).backup.count;
  await stopServer();

  // Simulate installing a newer app over the same external database. Startup
  // must create a safety backup before applying version migrations.
  const db = new DatabaseSync(join(dataDir, 'gearbeacon.mock.sqlite3'));
  db.prepare("INSERT INTO meta(key,value) VALUES('last_app_version','1.3.0') ON CONFLICT(key) DO UPDATE SET value='1.3.0'").run();
  db.close();

  startServer();
  await waitForServer();
  const afterUpgradeInfo = await request('/api/data/info');
  if (afterUpgradeInfo.backup.count <= beforeUpgrade) throw new Error('Automatic pre-update safety backup was not created');
  watchlist = await request('/api/watchlist');
  if (!watchlist.products.some((p) => p.slug === 'u7-pro-xgs')) throw new Error('Watchlist was lost during simulated upgrade');

  const updates = await request('/api/update/check');
  if (updates.currentVersion !== '1.4.0' || updates.latestVersion !== '1.4.0' || updates.updateAvailable) throw new Error('Update check endpoint failed');

  console.log('\nSELF-TEST PASSED: SQLite + migrations + persistent watchlist + notification preferences + health checks + backups + export/import + update checks all work.');
} finally {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
}
