import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import email from '../backend/dist/email.js';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-precision-'));
const socket = net.createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const base = `http://127.0.0.1:${port}`;
const webhook = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('ok'); }); });
await new Promise((done) => webhook.listen(0, '127.0.0.1', done));
const parent = 'uvc-g5-ptz';
const black = `${parent}::mock-black`;
const white = `${parent}::mock-white`;
let child;
let output = '';
let variants = [
  { id:'mock-black', slug:'uvc-g5-ptz-black', sku:'MOCK-G5-PTZ-B', title:'Black', status:'SoldOut', displayPrice:'$299.00' },
  { id:'mock-white', slug:'uvc-g5-ptz-white', sku:'MOCK-G5-PTZ-W', title:'White', status:'Available', displayPrice:'$329.00' },
];

async function request(path, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const response = await fetch(base + path, { method, headers:{ 'Content-Type':'application/json', Connection:'close' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return result;
}
const details = (slug = black) => request(`/api/products/${encodeURIComponent(slug)}`);
const check = () => request('/api/check', {});
const rules = (slug, rule) => request(`/api/watch/${encodeURIComponent(slug)}/rules`, { rule }, 'PUT');
const events = async () => (await request('/api/events?limit=250')).events;
const allowed = async (slug = black) => (await events()).filter((event) => event.slug === slug && event.notificationDecision.allowed);
function queueRows(slug = black) {
  const database = new DatabaseSync(join(dataDir, 'gearbeacon.mock.sqlite3'), { readOnly:true });
  try { return database.prepare("SELECT event_id,status,payload_json FROM notification_queue WHERE region='us' AND json_extract(payload_json,'$.slug')=?").all(slug); }
  finally { database.close(); }
}
async function observe(change, count = 1) {
  variants = variants.map((variant) => variant.id === 'mock-black' ? { ...variant, ...change } : variant);
  await request(`/api/mock/product/${parent}`, { variants });
  for (let i = 0; i < count; i++) await check();
}
async function start() {
  output = '';
  child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd:root, stdio:['ignore','pipe','pipe'], env:{
      ...process.env, MOCK_MODE:'1', PORT:String(port), POLL_SECONDS:'86400', REGIONS:'us,ca',
      GEARBEACON_DATA_DIR:dataDir, GEARBEACON_SKIP_LEGACY_IMPORT:'1',
      GEARBEACON_BACKUP_INTERVAL_HOURS:'0', GEARBEACON_GITHUB_RELEASE_API:'',
      GEARBEACON_ACCESS_MODE:'local', GEARBEACON_BIND_HOST:'127.0.0.1',
      GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify({ [parent]:{ variants } }),
      NTFY_TOPIC:'', DISCORD_WEBHOOK_URL:'', GOTIFY_BASE_URL:'', GEARBEACON_WEBHOOK_URL:`http://127.0.0.1:${webhook.address().port}/test`,
      SMTP_HOST:'', SMTP_FROM:'', SMTP_TO:'', SMTP_USER:'', SMTP_PASSWORD:'',
    },
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const status = await request('/api/status'); if (status.lastSuccessAt && !status.checking) return; } catch {}
    await delay(100);
  }
  throw new Error(`Precision server did not become ready: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const exited = new Promise((done) => current.once('exit', done));
  current.kill('SIGINT');
  await Promise.race([exited, delay(3000)]);
  if (current.exitCode === null) { current.kill('SIGKILL'); await exited; }
}

try {
  await start();
  const config = await request('/api/config');
  await request('/api/config', { config:{ ...config.config,digestEnabled:true,digestTime:'12:34',notificationTimeZone:'UTC',notificationCooldownMinutes:0 } }, 'PUT');
  assert.equal((await request('/api/status')).storage.schemaVersion, 8);
  const initial = await details();
  assert.equal(initial.product.sku, 'MOCK-G5-PTZ-B');
  assert.equal(initial.product.price, '$299.00');
  assert.equal(initial.product.inStock, false);
  assert.equal(initial.parent.inStock, true);
  assert.equal(initial.variants.length, 2);
  assert.equal(new URL(initial.product.url).searchParams.get('variant'), 'uvc-g5-ptz-black');
  assert.equal((await request('/api/products')).count, 6, 'Browse must not duplicate variants.');
  await request(`/api/mock/product/${parent}`, { variants:[...variants, { id:'invalid',slug:'invalid' }] });
  const incomplete = await check();
  assert.equal(incomplete.catalogHealth, 'degraded', 'Malformed variant metadata was treated as a complete catalog.');
  assert.equal((await details()).product.inStock, false);
  await request(`/api/mock/product/${parent}`, { variants });
  await check();
  const imported = await request('/api/watch/import/preview', { content:`https://store.ui.com/us/en/products/${parent}?variant=uvc-g5-ptz-black\nMOCK-G5-PTZ-W\nhttps://store.ui.com/us/en/products/${parent}?variant=not-real` });
  assert.equal(imported.items[0].slug, black);
  assert.equal(imported.items[1].slug, white);
  assert.equal(imported.items[2].status, 'unrecognized', 'Unknown variants must not silently import the parent.');
  await request('/api/watch/import', { slugs:[black] });
  await request('/api/watch', { slug:parent });
  await rules(parent, { restock:false });
  const createdAt = (await details()).product.watchedAt;
  const a = await request('/api/collections', { name:'Camera project' });
  const b = await request('/api/collections', { name:'Network upgrade' });
  await request('/api/collections', { name:'camera PROJECT' }, 'POST', 409);
  await request('/api/collections', { name:' ' }, 'POST', 400);
  await request(`/api/collections/${a.id}?region=ca`, { name:'Wrong region' }, 'PUT', 404);
  const memberships = `/api/watch/${encodeURIComponent(black)}/collections`;
  await request(memberships, { collections:[a.id,b.id,a.id] }, 'PUT');
  assert.equal((await details()).product.collections.length, 2);
  await request(memberships, { collections:[a.id,'missing'] }, 'PUT', 400);
  assert.equal((await details()).product.collections.length, 2, 'Invalid assignment changed valid membership.');
  await rules(black, { availableUnderTarget:true, targetPrice:300 });
  const preview = await request(`/api/watch/${encodeURIComponent(black)}/preview`, { rule:{ availableUnderTarget:true,targetPrice:300 } });
  assert.equal(preview.decision.allowed, true);
  assert.match(preview.description, /Black.*300 USD/);
  assert.equal((await events()).length, 0, 'Rule preview created activity.');
  await rules(black, { targetPrice:300, availableUnderTarget:true });
  await observe({ status:'Available' });
  assert.equal((await allowed()).length, 1, 'Exact restock while sibling available must alert once despite two collections.');
  assert.equal(queueRows().length, 1, 'Overlapping collections duplicated the durable delivery job.');
  const queued = JSON.parse(queueRows()[0].payload_json);
  assert.equal(queued.sku, 'MOCK-G5-PTZ-B');
  assert.equal(queued.variantId, 'mock-black');
  const rendered = email.renderEmail(queued, { regions:{ us:{ label:'United States' } } });
  assert.ok(rendered.text.includes('SKU: MOCK-G5-PTZ-B') && rendered.html.includes('MOCK-G5-PTZ-B'), 'Email did not retain the actual variant SKU.');
  assert.match((await allowed())[0].name, /Black/);
  assert.equal((await details(parent)).product.inStock, true);
  await check();
  assert.equal((await allowed()).length, 1, 'Repeated qualifying observation duplicated alert.');

  // Sellouts, prices, and omissions require two complete observations.
  await observe({ status:'SoldOut' });
  assert.equal((await details()).product.inStock, true);
  const support = await request('/api/operations/support-bundle');
  const supportText = JSON.stringify(support);
  for (const privateValue of [black, parent, 'MOCK-G5-PTZ-B', 'Camera project', 'Network upgrade']) assert.ok(!supportText.includes(privateValue), 'Support bundle exposed watch or collection data.');
  assert.ok(support.operations.monitoringConfidence.pending.every((item) => item.slug === '[redacted]' && item.candidate === '[redacted]'), 'Support bundle exposed pending product observations.');
  await request('/api/mock/fault', { partialOmitSlugs:['udm-se'] });
  await check(); await check();
  assert.equal((await details()).product.inStock, true, 'Partial catalogs advanced variant evidence.');
  await request('/api/mock/fault', { reset:true });
  await check();
  assert.equal((await details()).product.inStock, false);
  await observe({ status:'Available', displayPrice:'$350.00' });
  assert.equal((await allowed()).length, 1, 'A restock above target used the old lower price.');
  await check();
  assert.equal((await details()).product.price, '$350.00');
  await observe({ displayPrice:'$280.00' });
  assert.equal((await details()).product.price, '$350.00');
  await check();
  assert.equal((await allowed()).length, 2, 'Confirmed price reaching target while available did not alert.');
  await observe({ status:'SoldOut' }, 2);
  await observe({ status:'Available',displayPrice:'$250.00' });
  await check();
  assert.equal((await allowed()).length, 3, 'Restock plus price confirmation must yield one qualifying alert.');

  // Stable IDs survive reordering; confirmation and condition state survive restart.
  variants.reverse();
  await request(`/api/mock/product/${parent}`, { variants });
  await check();
  assert.equal((await details()).product.sku, 'MOCK-G5-PTZ-B');
  await observe({ status:'SoldOut' });
  await stop(); await start();
  assert.equal((await details()).product.inStock, false, 'Pending sellout did not survive restart.');
  assert.equal((await details()).product.watchedAt, createdAt);
  assert.equal((await details()).product.collections.length, 2);
  await observe({ status:'Available' });
  const beforeRestart = (await allowed()).length;
  await stop(); await start(); await check();
  assert.equal((await allowed()).length, beforeRestart, 'Restart duplicated a qualifying alert.');
  assert.equal(queueRows().length, beforeRestart, 'Restart duplicated or lost queued jobs.');

  await rules(parent, { availableUnderTarget:true,targetPrice:300 });
  await check(); // Existing availability establishes the new condition's baseline.
  const anyBefore = (await allowed(parent)).length;
  await observe({ status:'SoldOut' }, 2);
  await observe({ status:'Available' });
  assert.equal((await allowed(parent)).length, anyBefore + 1, 'Any variant condition missed a qualifying child while the parent stayed available.');
  const anyAlert = (await allowed(parent))[0];
  assert.equal(anyAlert.sourceSlug, black);
  assert.equal(anyAlert.sku, 'MOCK-G5-PTZ-B');
  assert.equal(new URL(anyAlert.url).searchParams.get('variant'), 'uvc-g5-ptz-black');
  await check();
  assert.equal((await allowed(parent)).length, anyBefore + 1, 'Any variant condition repeated without leaving the qualifying state.');

  const retainedHistory = (await details()).history.length;
  await request('/api/watch/bulk', { action:'purchased',slugs:[black] });
  assert.ok((await details()).product.watchRule.purchasedAt);
  assert.ok(queueRows().length > 0 && queueRows().every((row) => row.status === 'cancelled'), 'Purchased watch retained pending deliveries.');
  await request('/api/notifications/preferences', { allActivity:true }, 'PUT');
  await observe({ status:'SoldOut' }, 2);
  await observe({ status:'Available' });
  assert.equal((await events()).filter((event) => event.slug === black && event.notificationDecision.reason === 'purchased').length > 0, true);
  assert.ok((await details()).history.length > retainedHistory);
  const backup = await request('/api/data/export/encrypted', { passphrase:'precision test recovery passphrase' });
  const snapshot = await request('/api/data/export');
  assert.equal(snapshot.formatVersion, 4);
  const invalidSnapshot = structuredClone(snapshot);
  invalidSnapshot.regions.us.collections[0].slugs.push('not-a-watch');
  await request('/api/data/preview', { backup:invalidSnapshot }, 'POST', 400);
  await request('/api/data/import', { backup:invalidSnapshot }, 'POST', 400);
  assert.equal((await details()).product.collections.length, 2, 'Invalid recovery data changed active collections.');
  const collectionCreatedAt = snapshot.regions.us.collections.find((collection) => collection.id === a.id).createdAt;
  await request(`/api/collections/${a.id}`, undefined, 'DELETE');
  await request('/api/watch/bulk', { action:'wanted',slugs:[black] });
  await request('/api/data/import', { backup,passphrase:'precision test recovery passphrase' });
  assert.equal((await details()).product.collections.length, 2);
  assert.equal((await request('/api/collections')).collections.find((collection) => collection.id === a.id).createdAt, collectionCreatedAt);
  assert.ok((await details()).product.watchRule.purchasedAt);
  assert.equal((await details()).product.watchedAt, createdAt);
  assert.ok((await details()).history.length > retainedHistory);
  await request(`/api/collections/${a.id}`, { name:'Renamed project' }, 'PUT');
  assert.ok((await request('/api/collections')).collections.some((item) => item.name === 'Renamed project'));
  await request(`/api/collections/${a.id}`, undefined, 'DELETE');
  assert.equal((await details()).product.watched, true, 'Deleting a collection removed its watches.');
  assert.equal((await details()).product.collections.length, 1);
  await request('/api/notifications/preferences', { allActivity:false }, 'PUT');
  await request('/api/watch/bulk', { action:'wanted',slugs:[black] });

  const remaining = variants.filter((variant) => variant.id !== 'mock-black');
  await request(`/api/mock/product/${parent}`, { variants:remaining });
  await check();
  assert.equal(Boolean((await details()).product.unlisted), false);
  await request('/api/mock/fault', { partialOmitSlugs:['udm-se'] });
  await check(); await check();
  assert.equal(Boolean((await details()).product.unlisted), false);
  await request('/api/mock/fault', { reset:true });
  await check();
  assert.equal((await details()).product.status, 'Unlisted');
  assert.equal((await details(white)).product.status, 'Available');
  await request(`/api/watch/${encodeURIComponent(black)}`, undefined, 'DELETE');
  assert.equal((await request('/api/collections')).collections[0].slugs.length, 0, 'Removed watch left orphan membership.');
  console.log('PRECISION TEST PASSED: exact variants, imports, combined rules, collection isolation/deduplication, purchased state, confirmation, restart, and encrypted recovery.');
} catch (err) {
  console.error(output.slice(-5000));
  throw err;
} finally {
  await stop();
  await new Promise((done) => webhook.close(done));
  await rm(dataDir, { recursive:true, force:true });
}
