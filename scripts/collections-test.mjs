import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-collections-'));
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

const itemUrl = (id, slug = black) => `/api/collections/${id}/items/${encodeURIComponent(slug)}`;
const editItem = (id, value, slug = black, status = 200) => request(itemUrl(id,slug),value,'PUT',status);
const preview = async (slug = black) => (await request(`/api/watch/${encodeURIComponent(slug)}/preview`,{ rule:{} })).decision;
try {
  await start();
  assert.equal((await request('/api/status')).storage.schemaVersion,12);
  assert.equal((await request('/api/collections')).capabilities.purchasePlanning,true);
  for (const slug of [black,white]) await request('/api/watch',{slug});
  const project=(await request('/api/collections',{name:'Purchase plan',slugs:[black,white],budget:2000})).id;
  const other=(await request('/api/collections',{name:'Second project',slugs:[black]})).id;
  await editItem(project,{quantity:3,purchasedQuantity:1,paidTotal:250,targetPrice:300});
  let value=await collection(project);
  assert.equal(value.pricing.total,1177);
  assert.deepEqual(value.planning,{quantity:4,purchasedQuantity:1,completedItems:0,spent:250,remainingCost:927,estimatedTotal:1177,missingPaid:0,missingPrices:0,budgetDifference:823});
  assert.equal(value.readiness.remaining,2);
  assert.equal((await collection(other)).items[0].quantity,1);
  assert.equal((await details()).product.watchRule.purchasedAt,null);
  assert.equal((await details()).product.watchRule.targetPrice,300);
  await observe({displayPrice:'$399.00'},2);
  value=await collection(project);
  assert.equal(value.planning.spent,250,'Recorded spending followed a catalog price change.');
  assert.equal(value.pricing.total,1377);
  await editItem(project,{purchasedQuantity:3,paidTotal:700});
  assert.equal((await collection(project)).pricing.total,1029);
  assert.equal((await collection(project)).readiness.purchased,1);
  assert.equal((await collection(project)).readiness.remaining,1);
  assert.equal((await collection(other)).readiness.purchased,0,'A project purchase marked a shared item purchased elsewhere.');
  await request(`/api/collections/${project}`,{budget:900},'PUT');
  assert.equal((await collection(project)).planning.budgetDifference,-129);
  for (const bad of [{quantity:0},{quantity:1.5},{quantity:null},{quantity:1001},{quantity:2},{purchasedQuantity:4},{purchasedQuantity:-1},{paidTotal:-1},{paidTotal:'20'},{targetPrice:-5}]) {
    const before=await collection(project);
    await editItem(project,bad,black,400);
    assert.deepEqual((await collection(project)).items,before.items,'Invalid input partly changed the plan.');
  }
  await request(`/api/collections/${project}`,{name:'Should not save',budget:-1},'PUT',400);
  assert.equal((await collection(project)).name,'Purchase plan');
  await request(`/api/collections/${project}`,{alertsOnly:'yes'},'PUT',400);
  await editItem(project,{paidTotal:null});
  assert.equal((await collection(project)).planning.missingPaid,1);
  assert.equal((await collection(project)).planning.budgetDifference,null);
  await editItem(project,{paidTotal:0});
  assert.equal((await collection(project)).planning.spent,0);
  assert.equal((await collection(project)).planning.missingPaid,0);
  await editItem(project,{paidTotal:700});
  await request(`/api/collections/${project}`,{name:'Purchase plan renamed',slugs:[black,white]},'PUT');
  await request(`/api/watch/${encodeURIComponent(black)}/collections`,{collections:[project,other]},'PUT');
  assert.equal((await collection(project)).items.find(item=>item.slug===black).paidTotal,700,'Editing retained membership erased purchase records.');
  await request(`/api/watch/${encodeURIComponent(black)}/collections`,{collections:[project]},'PUT');
  assert.equal((await collection(project)).items[0].quantity,3);
  await request(`/api/collections/${other}`,{addSlugs:[black]},'PUT');
  await editItem(project,{quantity:3,purchasedQuantity:0,paidTotal:null});
  const config=(await request('/api/config')).config;
  await request('/api/config',{config:{...config,digestEnabled:true,digestTime:'12:34',notificationTimeZone:'UTC',notificationCooldownMinutes:0}},'PUT');
  await rules(black,{targetPrice:null,restock:true,immediateRestock:false});
  await observe({status:'SoldOut'},2); await observe({status:'Available',displayPrice:'$299.00'}); await check();
  assert.ok(query("SELECT id FROM notification_queue WHERE status='pending' AND json_extract(payload_json,'$.slug')=?",black).length,'The test did not queue an individual alert.');
  const rulesBefore=(await details()).product.watchRule;
  await request(`/api/collections/${project}`,{notifyReady:true,alertsOnly:true},'PUT');
  assert.equal(query("SELECT id FROM notification_queue WHERE status IN ('pending','failed') AND json_extract(payload_json,'$.slug')=?",black).length,0,'Collection-only mode left individual deliveries queued.');
  assert.deepEqual((await details()).product.watchRule,rulesBefore,'Collection-only mode rewrote the item rules.');
  assert.equal((await preview()).reason,'collection-only');
  await request('/api/notifications/preferences',{allActivity:true},'PUT');
  await rules(black,{immediateRestock:true});
  assert.equal((await preview()).reason,'collection-only','All activity or immediate restocks bypassed collection-only mode.');
  await request(`/api/collections/${other}`,{notifyReady:true,alertsOnly:true},'PUT');
  assert.equal((await preview()).collections.length,2);
  await request(`/api/collections/${project}`,{alertsOnly:false},'PUT');
  assert.equal((await preview()).collections[0].id,other);
  await request(`/api/collections/${other}`,{notifyReady:false},'PUT');
  assert.equal((await preview()).allowed,true,'Disabling the last collection alert did not restore item notifications.');
  await request(`/api/collections/${project}`,{alertsOnly:true},'PUT');
  await observe({status:'SoldOut'},2); await observe({status:'Available'});
  assert.ok((await alerts()).some(event=>event.collectionId===project),'Collection-only mode suppressed the collection-ready alert.');
  assert.equal(query("SELECT id FROM notification_queue WHERE status='pending' AND json_extract(payload_json,'$.slug')=?",black).length,0);
  await request(`/api/collections/${other}`,{notifyReady:true},'PUT');
  await request(itemUrl(project),undefined,'DELETE');
  assert.equal((await preview()).reason,'collection-only');
  await request(`/api/collections/${other}`,undefined,'DELETE');
  assert.equal((await preview()).allowed,true);
  assert.ok((await details()).product.watched,'Removing collection membership removed the watch.');
  await request(`/api/collections/${project}`,{addSlugs:[black]},'PUT');
  await editItem(project,{quantity:4,purchasedQuantity:2,paidTotal:510.25});
  const saved=(await collection(project)).items;
  const exported=await request('/api/data/export');
  const encrypted=await request('/api/data/export/encrypted',{passphrase:'collection plans test recovery passphrase'});
  assert.equal(exported.formatVersion,8);
  await stop(); await start();
  assert.deepEqual((await collection(project)).items,saved,'Restart lost purchases.');
  assert.equal((await preview()).reason,'collection-only','Restart lost alert suppression.');
  const ca=(await request('/api/collections?region=ca')).collections;
  assert.deepEqual(ca,[],'Plans leaked into another region.');
  for (const change of [item=>item.quantity=0,item=>item.purchasedQuantity=100,item=>item.paidTotal=-1]) {
    const invalid=structuredClone(exported); change(invalid.regions.us.collections.find(item=>item.id===project).items[0]);
    await request('/api/data/import',{backup:invalid},'POST',400);
    assert.deepEqual((await collection(project)).items,saved);
  }
  await editItem(project,{paidTotal:1});
  await request('/api/data/import',{backup:exported});
  assert.deepEqual((await collection(project)).items,saved,'Recovery lost purchase costs or quantities.');
  assert.equal((await collection(project)).budget,900);
  assert.equal((await preview()).reason,'collection-only');
  await editItem(project,{paidTotal:2});
  await request('/api/data/import',{backup:encrypted,passphrase:'collection plans test recovery passphrase'});
  assert.deepEqual((await collection(project)).items,saved,'Encrypted recovery lost purchase records.');
  assert.equal((await collection(project)).alertsOnly,true);
  const support=await request('/api/operations/support-bundle');
  assert.ok(!JSON.stringify(support).includes('Purchase plan renamed'));
  const legacy=structuredClone(exported); legacy.formatVersion=5;
  for (const region of Object.values(legacy.regions)) for (const item of region.collections) { delete item.items; delete item.budget; delete item.alertsOnly; }
  legacy.regions.us.watchRules[black].purchasedAt=new Date().toISOString();
  await request('/api/data/import',{backup:legacy});
  assert.equal((await collection(project)).items[0].quantity,1);
  assert.equal((await collection(project)).alertsOnly,false);
  assert.equal((await collection(project)).items.find(item=>item.slug===black).purchasedQuantity,1,'Legacy recovery lost purchased state.');
  assert.equal((await collection(project)).planning.missingPaid,1,'Legacy recovery invented an actual purchase cost.');
  // Re-create the shipped schema-v9 layout in this disposable fixture and prove the real migration backfill.
  await stop();
  const migrationDb=new DatabaseSync(join(dataDir,'gearbeacon.mock.sqlite3'));
  migrationDb.exec('DELETE FROM schema_migrations WHERE version>9; ALTER TABLE watch_collections DROP COLUMN budget_required; ALTER TABLE watch_collections DROP COLUMN archived; ALTER TABLE watch_collections DROP COLUMN budget; ALTER TABLE watch_collections DROP COLUMN alerts_only; ALTER TABLE watch_collection_members DROP COLUMN paid_total; ALTER TABLE watch_collection_members DROP COLUMN purchased_quantity; ALTER TABLE watch_collection_members DROP COLUMN quantity;');
  const oldBackupCount=migrationDb.prepare('SELECT COUNT(*) AS count FROM backup_log').get().count;
  migrationDb.close();
  await start();
  const migrated=await collection(project);
  assert.deepEqual(migrated.items.find(item=>item.slug===black),{slug:black,quantity:1,purchasedQuantity:1,paidTotal:null});
  assert.deepEqual(migrated.items.find(item=>item.slug===white),{slug:white,quantity:1,purchasedQuantity:0,paidTotal:null});
  assert.equal(migrated.budget,null); assert.equal(migrated.alertsOnly,false); assert.equal(migrated.notifyReady,true);
  assert.ok(query('SELECT COUNT(*) AS count FROM backup_log')[0].count>oldBackupCount,'Schema-v9 migration did not record a safety backup.');
  console.log('COLLECTION PLANS TEST PASSED: quantities, partial purchases, recorded costs, budgets, shared targets, member retention, alert suppression/overlap/queue cancellation, restart, regional isolation, privacy, invalid input, plain/encrypted recovery, and schema-v9 purchase migration.');
} catch (err) { console.error(output.slice(-4000)); throw err; }
finally { await stop(); await new Promise(done=>webhook.close(done)); await rm(dataDir,{recursive:true,force:true}); }
