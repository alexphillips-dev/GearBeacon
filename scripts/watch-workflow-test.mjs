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
  const overview=async()=> (await request('/api/products')).overview;
  const add=body=>request('/api/watch/add',body);
  const watched=slug=>details(slug).then(result=>result.product.watched);
  assert.equal((await request('/api/collections')).capabilities.watchWorkflow,true);
  const initial=await add({slug:black,collectionName:'Build project',quantity:3}); const id=initial.collectionId;
  assert.equal(initial.product.watched,true); assert.equal(initial.product.variantId,'mock-black');
  assert.deepEqual((await collection(id)).items,[{slug:black,quantity:3,purchasedQuantity:0,paidTotal:null}]);
  assert.equal(await watched(parent),false,'Adding an exact variant also watched its parent.');
  await editItem(id,{purchasedQuantity:1,paidTotal:270,targetPrice:300});
  const preserved=(await collection(id)).items;
  const watchBefore=(await details()).product;
  const duplicate=await add({slug:black,collectionId:id,quantity:99});
  assert.equal(duplicate.alreadyMember,true); assert.equal(duplicate.alreadyWatched,true);
  assert.deepEqual((await collection(id)).items,preserved,'Repeated Add overwrote quantity or payments.');
  assert.deepEqual((await details()).product.watchRule,watchBefore.watchRule);
  assert.equal((await details()).product.watchedAt,watchBefore.watchedAt);
  await add({slug:white});
  assert.ok((await overview()).readyToBuy.includes(white));
  assert.ok(!(await overview()).targetMet.includes(white));
  await rules(white,{targetPrice:320});
  assert.ok(!(await overview()).readyToBuy.includes(white),'Above-target item counted as ready.');
  await rules(white,{targetPrice:329});
  assert.ok((await overview()).targetMet.includes(white));
  await add({slug:parent}); await rules(parent,{targetPrice:300});
  assert.ok(!(await overview()).readyToBuy.includes(parent),'Any-variant readiness mixed cheap sold-out and expensive available variants.');
  await observe({status:'Available'});
  assert.ok((await overview()).readyToBuy.includes(black));
  assert.ok((await overview()).targetMet.includes(parent));
  assert.ok((await overview()).collectionsReady.includes(id));
  await observe({status:'SoldOut'});
  assert.equal((await details()).product.inStock,true,'Test did not retain the pending last-known-good status.');
  assert.ok(!(await overview()).readyToBuy.includes(black),'Pending sellout was presented as ready to buy.');
  await check(); await observe({status:'Available'});
  await editItem(id,{purchasedQuantity:3,paidTotal:800});
  assert.ok(!(await overview()).readyToBuy.includes(black),'Fully purchased project item counted as remaining.');
  assert.ok(!(await overview()).collectionsReady.includes(id));
  const second=(await add({slug:black,collectionName:'Second build'})).collectionId;
  assert.ok((await overview()).readyToBuy.includes(black),'A remaining shared project item was excluded.');
  await request(`/api/collections/${second}`,{archived:true},'PUT');
  assert.ok(!(await overview()).readyToBuy.includes(black),'Archived-only demand counted in the active overview.');
  await request(`/api/collections/${second}`,{archived:false,notifyReady:true,alertsOnly:true},'PUT');
  await editItem(id,{purchasedQuantity:1,paidTotal:270});
  await request(`/api/collections/${id}`,{notifyReady:true,alertsOnly:true,budget:2000},'PUT');
  assert.equal((await preview()).collections.length,2);
  const config=(await request('/api/config')).config;
  await request('/api/config',{config:{...config,digestEnabled:true,digestTime:'12:34',notificationTimeZone:'UTC',notificationCooldownMinutes:0}},'PUT');
  await observe({status:'SoldOut'},2); await observe({status:'Available'});
  assert.ok(jobs().some(job=>job.status==='pending'),'Ready collection did not queue an alert.');
  const beforeArchive=await collection(id);
  await request(`/api/collections/${id}`,{archived:true},'PUT');
  assert.equal((await collection(id)).notifyReady,true,'Archive erased saved alert settings.');
  assert.deepEqual((await collection(id)).items,beforeArchive.items);
  assert.equal((await collection(id)).budget,2000);
  assert.equal((await preview()).collections.length,1,'Archive did not release its override independently.');
  assert.ok(jobs().filter(job=>JSON.parse(job.payload_json).collectionId===id).every(job=>job.status==='cancelled'));
  await request(`/api/collections/${second}`,{archived:true},'PUT');
  assert.notEqual((await preview()).reason,'collection-only');
  await request('/api/watch/add',{slug:'udm-se',collectionId:id,quantity:2},'POST',409);
  assert.equal(await watched('udm-se'),false,'Rejected archive destination created a watch.');
  await request('/api/watch/add',{slug:'udm-se',collectionName:'Bad quantity',quantity:0},'POST',400);
  await request('/api/watch/add',{slug:'udm-se',collectionId:'missing'},'POST',404);
  await request('/api/watch/add',{slug:'udm-se',collectionName:'Build project'},'POST',409);
  assert.equal(await watched('udm-se'),false);
  const savedRule=(await details()).product.watchRule;
  const encrypted=await request('/api/data/export/encrypted',{passphrase:'workflow recovery fixture password'});
  const plain=await request('/api/data/export'); assert.equal(plain.formatVersion,7);
  await request(`/api/collections/${id}`,{archived:false},'PUT');
  const eventsBefore=(await alerts()).length;
  await check(); assert.equal((await alerts()).length,eventsBefore,'Restoring an already-ready collection sent an immediate alert.');
  await request('/api/data/import',{backup:encrypted,passphrase:'workflow recovery fixture password'});
  assert.equal((await collection(id)).archived,true); assert.deepEqual((await collection(id)).items,beforeArchive.items);
  await stop(); await start();
  assert.equal((await collection(id)).archived,true);
  assert.notEqual((await preview()).reason,'collection-only');
  assert.deepEqual((await details()).product.watchRule,savedRule);
  const retainedEvents=(await alerts()).length;
  await observe({status:'SoldOut'},2); await observe({status:'Available'});
  assert.equal((await alerts()).length,retainedEvents,'Archived collection produced a readiness event.');
  // Undo returns the exact purchase record without mutating shared rules or overwriting a later membership.
  await request(`/api/collections/${id}`,{archived:false},'PUT');
  const removed=await request(itemUrl(id),undefined,'DELETE');
  assert.deepEqual(removed.removedItem,beforeArchive.items[0]);
  const restored=await request(itemUrl(id),removed.removedItem,'POST');
  assert.deepEqual(restored.collections.find(item=>item.id===id).items,beforeArchive.items);
  assert.deepEqual((await details()).product.watchRule,savedRule);
  await request(itemUrl(id),removed.removedItem,'POST',409);
  await request(itemUrl(id),undefined,'DELETE');
  await add({slug:black,collectionId:id,quantity:5});
  await request(itemUrl(id),removed.removedItem,'POST',409);
  assert.equal((await collection(id)).items[0].quantity,5,'Undo overwrote a product added again after removal.');
  await request(itemUrl(id),undefined,'DELETE');
  await request(itemUrl(id),{quantity:3,purchasedQuantity:4},'POST',400);
  assert.equal((await collection(id)).items.length,0);
  // A failed combined Add rolls back both membership and watch creation.
  const faultDb=new DatabaseSync(join(dataDir,'gearbeacon.mock.sqlite3'));
  try {
    faultDb.exec("CREATE TRIGGER workflow_add_failure BEFORE INSERT ON watch_collection_members BEGIN SELECT RAISE(ABORT,'mock transaction failure'); END");
    await request('/api/watch/add',{slug:'udm-se',collectionName:'Failed project',quantity:2},'POST',500);
    assert.equal(await watched('udm-se'),false);
    assert.ok(!(await collections()).some(item=>item.name==='Failed project'));
  } finally { faultDb.exec('DROP TRIGGER workflow_add_failure'); faultDb.close(); }
  await add({slug:'udm-se',collectionId:id,quantity:2});
  assert.equal(await watched('udm-se'),true);
  const regional=await request('/api/products?region=ca');
  assert.deepEqual(regional.overview.readyToBuy,[]); assert.deepEqual(regional.collections,[]);
  const invalid=structuredClone(plain); invalid.regions.us.collections[0].archived='yes';
  await request('/api/data/import',{backup:invalid},'POST',400);
  const legacy=structuredClone(plain); legacy.formatVersion=6;
  for (const region of Object.values(legacy.regions)) for (const entry of region.collections) delete entry.archived;
  await request('/api/data/import',{backup:legacy});
  assert.ok((await collections()).every(item=>item.archived===false));
  await request(`/api/collections/${id}`,{archived:true},'PUT');
  const archivedRecord=(await collection(id)).items;
  await request('/api/watch/bulk',{action:'purchased',slugs:[black]});
  await request('/api/watch/bulk',{action:'wanted',slugs:[black]});
  assert.deepEqual((await collection(id)).items,archivedRecord,'Shared watch purchase actions erased archived history.');
  await request('/api/watch/bulk',{action:'purchased',slugs:[black]});
  const future=(await add({slug:black,collectionName:'Next purchase'})).collectionId;
  await observe({status:'Available'});
  assert.ok((await overview()).readyToBuy.includes(black),'A new project with remaining units was hidden by an older shared purchased flag.');
  assert.equal((await collection(future)).items[0].purchasedQuantity,0);
  console.log('WATCH WORKFLOW TEST PASSED: confirmed overview/variants/targets/quantities, direct Add/deduplication/atomic rollback, archive/restore/overlap/queued alerts, undo conflicts, restart, regional isolation, and recovery.');
} catch (err) { console.error(output.slice(-4000)); throw err; }
finally { await stop(); await new Promise(done=>webhook.close(done)); await rm(dataDir,{recursive:true,force:true}); }
