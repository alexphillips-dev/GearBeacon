import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-v19-faults-'));
const dataDir = join(testRoot, 'data');
const secondaryDir = join(testRoot, 'secondary');
const port = 9700 + (process.pid % 200);
const base = `http://127.0.0.1:${port}`;
const databaseFile = join(dataDir, 'gearbeacon.mock.sqlite3');
const secretKeyFile = join(dataDir, 'secrets.key');
const persistentOverrides = {
  'unas-pro': { status:'Available', price:'$450.00', present:true },
  'u7-pro-xgs': { status:'Available', price:'$299.00', present:true },
};
let child = null;
let output = '';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function processEnvironment(extra = {}) {
  return {
    ...process.env,
    MOCK_MODE:'1',
    PORT:String(port),
    POLL_SECONDS:'3600',
    REGIONS:'us',
    GEARBEACON_DATA_DIR:dataDir,
    GEARBEACON_SKIP_LEGACY_IMPORT:'1',
    GEARBEACON_GITHUB_RELEASE_API:'',
    GEARBEACON_BACKUP_INTERVAL_HOURS:'0',
    GEARBEACON_ACCESS_MODE:'local',
    GEARBEACON_BIND_HOST:'127.0.0.1',
    ...extra,
  };
}

async function startServer(extra = {}) {
  output = '';
  child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd:projectRoot,
    env:processEnvironment(extra),
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { output += String(data); });
  child.stderr.on('data', (data) => { output += String(data); });
  await waitForStatus();
}

function waitForChildExit(current, timeoutMs) {
  if (current.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    current.once('exit', onExit);
  });
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  if (current.exitCode !== null) return;
  current.kill('SIGINT');
  if (await waitForChildExit(current, 3000)) return;
  current.kill('SIGKILL');
  if (!await waitForChildExit(current, 3000)) throw new Error('GearBeacon fault-test server did not exit after SIGKILL.');
}

async function expectStartupFailure(extra, expected) {
  const probe = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd:projectRoot,
    env:processEnvironment(extra),
    stdio:['ignore', 'pipe', 'pipe'],
  });
  let probeOutput = '';
  probe.stdout.on('data', (data) => { probeOutput += String(data); });
  probe.stderr.on('data', (data) => { probeOutput += String(data); });
  const code = await Promise.race([
    new Promise((resolve) => probe.once('exit', resolve)),
    delay(5000).then(() => { probe.kill('SIGKILL'); return null; }),
  ]);
  assert(code !== 0 && expected.test(probeOutput), `Expected startup failure ${expected}, got code ${code}: ${probeOutput}`);
}

async function fetchJson(path, options = {}, expected = 200) {
  const response = await fetch(base + path, {
    ...options,
    // A fault test repeatedly replaces the server process on the same port.
    // Do not let the client's pooled keep-alive socket outlive that process,
    // especially on Windows where socket teardown can lag child exit.
    headers:{ 'Content-Type':'application/json', Connection:'close', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== expected) throw new Error(`${path}: expected HTTP ${expected}, got ${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

function post(path, body = {}, expected = 200) {
  return fetchJson(path, { method:'POST', body:JSON.stringify(body) }, expected);
}

async function waitForStatus() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child?.exitCode !== null) throw new Error(`GearBeacon exited during startup: ${output}`);
    try {
      const status = await fetchJson('/api/status');
      if (status.lastSuccessAt) return status;
    } catch {}
    await delay(100);
  }
  throw new Error(`GearBeacon fault-test server did not become ready: ${output}`);
}

function insertActivityRows(count) {
  const target = new DatabaseSync(databaseFile);
  const insert = target.prepare('INSERT INTO events(id,region,detected_at,data_json,type,slug,name,alert_kind) VALUES(?,?,?,?,?,?,?,?)');
  const started = Date.now();
  target.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < count; index += 1) {
      const detectedAt = new Date(started - index * 1000).toISOString();
      const event = {
        id:`scale-event-${String(index).padStart(5, '0')}`,
        region:'us', type:index % 3 === 0 ? 'price_change' : index % 3 === 1 ? 'restock' : 'sold_out',
        alertKind:index % 3 === 0 ? 'price_change' : index % 3 === 1 ? 'restock' : 'sold_out',
        slug:`scale-product-${index % 500}`, name:`Scale Product ${index % 500}`,
        detectedAt, status:index % 3 === 2 ? 'SoldOut' : 'Available', price:`$${100 + (index % 400)}.00`, watchedAtDetection:false,
      };
      insert.run(event.id, event.region, detectedAt, JSON.stringify(event), event.type, event.slug, event.name, event.alertKind);
    }
    target.exec('COMMIT');
  } catch (err) {
    try { target.exec('ROLLBACK'); } catch {}
    throw err;
  } finally { target.close(); }
}

await Promise.all([mkdir(dataDir), mkdir(secondaryDir)]);

try {
  await startServer();
  let status = await fetchJson('/api/status');
  assert(status.version === '1.0.1' && status.productCount === 6, 'Fault suite did not start on the V1.0.1 six-product baseline.');

  // 429 handling must preserve state and never schedule before Retry-After.
  await post('/api/mock/fault', { rateLimitOnceSeconds:120 });
  const limited = await post('/api/check', {}, 502);
  assert(limited.ok === false, 'Injected HTTP 429 did not fail the active check.');
  status = await fetchJson('/api/status');
  assert(status.retryAfterAt && status.nextCheckAt && new Date(status.nextCheckAt) >= new Date(status.retryAfterAt), 'Retry-After was not honored by the next monitor schedule.');
  assert((await fetchJson('/api/products')).count === 6, 'HTTP 429 altered the last-known-good product catalog.');
  await post('/api/mock/fault', { reset:true });
  assert((await post('/api/check')).ok, 'Monitor did not recover after the rate-limit fault cleared.');

  // Repeated partial catalogs must not convert an omitted product to sold out or unlisted.
  await post('/api/mock/fault', { partialOmitSlugs:['unas-pro'] });
  for (let attempt = 0; attempt < 3; attempt += 1) assert((await post('/api/check')).catalogHealth === 'degraded', 'Partial catalog was not marked degraded.');
  const preserved = await fetchJson('/api/products/unas-pro');
  assert(preserved.product.inStock && !preserved.product.unlisted, 'Partial catalogs changed the omitted product instead of preserving last-known-good state.');
  const partialEvents = await fetchJson('/api/activity?type=status_change&search=unas-pro');
  assert(partialEvents.count === 0, 'Partial catalogs emitted a false status-change event.');
  await post('/api/mock/fault', { reset:true });
  await post('/api/check');

  // One-observation sold-out oscillation must repeatedly clear without an alert.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await post('/api/mock/product/usw-pro-max-24-poe', { status:'SoldOut' });
    await post('/api/check');
    await post('/api/mock/product/usw-pro-max-24-poe', { status:'Available' });
    await post('/api/check');
  }
  const oscillationEvents = await fetchJson('/api/activity?type=sold_out&search=usw-pro-max-24-poe');
  const oscillatingProduct = await fetchJson('/api/products/usw-pro-max-24-poe');
  assert(oscillationEvents.count === 0 && oscillatingProduct.product.inStock, 'Oscillating availability produced a false sold-out transition.');

  // Pending confirmations must survive a process restart and confirm on observation two.
  await post('/api/mock/product/unas-pro', { status:'Available', price:'$450.00' });
  assert((await post('/api/check')).pendingChanges >= 1, 'Price change did not enter pending confirmation before restart.');
  await stopServer();
  const persisted = new DatabaseSync(databaseFile, { readOnly:true });
  const pendingBeforeRestart = persisted.prepare("SELECT candidate_json,observations FROM pending_transitions WHERE region='us' AND slug='unas-pro' AND kind='price'").get();
  persisted.close();
  assert(pendingBeforeRestart?.candidate_json === JSON.stringify({ price:'$450.00' }) && Number(pendingBeforeRestart.observations) === 1, 'Pending price evidence was not durable before restart.');
  await startServer({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify({ 'unas-pro':persistentOverrides['unas-pro'] }) });
  const confirmed = await fetchJson('/api/activity?type=price_change&search=unas-pro');
  assert(confirmed.count === 1 && confirmed.events[0].confirmation?.observations === 2, `Pending transition did not survive restart and confirm with persisted evidence: ${JSON.stringify({ count:confirmed.count, confirmation:confirmed.events[0]?.confirmation || null })}`);

  // A future delivery job must remain queued across restart.
  let config = await fetchJson('/api/config');
  config = await fetchJson('/api/config', { method:'PUT', body:JSON.stringify({
    config:{ ...config.config, digestEnabled:true, digestTime:'09:00', secondaryBackupDir:secondaryDir, secondaryEncryptedExports:true, channelEnabled:{ ...config.config.channelEnabled, webhook:true } },
    secrets:{ webhookUrl:'http://127.0.0.1:9/fault-test', secondaryBackupPassphrase:'v19 secondary fault passphrase' },
  }) });
  await post('/api/watch', { slug:'u7-pro-xgs' });
  await post('/api/mock/product/u7-pro-xgs', { status:'Available' });
  assert((await post('/api/check')).notifications === 1, 'Restock did not create a queued notification for restart testing.');
  const queuedBefore = (await fetchJson('/api/status')).notifications.queue;
  assert(queuedBefore.pending >= 1 && new Date(queuedBefore.nextDeliveryAt) > new Date(), 'Notification was not held for the future digest.');
  await stopServer();
  await startServer({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify(persistentOverrides) });
  const queuedAfter = (await fetchJson('/api/status')).notifications.queue;
  assert(queuedAfter.pending >= queuedBefore.pending && queuedAfter.nextDeliveryAt === queuedBefore.nextDeliveryAt, 'Queued notification did not survive process restart.');

  // Primary backup must still succeed when the configured secondary mount disappears.
  await rm(secondaryDir, { recursive:true, force:true });
  await writeFile(secondaryDir, 'simulated unavailable mount');
  const unavailableCopy = await post('/api/data/backup');
  assert(unavailableCopy.backup?.validated && unavailableCopy.backup.secondary?.ok === false, 'Unavailable secondary storage prevented a safe primary backup or was not reported.');
  await unlink(secondaryDir);
  await mkdir(secondaryDir);

  // Restore tests must reject a corrupt primary SQLite backup.
  const primaryBackup = await post('/api/data/backup');
  await writeFile(primaryBackup.backup.path, 'not a sqlite database');
  const corruptPrimary = await post('/api/data/test-restore', { location:'primary', filename:primaryBackup.backup.filename }, 400);
  assert(/database|sqlite|malformed|file/i.test(corruptPrimary.error || ''), 'Corrupt primary backup was not rejected with a useful error.');

  // Restore tests must also reject authenticated-encryption corruption.
  const encryptedBackup = await post('/api/data/backup');
  assert(encryptedBackup.backup.secondary?.ok && encryptedBackup.backup.secondary.encrypted, 'Encrypted secondary backup was not created.');
  const encryptedPath = join(secondaryDir, encryptedBackup.backup.secondary.filename);
  const wrapper = JSON.parse(await readFile(encryptedPath, 'utf8'));
  wrapper.data = `${wrapper.data.slice(0, -2)}AA`;
  await writeFile(encryptedPath, JSON.stringify(wrapper));
  const corruptEncrypted = await post('/api/data/test-restore', { location:'secondary', filename:encryptedBackup.backup.secondary.filename }, 400);
  assert(/decrypt|auth|authenticate|backup/i.test(corruptEncrypted.error || ''), 'Corrupt encrypted recovery copy was not rejected.');

  // A wrong or missing local key must fail closed when encrypted credentials exist.
  await stopServer();
  const originalKey = await readFile(secretKeyFile, 'utf8');
  await writeFile(secretKeyFile, Buffer.alloc(32, 7).toString('base64'));
  await expectStartupFailure({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify(persistentOverrides) }, /could not be decrypted|authenticate data/i);
  await unlink(secretKeyFile);
  await expectStartupFailure({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify(persistentOverrides) }, /could not be decrypted|authenticate data/i);
  await writeFile(secretKeyFile, originalKey);

  // The dashboard/API path must remain usable at the real catalog scale.
  await startServer({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify(persistentOverrides), GEARBEACON_MOCK_CATALOG_SIZE:'500' });
  status = await fetchJson('/api/status');
  assert(status.productCount === 500 && status.catalogHealth === 'healthy', '500-product catalog did not complete as healthy.');
  const scaleProducts = await fetchJson('/api/products');
  assert(scaleProducts.count === 500 && scaleProducts.products.length === 500, '500-product API response was incomplete.');

  // Retained activity must paginate above 10k rows and cap exports deterministically.
  await stopServer();
  insertActivityRows(10050);
  await startServer({ GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify(persistentOverrides), GEARBEACON_MOCK_CATALOG_SIZE:'500' });
  const largeActivity = await fetchJson('/api/activity?limit=100&page=101');
  assert(largeActivity.count >= 10050 && largeActivity.events.length > 0 && largeActivity.pages >= 101, '10k activity pagination failed.');
  const largeExport = await fetchJson('/api/activity/export?format=json');
  assert(largeExport.events.length === 10000 && largeExport.truncated === true && largeExport.count >= 10050, '10k activity export limit was not enforced or disclosed.');

  console.log('FAULT TEST PASSED: Retry-After, partial catalogs, oscillation, restart persistence, backup/key failures, 500 products, and 10k activity rows are covered.');
} finally {
  await stopServer();
  await rm(testRoot, { recursive:true, force:true });
}
