import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-v15-test-'));
let child = null;
let base = '';
let smtpMessages = 0;
const smtpServer = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  socket.write('220 GearBeacon test SMTP\r\n');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, '');
      buffer = buffer.slice(index + 1);
      if (inData) {
        if (line === '.') { inData = false; smtpMessages += 1; socket.write('250 queued\r\n'); }
      } else if (/^EHLO /i.test(line)) socket.write('250-test.local\r\n250 8BITMIME\r\n');
      else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n');
      else if (line === 'DATA') { inData = true; socket.write('354 send message\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 unsupported\r\n');
    }
  });
});
await new Promise((resolve, reject) => { smtpServer.listen(0, '127.0.0.1', resolve); smtpServer.once('error', reject); });
const smtpPort = smtpServer.address().port;

function startServer(port, dataDir, extraEnv = {}) {
  base = `http://127.0.0.1:${port}`;
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
      GEARBEACON_BACKUP_INTERVAL_HOURS: '0',
      GEARBEACON_ACCESS_MODE: 'local',
      GEARBEACON_BIND_HOST: '127.0.0.1',
      REGIONS: 'us,ca',
      SMTP_HOST: '', SMTP_FROM: '', SMTP_TO: '', SMTP_USER: '', SMTP_PASSWORD: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill('SIGINT');
  await Promise.race([new Promise((resolve) => current.once('exit', resolve)), delay(2500)]);
}

async function fetchJson(path, options = {}, expected = 200) {
  const response = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== expected) throw new Error(`${path}: expected HTTP ${expected}, got ${response.status}: ${body.error || 'unknown error'}`);
  return { response, body };
}

async function request(path, options = {}) {
  return (await fetchJson(path, options, 200)).body;
}

async function waitFor(path = '/api/status') {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await fetchJson(path, {}, 200);
      if (path !== '/api/status' || result.body.lastSuccessAt) return result.body;
    } catch {}
    await delay(100);
  }
  throw new Error(`GearBeacon test server did not become ready at ${path}`);
}

async function proveUnsafeBindRefusal(dataDir) {
  const rejected = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOCK_MODE: '1', PORT: '8896', GEARBEACON_DATA_DIR: dataDir,
      GEARBEACON_SKIP_LEGACY_IMPORT: '1', GEARBEACON_ACCESS_MODE: 'local',
      GEARBEACON_BIND_HOST: '0.0.0.0', GEARBEACON_BACKUP_INTERVAL_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  rejected.stdout.on('data', (data) => { output += data; });
  rejected.stderr.on('data', (data) => { output += data; });
  const exitCode = await Promise.race([
    new Promise((resolve) => rejected.once('exit', resolve)),
    delay(5000).then(() => { rejected.kill('SIGKILL'); return null; }),
  ]);
  if (exitCode === 0 || !/Refusing to expose an unauthenticated local-mode server/i.test(output)) {
    throw new Error('Local mode did not refuse a non-loopback bind.');
  }
}

const localData = join(testRoot, 'local');
const privateData = join(testRoot, 'private');
const refusalData = join(testRoot, 'refusal');
await Promise.all([mkdir(localData), mkdir(privateData), mkdir(refusalData)]);

try {
  await proveUnsafeBindRefusal(refusalData);

  // Local mode: loopback-only, web-only, multi-region, persistence and backups.
  startServer(8899, localData, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort),
    SMTP_FROM: 'GearBeacon <gearbeacon@test.local>', SMTP_TO: 'owner@test.local',
  });
  const status = await waitFor('/api/status?region=us');
  if (status.version !== '1.5.0') throw new Error(`Unexpected app version: ${status.version}`);
  if (status.storage?.engine !== 'SQLite' || status.storage?.schemaVersion !== 4) throw new Error('SQLite schema v4 was not initialized.');
  if (status.deployment?.mode !== 'local' || status.deployment?.bindHost !== '127.0.0.1' || status.deployment?.authenticationRequired) throw new Error('Safe local access defaults are wrong.');
  if (status.privacy?.telemetry !== false || status.privacy?.publicCloudRequired !== false) throw new Error('Privacy status is wrong.');
  if (status.regions?.length !== 2) throw new Error('Multi-region configuration was not loaded.');
  const dashboard = await fetch(base + '/');
  const dashboardHtml = await dashboard.text();
  if (dashboard.status !== 200 || !dashboard.headers.get('content-security-policy') || dashboard.headers.get('x-frame-options') !== 'DENY') throw new Error('Dashboard security headers are missing.');
  if (!dashboardHtml.includes('GearBeacon owner access') || /<script>(?!\s*<\/script>)/i.test(dashboardHtml)) throw new Error('Dashboard authentication gate or CSP-safe markup is missing.');

  const schemaDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'));
  const pushTable = schemaDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_tokens'").get();
  schemaDb.close();
  if (pushTable) throw new Error('The obsolete push-token table still exists in schema v4.');

  const products = await request('/api/products?region=us');
  if (products.count < 5 || !products.products.some((product) => product.slug === 'u7-pro-xgs')) throw new Error('Mock catalog did not load.');
  await request('/api/watch?region=us', { method: 'POST', body: JSON.stringify({ slug: 'u7-pro-xgs' }) });
  const caBefore = await request('/api/watchlist?region=ca');
  if (caBefore.count !== 0) throw new Error('Regional watchlists are not isolated.');
  await request('/api/watch?region=ca', { method: 'POST', body: JSON.stringify({ slug: 'unas-pro' }) });

  await request('/api/mock/toggle/u7-pro-xgs?region=us', { method: 'POST' });
  await request('/api/check?region=us', { method: 'POST' });
  const events = await request('/api/events?limit=20&region=us');
  if (!events.events.some((event) => event.slug === 'u7-pro-xgs' && event.type === 'restock' && event.watchedAtDetection)) throw new Error('Watched restock event was not generated.');

  const preferences = await request('/api/notifications/preferences?region=us', {
    method: 'PUT',
    body: JSON.stringify({ preferences: { restock: true, soldOut: true, priceChange: true, statusChange: false, newProduct: true } }),
  });
  if (!preferences.preferences.soldOut || !preferences.preferences.newProduct) throw new Error('Notification preferences did not save.');
  const notificationTest = await request('/api/notifications/test?region=us', { method: 'POST' });
  if (!notificationTest.outcomes.some((outcome) => outcome.channel === 'email' && outcome.ok) || smtpMessages < 2) throw new Error('SMTP notification delivery failed.');

  const encryptedExport = await request('/api/data/export/encrypted?region=us', {
    method: 'POST', body: JSON.stringify({ passphrase: 'v15 test export passphrase' }),
  });
  if (encryptedExport.format !== 'GearBeaconEncryptedBackup' || encryptedExport.encryption !== 'AES-256-GCM') throw new Error('Encrypted export failed.');
  const preview = await request('/api/data/preview?region=us', {
    method: 'POST', body: JSON.stringify({ backup: encryptedExport, passphrase: 'v15 test export passphrase' }),
  });
  if (preview.willImport.length !== 2) throw new Error('Encrypted backup preview did not include configured regions.');
  await request('/api/watch/u7-pro-xgs?region=us', { method: 'DELETE' });
  const imported = await request('/api/data/import?region=us', {
    method: 'POST', body: JSON.stringify({ backup: encryptedExport, passphrase: 'v15 test export passphrase' }),
  });
  if (imported.watchCount !== 2 || imported.importedRegions.length !== 2) throw new Error('Encrypted multi-region restore failed.');

  const backup = await request('/api/data/backup?region=us', { method: 'POST' });
  if (!backup.backup?.validated) throw new Error('Validated SQLite backup failed.');
  const info = await request('/api/data/info?region=us');
  if (!info.integrity?.ok || info.backup.count < 2 || info.backup.retention !== 10) throw new Error('Backup or database integrity reporting failed.');

  await stopServer();
  startServer(8899, localData);
  await waitFor('/api/status?region=us');
  const usPersisted = await request('/api/watchlist?region=us');
  const caPersisted = await request('/api/watchlist?region=ca');
  if (!usPersisted.products.some((product) => product.slug === 'u7-pro-xgs') || !caPersisted.products.some((product) => product.slug === 'unas-pro')) throw new Error('Multi-region watchlists did not survive restart.');
  const persistedPreferences = await request('/api/notifications/preferences?region=us');
  if (!persistedPreferences.preferences.soldOut || !persistedPreferences.preferences.newProduct) throw new Error('Notification preferences did not survive restart.');
  const beforeUpgrade = (await request('/api/data/info?region=us')).backup.count;
  await stopServer();

  const upgradeDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'));
  upgradeDb.exec(`
    DELETE FROM schema_migrations WHERE version=4;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS owner_credentials;
    CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  `);
  upgradeDb.prepare("INSERT INTO meta(key,value) VALUES('last_app_version','1.4.0') ON CONFLICT(key) DO UPDATE SET value='1.4.0'").run();
  upgradeDb.close();
  startServer(8899, localData);
  await waitFor('/api/status?region=us');
  const afterUpgrade = await request('/api/data/info?region=us');
  if (afterUpgrade.backup.count <= beforeUpgrade || afterUpgrade.schemaVersion !== 4) throw new Error('Automatic pre-update backup or schema migration failed.');
  const migratedDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'));
  const migratedPushTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_tokens'").get();
  migratedDb.close();
  if (migratedPushTable) throw new Error('Schema v3 to v4 migration did not remove obsolete push storage.');
  const updates = await request('/api/update/check?region=us');
  if (updates.currentVersion !== '1.5.0' || updates.latestVersion !== '1.5.0' || updates.updateAvailable) throw new Error('Bundled update check failed.');
  await stopServer();

  // Private mode: setup, password/session hashing, authentication, CSRF and origin policy.
  startServer(8898, privateData, {
    REGIONS: 'us', GEARBEACON_ACCESS_MODE: 'private', GEARBEACON_SETUP_TOKEN: 'v15-one-time-setup-token',
  });
  await waitFor('/healthz');
  await fetchJson('/api/status', {}, 428);
  const setup = await fetchJson('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ setupToken: 'v15-one-time-setup-token', password: 'v15 private owner password' }),
  }, 201);
  let cookie = setup.response.headers.get('set-cookie')?.split(';')[0];
  let csrf = setup.body.csrfToken;
  if (!cookie || !csrf) throw new Error('Private setup did not create a session.');
  await fetchJson('/api/watch', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ slug: 'u7-pro-xgs' }) }, 403);
  await fetchJson('/api/status', { headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } }, 403);
  const protectedStatus = await fetchJson('/api/status', { headers: { Cookie: cookie } }, 200);
  if (!protectedStatus.body.deployment.authenticationRequired) throw new Error('Private API did not report required authentication.');
  await fetchJson('/api/watch', {
    method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ slug: 'u7-pro-xgs' }),
  }, 200);
  const secondLogin = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v15 private owner password' }) }, 200);
  const secondCookie = secondLogin.response.headers.get('set-cookie')?.split(';')[0];
  const sessions = await fetchJson('/api/auth/sessions', { headers: { Cookie: cookie } }, 200);
  const otherSession = sessions.body.sessions.find((session) => !session.current);
  if (sessions.body.sessions.length !== 2 || !otherSession || !secondCookie) throw new Error('Owner session listing failed.');
  await fetchJson(`/api/auth/sessions/${otherSession.id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } }, 200);
  await fetchJson('/api/status', { headers: { Cookie: secondCookie } }, 401);

  const rotated = await fetchJson('/api/auth/password', {
    method: 'PUT', headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ currentPassword: 'v15 private owner password', newPassword: 'v15 rotated private owner password' }),
  }, 200);
  const rotatedCookie = rotated.response.headers.get('set-cookie')?.split(';')[0];
  if (!rotatedCookie || !rotated.body.csrfToken) throw new Error('Owner password rotation did not create a replacement session.');
  await fetchJson('/api/status', { headers: { Cookie: cookie } }, 401);
  cookie = rotatedCookie;
  csrf = rotated.body.csrfToken;

  const authDb = new DatabaseSync(join(privateData, 'gearbeacon.mock.sqlite3'));
  const credential = authDb.prepare('SELECT password_hash FROM owner_credentials WHERE id=1').get();
  const storedSession = authDb.prepare('SELECT token_hash,csrf_token FROM sessions').get();
  authDb.close();
  if (!credential?.password_hash.startsWith('scrypt-v1$') || credential.password_hash.includes('v15 rotated private owner password')) throw new Error('Owner password was not safely hashed.');
  if (!/^[a-f0-9]{64}$/.test(storedSession?.token_hash || '') || storedSession.token_hash.includes(cookie)) throw new Error('Session token was not hashed in SQLite.');

  await fetchJson('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } }, 200);
  await fetchJson('/api/status', { headers: { Cookie: cookie } }, 401);
  await stopServer();

  startServer(8898, privateData, { REGIONS: 'us', GEARBEACON_ACCESS_MODE: 'private' });
  await waitFor('/healthz');
  const authState = await request('/api/auth/status');
  if (authState.setupRequired) throw new Error('Completed owner setup did not survive restart.');
  await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v15 private owner password' }) }, 401);
  const login = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v15 rotated private owner password' }) }, 200);
  if (!login.response.headers.get('set-cookie') || !login.body.csrfToken) throw new Error('Owner login failed after restart.');

  console.log('\nSELF-TEST PASSED: V1.5 safe binds + private owner auth + CSRF/origin defenses + hashed sessions + web-only schema + multi-region monitoring + SQLite integrity/backups + encrypted restore + persistence + updates all work.');
} finally {
  await stopServer();
  await new Promise((resolve) => smtpServer.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
}
