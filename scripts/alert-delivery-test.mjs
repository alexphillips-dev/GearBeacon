import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-alert-delivery-'));
const socket = net.createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const base = `http://127.0.0.1:${port}`;
const received = []; let rejectWebhook = false;
const webhook = http.createServer((req, res) => {
  let body = ''; req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => { received.push({ channel:req.url === '/ntfy' ? 'ntfy' : 'webhook', body:req.url === '/ntfy' ? body : JSON.parse(body) }); res.writeHead(rejectWebhook && req.url !== '/ntfy' ? 503 : 200); res.end('ok'); });
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
    NTFY_TOPIC:'ntfy', NTFY_BASE_URL:`http://127.0.0.1:${webhook.address().port}`, DISCORD_WEBHOOK_URL:'', GOTIFY_BASE_URL:'', GEARBEACON_WEBHOOK_URL:`http://127.0.0.1:${webhook.address().port}/test`, SMTP_HOST:'', SMTP_FROM:'', SMTP_TO:'', SMTP_USER:'', SMTP_PASSWORD:'',
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


const { renderEmail } = createRequire(import.meta.url)('../backend/dist/email.js');
function edit(sql, ...args) {
  const db = new DatabaseSync(join(dataDir, 'gearbeacon.mock.sqlite3'));
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}
const queue = () => query('SELECT * FROM notification_queue ORDER BY id');
const pending = () => queue().filter(row=>row.status==='pending');
const explain = () => request(`/api/watch/${encodeURIComponent(black)}/alerts`);
async function waitFor(test, message) {
  for (let i=0;i<200;i++) { if (await test()) return; await delay(25); }
  throw new Error(message);
}
async function deliver() {
  edit("UPDATE notification_queue SET next_attempt_at=? WHERE status='pending'", new Date(Date.now()-1000).toISOString());
  await request('/api/notifications/retry-failed',{});
  await waitFor(()=>!queue().some(row=>row.status==='processing' || row.status==='pending' && new Date(row.next_attempt_at).getTime()<=Date.now()),'Queue did not finish');
}
function agePending(minutes) {
  edit("UPDATE notification_queue SET payload_json=json_set(payload_json,'$.detectedAt',?) WHERE status='pending'",new Date(Date.now()-minutes*60000).toISOString());
}
async function restock() { await observe({status:'SoldOut'},2); await observe({status:'Available'}); }
try {
  await start();
  assert.equal((await request('/api/status')).storage.schemaVersion,13);
  assert.equal((await details()).product.freshness.state,'confirmed');
  const initial=(await details()).product.freshness.checkedAt;
  const config=(await request('/api/config')).config;
  const future=new Date(Date.now()+3600000).toISOString().slice(11,16);
  await request('/api/config',{config:{...config,digestEnabled:true,digestTime:future,notificationTimeZone:'UTC',notificationCooldownMinutes:0}},'PUT');
  await request('/api/watch',{slug:black});
  assert.deepEqual((await explain()).configuration.channels,['ntfy','webhook']);
  for (const rule of [{channels:'email'},{channels:['bogus']},{channels:[null]},{maxAlertAgeMinutes:0},{maxAlertAgeMinutes:10081},{maxAlertAgeMinutes:'5'},{maxAlertAgeMinutes:1.5}]) {
    await request(`/api/watch/${encodeURIComponent(black)}/rules`,{rule},'PUT',400);
  }
  await rules(black,{channels:['ntfy']}); await restock();
  assert.deepEqual(pending().map(row=>row.channel),['ntfy']);
  await rules(black,{channels:null}); await restock();
  assert.deepEqual(pending().slice(-2).map(row=>row.channel),['ntfy','webhook']);
  await rules(black,{channels:['webhook']});
  assert.ok(queue().filter(row=>row.channel==='ntfy').every(row=>row.status==='cancelled'));
  assert.deepEqual((await explain()).configuration.channels,['webhook']);
  const preview=await request(`/api/watch/${encodeURIComponent(black)}/preview`,{rule:{channels:['ntfy']}});
  assert.deepEqual(preview.configuredChannels,['ntfy'],'Preview did not use unsaved route');
  await rules(black,{channels:[]});
  assert.equal(pending().length,0);
  await request('/api/notifications/preferences',{allActivity:true},'PUT');
  await restock(); assert.equal(pending().length,0,'All activity bypassed the explicit empty route');
  await request('/api/notifications/preferences',{allActivity:false},'PUT');
  await rules(black,{channels:['webhook'],maxAlertAgeMinutes:null}); await restock();
  const held=pending()[0]; assert.ok(held);
  const original=query('SELECT data_json FROM events WHERE id=?',held.event_id)[0].data_json;
  agePending(2); await observe({status:'SoldOut'},2);
  await deliver();
  const delivered=received.find(item=>item.channel==='webhook').body;
  const delayed=delivered.event.type==='digest' ? delivered.event.events[0] : delivered.event;
  assert.equal(delayed.status,'Available','Delivery overwrote original stock evidence');
  assert.equal(delayed.deliveryContext.status,'Sold out');
  assert.equal(delayed.deliveryContext.freshness.state,'confirmed');
  assert.ok(delayed.deliveryContext.message.includes('Detected '));
  assert.ok(!delivered.message.includes('detected now'));
  assert.equal(query('SELECT data_json FROM events WHERE id=?',held.event_id)[0].data_json,original,'Sending changed Activity evidence');
  assert.ok(query('SELECT detail FROM notification_log WHERE event_id=? AND status=?',held.event_id,'sent')[0].detail.includes('Latest confirmed status: Sold out'));
  assert.ok(!JSON.stringify(await request('/api/operations/support-bundle')).includes('Latest confirmed status:'), 'Support bundle exposed delayed product context');
  for (const detailLevel of ['compact','standard','detailed']) {
    for (const event of [delayed,{type:'digest',events:[delayed],region:'us'}]) {
      const email=renderEmail(event,{detailLevel,theme:'light'});
      assert.ok(email.html.includes('Latest confirmed status: Sold out'));
      assert.ok(email.text.includes('Latest confirmed status: Sold out'));
      assert.ok(email.html.includes('Delayed alert'));
    }
  }
  assert.match(renderEmail(delayed).subject,/Delayed alert/);
  const escaped=renderEmail({...delayed,deliveryContext:{message:'<script>bad()</script>'}});
  assert.ok(!escaped.html.includes('<script>'));

  // Parent watches with a matching variant retain the identity of the triggering variant.
  await request('/api/watch',{slug:parent});
  await rules(black,{channels:[]});
  await rules(parent,{channels:['webhook'],targetPrice:300,availableUnderTarget:true});
  await restock();
  assert.ok(pending().some(row=>JSON.parse(row.payload_json).sourceSlug===black));
  agePending(2); await observe({status:'SoldOut'},2); received.length=0; await deliver();
  const parentEvent=received[0].body.event;
  assert.equal(parentEvent.slug,parent); assert.equal(parentEvent.sourceSlug,black);
  assert.equal(parentEvent.deliveryContext.status,'Sold out','Delayed Any variant alert used the still-available sibling');
  await rules(parent,{channels:[]}); await rules(black,{channels:['webhook'],maxAlertAgeMinutes:1});
  await restock(); agePending(2); const expiring=pending()[0]; received.length=0; await deliver();
  assert.equal(received.length,0,'An expired restock was delivered');
  assert.equal(queue().find(row=>row.id===expiring.id).status,'cancelled');
  const expiredActivity=(await request('/api/activity?scope=us')).events.find(event=>event.id===expiring.event_id);
  assert.equal(expiredActivity.serverAlert.label,'Expired');
  await request('/api/notifications/retry-failed',{}); assert.equal(received.length,0,'Manual retry revived an expired job');

  // Failed deliveries cannot evade expiry when retried.
  await rules(black,{maxAlertAgeMinutes:1}); await restock();
  rejectWebhook=true; await deliver(); rejectWebhook=false;
  const failed=pending()[0]; assert.equal(failed.attempts,1);
  agePending(2); received.length=0; await deliver(); assert.equal(received.length,0);
  assert.equal(queue().find(row=>row.id===failed.id).status,'cancelled');

  await rules(black,{maxAlertAgeMinutes:null}); await restock();
  agePending(2); await observe({status:'SoldOut'});
  assert.equal((await details()).product.freshness.state,'pending');
  assert.equal((await details(parent)).product.freshness.state,'pending');
  assert.equal((await details()).product.inStock,true,'Pending sellout replaced last known stock');
  received.length=0; await deliver(); assert.equal(received[0].body.event.deliveryContext.freshness.state,'pending');
  await observe({status:'SoldOut'}); assert.equal((await details()).product.freshness.state,'confirmed');
  assert.ok(new Date((await details()).product.freshness.checkedAt)>=new Date(initial));
  await request('/api/mock/fault',{partialOmitSlugs:['unas-pro']}); await check();
  assert.equal((await details()).product.freshness.state,'stale','Partial catalog was presented as fresh');
  assert.equal((await request(`/api/products/${encodeURIComponent(black)}?region=ca`)).product.freshness.state,'confirmed','US failure contaminated Canada');
  await request('/api/mock/fault',{reset:true}); await check();
  await restock(); agePending(2); await request('/api/mock/fault',{rateLimitOnceSeconds:1}); await request('/api/check',{},'POST',502);
  received.length=0; await deliver(); assert.equal(received[0].body.event.deliveryContext.freshness.state,'stale');
  await request('/api/mock/fault',{reset:true}); await check();


  // Expiry also covers confirmed price opportunities, but not ordinary sellout events.
  await rules(black,{channels:[],maxAlertAgeMinutes:1});
  await observe({status:'Available',displayPrice:'$400.00'},2);
  await rules(black,{channels:['webhook'],restock:false,priceChange:true,priceDropOnly:true});
  await observe({displayPrice:'$350.00'},2);
  assert.ok(pending().some(row=>JSON.parse(row.payload_json).alertKind==='price_drop'));
  agePending(2); received.length=0; await deliver(); assert.equal(received.length,0,'An expired price drop was delivered');
  await rules(black,{targetPrice:300,availableUnderTarget:true});
  await observe({displayPrice:'$250.00'},2);
  assert.ok(pending().some(row=>JSON.parse(row.payload_json).alertKind==='target_price'));
  agePending(2); received.length=0; await deliver(); assert.equal(received.length,0,'An expired target alert was delivered');
  await rules(black,{targetPrice:null,availableUnderTarget:false,priceChange:false,priceDropOnly:false,restock:true,soldOut:true});
  await restock(); agePending(2); received.length=0; await deliver();
  assert.ok(received.length===1 && received[0].body.event.type==='sold_out','Expiry discarded ordinary sellout history or retained the expired restock');
  await rules(black,{maxAlertAgeMinutes:null,soldOut:false});
  await restock(); agePending(2); const beforeRestart=pending()[0];
  await stop(); await start(); received.length=0; await deliver();
  assert.ok(received.some(item=>item.body.event.id===beforeRestart.event_id && item.body.event.deliveryContext),'Delayed pending delivery lost its snapshot across restart');
  const project=(await request('/api/collections',{name:'Delivery test',slugs:[black]})).id;
  const projectUrl=`/api/collections/${project}`;
  for (const value of [{channels:['bad']},{maxAlertAgeMinutes:-1}]) await request(projectUrl,value,'PUT',400);
  await request(projectUrl,{notifyReady:true,alertsOnly:true,channels:['ntfy'],maxAlertAgeMinutes:30},'PUT');
  await restock();
  assert.deepEqual(pending().map(row=>row.channel),['ntfy']);
  assert.equal(JSON.parse(pending()[0].payload_json).type,'collection_ready');
  assert.deepEqual((await request(`${projectUrl}/alerts`)).configuration.channels,['ntfy']);
  await request(projectUrl,{channels:['webhook']},'PUT'); assert.equal(pending().length,0,'Collection route edit retained an old destination');
  await restock(); agePending(2); await observe({status:'SoldOut'},2); received.length=0; await deliver();
  assert.equal(received[0].body.event.deliveryContext.status,'Not ready');
  await request(projectUrl,{maxAlertAgeMinutes:1},'PUT'); await restock(); agePending(2); received.length=0; await deliver(); assert.equal(received.length,0);
  // Routes and expiry survive restarts, exports and the v12 safety migration.
  const snapshot=await request('/api/data/export'); assert.equal(snapshot.formatVersion,9);
  await stop(); await start();
  assert.deepEqual((await collection(project)).channels,['webhook']); assert.equal((await collection(project)).maxAlertAgeMinutes,1);
  await request('/api/data/import',{backup:snapshot});
  assert.deepEqual((await details()).product.watchRule.channels,['webhook']);
  assert.equal((await collection(project)).maxAlertAgeMinutes,1);
  const invalid=structuredClone(snapshot); invalid.regions.us.collections[0].channels=['bad'];
  await request('/api/data/preview',{backup:invalid},'POST',400);
  const legacy=structuredClone(snapshot); legacy.formatVersion=8;
  for (const region of Object.values(legacy.regions)) {
    for (const value of [...Object.values(region.watchRules),...region.collections]) { delete value.channels; delete value.maxAlertAgeMinutes; }
  }
  await request('/api/data/import',{backup:legacy});
  assert.equal((await details()).product.watchRule.channels,null); assert.equal((await collection(project)).maxAlertAgeMinutes,null);
  const support=JSON.stringify(await request('/api/operations/support-bundle'));
  assert.ok(!support.includes('Delivery test') && !support.includes(black));
  await stop();
  edit('DELETE FROM schema_migrations WHERE version=13'); edit('ALTER TABLE watch_collections DROP COLUMN delivery_json');
  const backups=query('SELECT COUNT(*) AS count FROM backup_log')[0].count;
  await start();
  assert.equal((await request('/api/status')).storage.schemaVersion,13);
  assert.equal((await collection(project)).channels,null);
  assert.ok(query('SELECT COUNT(*) AS count FROM backup_log')[0].count>backups,'Migration did not make a safety backup');
  console.log('ALERT DELIVERY TEST PASSED: routes/defaults/previews, cancellation, delayed snapshots and email/digests, expiry/retries, variant and regional freshness, collections, recovery and v12 migration.');
} catch (err) { console.error(output.slice(-2000)); throw err; }
finally { await stop(); await new Promise(done=>webhook.close(done)); await rm(dataDir,{recursive:true,force:true}); }
