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
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-budget-alerts-'));
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
  assert.equal((await request('/api/collections')).capabilities.budgetAlerts,true);
  const config=(await request('/api/config')).config;
  await request('/api/config',{config:{...config,digestEnabled:true,digestTime:'12:34',notificationTimeZone:'UTC',notificationCooldownMinutes:0}},'PUT');
  for (const slug of [black,white,parent]) await request('/api/watch',{slug});
  const project=(await request('/api/collections',{name:'Budget project',slugs:[black],budget:1000})).id;
  const edit = body => request(`/api/collections/${project}`,body,'PUT');
  const count = async () => (await alerts()).filter(event=>event.collectionId===project).length;
  await editItem(project,{quantity:3,purchasedQuantity:1,paidTotal:250});
  assert.equal((await collection(project)).budgetRequired,false);
  await edit({notifyReady:true,budgetRequired:true,alertsOnly:true});
  await observe({status:'Available',displayPrice:'$400.00'},2);
  let value=await collection(project);
  assert.equal(value.readiness.budget.total,1050);
  assert.equal(value.readiness.budget.state,'over');
  assert.equal(value.readiness.ready,false);
  assert.equal(await count(),0,'Over-budget collection sent a readiness alert.');
  await observe({displayPrice:'$375.00'});
  assert.equal((await collection(project)).readiness.budget.state,'unknown','Pending price was treated as confirmed.');
  assert.equal(await count(),0);
  await check();
  value=await collection(project);
  assert.equal(value.readiness.budget.total,1000);
  assert.equal(value.readiness.budget.difference,0);
  assert.equal(value.readiness.ready,true,'Exact budget boundary should qualify.');
  assert.equal(await count(),1);
  const event=(await alerts()).find(event=>event.collectionId===project);
  assert.match(event.detail,/1000.00 USD.*within budget/);
  assert.equal(event.readiness.budget.state,'within');
  assert.match((await request(`/api/collections/${project}/alerts`)).configuration.reasons.join(' '),/within budget/);
  await check(); await stop(); await start(); await check();
  assert.equal(await count(),1,'Restart or another observation duplicated a budget alert.');
  await request('/api/mock/fault',{partialOmitSlugs:['udm-se']}); await check();
  assert.equal((await collection(project)).readiness.budget.state,'unknown');
  await request('/api/mock/fault',{reset:true}); await check();
  assert.equal(await count(),1,'An incomplete catalog rearmed the budget alert.');
  // A transient candidate over budget cannot rearm a collection that already qualified.
  await observe({displayPrice:'$401.00'});
  assert.equal((await collection(project)).readiness.budget.state,'unknown');
  await observe({displayPrice:'$375.00'},2);
  assert.equal(await count(),1,'Pending price rearmed the collection.');
  await observe({displayPrice:'$410.00'},2);
  assert.equal((await collection(project)).readiness.budget.state,'over');
  await observe({displayPrice:'$370.00'},2);
  assert.equal(await count(),2,'Confirmed return under budget did not rearm.');
  await edit({budget:1100});
  assert.equal(jobs().filter(job=>JSON.parse(job.payload_json).collectionId===project && ['pending','failed'].includes(job.status)).length,0,'Budget edits left old deliveries queued.');
  await check(); assert.equal(await count(),2,'Saving a budget generated a catch-up alert.');
  await editItem(project,{paidTotal:null});
  assert.equal((await collection(project)).readiness.budget.state,'unknown');
  assert.equal((await collection(project)).readiness.ready,false);
  await editItem(project,{paidTotal:0});
  assert.equal((await collection(project)).readiness.budget.total,740,'Zero paid should be a known cost.');
  await edit({budget:null});
  assert.equal((await collection(project)).budgetRequired,true);
  assert.equal((await collection(project)).readiness.budget.state,'unknown','Clearing a budget silently removed the constraint.');
  await edit({budget:0});
  assert.equal((await collection(project)).readiness.budget.state,'over');
  await observe({displayPrice:'Price unavailable'},2);
  assert.equal((await collection(project)).readiness.budget.state,'unknown','Missing price was treated as zero.');
  await edit({budgetRequired:false});
  assert.equal((await collection(project)).readiness.ready,true,'Opting out should preserve ordinary readiness.');
  await edit({budgetRequired:true,budget:1000});
  await observe({displayPrice:'$370.00'},2);
  const before=await count();
  await editItem(project,{purchasedQuantity:3,paidTotal:740}); await check();
  assert.equal((await collection(project)).readiness.ready,false,'Fully purchased collection qualified.');
  assert.equal(await count(),before);
  await request(`/api/collections/${project}`,{budgetRequired:'yes',name:'Invalid edit'},'PUT',400);
  assert.equal((await collection(project)).name,'Budget project');
  // Any-variant cost must come from the available variant meeting the shared target.
  await observe({status:'SoldOut',displayPrice:'$10.00'},2);
  const any=(await request('/api/collections',{name:'Any variant budget',slugs:[parent],budget:100})).id;
  await request(`/api/collections/${any}`,{budgetRequired:true},'PUT');
  assert.equal((await collection(any)).readiness.budget.total,329);
  assert.equal((await collection(any)).readiness.ready,false,'An unavailable cheaper variant satisfied the budget.');
  await request(`/api/collections/${any}`,{budget:329},'PUT');
  assert.equal((await collection(any)).readiness.ready,true);
  assert.equal((await collection(any)).readiness.items[0].matchingSlug,white);
  assert.equal((await request('/api/collections?region=ca')).collections.length,0);
  const snapshot=await request('/api/data/export'); assert.equal(snapshot.formatVersion,9);
  const encrypted=await request('/api/data/export/encrypted',{passphrase:'budget alert fixture recovery phrase'});
  await edit({budgetRequired:false});
  await request('/api/data/import',{backup:snapshot});
  assert.equal((await collection(project)).budgetRequired,true);
  await edit({budgetRequired:false});
  await request('/api/data/import',{backup:encrypted,passphrase:'budget alert fixture recovery phrase'});
  assert.equal((await collection(project)).budgetRequired,true);
  const bad=structuredClone(snapshot); bad.regions.us.collections[0].budgetRequired='yes';
  await request('/api/data/import',{backup:bad},'POST',400);
  assert.equal((await collection(project)).budgetRequired,true);
  const legacy=structuredClone(snapshot); legacy.formatVersion=7;
  for (const region of Object.values(legacy.regions)) for (const value of region.collections) delete value.budgetRequired;
  await request('/api/data/import',{backup:legacy});
  assert.equal((await collection(project)).budgetRequired,false,'Older recovery unexpectedly opted into budget alerts.');
  // Anchored Activity pages stay stable while real catalog events are appended.
  const first=await request('/api/activity?scope=us&limit=10');
  const anchor=encodeURIComponent(first.snapshot);
  await observe({status:'Available'});
  const held=await request(`/api/activity?scope=us&limit=10&snapshot=${anchor}`);
  assert.deepEqual(held.events.map(event=>event.id),first.events.map(event=>event.id));
  assert.equal(held.count,first.count); assert.ok(held.newCount>0);
  const live=await request('/api/activity?scope=us&limit=10');
  assert.ok(live.count>first.count);
  const caPage=await request('/api/activity?scope=ca');
  const caHeld=await request(`/api/activity?scope=ca&snapshot=${anchor}`);
  assert.equal(caHeld.newCount,0,'Snapshot new-event count ignored the region filter.');
  assert.equal(caHeld.count,caPage.count);
  const missingAnchor=await request('/api/activity?snapshot=1:deleted-event');
  assert.equal(missingAnchor.snapshotReset,true,'Missing snapshot anchor was not identified.');
  const exportedActivity=await request(`/api/activity/export?scope=us&format=json&snapshot=${anchor}`);
  assert.equal(exportedActivity.count,live.count,'Export was limited to the reading snapshot.');
  await request('/api/activity?snapshot=invalid',undefined,'GET',400);
  // Recreate exactly the shipped v11 layout in this disposable database.
  await stop();
  const migrationDb=new DatabaseSync(join(dataDir,'gearbeacon.mock.sqlite3'));
  migrationDb.exec('DELETE FROM schema_migrations WHERE version>=12; ALTER TABLE watch_collections DROP COLUMN delivery_json; ALTER TABLE watch_collections DROP COLUMN budget_required;');
  const backupCount=migrationDb.prepare('SELECT COUNT(*) AS count FROM backup_log').get().count;
  migrationDb.close(); await start();
  assert.equal((await request('/api/status')).storage.schemaVersion,13);
  assert.equal((await collection(project)).budgetRequired,false);
  assert.equal((await collection(project)).items[0].paidTotal,740);
  assert.ok(query('SELECT COUNT(*) AS count FROM backup_log')[0].count>backupCount);
  console.log('BUDGET ALERTS TEST PASSED: budget boundary, confirmed prices, quantities, paid/unknown costs, variants, baseline/queue/restart, recovery, migration, and stable Activity pages.');
} catch (err) { console.error(output.slice(-4000)); throw err; }
finally { await stop(); await new Promise(done=>webhook.close(done)); await rm(dataDir,{recursive:true,force:true}); }
