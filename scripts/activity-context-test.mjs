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
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-activity-context-'));
const socket = net.createServer();
await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise(done => socket.close(done));
const base = `http://127.0.0.1:${port}`;
const delivery = http.createServer((req,res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('ok'); }); });
await new Promise(done => delivery.listen(0,'127.0.0.1',done));
const parent = 'uvc-g5-ptz', black = `${parent}::context-black`, white = `${parent}::context-white`;
let variants = [
  {id:'context-black',slug:'context-black',sku:'CONTEXT-B',title:'Black',status:'SoldOut',displayPrice:'$299.00'},
  {id:'context-white',slug:'context-white',sku:'CONTEXT-W',title:'White',status:'Available',displayPrice:'$329.00'},
];
let output = '';
const server = spawn(process.execPath,['--no-warnings','backend/dist/index.js'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{
  ...process.env,MOCK_MODE:'1',PORT:String(port),POLL_SECONDS:'86400',REGIONS:'us,ca',GEARBEACON_DATA_DIR:dataDir,
  GEARBEACON_SKIP_LEGACY_IMPORT:'1',GEARBEACON_BACKUP_INTERVAL_HOURS:'0',GEARBEACON_GITHUB_RELEASE_API:'',
  GEARBEACON_ACCESS_MODE:'local',GEARBEACON_BIND_HOST:'127.0.0.1',GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify({[parent]:{variants}}),
  NTFY_TOPIC:'',DISCORD_WEBHOOK_URL:'',GOTIFY_BASE_URL:`http://127.0.0.1:${delivery.address().port}`,GOTIFY_TOKEN:'mock-activity-token',
  GEARBEACON_WEBHOOK_URL:`http://127.0.0.1:${delivery.address().port}/mock`,SMTP_HOST:'',SMTP_FROM:'',SMTP_TO:'',SMTP_USER:'',SMTP_PASSWORD:'',
}});
server.stdout.on('data',chunk => output += chunk); server.stderr.on('data',chunk => output += chunk);
async function request(path,body,method=body === undefined ? 'GET' : 'POST',status=200) {
  const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',Connection:'close'},...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const result = await response.json(); assert.equal(response.status,status,`${path}: ${JSON.stringify(result)}`); return result;
}
async function waitFor(check,message) {
  for (let index=0; index<150; index++) { if (await check()) return; await delay(100); }
  throw new Error(typeof message === 'function' ? message() : message);
}
function storedEvent(id) {
  const db = new DatabaseSync(join(dataDir,'gearbeacon.mock.sqlite3'),{readOnly:true});
  try { return db.prepare('SELECT data_json FROM events WHERE id=?').get(id).data_json; } finally { db.close(); }
}
const activity = suffix => request(`/api/activity?scope=us${suffix || ''}`);
const detail = async id => (await request(`/api/activity/${encodeURIComponent(id)}`)).event;
const watch = slug => request('/api/watch',{slug});
const rule = value => request(`/api/watch/${encodeURIComponent(black)}/rules`,{rule:value},'PUT');
async function observe(change,count=1) {
  variants = variants.map(item => item.id === 'context-black' ? {...item,...change} : item);
  await request(`/api/mock/product/${parent}`,{variants});
  for (let index=0; index<count; index++) await request('/api/check',{});
}

try {
  await waitFor(async () => { try { const value=await request('/api/status'); return value.lastSuccessAt && !value.checking; } catch { return false; } },'Activity fixture did not start');
  await request('/api/config',{config:{...(await request('/api/config')).config,notificationCooldownMinutes:0,notificationGroupSeconds:0,digestEnabled:false,quietHoursEnabled:false}},'PUT');
  await watch(black); await watch(parent); await rule({targetPrice:300,channels:['webhook']});
  const project = (await request('/api/collections',{name:'Activity camera project'})).id;
  for (const slug of [black,parent]) await request(`/api/watch/${encodeURIComponent(slug)}/collections`,{collections:[project]},'PUT');
  await observe({status:'Available'});
  const restock = (await activity()).events.find(event => event.slug === black && event.type === 'restock');
  assert.ok(restock); const original = storedEvent(restock.id);
  assert.equal(restock.context.current.freshness.state,'confirmed');
  assert.equal(restock.context.current.inStock,true);
  assert.equal(restock.context.identity.variantTitle,'Black');
  assert.equal(restock.context.identity.sku,'CONTEXT-B');
  assert.equal(restock.context.watch.watched,true);
  assert.equal(restock.context.watch.collections.length,1,'Direct and parent memberships duplicated a collection');
  assert.equal(restock.context.watch.collections[0].viaParent,false);
  assert.equal(restock.context.price.targetDifference,-1);
  assert.equal(restock.context.price.low30.isLowest,false,'A new installation invented 30 days of price history');
  await waitFor(async () => (await detail(restock.id)).serverAlert.state === 'sent','Mock webhook did not deliver');
  assert.equal((await detail(restock.id)).serverAlert.label,'Sent · Webhook');
  await observe({status:'SoldOut'});
  assert.equal((await detail(restock.id)).context.current.freshness.state,'pending');
  assert.equal((await detail(restock.id)).context.current.inStock,true,'A pending sellout replaced last-known-good availability');
  await observe({status:'SoldOut'});
  assert.equal((await detail(restock.id)).context.current.status,'Sold out');
  assert.equal((await detail(restock.id)).inStock,true,'Current context overwrote the original restock');
  await request('/api/mock/fault',{partialOmitSlugs:['udm-se']}); await request('/api/check',{});
  assert.equal((await detail(restock.id)).context.current.freshness.state,'stale');
  await request('/api/mock/fault',{reset:true}); await request('/api/check',{});
  await rule({targetPrice:280});
  assert.equal((await detail(restock.id)).context.price.targetDifference,19);
  assert.equal((await detail(restock.id)).targetPrice,300,'Editing a target rewrote its event snapshot');
  assert.equal(storedEvent(restock.id),original,'Reading live context mutated stored event data');
  await request(`/api/watch/${encodeURIComponent(black)}`,undefined,'DELETE');
  const parentContext = (await detail(restock.id)).context;
  assert.equal(parentContext.watch.watched,false); assert.equal(parentContext.watch.parentWatched,true);
  assert.equal(parentContext.watch.collections[0].viaParent,true);
  assert.equal(parentContext.price.targetPrice,null,'A parent target leaked into an unwatched exact variant');
  await watch(black); await rule({targetPrice:300,channels:['gotify','webhook']});
  await observe({status:'Available'});
  const second = (await activity()).events.find(event => event.slug === black && event.type === 'restock' && event.id !== restock.id);
  let secondOutcome;
  await waitFor(async () => { secondOutcome=(await detail(second.id)).serverAlert; return secondOutcome.state === 'sent' || secondOutcome.state === 'failed' || secondOutcome.state === 'partial'; },()=>`Mock channels did not finish: ${JSON.stringify(secondOutcome)}`);
  assert.equal(secondOutcome.label,'Sent · 2 channels',JSON.stringify(secondOutcome));

  const backup = await request('/api/data/export');
  const now = Date.now(), at = days => new Date(now-days*86400000).toISOString();
  const template = {...restock,name:'Activity context fixture',serverAlert:{state:'muted',reason:'not-watched'},watchedAtDetection:false};
  delete template.context; delete template.notificationDecision;
  const events = [];
  for (const [type,count] of [['restock',12],['sold_out',9],['status_change',2],['new_product',2]]) {
    for (let i=0;i<count;i++) events.push({...template,id:`context-${type}-${i}`,type,detectedAt:at(type === 'sold_out' ? 1 : 0)});
  }
  const mutedLabels = {paused:'Alerts paused',purchased:'Purchased',disabled:'Rule filtered',cooldown:'Cooldown','collection-only':'Collection only','condition-not-met':'Target not met','condition-already-matched':'Already alerted','variant-baseline':'Variant discovered','collection-disabled':'Collection alerts off'};
  Object.keys(mutedLabels).forEach((reason,index) => { events[index].serverAlert={state:'muted',reason}; });
  events.push({...template,id:'context-low',type:'price_change',price:'$250.00',previousPrice:'$280.00',priceValue:250,previousPriceValue:280,priceDifference:-30,detectedAt:at(2)});
  events.push({...events.at(-1),id:'context-parent',slug:parent,parentSlug:null,variantId:null,variantTitle:null});
  events.push({...events.at(-2),id:'context-rise',price:'$310.00',priceValue:310,priceDifference:30});
  events.push({...events.at(-1),id:'context-equal',price:'$280.00',priceValue:280,priceDifference:0});
  events.push({...events.at(-1),id:'context-legacy',priceValue:null,previousPriceValue:null,priceDifference:null,previousPrice:null,alertKind:'price_change'});
  events.push({...template,id:'context-missing',slug:'missing-context-product',parentSlug:null,variantId:null,detectedAt:at(0)});
  events.push({...template,id:'context-short-history',slug:white,variantId:'context-white',variantTitle:'White',priceValue:329,detectedAt:at(0)});
  backup.regions.us.events = events;
  backup.regions.ca.events = [{...events[0],id:'context-canada',region:'ca'}];
  const interval = (slug,start,end,value,currency='USD') => ({slug,startedAt:at(start),endedAt:at(end),price:`$${value}.00`,priceValue:value,currency,inStock:true,status:'Available'});
  backup.regions.us.inventoryHistory = [interval(black,40,3,300),interval(black,3,2,280),interval(black,2,1,250),interval(black,1,0,100),interval(parent,40,0,1),interval(white,1,0,329)];
  backup.regions.ca.inventoryHistory = [interval(black,40,0,5,'CAD')];
  await request('/api/data/import',{backup});
  const low = (await detail('context-low')).context.price;
  assert.equal(low.low30.lowest,250,'A future, parent, or other Store price contaminated the historical comparison');
  assert.equal(low.low30.isLowest,true); assert.equal(low.targetDifference,-50);
  assert.equal((await detail('context-parent')).context.price.exactPriceScope,false);
  assert.equal((await detail('context-parent')).context.price.low30,null);
  assert.equal((await detail('context-short-history')).context.price.low30.isLowest,false);
  assert.equal((await detail('context-missing')).context.current.status,null);
  assert.equal((await detail('context-missing')).context.current.freshness.state,'unknown');
  assert.equal((await detail('context-legacy')).context.price.eventPrice,280,'Legacy formatted prices lost their comparison');
  assert.equal((await detail('context-low')).serverAlert.label,'Not watched');
  for (const [index,label] of Object.values(mutedLabels).entries()) assert.equal((await detail(events[index].id)).serverAlert.label,label,'A recorded suppression reason was replaced by current rules');
  const first = await activity('&limit=10');
  assert.equal(first.events.length,10); assert.equal(first.count,32);
  assert.deepEqual(Object.fromEntries(Object.entries(first.summary).filter(([key]) => !['timeZone','asOf'].includes(key))),{total:32,restocks:14,soldOut:9,priceChanges:5,priceDrops:2,priceIncreases:1,statusChanges:2,newProducts:2,collectionReady:0});
  const secondPage = await activity('&limit=10&page=2');
  assert.equal(secondPage.summary.total,32,'Summary counted only the visible page');
  const drops = await activity('&type=price_change&search=context%20fixture');
  assert.equal(drops.summary.total,5); assert.equal(drops.summary.priceDrops,2);
  assert.equal((await request('/api/activity?scope=ca')).summary.total,1);
  assert.equal((await activity('&delivery=sent')).summary.total,0);
  assert.equal((await activity('&search=does-not-exist')).summary.total,0);
  for (const [day,start,end] of [['2026-03-08','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z'],['2026-11-01','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z']]) {
    const filtered = await activity(`&from=${day}&to=${day}&timeZone=America%2FNew_York`);
    assert.equal(filtered.filters.from,start); assert.equal(filtered.filters.to,end); assert.equal(filtered.summary.timeZone,'America/New_York');
  }
  const dated = await activity(`&from=${encodeURIComponent(at(1.1))}&to=${encodeURIComponent(at(.9))}`);
  assert.equal(dated.summary.total,9,'Date summary ignored the selected range');
  await request('/api/activity?from=2026-02-30',undefined,'GET',400);
  await request('/api/activity?timeZone=Unknown%2FPlace',undefined,'GET',400);
  await observe({status:'SoldOut'},2);
  const held = await activity(`&snapshot=${encodeURIComponent(first.snapshot)}`);
  assert.equal(held.count,32); assert.ok(held.summary.total>32);
  const arrivals = await activity(`&after=${encodeURIComponent(first.snapshot)}`);
  assert.equal(arrivals.summary.total,held.summary.total,'Arrival summary counted only arrivals');
  await observe({status:'Available'});
  const pinned = await activity(`&after=${encodeURIComponent(first.snapshot)}&snapshot=${encodeURIComponent(arrivals.snapshot)}`);
  assert.equal(pinned.summary.total,arrivals.summary.total,'A later arrival changed the pinned summary boundary');
  assert.ok((await activity()).summary.total>pinned.summary.total);
  console.log('ACTIVITY CONTEXT TEST PASSED: immutable snapshots, current/pending/stale/missing status, watch and collection context, exact historical price windows, delivery labels, filtered totals, pagination, arrivals, timezone and DST boundaries.');
} catch (error) { console.error(output.slice(-5000)); throw error; }
finally {
  if (server.exitCode === null) { const exited=new Promise(done => server.once('exit',done)); server.kill('SIGINT'); await Promise.race([exited,delay(3000)]); if (server.exitCode === null) {server.kill('SIGKILL');await exited;} }
  await new Promise(done => delivery.close(done));
  await rm(dataDir,{recursive:true,force:true});
}
