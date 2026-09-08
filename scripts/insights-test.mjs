import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import email from '../backend/dist/email.js';

const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-insights-'));
const socket = net.createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const base = `http://127.0.0.1:${port}`;
const received = [];
const webhook = http.createServer((req, res) => {
  let body = ''; req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end('ok'); });
});
await new Promise((done) => webhook.listen(0, '127.0.0.1', done));
const parent = 'uvc-g5-ptz'; const black = `${parent}::mock-black`; const white = `${parent}::mock-white`;
let variants = [
  { id:'mock-black', slug:'uvc-g5-ptz-black', sku:'MOCK-B', title:'Black', status:'SoldOut', displayPrice:'$299.00' },
  { id:'mock-white', slug:'uvc-g5-ptz-white', sku:'MOCK-W', title:'White', status:'Available', displayPrice:'$329.00' },
];
let child; let output = '';
async function request(path, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
  const response = await fetch(base + path, { method, headers:{ 'Content-Type':'application/json', Connection:'close' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:AbortSignal.timeout(20000) });
  const result = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`); return result;
}
const check = () => request('/api/check', {});
const details = (slug = black, days = 30) => request(`/api/products/${encodeURIComponent(slug)}?days=${days}`);
const rules = (slug, rule) => request(`/api/watch/${encodeURIComponent(slug)}/rules`, { rule }, 'PUT');
const collections = async () => (await request('/api/collections')).collections;
const collection = async (id) => (await collections()).find((value) => value.id === id);
const alerts = async () => (await request('/api/activity?type=collection_ready')).events;
function query(sql, ...args) {
  const db = new DatabaseSync(join(dataDir, 'gearbeacon.mock.sqlite3'), { readOnly:true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const jobs = () => query("SELECT status,payload_json FROM notification_queue WHERE json_extract(payload_json,'$.type')='collection_ready'");
async function observe(change, count = 1) {
  variants = variants.map((variant) => variant.id === 'mock-black' ? { ...variant, ...change } : variant);
  await request(`/api/mock/product/${parent}`, { variants });
  for (let index = 0; index < count; index++) await check();
}
async function start() {
  output = '';
  child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], { cwd:root, stdio:['ignore','pipe','pipe'], env:{
    ...process.env, MOCK_MODE:'1', PORT:String(port), POLL_SECONDS:'86400', REGIONS:'us,ca',
    GEARBEACON_DATA_DIR:dataDir, GEARBEACON_SKIP_LEGACY_IMPORT:'1', GEARBEACON_BACKUP_INTERVAL_HOURS:'0', GEARBEACON_GITHUB_RELEASE_API:'',
    GEARBEACON_ACCESS_MODE:'local', GEARBEACON_BIND_HOST:'127.0.0.1', GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify({ [parent]:{ variants } }),
    NTFY_TOPIC:'', DISCORD_WEBHOOK_URL:'', GOTIFY_BASE_URL:'', GEARBEACON_WEBHOOK_URL:`http://127.0.0.1:${webhook.address().port}/test`, SMTP_HOST:'', SMTP_FROM:'', SMTP_TO:'', SMTP_USER:'', SMTP_PASSWORD:'',
  } });
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  for (let index = 0; index < 150; index++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const result = await request('/api/status'); if (result.lastSuccessAt && !result.checking) return; } catch {}
    await delay(100);
  }
  throw new Error(`Test server failed to start: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child; const exited = new Promise((done) => current.once('exit', done)); current.kill('SIGINT');
  await Promise.race([exited, delay(3000)]);
  if (current.exitCode === null) { current.kill('SIGKILL'); await exited; }
}

try {
  await start();
  const config = (await request('/api/config')).config;
  await request('/api/config', { config:{ ...config, digestEnabled:true, digestTime:'12:34', notificationTimeZone:'UTC', notificationCooldownMinutes:0 } }, 'PUT');
  assert.equal((await details()).insights.fullWindow, false, 'A new installation invented historical coverage.');
  assert.equal((await details()).insights.prices[0].lowestAvailable, null);
  assert.equal((await details(parent)).insights.exactPriceScope, false, 'Any variant mixed SKU prices.');
  await request(`/api/products/${encodeURIComponent(black)}?days=365`, undefined, 'GET', 400);
  await check();
  const initialCoverage = query("SELECT * FROM monitor_coverage WHERE region='us'");
  assert.equal(initialCoverage.length, 1, 'Unchanged successful checks did not compact.');
  assert.equal(initialCoverage[0].checks, 2);
  assert.equal(query("SELECT * FROM inventory_history WHERE region='us' AND slug=?", black).length, 1);

  for (const slug of [black,white,parent]) await request('/api/watch', { slug });
  await rules(black, { targetPrice:300 }); await rules(white, { targetPrice:340 }); await rules(parent, { targetPrice:300 });
  const project = (await request('/api/collections', { name:'Camera project' })).id;
  const any = (await request('/api/collections', { name:'Any camera' })).id;
  for (const [slug,id] of [[black,project],[white,project],[parent,any]]) await request(`/api/watch/${encodeURIComponent(slug)}/collections`, { collections:[id] }, 'PUT');
  await request(`/api/collections/${project}`, { notifyReady:true }, 'PUT');
  await request(`/api/collections/${any}`, { notifyReady:true }, 'PUT');
  assert.equal((await collection(project)).readiness.qualifying, 1);
  assert.equal((await collection(any)).readiness.ready, false, 'Availability and price matched on different variants.');
  await observe({ status:'Available' });
  assert.equal((await alerts()).length, 2, 'Each opted-in collection must alert once on entering readiness.');
  assert.equal(jobs().length, 2);
  const snapshotEvent = jobs().map((row) => JSON.parse(row.payload_json)).find((event) => event.collectionId === project);
  const rendered = email.renderEmail(snapshotEvent);
  assert.match(rendered.subject, /Camera project is ready/);
  assert.match(rendered.text, /All 2 remaining items/);
  assert.ok(!rendered.html.includes('IMAGE UNAVAILABLE'), 'Collection email pretended to be a product.');
  await check(); await stop(); await start();
  assert.equal((await alerts()).length, 2, 'Restart duplicated readiness alerts.');
  assert.equal(query("SELECT * FROM monitor_coverage WHERE region='us'").length, 2, 'Restart falsely joined coverage intervals.');

  await observe({ status:'SoldOut' });
  assert.equal((await collection(project)).readiness.unknown, 1);
  await request('/api/mock/fault', { partialOmitSlugs:['udm-se'] }); await check(); await check();
  assert.equal((await collection(project)).readiness.unknown, 2, 'Partial catalog represented current readiness as known.');
  await request('/api/mock/fault', { reset:true }); await observe({ status:'Available' });
  assert.equal((await alerts()).length, 2, 'Unknown evidence rearmed readiness.');
  const beforeFailure = query("SELECT COUNT(*) AS count FROM inventory_history WHERE region='us'")[0].count;
  await request('/api/mock/fault', { rateLimitOnceSeconds:120 });
  await request('/api/check', {}, 'POST', 502);
  assert.equal((await collection(project)).readiness.unknown, 2);
  assert.equal(query("SELECT COUNT(*) AS count FROM inventory_history WHERE region='us'")[0].count, beforeFailure, 'Failed checks recorded new inventory evidence.');
  await request('/api/mock/fault', { reset:true }); await check();
  assert.equal((await alerts()).length, 2, 'Failure and recovery duplicated readiness alerts.');
  assert.ok((await details()).insights.timeline.some((row) => row.unknown));
  await observe({ status:'SoldOut' }, 2);
  await observe({ status:'Available', displayPrice:'$350.00' });
  assert.equal((await alerts()).length, 2, 'Restock used an old lower price while confirmation was pending.');
  await check(); assert.equal((await collection(project)).readiness.ready, false);
  await observe({ displayPrice:'$280.00' }); assert.equal((await alerts()).length, 2);
  await check(); assert.equal((await alerts()).length, 4, 'Confirmed price crossing did not reenter readiness.');
  const recovery = await request('/api/data/export/encrypted', { passphrase:'insight test recovery passphrase' });
  const retained = await request('/api/data/export');
  await request(`/api/collections/${project}`, { notifyReady:false }, 'PUT');
  assert.ok(jobs().filter((row) => JSON.parse(row.payload_json).collectionId === project).every((row) => row.status === 'cancelled'));
  await request('/api/data/import', { backup:recovery, passphrase:'insight test recovery passphrase' }); await check();
  assert.equal((await collection(project)).notifyReady, true);
  assert.equal((await alerts()).length, 4, 'Recovery lost the collection alert latch.');
  assert.ok((await request('/api/data/export')).regions.us.inventoryHistory.length >= retained.regions.us.inventoryHistory.length);
  await request('/api/watch/bulk', { action:'purchased', slugs:[black,white,parent] }); await check();
  assert.equal((await collection(project)).readiness.remaining, 0);
  assert.equal((await collection(project)).readiness.ready, false);
  assert.equal((await alerts()).length, 4, 'A fully purchased collection alerted.');
  const empty = (await request('/api/collections', { name:'Empty project' })).id;
  await request(`/api/collections/${empty}`, { notifyReady:true }, 'PUT'); await check();
  assert.equal((await alerts()).length, 4, 'An empty collection alerted.');
  await request('/api/notifications/preferences', { allActivity:true }, 'PUT');
  await request(`/api/collections/${project}`, { notifyReady:false }, 'PUT');
  await request('/api/watch/bulk', { action:'wanted', slugs:[black,white] });
  await observe({ status:'SoldOut' }, 2); await observe({ status:'Available' });
  assert.equal((await alerts()).length, 4, 'All activity overrode the collection opt-in.');
  const supportText = JSON.stringify(await request('/api/operations/support-bundle'));
  for (const value of ['Camera project','Any camera',black,'MOCK-B']) assert.ok(!supportText.includes(value), 'Support bundle exposed collection or product data.');

  await request('/api/config', { config:{ ...(await request('/api/config')).config, digestEnabled:false, notificationGroupSeconds:0, quietHoursEnabled:false } }, 'PUT');
  await request(`/api/collections/${project}`, { notifyReady:true }, 'PUT');
  await observe({ status:'SoldOut' }, 2); await observe({ status:'Available' });
  for (let index = 0; index < 150 && !received.some((value) => value.event?.collectionId === project); index++) await delay(100);
  const delivered = received.find((value) => value.event?.collectionId === project);
  assert.ok(delivered && delivered.title === 'Camera project is ready' && delivered.event.readiness.remaining === 2, 'Collection alert did not reach its configured server-side channel.');

  // Deterministic imported history: window boundaries, zero/missing prices,
  // available-only minima, currency isolation, gaps and old aggregate data.
  const backup = await request('/api/data/export');
  // New interval exports can exceed the previous 25 MiB request budget.
  await request('/api/data/preview', { backup, padding:'x'.repeat(26 * 1024 * 1024) });
  const now = Date.now(); const at = (days) => new Date(now - days * 86400000).toISOString();
  const interval = (start,end,price,inStock) => ({ slug:black, startedAt:at(start), endedAt:at(end), price:price === null ? null : `$${price}.00`, priceValue:price, currency:'USD', inStock, status:inStock ? 'Available' : 'SoldOut' });
  backup.regions.us.inventoryHistory = [interval(100,95,100,true),interval(60,31,200,false),interval(30,20,300,true),interval(10,8,250,true),interval(5,4,0,false),interval(3,2,280,true),interval(1,.5,null,true)];
  backup.regions.us.monitoringCoverage = backup.regions.us.inventoryHistory.map((row) => ({ startedAt:row.startedAt, endedAt:row.endedAt, checks:2 }));
  backup.regions.us.productHistory = [{ slug:black, observedAt:at(3), changeType:'restock', status:'Available', inStock:true, price:'$280.00', priceValue:280 }, { slug:parent, observedAt:at(2), changeType:'restock', status:'Available', inStock:true, price:'$10.00', priceValue:10 }];
  await request('/api/data/import', { backup });
  const insight = (await details()).insights;
  assert.deepEqual(insight.prices.map((row) => [row.days,row.lowest,row.lowestAvailable]), [[7,0,280],[30,0,250],[90,0,250]]);
  assert.ok(Math.abs(insight.availableSeconds - 13.5 * 86400) <= 2);
  assert.ok(Math.abs(insight.observedSeconds - 14.5 * 86400) <= 2);
  assert.equal(insight.restocks.length, 1, 'Parent restocks contaminated exact variant counts.');
  assert.equal(insight.currentConfirmed, false, 'Imported history implied current monitoring coverage.');
  assert.equal((await details(black,7)).insights.days, 7);
  assert.notEqual((await request(`/api/products/${encodeURIComponent(black)}?region=ca`)).insights.prices[0].lowest, 0, 'Regional histories mixed.');
  for (const mutate of [
    (value) => { value.regions.us.inventoryHistory[0].currency = 'EUR'; },
    (value) => { value.regions.us.inventoryHistory[1].startedAt = at(101); },
    (value) => { value.regions.us.inventoryHistory[0].endedAt = 'invalid'; },
    (value) => { value.regions.us.collections[0].readyState = 7; },
  ]) {
    const invalid = structuredClone(backup); mutate(invalid);
    await request('/api/data/preview', { backup:invalid }, 'POST', 400);
    await request('/api/data/import', { backup:invalid }, 'POST', 400);
    assert.equal((await details()).insights.prices[0].lowest, 0, 'Invalid import changed history.');
  }
  backup.formatVersion = 4;
  for (const region of Object.values(backup.regions)) {
    delete region.inventoryHistory; delete region.monitoringCoverage;
    for (const value of region.collections) { delete value.notifyReady; delete value.readyState; }
  }
  await request('/api/data/import', { backup });
  assert.equal((await details()).insights.historySince, null, 'Legacy aggregate data was backfilled as confirmed variant coverage.');
  assert.ok((await collections()).every((value) => !value.notifyReady));
  console.log('INSIGHTS TEST PASSED: coverage/gaps, price windows, exact SKU/currency isolation, collection transitions/deduplication, durable queue, restart, purchased/empty state, privacy and recovery.');
} catch (err) { console.error(output.slice(-5000)); throw err; }
finally { await stop(); await new Promise((done) => webhook.close(done)); await rm(dataDir, { recursive:true, force:true }); }
