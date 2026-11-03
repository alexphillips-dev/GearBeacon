import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const project = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'gearbeacon-audit-regression-'));
const clock = join(root, 'clock.txt'), preload = join(root, 'clock.cjs');
await writeFile(clock, '0');
await writeFile(preload, "const fs=require('node:fs');const now=Date.now.bind(Date);Date.now=()=>now()+Number(fs.readFileSync(" + JSON.stringify(clock) + ",'utf8'));");
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:GEARBEACON_|SMTP_|NTFY_|GOTIFY_|DISCORD_|MOCK_MODE$|REGIONS?$|POLL_SECONDS$|PORT$)/i.test(name)));
let child, database, output = '', accepted = 0, smtpMode = 'close-on-quit';
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
const silent = net.createServer(track);
const smtp = net.createServer(socket => {
  track(socket);
  let buffer = '', data = false, upgrading = false;
  socket.write('220 fixture SMTP\r\n');
  socket.on('data', chunk => {
    if (upgrading) return;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, ''); buffer = buffer.slice(index + 1);
      if (data) {
        if (line === '.') { accepted++; data = false; socket.write('250 queued fixture-message\r\n'); }
      } else if (line.startsWith('EHLO ')) socket.write(smtpMode === 'stall-starttls' ? '250-fixture\r\n250 STARTTLS\r\n' : '250 fixture\r\n');
      else if (line === 'STARTTLS') { upgrading = true; socket.write('220 ready for TLS\r\n'); return; }
      else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write('250 accepted\r\n');
      else if (line === 'DATA') { data = true; socket.write('354 send message\r\n'); }
      else if (line === 'QUIT') socket.destroy(); // Deliberately omit 221 after accepting DATA.
      else socket.write('500 unsupported\r\n');
    }
  });
});
for (const server of [silent, smtp]) await new Promise(done => server.listen(0, '127.0.0.1', done));
const probe = net.createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port; await new Promise(done => probe.close(done));
const base = 'http://127.0.0.1:' + port;
async function request(route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, { method, headers:{ 'Content-Type':'application/json' },
    body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(20000) });
  const value = await response.json(); assert.equal(response.status, expected, route + ': ' + JSON.stringify(value));
  return value;
}
async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(message);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(done => child.once('exit', done)); child.kill();
  await Promise.race([ended, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
}
async function start() {
  child = spawn(process.execPath, ['--require', preload, '--no-warnings', 'backend/dist/index.js'], {
    cwd:project, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{ ...cleanEnvironment,
      MOCK_MODE:'1', REGIONS:'us', PORT:String(port), POLL_SECONDS:'60', GEARBEACON_DATA_DIR:root,
      GEARBEACON_SKIP_LEGACY_IMPORT:'1', GEARBEACON_ACCESS_MODE:'local', GEARBEACON_BIND_HOST:'127.0.0.1',
      GEARBEACON_GITHUB_RELEASE_API:'', GEARBEACON_AUTO_UPDATE_CHECKS:'0', GEARBEACON_BACKUP_INTERVAL_HOURS:'0',
      GEARBEACON_EMAIL_EMBED_IMAGES:'0' },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output += value; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Fixture server exited: ' + output.slice(-2000));
    try { return Boolean((await request('/api/status')).lastSuccessAt); } catch { return false; }
  }, 'Fixture server did not start', 20000);
}
const observe = async (slug, value, count = 1) => {
  await request('/api/mock/product/' + slug, 'POST', value);
  for (let i = 0; i < count; i++) await request('/api/check', 'POST');
};
const dateEvents = async slug => (await request('/api/activity?scope=us&type=restock_date&limit=100')).events.filter(event => event.slug === slug);
const dateA = '2027-02-10T00:00:00.000Z', dateB = '2027-02-17T00:00:00.000Z';
try {
  await start();
  database = new DatabaseSync(join(root, 'gearbeacon.mock.sqlite3'));
  for (const [slug, firstDate] of [['unas-pro', null], ['udm-se', dateA]]) {
    await request('/api/watch', 'POST', { slug });
    await observe(slug, { status:'SoldOut', restockEtaAt:firstDate });
    await observe(slug, { status:'SoldOut', restockEtaAt:dateB });
    assert.equal((await request('/api/products/' + slug)).product.restockEtaAt, null, 'Sellout committed an unconfirmed date');
    assert.equal((await dateEvents(slug)).length, 0);
    await request('/api/check', 'POST');
    const announced = await dateEvents(slug);
    assert.equal(announced.length, 1); assert.equal(announced[0].restockEtaAt, dateB);
    assert.equal(announced[0].confirmation.observations, 2);
    await request('/api/check', 'POST'); assert.equal((await dateEvents(slug)).length, 1);
  }
  const insightSlug = 'u7-pro-xgs';
  await observe(insightSlug, { status:'SoldOut', price:'250', restockEtaAt:dateA }, 2);
  assert.equal((await request('/api/products/' + insightSlug)).insights.restocks.length, 0, 'Date/price change counted as a restock');
  await observe(insightSlug, { price:'200' });
  await observe(insightSlug, { status:'Available', price:'200' });
  const realRestock = await request('/api/products/' + insightSlug);
  assert.equal(realRestock.insights.restocks.length, 1, 'A real combined restock was excluded');
  assert.ok(realRestock.history.some(row => row.changeType === 'restock+price'));

  const addresses = ['2001:db8::42', '::1', '::ffff:192.0.2.1', 'fe80::1%eth0', '[2001:db8::1]'];
  database.prepare('INSERT INTO app_log(level,source,message,detail_json,created_at) VALUES(?,?,?,?,?)')
    .run('info', 'security', 'Fixture address redaction', JSON.stringify({ remoteAddress:addresses[0], detail:addresses.join(' ') + ' ' + dateA }), new Date().toISOString());
  const support = JSON.stringify(await request('/api/operations/support-bundle'));
  for (const address of addresses) assert.ok(!support.includes(address), 'Support bundle exposed ' + address);
  assert.ok(support.includes(dateA), 'Address redaction changed an ISO timestamp');

  const snapshot = await request('/api/data/export');
  const before = JSON.stringify(snapshot.regions), backups = (await readdir(join(root, 'backups'))).sort();
  for (const corrupt of [() => 1, () => null, () => [], () => ({}),
    p => ({ ...p, name:null }), p => ({ ...p, slug:'wrong' }), p => ({ ...p, inStock:'yes' }),
    p => ({ ...p, category:1 }), p => ({ ...p, price:{} }), p => ({ ...p, lastSeenAt:'invalid' }),
    p => ({ ...p, url:'javascript:alert(1)' }), p => ({ ...p, parentSlug:'missing-parent' }),
    p => ({ ...p, variantKeys:['missing-variant'] })]) {
    const broken = structuredClone(snapshot); broken.regions.us.products['unas-pro'] = corrupt(broken.regions.us.products['unas-pro']);
    await request('/api/data/preview', 'POST', { backup:broken }, 400);
    await request('/api/data/import', 'POST', { backup:broken }, 400);
    assert.equal(JSON.stringify((await request('/api/data/export')).regions), before, 'Rejected restore changed active data');
  }
  assert.deepEqual((await readdir(join(root, 'backups'))).sort(), backups, 'Invalid restore created a backup before validation');
  const legacy = { watchlist:snapshot.regions.us.watchlist, products:snapshot.regions.us.products, events:snapshot.regions.us.events };
  await request('/api/data/preview', 'POST', { backup:legacy });
  await request('/api/data/import', 'POST', { backup:legacy });
  assert.ok((await request('/api/products')).count > 0, 'Valid legacy restore broke the catalog');

  let config = (await request('/api/config')).config;
  await request('/api/config', 'PUT', { ...config, pollSeconds:21600 });
  assert.equal((await request('/api/status')).health.staleAfterSeconds, 64800);
  await writeFile(clock, String(10801 * 1000));
  assert.equal((await request('/api/status')).health.stale, false, 'Healthy long-interval polling was marked stale');
  await writeFile(clock, String(64801 * 1000));
  assert.equal((await request('/api/status')).health.stale, true, 'Overdue monitoring stayed healthy');
  await writeFile(clock, '0');
  await request('/api/config', 'PUT', { ...config, pollSeconds:30 });
  assert.equal((await request('/api/status')).health.staleAfterSeconds, 180);
  await request('/api/config', 'PUT', { ...config, pollSeconds:3600 });
  database.close(); database = null; await stop(); await start();
  database = new DatabaseSync(join(root, 'gearbeacon.mock.sqlite3'));
  assert.equal((await request('/api/status')).health.staleAfterSeconds, 10800, 'Saved startup polling used the environment stale threshold');

  config = (await request('/api/config')).config;
  const mailConfig = { ...config, smtpHost:'127.0.0.1', smtpPort:smtp.address().port, smtpSecure:false,
    smtpStarttls:false, smtpFrom:'monitor@example.invalid', smtpTo:['owner@example.invalid'], emailEmbedImages:false, notificationCooldownMinutes:0,
    channelEnabled:{ ntfy:false, discord:false, gotify:false, webhook:false, email:true } };
  await request('/api/config', 'PUT', mailConfig);
  await request('/api/notifications/test', 'POST', { channel:'email' });
  assert.equal(accepted, 1, 'Accepted SMTP message was reported as a failure');
  await observe('unas-pro', { status:'SoldOut', restockEtaAt:null }, 2);
  await observe('unas-pro', { status:'Available', restockEtaAt:null });
  await request('/api/notifications/retry-failed', 'POST');
  const queued = () => database.prepare("SELECT id,status,attempts FROM notification_queue WHERE channel='email' AND json_extract(payload_json,'$.type')='restock' ORDER BY id DESC LIMIT 1").get();
  await waitFor(() => queued()?.status === 'sent', 'Accepted queued mail was not marked sent');
  const acceptedBefore = accepted;
  await request('/api/notifications/retry-failed', 'POST'); await delay(150);
  assert.equal(accepted, acceptedBefore, 'Accepted mail was delivered twice'); assert.equal(queued().attempts, 1);

  await request('/api/config', 'PUT', { ...mailConfig, smtpSecure:true, smtpPort:silent.address().port });
  await observe('unas-pro', { status:'SoldOut' }, 2); await observe('unas-pro', { status:'Available' });
  await request('/api/notifications/retry-failed', 'POST');
  await waitFor(() => queued()?.attempts === 1, 'Silent implicit TLS connection blocked the worker', 16000);
  assert.equal(queued().status, 'pending');
  await request('/api/config', 'PUT', mailConfig);
  database.prepare('UPDATE notification_queue SET next_attempt_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', queued().id);
  await request('/api/notifications/retry-failed', 'POST');
  await waitFor(() => queued()?.status === 'sent', 'Delivery worker did not recover after TLS setup timed out');
  smtpMode = 'stall-starttls';
  await request('/api/config', 'PUT', { ...mailConfig, smtpStarttls:true });
  const upgradeStarted = Date.now();
  const failure = await request('/api/notifications/test', 'POST', { channel:'email' }, 502);
  assert.ok(Date.now() - upgradeStarted < 16000, 'STARTTLS setup exceeded its deadline');
  assert.match(failure.outcomes[0].error, /timed out/);
  console.log('AUDIT REGRESSIONS PASSED: independent dates, exact restock counts, IPv6 redaction, restore validation/legacy compatibility, live/startup health thresholds, SMTP acceptance/deduplication, TLS setup deadlines and worker recovery.');
} catch (error) { console.error(output.slice(-2500)); throw error; }
finally {
  database?.close(); await stop();
  for (const socket of sockets) socket.destroy();
  for (const server of [smtp, silent]) await new Promise(done => server.close(done));
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('gearbeacon-audit-regression-'));
  await rm(root, { recursive:true, force:true });
}
