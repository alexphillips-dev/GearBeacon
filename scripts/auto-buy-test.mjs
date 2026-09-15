import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname,'..'), dataDir = await mkdtemp(join(tmpdir(),'gearbeacon-auto-buy-'));
const socket = net.createServer(); await new Promise(done=>socket.listen(0,'127.0.0.1',done));
const port = socket.address().port; await new Promise(done=>socket.close(done));
const base = `http://127.0.0.1:${port}`;
const parent = 'uvc-g5-ptz', slug = `${parent}::mock-black`;
const variants = [{ id:'mock-black',slug:'uvc-g5-ptz-black',sku:'MOCK-B',title:'Black',status:'Available',displayPrice:'$299.00' }];
let child, output = '', token = '', csrf = '', cookie = '';
async function request(path,body,method = body === undefined ? 'GET' : 'POST',expected = 200,worker = false) {
  const response = await fetch(base+path,{ method,headers:{ 'Content-Type':'application/json',Connection:'close',...(worker ? { Authorization:`Bearer ${token}` } : { Cookie:cookie,'X-CSRF-Token':csrf }) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }),signal:AbortSignal.timeout(15000) });
  const data = await response.json(); assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);
  if (!worker && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (!worker && data.csrfToken) csrf = data.csrfToken;
  return data;
}
const status = () => request('/api/auto-buy');
const worker = (action,body = {},expected = 200) => request('/api/auto-buy/worker/'+action,body,'POST',expected,true);
const profile = region=>({ id:`profile-${region}`,state:'ready',addressLabel:'Test home',paymentLabel:'visa ···· 4242' });
const heartbeat = () => worker('heartbeat',{ protocol:1,mode:'mock',profiles:{ us:profile('us'),ca:profile('ca') } });
async function pair() { const p=await request('/api/auto-buy/pairing',{}); token=(await worker('pair',{ code:p.code,protocol:1,mode:'mock' })).token; await heartbeat(); }
async function arm(region = 'us',overrides = {},expected = 200) {
  const before=(await status()).rules.find(r=>r.slug === slug && r.region === region);
  return request(`/api/auto-buy/rules?region=${region}`,{ slug,quantity:1,maxTotalMinor:35000,expiresAt:new Date(Date.now()+86400000).toISOString(),authorized:true,revision:before?.revision || 0,...overrides },'PUT',expected);
}
const check = (region='us') => request(`/api/check?region=${region}`,{});
const claim = async()=> (await worker('claim')).attempt;
const proof = a => ({ checkoutId:'fixture-checkout',profileId:a.profileId,currency:a.currency,totalMinor:32900,taxCalculated:true,shippingSelected:true,addressVerified:true,paymentVerified:true,hasCustomer:true,externalItemCount:0,
  items:[{ sku:a.sku,variantId:a.variantId,quantity:a.quantity }],observedAt:new Date().toISOString() });
const receipt = a=>({ ...proof(a),paid:true,orderId:'fixture-order',orderNumber:'TEST-001' });
async function start() {
  output=''; child=spawn(process.execPath,['--no-warnings','backend/dist/index.js'],{ cwd:root,stdio:['ignore','pipe','pipe'],env:{ ...process.env,
    MOCK_MODE:'1',PORT:String(port),POLL_SECONDS:'86400',REGIONS:'us,ca',GEARBEACON_DATA_DIR:dataDir,GEARBEACON_SKIP_LEGACY_IMPORT:'1',GEARBEACON_BACKUP_INTERVAL_HOURS:'0',GEARBEACON_GITHUB_RELEASE_API:'',
    GEARBEACON_ACCESS_MODE:'local',GEARBEACON_BIND_HOST:'127.0.0.1',GEARBEACON_MOCK_OVERRIDES_JSON:JSON.stringify({ [parent]:{ variants } }),
    NTFY_TOPIC:'',DISCORD_WEBHOOK_URL:'',GOTIFY_BASE_URL:'',GEARBEACON_WEBHOOK_URL:'',SMTP_HOST:'',SMTP_FROM:'',SMTP_TO:'',SMTP_USER:'',SMTP_PASSWORD:'',
  } });
  child.stdout.on('data',data=>{output+=data;}); child.stderr.on('data',data=>{output+=data;});
  for(let n=0;n<120;n++) { if(child.exitCode!==null)throw Error(output);try {const s=await request('/api/status');if(s.lastSuccessAt&&!s.checking)return;}catch{} await delay(100); }
  throw Error('Mock server did not start: '+output.slice(-1000));
}
async function stop() { if(!child||child.exitCode!==null)return;const exit=new Promise(done=>child.once('exit',done));child.kill('SIGINT');await exit; }
const readDb = fn=>{const db=new DatabaseSync(join(dataDir,'gearbeacon.mock.sqlite3'));try{return fn(db);}finally{db.close();}};
try {
  await start();
  assert.equal((await status()).connection,null);
  for(const region of ['us','ca'])await request(`/api/watch?region=${region}`,{slug});
  await arm('us',{},409);
  await worker('pair',{code:'invalid',protocol:1,mode:'mock'},401);
  await pair();
  await arm('us',{authorized:false},400);
  await arm('us',{quantity:1.5},400);
  await arm('us',{maxTotalMinor:NaN},400);
  await arm('us',{expiresAt:'bad'},400);
  await arm('us',{slug:parent},400);
  const first=(await arm()).rule;
  await arm('us',{revision:0},409);
  await check(); await check();
  assert.equal((await status()).attempts.length,1,'Duplicate catalog observations queued duplicate purchases');
  let a=await claim(); assert.ok(a); assert.equal(await claim(),null,'The cart was claimed twice');
  for(const changed of [{totalMinor:35001},{currency:'CAD'},{taxCalculated:false},{addressVerified:false},{paymentVerified:false},{externalItemCount:1},{observedAt:'bad'},
    {items:[{sku:'WRONG',variantId:a.variantId,quantity:1}]},{items:[...proof(a).items,...proof(a).items]}]) {
    await worker(`attempts/${a.id}/authorize`,{...proof(a),...changed},409);
  }
  await request(`/api/auto-buy/rules/${first.id}/pause`,{});
  await worker(`attempts/${a.id}/authorize`,proof(a),409);
  await arm(); await check(); a=await claim();
  await worker(`attempts/${a.id}/authorize`,proof(a));
  await worker(`attempts/${a.id}/authorize`,proof(a),409);
  await request('/api/auto-buy/pause-all',{});
  await worker(`attempts/${a.id}/complete`,{...receipt(a),paid:false},409);
  await worker(`attempts/${a.id}/complete`,receipt(a));
  await worker(`attempts/${a.id}/complete`,receipt(a));
  assert.equal((await status()).rules.find(r=>r.id===a.ruleId).state,'purchased');
  assert.ok((await request(`/api/products/${encodeURIComponent(slug)}`)).product.watchRule.purchasedAt);
  await check(); assert.equal(await claim(),null);
  // Regional authorization and a restart after submission must never produce another order.
  const ca=(await arm('ca')).rule; assert.equal(ca.currency,'CAD');
  await check('ca');a=await claim();assert.equal(a.region,'ca');await worker(`attempts/${a.id}/authorize`,proof(a));
  await stop(); await start(); await heartbeat();
  assert.equal((await status()).attempts.find(item=>item.id===a.id).state,'unknown');
  assert.equal(await claim(),null);await arm('ca',{},409);
  await request(`/api/auto-buy/attempts/${a.id}/resolve`,{outcome:'not-purchased',checkedStoreOrders:true},'POST',409);
  await request('/api/auto-buy/disconnect',{});
  await request(`/api/auto-buy/attempts/${a.id}/resolve`,{outcome:'not-purchased',checkedStoreOrders:true});
  await pair();await arm('ca');await check('ca');a=await claim();
  await worker(`attempts/${a.id}/report`,{code:'session'});
  assert.equal((await status()).rules.find(r=>r.id===a.ruleId).state,'paused');
  // Collection accounting updates only the selected purchase plan.
  await request(`/api/watch/${encodeURIComponent(slug)}/rules`,{purchasedAt:null},'PUT');
  const c1=await request('/api/watch/add',{slug,collectionName:'Auto-buy target',quantity:3});
  const c2=await request('/api/watch/add',{slug,collectionName:'Keep wanted',quantity:3});
  await arm('us',{collectionId:c1.collectionId,quantity:2,maxTotalMinor:70000});await check();a=await claim();
  await worker(`attempts/${a.id}/authorize`,proof(a));await worker(`attempts/${a.id}/complete`,receipt(a));
  const collections=(await request('/api/collections')).collections;
  assert.equal(collections.find(c=>c.id===c1.collectionId).items[0].purchasedQuantity,2);
  assert.equal(collections.find(c=>c.id===c2.collectionId).items[0].purchasedQuantity,0);
  assert.equal((await request(`/api/products/${encodeURIComponent(slug)}`)).product.watchRule.purchasedAt,null);
  // Manual purchase/watch removal invalidates pending authorization at the gate.
  await arm();await check();a=await claim();await request(`/api/watch/${encodeURIComponent(slug)}`,undefined,'DELETE');
  await worker(`attempts/${a.id}/authorize`,proof(a),409);
  await request('/api/watch',{slug});await arm();
  // A partial catalog cannot claim a newly armed instruction or advance checkout evidence.
  await request('/api/mock/fault',{partialOmitSlugs:[parent]});await check();
  assert.equal(await claim(),null);
  await request('/api/mock/fault',{reset:true});await check();a=await claim();assert.ok(a);
  // Expiry is checked again at the submission gate, independent of the browser timer.
  readDb(db=>{db.exec('PRAGMA busy_timeout=5000');const r=db.prepare('SELECT config_json FROM auto_buy_rules WHERE id=?').get(a.ruleId);const c=JSON.parse(r.config_json);c.expiresAt=new Date(Date.now()-1000).toISOString();db.prepare('UPDATE auto_buy_rules SET config_json=? WHERE id=?').run(JSON.stringify(c),a.ruleId);});
  await worker(`attempts/${a.id}/authorize`,proof(a),409);assert.equal((await status()).rules.find(r=>r.id===a.ruleId).state,'expired');
  await arm();
  const exported=await request('/api/data/export');assert.equal(exported.formatVersion,10);
  assert.ok(exported.autoBuy.rules.every(r=>r.state!=='armed'));assert.ok(!JSON.stringify(exported).includes(token));
  await request('/api/data/backup',{});
  const backup=readDb(db=>db.prepare("SELECT filename FROM backup_log WHERE status='validated' ORDER BY id DESC LIMIT 1").get().filename);
  const copy=new DatabaseSync(join(dataDir,'backups',backup),{readOnly:true});
  try {assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM auto_buy_connection').get().n,0);assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM auto_buy_rules WHERE state='armed'").get().n,0);}finally{copy.close();}
  await request('/api/data/import',{backup:exported});assert.equal((await status()).connection,null);assert.ok((await status()).rules.every(r=>r.state!=='armed'));
  const support=JSON.stringify(await request('/api/operations/support-bundle'));
  for(const privateValue of [token,'TEST-001','MOCK-B','Test home'])assert.ok(!support.includes(privateValue));
  // A companion token cannot grant owner access or bypass CSRF once authentication is enabled.
  await pair();await request('/api/auth/password',{currentPassword:'',newPassword:'Mock-auto-buy-owner-password!'},'PUT');
  await request('/api/products',undefined,'GET',401,true);
  const response=await fetch(base+'/api/auto-buy/pause-all',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  console.log('AUTO-BUY TEST PASSED: exact variants and regions, authorization limits, duplicate claims, pause races, uncertain restart, scope of purchase accounting, recovery, privacy, owner authentication and CSRF.');
} catch(err){console.error(output.slice(-1000));throw err;}
finally{await stop();await rm(dataDir,{recursive:true,force:true});}
