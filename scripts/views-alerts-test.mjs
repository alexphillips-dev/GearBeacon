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


const explain = (slug=black) => request(`/api/watch/${encodeURIComponent(slug)}/alerts`);
try {
  await start();
  const health = await request('/healthz'); assert.equal(health.packageVersion, health.version);
  assert.deepEqual((await request('/api/views')).views, []);
  const create = (body, status=200) => request('/api/views',body,'POST',status);
  let view = (await create({name:'Ready WiFi',scope:'watchlist',filters:{search:'WiFi',status:'in',layout:'compact',groupCollections:true}})).view;
  assert.equal(view.revision,1); assert.equal(view.filters.collection,'all'); assert.equal(view.filters.layout,'compact');
  await create({name:'ready wifi',scope:'watchlist',filters:{}},409);
  for (const body of [{name:'',scope:'browse',filters:{}},{name:'bad',scope:'invalid',filters:{}},{name:'bad',scope:'browse',filters:{search:'a'.repeat(201)}},{name:'bad',scope:'watchlist',filters:{status:'bogus'}},{name:'bad',scope:'watchlist',filters:{groupCollections:'true'}},{name:'bad',scope:'watchlist',filters:{collection:'missing'}}]) await create(body,400);
  await request(`/api/views/${view.id}`,{name:'Stale',revision:0},'PUT',409);
  const [one,two] = await Promise.all([fetch(base+`/api/views/${view.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Changed A',revision:1})}),fetch(base+`/api/views/${view.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Changed B',revision:1})})]);
  assert.deepEqual([one.status,two.status].sort(),[200,409]);
  view=(await request('/api/views')).views[0]; assert.equal(view.revision,2);
  await request(`/api/views/${view.id}`,{revision:1},'DELETE',409);
  assert.deepEqual((await request('/api/views?region=ca')).views,[]);
  await request(`/api/views/${view.id}?region=ca`,{revision:2},'DELETE',404);
  const ca=(await request('/api/views?region=ca',{name:'Canadian view',scope:'browse',filters:{availability:'in',sort:'price-low'}})).view;
  await stop(); await start();
  assert.equal((await request('/api/views')).views[0].id,view.id);
  assert.equal((await request('/api/views?region=ca')).views[0].id,ca.id);
  const saved=await request('/api/data/export'); assert.ok(saved.settings.owner_views.includes(view.id));
  const sharedIds=structuredClone(saved); const importedViews=JSON.parse(sharedIds.settings.owner_views); importedViews.find(item=>item.region==='ca').id=view.id; sharedIds.settings.owner_views=JSON.stringify(importedViews);
  await request('/api/data/import',{backup:sharedIds});
  await request(`/api/views/${view.id}`,{revision:2,name:'US rename'},'PUT');
  assert.equal((await request('/api/views?region=ca')).views[0].id,view.id,'Imported duplicate identity crossed region boundaries.');
  await request('/api/data/import',{backup:saved});
  assert.ok(!JSON.stringify(await request('/api/operations/support-bundle')).includes(view.name),'Support bundle exposed saved view data.');
  await request(`/api/views/${view.id}`,{revision:2},'DELETE');
  await request('/api/data/import',{backup:saved});
  assert.equal((await request('/api/views')).views[0].id,view.id);
  const malformed=structuredClone(saved); malformed.settings.owner_views=JSON.stringify([{id:'bad',name:'bad',region:'us',scope:'watchlist',revision:1,filters:{layout:'script'}}]);
  await request('/api/data/import',{backup:malformed}); assert.deepEqual((await request('/api/views')).views,[]);
  await request('/api/data/import',{backup:saved});
  for (let i=1;i<30;i++) await create({name:`View ${i}`,scope:'browse',filters:{}});
  await create({name:'One too many',scope:'browse',filters:{}},400);
  assert.equal((await request('/api/views?region=ca')).views.length,1);
  await request('/api/data/import',{backup:saved});

  await request('/api/watch',{slug:black});
  let value=await explain(); assert.equal(value.configuration.state,'active'); assert.deepEqual(value.configuration.channels,['webhook']); assert.deepEqual(value.delivery,[]);
  assert.equal((await details()).product.alertSummary.label,value.configuration.label);
  await rules(black,{pausedUntil:'indefinite'}); assert.equal((await explain()).configuration.state,'off');
  await request('/api/notifications/preferences',{allActivity:true},'PUT');
  assert.equal((await explain()).configuration.label,'All activity alerts enabled');
  await rules(black,{purchasedAt:new Date().toISOString()}); assert.equal((await explain()).configuration.label,'Purchased · alerts stopped');
  await rules(black,{purchasedAt:null,pausedUntil:null,restock:true});
  const project=(await request('/api/collections',{name:'Shared alerts'})).id;
  await request(`/api/collections/${project}`,{addSlugs:[black],notifyReady:true,alertsOnly:true},'PUT');
  value=await explain(); assert.equal(value.configuration.state,'suppressed'); assert.ok(value.configuration.label.includes('Shared alerts')); assert.deepEqual(value.plans,[]);
  assert.equal((await request(`/api/collections/${project}/alerts`)).configuration.state,'active');
  await request(`/api/collections/${project}`,{archived:true},'PUT');
  assert.equal((await request(`/api/collections/${project}/alerts`)).configuration.state,'off');
  assert.equal((await explain()).configuration.state,'active');
  await request('/api/notifications/preferences',{allActivity:false,restock:true,priceChange:false,soldOut:false,statusChange:false},'PUT');
  await rules(black,{targetPrice:300,availableUnderTarget:true});
  assert.ok((await explain()).configuration.label.includes('Available-at-target'));
  await rules(black,{targetPrice:null,availableUnderTarget:false,immediateRestock:false});
  const config=(await request('/api/config')).config;
  await request('/api/config',{config:{...config,digestEnabled:true,digestTime:'12:34',notificationTimeZone:'UTC',notificationCooldownMinutes:30}},'PUT');
  value=await explain(); assert.ok(value.plans.every(plan=>plan.mode==='digest')); assert.equal(value.delivery.length,0,'A schedule preview invented a queue job.');
  await observe({status:'Available'});
  value=await explain(); assert.ok(value.delivery.some(job=>job.status==='pending' && job.mode==='digest')); assert.ok(value.cooldowns.some(row=>row.type==='restock'));
  assert.ok(!JSON.stringify(value).includes('/test'),'Explanation leaked a notification endpoint.');
  await rules(black,{immediateRestock:true}); assert.equal((await explain()).plans.find(plan=>plan.type==='restock').mode,'immediate-restock');
  await request('/api/config',{config:{...config,digestEnabled:false,notificationGroupSeconds:60}},'PUT');
  await rules(black,{immediateRestock:false}); assert.equal((await explain()).plans[0].mode,'grouped');
  await request('/api/config',{config:{...config,channelEnabled:{webhook:false}}},'PUT');
  value=await explain(); assert.equal(value.configuration.state,'no-channel'); assert.deepEqual(value.configuration.channels,[]); assert.deepEqual(value.plans,[]);
  await request('/api/watch/missing/alerts',undefined,'GET',404);
  await request(`/api/watch/${encodeURIComponent(black)}/alerts?region=ca`,undefined,'GET',404);
  console.log('VIEWS AND ALERTS TEST PASSED: revision conflicts, limits, validation, regional isolation, restart/import, effective rules, schedules, real queued jobs and channel state.');
} catch (err) { console.error(output.slice(-4000)); throw err; }
finally { await stop(); await new Promise(done=>webhook.close(done)); await rm(dataDir,{recursive:true,force:true}); }
