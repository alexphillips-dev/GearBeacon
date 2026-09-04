import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-v19-test-'));
let child = null;
let base = '';
let smtpMessages = 0;
const smtpBodies = [];
const notificationRequests = { ntfy: 0, discord: 0, gotify: 0, webhook: 0, webhookSigned: false };
const webhookHmacSecret = 'v19-test-hmac-signing-secret';
const notificationServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url.startsWith('/ntfy/')) notificationRequests.ntfy += 1;
    else if (req.url.startsWith('/discord')) notificationRequests.discord += 1;
    else if (req.url.startsWith('/gotify/message')) notificationRequests.gotify += 1;
    else if (req.url.startsWith('/webhook')) {
      notificationRequests.webhook += 1;
      const timestamp = req.headers['x-gearbeacon-timestamp'];
      const expected = `sha256=${crypto.createHmac('sha256', webhookHmacSecret).update(`${timestamp}.${body}`).digest('hex')}`;
      notificationRequests.webhookSigned = Boolean(timestamp && crypto.timingSafeEqual(Buffer.from(String(req.headers['x-gearbeacon-signature'] || '')), Buffer.from(expected)));
    }
    const simulateRestockFailure = req.url.startsWith('/webhook') && /\"type\":\"restock\"/.test(body);
    res.writeHead(simulateRestockFailure ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve, reject) => { notificationServer.listen(0, '127.0.0.1', resolve); notificationServer.once('error', reject); });
const notificationPort = notificationServer.address().port;
const notificationBase = `http://127.0.0.1:${notificationPort}`;
const smtpServer = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let dataLines = [];
  socket.write('220 GearBeacon test SMTP\r\n');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, '');
      buffer = buffer.slice(index + 1);
      if (inData) {
        if (line === '.') { inData = false; smtpMessages += 1; smtpBodies.push(dataLines.join('\r\n')); dataLines = []; socket.write('250 queued\r\n'); }
        else dataLines.push(line.startsWith('..') ? line.slice(1) : line);
      } else if (/^EHLO /i.test(line)) socket.write('250-test.local\r\n250 8BITMIME\r\n');
      else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n');
      else if (line === 'DATA') { inData = true; dataLines = []; socket.write('354 send message\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 unsupported\r\n');
    }
  });
});
await new Promise((resolve, reject) => { smtpServer.listen(0, '127.0.0.1', resolve); smtpServer.once('error', reject); });
const smtpPort = smtpServer.address().port;
const require = createRequire(import.meta.url);
const { renderEmail, validInlineImageUrl } = require('../backend/dist/email.js');

function decodedMimePart(raw, type) {
  const escaped = type.replace('/', '\\/');
  const match = raw.match(new RegExp(`Content-Type: ${escaped}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`));
  return match ? Buffer.from(match[1].replace(/\s/g, ''), 'base64').toString('utf8') : '';
}

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
      SMTP_HOST: '', SMTP_FROM: '', SMTP_TO: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_STARTTLS: '0',
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

function downgradeDatabaseForUpgradeTest(databaseFile, appVersion, schema) {
  const target = new DatabaseSync(databaseFile);
  target.exec(`
    DELETE FROM schema_migrations WHERE version>${schema};
    DROP TABLE IF EXISTS pending_transitions; DROP TABLE IF EXISTS monitor_checks;
    ALTER TABLE events RENAME TO events_v7;
    CREATE TABLE events (id TEXT PRIMARY KEY,region TEXT NOT NULL,detected_at TEXT NOT NULL,data_json TEXT NOT NULL);
    INSERT INTO events(id,region,detected_at,data_json) SELECT id,region,detected_at,data_json FROM events_v7;
    DROP TABLE events_v7;
    CREATE INDEX idx_events_region_detected ON events(region,detected_at);
  `);
  if (schema < 6) target.exec('DROP TABLE IF EXISTS product_observations; DROP TABLE IF EXISTS watch_rules; DROP TABLE IF EXISTS notification_cooldowns;');
  if (schema < 5) target.exec('DROP TABLE IF EXISTS notification_queue; DROP TABLE IF EXISTS app_log; DROP TABLE IF EXISTS backup_log;');
  target.prepare("INSERT INTO meta(key,value) VALUES('last_app_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(appVersion);
  target.close();
}

const localData = join(testRoot, 'local');
const privateData = join(testRoot, 'private');
const refusalData = join(testRoot, 'refusal');
const proxyData = join(testRoot, 'proxy');
const secondaryData = join(testRoot, 'secondary-recovery');
await Promise.all([mkdir(localData), mkdir(privateData), mkdir(refusalData), mkdir(proxyData), mkdir(secondaryData)]);

try {
  await proveUnsafeBindRefusal(refusalData);

  // Local mode: loopback-only, web-only, multi-region, persistence and backups.
  startServer(8899, localData, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort),
    SMTP_FROM: 'GearBeacon <gearbeacon@test.local>', SMTP_TO: 'owner@test.local',
    NTFY_BASE_URL: `${notificationBase}/ntfy`, NTFY_TOPIC: 'gearbeacon-test',
    DISCORD_WEBHOOK_URL: `${notificationBase}/discord`,
    GOTIFY_BASE_URL: `${notificationBase}/gotify`, GOTIFY_TOKEN: 'test-gotify-token',
    GEARBEACON_WEBHOOK_URL: `${notificationBase}/webhook`, GEARBEACON_WEBHOOK_TOKEN: 'test-bearer',
    GEARBEACON_WEBHOOK_HMAC_SECRET: webhookHmacSecret,
  });
  const status = await waitFor('/api/status?region=us');
  if (status.version !== '1.9.0') throw new Error(`Unexpected app version: ${status.version}`);
  if (status.storage?.engine !== 'SQLite' || status.storage?.schemaVersion !== 7) throw new Error('SQLite schema v7 was not initialized.');
  if (status.deployment?.mode !== 'local' || status.deployment?.bindHost !== '127.0.0.1' || status.deployment?.authenticationRequired) throw new Error('Safe local access defaults are wrong.');
  if (status.privacy?.telemetry !== false || status.privacy?.publicCloudRequired !== false) throw new Error('Privacy status is wrong.');
  if (status.regions?.length !== 2) throw new Error('Multi-region configuration was not loaded.');
  const dashboard = await fetch(base + '/');
  const dashboardHtml = await dashboard.text();
  if (dashboard.status !== 200 || !dashboard.headers.get('content-security-policy') || dashboard.headers.get('x-frame-options') !== 'DENY') throw new Error('Dashboard security headers are missing.');
  if (!dashboardHtml.includes('GearBeacon owner access') || /<script>(?!\s*<\/script>)/i.test(dashboardHtml)) throw new Error('Dashboard authentication gate or CSP-safe markup is missing.');
  const unexpectedFailure = await fetchJson('/api/products/%', {}, 500);
  if (!/check Operations logs/i.test(unexpectedFailure.body.error || '') || /URIError|decodeURIComponent|backend[\\/]src|\bat\b/i.test(unexpectedFailure.body.error || '')) throw new Error('Unexpected HTTP errors expose internal exception details.');

  const schemaDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'));
  const pushTable = schemaDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_tokens'").get();
  schemaDb.close();
  if (pushTable) throw new Error('The obsolete push-token table still exists in schema v7.');

  const initialConfig = await request('/api/config');
  if ((await request('/api/auth/status')).onboardingComplete) throw new Error('Fresh installation incorrectly skipped guided onboarding.');
  await fetchJson('/api/config/validate', { method:'POST', body:JSON.stringify({ ...initialConfig.config, accessMode:'proxy', publicBaseUrl:'http://unsafe.test' }) }, 400);
  const configSave = await request('/api/config', { method:'PUT', body:JSON.stringify({
    config: { ...initialConfig.config, notificationGroupSeconds: 1, notificationMaxAttempts: 3 },
    secrets: { webhookHmacSecret, discordWebhookUrl: `${notificationBase}/discord`, webhookUrl: `${notificationBase}/webhook`, webhookToken: 'test-bearer', gotifyToken: 'test-gotify-token' },
  }) });
  if (configSave.config.notificationMaxAttempts !== 3 || !configSave.secretsConfigured.webhookHmacSecret) throw new Error('Browser-managed configuration did not save.');
  const publicConfigText = JSON.stringify(await request('/api/config'));
  if (publicConfigText.includes(webhookHmacSecret) || publicConfigText.includes('test-bearer')) throw new Error('Configuration API exposed notification credentials.');
  const secretDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'), { readOnly:true });
  const encryptedSecrets = secretDb.prepare("SELECT value FROM settings WHERE key='encrypted_notification_secrets'").get()?.value || '';
  secretDb.close();
  if (!encryptedSecrets.startsWith('v1:') || encryptedSecrets.includes(webhookHmacSecret) || encryptedSecrets.includes('test-bearer')) throw new Error('Notification credentials were not encrypted in SQLite.');
  const keyStat = await lstat(join(localData, 'secrets.key'));
  const keyBytes = Buffer.from((await readFile(join(localData, 'secrets.key'), 'utf8')).trim(), 'base64');
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyBytes.length !== 32) throw new Error('Separate local notification key file is invalid.');
  const onboarding = await request('/api/onboarding/complete', { method:'POST' });
  if (!onboarding.ok || !(await request('/api/auth/status')).onboardingComplete) throw new Error('Guided onboarding state did not persist.');

  const products = await request('/api/products?region=us');
  if (products.count < 5 || !products.products.some((product) => product.slug === 'u7-pro-xgs')) throw new Error('Mock catalog did not load.');
  await request('/api/watch?region=us', { method: 'POST', body: JSON.stringify({ slug: 'u7-pro-xgs' }) });
  await request('/api/watch?region=us', { method: 'POST', body: JSON.stringify({ slug: 'uvc-ai-turret' }) });
  const initialDetails = await request('/api/products/u7-pro-xgs?region=us');
  if (initialDetails.product?.slug !== 'u7-pro-xgs' || !initialDetails.product.watched || !initialDetails.firstObservedAt || initialDetails.history?.length < 1) throw new Error('Product details or baseline history is incomplete.');
  const watchedAtBeforeRestart = initialDetails.product.watchedAt;
  const initialRules = await request('/api/watch/u7-pro-xgs/rules?region=us');
  if (!initialRules.rule?.enabled || initialRules.rule.restock !== null || !initialRules.globalPreferences) throw new Error('Default per-product rules are incomplete.');
  const jsonImportPreview = await request('/api/watch/import/preview?region=us', {
    method:'POST',
    body:JSON.stringify({
      fileName:'watchlist.json',
      content:JSON.stringify({ products:[{ url:'https://store.ui.com/us/en/category/all-cloud-gateways/products/udm-se' }, { sku:'U7-Pro-XGS-B-US' }] }),
    }),
  });
  if (jsonImportPreview.summary.addable !== 1 || jsonImportPreview.summary.alreadyWatched !== 1 || !jsonImportPreview.items.some((item) => item.slug === 'u7-pro-xgs')) throw new Error(`JSON watchlist import matching failed: ${JSON.stringify(jsonImportPreview)}`);
  const csvImportPreview = await request('/api/watch/import/preview?region=us', {
    method:'POST',
    body:JSON.stringify({
      fileName:'watchlist.csv',
      content:'product_url,sku\n"https://store.ui.com/us/en/category/all-cloud-gateways/products/udm-se",\n,u7-pro-xgs\n"https://store.ui.com/us/en/category/all-cloud-gateways/products/udm-se",\n"https://store.ui.com/ca/en/category/network-storage/products/unas-pro",\n,retired-product',
    }),
  });
  if (csvImportPreview.region !== 'us' || csvImportPreview.summary.addable !== 1 || csvImportPreview.summary.alreadyWatched !== 1 || csvImportPreview.summary.duplicates !== 1 || csvImportPreview.summary.regionMismatch !== 1 || csvImportPreview.summary.unrecognized !== 1) throw new Error(`CSV watchlist import preview failed: ${JSON.stringify(csvImportPreview)}`);
  const importedWatch = await request('/api/watch/import?region=us', { method:'POST', body:JSON.stringify({ slugs:['udm-se', 'u7-pro-xgs', 'retired-product', '__proto__'] }) });
  if (importedWatch.added !== 1 || !importedWatch.alreadyWatched.includes('u7-pro-xgs') || !importedWatch.notFound.includes('retired-product') || !importedWatch.notFound.includes('__proto__') || !importedWatch.products.some((product) => product.slug === 'udm-se' && product.watched)) throw new Error('Confirmed watchlist import did not add only valid new products.');
  const rulesAfterImport = await request('/api/watch/u7-pro-xgs/rules?region=us');
  if (JSON.stringify(rulesAfterImport.rule) !== JSON.stringify(initialRules.rule)) throw new Error('Watchlist import changed an existing product alert rule.');
  await request('/api/watch/udm-se?region=us', { method:'DELETE' });
  if ((await request('/api/watchlist?region=us')).count !== 2) throw new Error('Watchlist import test cleanup failed.');
  const paused = await request('/api/watch/bulk?region=us', { method:'POST', body:JSON.stringify({ action:'pause', slugs:['u7-pro-xgs', 'uvc-ai-turret'], minutes:60 }) });
  if (paused.affected !== 2 || !paused.pausedUntil || !paused.products.every((product) => product.watchRule?.pausedUntil)) throw new Error('Bulk watchlist pause failed.');
  const resumed = await request('/api/watch/bulk?region=us', { method:'POST', body:JSON.stringify({ action:'resume', slugs:['u7-pro-xgs', 'uvc-ai-turret'] }) });
  if (resumed.affected !== 2 || resumed.products.some((product) => product.watchRule?.pausedUntil)) throw new Error('Bulk watchlist resume failed.');
  const caBefore = await request('/api/watchlist?region=ca');
  if (caBefore.count !== 0) throw new Error('Regional watchlists are not isolated.');
  await request('/api/watch?region=ca', { method: 'POST', body: JSON.stringify({ slug: 'unas-pro' }) });

  await request('/api/mock/toggle/u7-pro-xgs?region=us', { method: 'POST' });
  await request('/api/mock/toggle/uvc-ai-turret?region=us', { method: 'POST' });
  await request('/api/check?region=us', { method: 'POST' });
  const events = await request('/api/events?limit=20&region=us');
  const restockEvent = events.events.find((event) => event.slug === 'u7-pro-xgs' && event.type === 'restock' && event.watchedAtDetection);
  if (!restockEvent) throw new Error('Watched restock event was not generated.');
  if (!restockEvent.imageUrl || restockEvent.alertKind !== 'restock' || !restockEvent.triggerReason || !restockEvent.notificationTimeZone || restockEvent.priceValue === undefined || !Object.hasOwn(restockEvent, 'priceDifferencePercent')) throw new Error('Queued alert snapshot is missing immutable email details.');
  if (!restockEvent.previousStateSince || !Number.isFinite(restockEvent.previousStateDurationSeconds) || restockEvent.previousStateDurationSeconds < 0) throw new Error('Activity event is missing its previous-state duration.');
  if (!restockEvent.serverAlert?.state || !restockEvent.serverAlert?.label || !restockEvent.serverAlert?.detail || !restockEvent.serverAlert.channels?.length || ['muted', 'no-channel'].includes(restockEvent.serverAlert.state)) throw new Error(`Activity event is missing its server-alert outcome: ${JSON.stringify(restockEvent.serverAlert)}`);
  if (restockEvent.confirmation?.policy !== 'restock-fast-path' || restockEvent.confirmation?.required !== 1) throw new Error('Restocks are not using the immediate valid-catalog confirmation policy.');

  // Price, negative availability, and catalog disappearance require two
  // consecutive valid observations while last-known-good state remains visible.
  await request('/api/mock/product/unas-pro?region=us', { method:'POST', body:JSON.stringify({ price:'$449.00', status:'Available' }) });
  await request('/api/check?region=us', { method:'POST' });
  let pendingProduct = (await request('/api/products?region=us')).products.find((product) => product.slug === 'unas-pro');
  let confidence = (await request('/api/operations')).monitoringConfidence;
  if (pendingProduct.price !== '$499.00' || !confidence.pending.some((item) => item.slug === 'unas-pro' && item.kind === 'price' && item.observations === 1)) throw new Error('A one-off price change replaced last-known-good data or was not recorded as pending.');
  await request('/api/check?region=us', { method:'POST' });
  const confirmedPrice = (await request('/api/events?limit=50&region=us')).events.find((event) => event.slug === 'unas-pro' && event.type === 'price_change');
  pendingProduct = (await request('/api/products?region=us')).products.find((product) => product.slug === 'unas-pro');
  if (pendingProduct.price !== '$449.00' || confirmedPrice?.confirmation?.observations !== 2 || confirmedPrice?.confirmation?.policy !== 'consecutive-valid-observations') throw new Error('Consecutive price confirmation did not create an evidenced event.');

  await request('/api/mock/product/usw-pro-max-24-poe?region=us', { method:'POST', body:JSON.stringify({ status:'SoldOut' }) });
  await request('/api/check?region=us', { method:'POST' });
  const pendingSoldOut = (await request('/api/products?region=us')).products.find((product) => product.slug === 'usw-pro-max-24-poe');
  if (!pendingSoldOut.inStock) throw new Error('A single sold-out observation replaced last-known-good availability.');
  await request('/api/check?region=us', { method:'POST' });
  const confirmedSoldOut = (await request('/api/events?limit=80&region=us')).events.find((event) => event.slug === 'usw-pro-max-24-poe' && event.type === 'sold_out');
  if (!confirmedSoldOut || confirmedSoldOut.confirmation?.observations !== 2 || (await request('/api/products?region=us')).products.find((product) => product.slug === 'usw-pro-max-24-poe').inStock) throw new Error('Sold-out confirmation did not require and record two observations.');
  await request('/api/mock/product/usw-pro-max-24-poe?region=us', { method:'POST', body:JSON.stringify({ status:'Available' }) });
  await request('/api/check?region=us', { method:'POST' });
  const recoveredStock = (await request('/api/events?limit=80&region=us')).events.find((event) => event.slug === 'usw-pro-max-24-poe' && event.type === 'restock');
  if (recoveredStock?.confirmation?.policy !== 'restock-fast-path') throw new Error('A confirmed product did not return through the restock fast path.');

  await request('/api/mock/product/udm-se?region=us', { method:'POST', body:JSON.stringify({ present:false, status:'Available' }) });
  await request('/api/check?region=us', { method:'POST' });
  if ((await request('/api/products?region=us')).products.find((product) => product.slug === 'udm-se').unlisted) throw new Error('One missing catalog observation marked a product unlisted.');
  await request('/api/check?region=us', { method:'POST' });
  const unlistedProduct = (await request('/api/products?region=us')).products.find((product) => product.slug === 'udm-se');
  if (!unlistedProduct.unlisted || unlistedProduct.status !== 'Unlisted') throw new Error('Two complete catalogs did not classify a missing product as unlisted.');
  await request('/api/mock/product/udm-se?region=us', { method:'POST', body:JSON.stringify({ present:true, status:'Available' }) });
  await request('/api/check?region=us', { method:'POST' });
  if ((await request('/api/products?region=us')).products.find((product) => product.slug === 'udm-se').unlisted) throw new Error('A reappearing product remained unlisted.');

  const activity = await request('/api/activity?scope=all&type=price_change&search=unas&page=1&limit=10');
  if (activity.count < 1 || activity.events[0]?.slug !== 'unas-pro' || activity.pages !== 1) throw new Error(`Searchable activity API failed: ${JSON.stringify(activity)}`);
  const activityDetail = await request(`/api/activity/${encodeURIComponent(confirmedPrice.id)}`);
  if (activityDetail.event?.confirmation?.observations !== 2 || !activityDetail.event?.serverAlert?.state) throw new Error('Activity detail did not include confirmation and delivery evidence.');
  const activityCsv = await fetch(`${base}/api/activity/export?scope=all&type=price_change&format=csv`);
  const activityCsvText = await activityCsv.text();
  if (!activityCsv.ok || !/text\/csv/i.test(activityCsv.headers.get('content-type') || '') || !/confirmationPolicy/.test(activityCsvText) || !/unas-pro/.test(activityCsvText)) throw new Error('Filtered CSV activity export failed.');
  const activityJson = await fetch(`${base}/api/activity/export?scope=all&format=json`);
  const activityJsonBody = await activityJson.json();
  if (!activityJson.ok || !Array.isArray(activityJsonBody.events) || activityJsonBody.events.length < 5) throw new Error('JSON activity export failed.');
  const normalizedPaging = await request('/api/activity?scope=all&page=not-a-number&limit=not-a-number');
  if (normalizedPaging.page !== 1 || normalizedPaging.limit !== 50) throw new Error('Activity pagination did not safely normalize invalid numeric input.');
  await fetchJson('/api/activity?scope=invalid', {}, 400);

  const preferences = await request('/api/notifications/preferences?region=us', {
    method: 'PUT',
    body: JSON.stringify({ preferences: { restock: true, soldOut: true, priceChange: true, statusChange: false, newProduct: true } }),
  });
  if (!preferences.preferences.soldOut || !preferences.preferences.newProduct) throw new Error('Notification preferences did not save.');
  const notificationTest = await request('/api/notifications/test?region=us', { method: 'POST' });
  if (!notificationTest.outcomes.every((outcome) => outcome.ok) || smtpMessages < 1) throw new Error('One or more notification mock deliveries failed.');
  const testMime = smtpBodies.at(-1) || '';
  const testHtml = decodedMimePart(testMime, 'text/html');
  const testText = decodedMimePart(testMime, 'text/plain');
  if (!/multipart\/related/i.test(testMime) || !/multipart\/alternative/i.test(testMime) || !/Message-ID: <[^>]+>/i.test(testMime) || !/Content-ID: <gearbeacon-logo>/i.test(testMime)) throw new Error('SMTP email is missing MIME alternatives, inline branding, or Message-ID.');
  if (!/Email is working/i.test(testHtml) || !/Why you received this/i.test(testHtml) || !/Email is working/i.test(testText) || /<script/i.test(testHtml)) throw new Error('SMTP HTML/plain-text test content is incomplete or unsafe.');
  const individualTest = await request('/api/notifications/test?region=us', { method:'POST', body:JSON.stringify({ channel:'webhook' }) });
  if (individualTest.outcomes.length !== 1 || individualTest.outcomes[0].channel !== 'webhook' || !individualTest.outcomes[0].ok) throw new Error('Individual notification-channel testing failed.');
  if (!notificationRequests.ntfy || !notificationRequests.discord || !notificationRequests.gotify || !notificationRequests.webhook || !notificationRequests.webhookSigned) throw new Error('Notification HTTP mocks or generic webhook HMAC signing failed.');
  const operations = await request('/api/operations');
  if (!Array.isArray(operations.regions) || operations.regions.length !== 2 || !operations.notifications?.queue || operations.notifications.queue.pending < 1 || !Array.isArray(operations.securityWarnings)) throw new Error('Operations dashboard API or durable delivery queue is incomplete.');
  let retried = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const delivery = await request('/api/notifications/log?limit=50');
    if (delivery.notifications.some((row) => row.channel === 'webhook' && row.status === 'retrying')) { retried = true; break; }
    await delay(200);
  }
  if (!retried) throw new Error('Failed webhook delivery did not enter exponential retry state.');
  let retryingActivity = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    retryingActivity = (await request('/api/events?limit=20&region=us')).events.find((event) => event.id === restockEvent.id);
    if (retryingActivity?.serverAlert?.state === 'retrying') break;
    await delay(100);
  }
  if (retryingActivity?.serverAlert?.state !== 'retrying' || retryingActivity.serverAlert.label !== 'Retrying' || !/another delivery attempt/i.test(retryingActivity.serverAlert.detail || '')) throw new Error(`Activity feed did not reflect the live server retry outcome: ${JSON.stringify(retryingActivity?.serverAlert)}`);
  const groupedDelivery = await request('/api/notifications/log?limit=100');
  if (!groupedDelivery.notifications.some((row) => row.status === 'sent' && /grouped 2/.test(row.detail || ''))) throw new Error('Notification grouping did not combine nearby events.');
  let groupedEmail = null;
  for (let attempt = 0; attempt < 80 && !groupedEmail; attempt += 1) {
    groupedEmail = smtpBodies.map((raw) => ({ raw, html:decodedMimePart(raw, 'text/html'), text:decodedMimePart(raw, 'text/plain') })).find((message) => /U7 Pro XGS/.test(message.html) && /AI Turret/.test(message.html));
    if (!groupedEmail) await delay(200);
  }
  if (!groupedEmail || !/GearBeacon digest/i.test(groupedEmail.text) || (!/Content-ID: <product-/i.test(groupedEmail.raw) && !/IMAGE UNAVAILABLE/i.test(groupedEmail.html))) throw new Error('Grouped email digest, text alternative, or product-image fallback is incomplete.');
  const savedRules = await request('/api/watch/u7-pro-xgs/rules?region=us', {
    method:'PUT', body:JSON.stringify({ rule:{ restock:true, soldOut:false, priceChange:true, statusChange:false, priceDropOnly:true, targetPrice:250, immediateRestock:true } }),
  });
  if (!savedRules.rule.immediateRestock || savedRules.rule.targetPrice !== 250 || savedRules.rule.soldOut !== false || !savedRules.rule.priceDropOnly) throw new Error('Per-product alert rules did not save.');
  const changedDetails = await request('/api/products/u7-pro-xgs?region=us');
  if (changedDetails.history.length < 2 || !changedDetails.lastChangedAt || changedDetails.product.watchRule?.targetPrice !== 250) throw new Error('Change-only product history or saved rules are missing from product details.');
  const schedulingConfig = await request('/api/config');
  await fetchJson('/api/config/validate', { method:'POST', body:JSON.stringify({ ...schedulingConfig.config, secondaryBackupDir:join(localData, 'not-a-separate-recovery-copy') }) }, 400);
  const schedulingSave = await request('/api/config', { method:'PUT', body:JSON.stringify({ config:{
    ...schedulingConfig.config,
    notificationTimeZone:'UTC', quietHoursEnabled:false, quietHoursStart:'22:00', quietHoursEnd:'07:00',
    digestEnabled:false, digestTime:'09:00', notificationCooldownMinutes:7, historyRetentionDays:400, eventRetentionDays:730,
    secondaryBackupDir:secondaryData, secondaryEncryptedExports:true,
    operationalAlerts:{ monitorFailures:true, notificationFailures:true, backupFailures:true, lowDiskSpace:true },
    emailDetailLevel:'detailed', emailTheme:'dark', emailSubjectPrefix:'[GB Test]', emailDigestMaxItems:3,
    emailEmbedImages:true, emailExplainReason:true, emailPriceCalculations:true,
  }, secrets:{ secondaryBackupPassphrase:'v19 secondary recovery passphrase' } }) });
  if (schedulingSave.config.notificationTimeZone !== 'UTC' || schedulingSave.config.notificationCooldownMinutes !== 7 || schedulingSave.config.historyRetentionDays !== 400 || schedulingSave.config.eventRetentionDays !== 730 || schedulingSave.config.secondaryBackupDir !== secondaryData || !schedulingSave.config.secondaryEncryptedExports || !schedulingSave.secretsConfigured.secondaryBackupPassphrase || !schedulingSave.config.operationalAlerts.lowDiskSpace || schedulingSave.config.emailDetailLevel !== 'detailed' || schedulingSave.config.emailDigestMaxItems !== 3 || schedulingSave.config.emailSubjectPrefix !== '[GB Test]') throw new Error('V1.9 delivery, email, recovery, or retention settings did not save.');
  await fetchJson('/api/config/validate', { method:'POST', body:JSON.stringify({ ...schedulingSave.config, emailSubjectPrefix:'[GearBeacon]\r\nBcc: attacker@example.test' }) }, 400);
  const deliveryPreview = await request('/api/notifications/preview?region=us&slug=u7-pro-xgs&eventType=restock');
  if (deliveryPreview.decision?.allowed !== true || deliveryPreview.delivery?.mode !== 'immediate-restock' || deliveryPreview.delivery?.timeZone !== 'UTC' || !deliveryPreview.copy?.title || !/^\[GB Test\]/.test(deliveryPreview.email?.subject || '') || !/Why you received this/i.test(deliveryPreview.email?.text || '')) throw new Error('Notification delivery or email preview did not honor saved settings.');
  for (const type of ['restock','target_price','price_drop','sold_out','status_change','new_product','operational','test','digest']) {
    const response = await fetch(`${base}/api/notifications/email-preview?region=us&slug=u7-pro-xgs&eventType=${type}&theme=light&detailLevel=detailed&digestMaxItems=3`);
    const html = await response.text();
    if (!response.ok || !/<!doctype html>/i.test(html) || !/GearBeacon/i.test(html) || /<script/i.test(html)) throw new Error(`Email preview failed for ${type}.`);
    if (response.headers.get('x-frame-options')) throw new Error('Email preview cannot be framed by its authenticated Settings page.');
    if (!/frame-ancestors 'self'/.test(response.headers.get('content-security-policy') || '')) throw new Error('Email preview CSP is not restricted to the GearBeacon origin.');
    if (type === 'digest' && (!/And 3 more updates not shown/i.test(html) || (html.match(/U7 Pro XGS/g) || []).length !== 2)) throw new Error('Digest preview did not enforce maximum items and product deduplication.');
  }
  if (!validInlineImageUrl('https://images.svc.ui.com/product.png') || validInlineImageUrl('https://images.svc.ui.com.attacker.test/product.png') || validInlineImageUrl('http://images.svc.ui.com/product.png')) throw new Error('Inline email image host/protocol allowlist is unsafe.');
  const escapedEmail = renderEmail({ type:'restock', name:'<script>alert(1)</script>', slug:'unsafe', region:'us', detectedAt:new Date().toISOString(), url:'javascript:alert(1)' }, { subjectPrefix:'[Test]', regions:{ us:{ label:'United States' } }, logoSource:'/assets/icon.png' });
  if (escapedEmail.html.includes('<script>alert(1)</script>') || escapedEmail.html.includes('javascript:') || !escapedEmail.html.includes('&lt;script&gt;')) throw new Error('Email renderer did not escape untrusted content or reject unsafe links.');
  const utcNow = new Date();
  const quietStart = `${String(utcNow.getUTCHours()).padStart(2, '0')}:${String(utcNow.getUTCMinutes()).padStart(2, '0')}`;
  const quietEndDate = new Date(utcNow.getTime() + 5 * 60000);
  const quietEnd = `${String(quietEndDate.getUTCHours()).padStart(2, '0')}:${String(quietEndDate.getUTCMinutes()).padStart(2, '0')}`;
  const quietSave = await request('/api/config', { method:'PUT', body:JSON.stringify({ config:{ ...schedulingSave.config, quietHoursEnabled:true, quietHoursStart:quietStart, quietHoursEnd:quietEnd } }) });
  const quietPreview = await request('/api/notifications/preview?region=us&slug=uvc-ai-turret&eventType=restock');
  if (quietPreview.delivery?.mode !== 'after-quiet-hours' || new Date(quietPreview.delivery.deliverAt).getTime() <= Date.now()) throw new Error('Quiet-hours delivery scheduling failed.');
  const digestSave = await request('/api/config', { method:'PUT', body:JSON.stringify({ config:{ ...quietSave.config, quietHoursEnabled:false, digestEnabled:true, digestTime:'09:00' } }) });
  const digestPreview = await request('/api/notifications/preview?region=us&slug=uvc-ai-turret&eventType=restock');
  if (digestPreview.delivery?.mode !== 'digest' || new Date(digestPreview.delivery.deliverAt).getTime() <= Date.now()) throw new Error('Daily digest scheduling failed.');
  await request('/api/config', { method:'PUT', body:JSON.stringify({ config:{ ...digestSave.config, digestEnabled:false } }) });
  const logs = await request('/api/logs?level=info&search=Store');
  if (!Array.isArray(logs.logs)) throw new Error('Operations log filtering failed.');
  const preparedUpdate = await request('/api/update/prepare', { method:'POST' });
  if (!preparedUpdate.backup?.validated || !/backup-?confirmed/i.test(preparedUpdate.command || '')) throw new Error('Owner-controlled update preparation did not create a validated backup or explicit command.');
  if (!preparedUpdate.backup.secondary?.ok || !preparedUpdate.backup.secondary.encrypted) throw new Error(`Secondary encrypted recovery copy failed: ${JSON.stringify(preparedUpdate.backup.secondary)}`);
  const primaryRestoreTest = await request('/api/data/test-restore', { method:'POST', body:JSON.stringify({ location:'primary' }) });
  const secondaryRestoreTest = await request('/api/data/test-restore', { method:'POST', body:JSON.stringify({ location:'secondary' }) });
  if (!primaryRestoreTest.ok || primaryRestoreTest.format !== 'sqlite' || !secondaryRestoreTest.ok || secondaryRestoreTest.format !== 'encrypted-json') throw new Error('Non-destructive primary or secondary restore testing failed.');
  const diagnostics = await request('/api/operations/diagnostics', { method:'POST', body:JSON.stringify({ network:false }) });
  if (!diagnostics.ok || diagnostics.summary.failed || !diagnostics.checks.some((item) => item.id === 'secret-key' && item.status === 'pass') || !diagnostics.checks.some((item) => item.id === 'secondary-restore' && item.status === 'pass')) throw new Error(`Installation diagnostics failed: ${JSON.stringify(diagnostics)}`);
  const supportBundle = await request('/api/operations/support-bundle');
  const supportText = JSON.stringify(supportBundle);
  if (supportBundle.format !== 'GearBeaconSupportBundle' || supportText.includes('v19 secondary recovery passphrase') || supportText.includes(webhookHmacSecret) || supportText.includes(secondaryData) || supportText.includes(notificationBase) || supportText.includes('127.0.0.1') || !supportText.includes('[redacted]')) throw new Error('Redacted support bundle is incomplete or exposes local secrets, paths, or addresses.');
  const operationsAfterBackup = await request('/api/operations');
  if (!operationsAfterBackup.backups.history.some((item) => item.filename === preparedUpdate.backup.filename && item.status === 'validated') || !operationsAfterBackup.backups.secondary?.latest || !operationsAfterBackup.monitoringConfidence || !Array.isArray(operationsAfterBackup.monitoringConfidence.recentChecks)) throw new Error('Validated backup history, secondary recovery, or monitoring confidence was not recorded for Operations.');

  const encryptedExport = await request('/api/data/export/encrypted?region=us', {
    method: 'POST', body: JSON.stringify({ passphrase: 'v15 test export passphrase' }),
  });
  if (encryptedExport.format !== 'GearBeaconEncryptedBackup' || encryptedExport.encryption !== 'AES-256-GCM') throw new Error('Encrypted export failed.');
  const preview = await request('/api/data/preview?region=us', {
    method: 'POST', body: JSON.stringify({ backup: encryptedExport, passphrase: 'v15 test export passphrase' }),
  });
  if (preview.willImport.length !== 2 || !preview.regions.some((region) => region.region === 'us' && region.historyCount >= 2)) throw new Error('Encrypted backup preview did not include configured regions and product history.');
  await request('/api/watch/u7-pro-xgs?region=us', { method: 'DELETE' });
  const imported = await request('/api/data/import?region=us', {
    method: 'POST', body: JSON.stringify({ backup: encryptedExport, passphrase: 'v15 test export passphrase' }),
  });
  if (imported.watchCount !== 3 || imported.importedRegions.length !== 2) throw new Error('Encrypted multi-region restore failed.');
  const configAfterImport = await request('/api/config');
  if (!configAfterImport.secretsConfigured.webhookHmacSecret || !configAfterImport.secretsConfigured.discordWebhookUrl || !configAfterImport.secretsConfigured.gotifyToken) throw new Error('Import erased installation-local notification credentials.');

  const backup = await request('/api/data/backup?region=us', { method: 'POST' });
  if (!backup.backup?.validated || !backup.backup.secondary?.ok) throw new Error('Validated primary/secondary backup failed.');
  const info = await request('/api/data/info?region=us');
  if (!info.integrity?.ok || info.backup.count < 2 || info.backup.retention !== 10 || info.backup.secondary.count < 1 || info.activity.retentionDays !== 730 || info.activity.events < 5) throw new Error('Backup, activity retention, or database integrity reporting failed.');

  await stopServer();
  startServer(8899, localData);
  await waitFor('/api/status?region=us');
  const usPersisted = await request('/api/watchlist?region=us');
  const caPersisted = await request('/api/watchlist?region=ca');
  if (!usPersisted.products.some((product) => product.slug === 'u7-pro-xgs') || !caPersisted.products.some((product) => product.slug === 'unas-pro')) throw new Error('Multi-region watchlists did not survive restart.');
  const persistedProduct = usPersisted.products.find((product) => product.slug === 'u7-pro-xgs');
  if (persistedProduct.watchedAt !== watchedAtBeforeRestart || persistedProduct.watchRule?.targetPrice !== 250 || !persistedProduct.watchRule?.immediateRestock) throw new Error(`Watch creation time or product alert rules did not survive restart: ${JSON.stringify({ watchedAtBeforeRestart, persistedProduct })}`);
  const persistedPreferences = await request('/api/notifications/preferences?region=us');
  if (!persistedPreferences.preferences.soldOut || !persistedPreferences.preferences.newProduct) throw new Error('Notification preferences did not survive restart.');
  const persistedConfig = await request('/api/config');
  if (persistedConfig.config.notificationTimeZone !== 'UTC' || persistedConfig.config.historyRetentionDays !== 400 || persistedConfig.config.eventRetentionDays !== 730 || persistedConfig.config.secondaryBackupDir !== secondaryData || !persistedConfig.secretsConfigured.secondaryBackupPassphrase) throw new Error('Delivery, activity, or recovery configuration did not survive restart.');
  const beforeUpgrade = (await request('/api/data/info?region=us')).backup.count;
  await stopServer();

  downgradeDatabaseForUpgradeTest(join(localData, 'gearbeacon.mock.sqlite3'), '1.5.0', 4);
  startServer(8899, localData);
  await waitFor('/api/status?region=us');
  const afterUpgrade = await request('/api/data/info?region=us');
  if (afterUpgrade.backup.count <= beforeUpgrade || afterUpgrade.schemaVersion !== 7) throw new Error('Automatic V1.5 pre-update backup or schema migration failed.');
  const migratedDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'));
  const migratedPushTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_tokens'").get();
  migratedDb.close();
  if (migratedPushTable) throw new Error('Obsolete push storage returned during the V1.5 to V1.9 migration.');
  const updates = await request('/api/update/check?region=us');
  if (updates.currentVersion !== '1.9.0' || updates.latestVersion !== '1.9.0' || updates.updateAvailable) throw new Error('Bundled update check failed.');
  await stopServer();

  for (const historical of [{ version:'1.6.0', schema:5 }, { version:'1.7.0', schema:6 }]) {
    const backupCount = (await (async () => {
      const testDb = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'), { readOnly:true });
      const count = Number(testDb.prepare('SELECT COUNT(*) AS count FROM backup_log').get()?.count || 0);
      testDb.close(); return count;
    })());
    downgradeDatabaseForUpgradeTest(join(localData, 'gearbeacon.mock.sqlite3'), historical.version, historical.schema);
    startServer(8899, localData);
    await waitFor('/api/status?region=us');
    const migrated = await request('/api/data/info?region=us');
    if (migrated.schemaVersion !== 7 || migrated.backup.count < 1) throw new Error(`Automatic V${historical.version} to V1.9 migration failed.`);
    const migratedLog = new DatabaseSync(join(localData, 'gearbeacon.mock.sqlite3'), { readOnly:true });
    const loggedBackups = Number(migratedLog.prepare('SELECT COUNT(*) AS count FROM backup_log').get()?.count || 0);
    migratedLog.close();
    if (loggedBackups <= backupCount) throw new Error(`V${historical.version} migration did not record its pre-update safety backup.`);
    await stopServer();
  }

  // Private mode: setup, password/session hashing, authentication, CSRF and origin policy.
  startServer(8898, privateData, {
    REGIONS: 'us', GEARBEACON_ACCESS_MODE: 'private', GEARBEACON_SETUP_TOKEN: 'v19-one-time-setup-token',
  });
  await waitFor('/healthz');
  await fetchJson('/api/status', {}, 428);
  const setup = await fetchJson('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ setupToken: 'v19-one-time-setup-token', password: 'v19 private owner password' }),
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
  const secondLogin = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v19 private owner password' }) }, 200);
  const secondCookie = secondLogin.response.headers.get('set-cookie')?.split(';')[0];
  const sessions = await fetchJson('/api/auth/sessions', { headers: { Cookie: cookie } }, 200);
  const otherSession = sessions.body.sessions.find((session) => !session.current);
  if (sessions.body.sessions.length !== 2 || !otherSession || !secondCookie) throw new Error('Owner session listing failed.');
  await fetchJson(`/api/auth/sessions/${otherSession.id}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } }, 200);
  await fetchJson('/api/status', { headers: { Cookie: secondCookie } }, 401);

  const rotated = await fetchJson('/api/auth/password', {
    method: 'PUT', headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ currentPassword: 'v19 private owner password', newPassword: 'v19 rotated private owner password' }),
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
  if (!credential?.password_hash.startsWith('scrypt-v1$') || credential.password_hash.includes('v19 rotated private owner password')) throw new Error('Owner password was not safely hashed.');
  if (!/^[a-f0-9]{64}$/.test(storedSession?.token_hash || '') || storedSession.token_hash.includes(cookie)) throw new Error('Session token was not hashed in SQLite.');

  await fetchJson('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } }, 200);
  await fetchJson('/api/status', { headers: { Cookie: cookie } }, 401);
  await stopServer();

  startServer(8898, privateData, { REGIONS: 'us', GEARBEACON_ACCESS_MODE: 'private' });
  await waitFor('/healthz');
  const authState = await request('/api/auth/status');
  if (authState.setupRequired) throw new Error('Completed owner setup did not survive restart.');
  await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v19 private owner password' }) }, 401);
  const login = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'v19 rotated private owner password' }) }, 200);
  if (!login.response.headers.get('set-cookie') || !login.body.csrfToken) throw new Error('Owner login failed after restart.');
  await stopServer();

  // Reverse-proxy mode trusts forwarded HTTPS/host/address only in explicit proxy mode.
  startServer(8897, proxyData, { REGIONS:'us', GEARBEACON_ACCESS_MODE:'proxy', GEARBEACON_SETUP_TOKEN:'v19-proxy-setup-token', GEARBEACON_PUBLIC_BASE_URL:'https://gearbeacon.test' });
  await waitFor('/healthz');
  const proxySetup = await fetchJson('/api/auth/setup', { method:'POST', headers:{ 'X-Forwarded-Proto':'https', 'X-Forwarded-Host':'gearbeacon.test', 'X-Forwarded-For':'203.0.113.7' }, body:JSON.stringify({ setupToken:'v19-proxy-setup-token', password:'v19 proxy owner password' }) }, 201);
  const proxyCookieHeader = proxySetup.response.headers.get('set-cookie') || '';
  if (!/; Secure/i.test(proxyCookieHeader)) throw new Error('Proxy-mode HTTPS did not create a Secure session cookie.');
  const proxyCookie = proxyCookieHeader.split(';')[0];
  const proxyStatus = await fetchJson('/api/status', { headers:{ Cookie:proxyCookie, Origin:'https://gearbeacon.test', 'X-Forwarded-Proto':'https', 'X-Forwarded-Host':'gearbeacon.test' } }, 200);
  if (proxyStatus.response.headers.get('strict-transport-security') == null || proxyStatus.response.headers.get('access-control-allow-origin') !== 'https://gearbeacon.test') throw new Error('Proxy-mode HTTPS security headers or origin policy failed.');

  console.log('\nSELF-TEST PASSED: V1.9 confirmed transitions + searchable/exportable activity + secondary recovery/restore tests + diagnostics/support bundle + watch intelligence + notifications + private self-hosting security all work.');
} finally {
  await stopServer();
  await new Promise((resolve) => smtpServer.close(resolve));
  await new Promise((resolve) => notificationServer.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
}
