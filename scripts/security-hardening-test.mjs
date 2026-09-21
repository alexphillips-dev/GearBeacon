import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { totp, base32 } from '../backend/dist/security.js';
import { loadProtectedKey, secureDataDirectory } from '../backend/dist/key-protection.js';
import { notificationFetch, addressPolicy } from '../backend/dist/outbound.js';

const root = mkdtempSync(join(tmpdir(),'gearbeacon-security-'));
const data = join(root,'data'); mkdirSync(data);
let child, database, cookie='', csrf=''; let output='';
const password='security fixture owner password';
const sink=createServer((req,res) => {
  if (req.url==='/redirect') { res.writeHead(307,{ Location:'/private-target' }); res.end(); }
  else if (req.url==='/oversize') res.end(Buffer.alloc(1024*1024+1));
  else { res.writeHead(200); res.end('ok'); }
});
await new Promise(resolve=>sink.listen(0,'127.0.0.1',resolve));
const sinkUrl=`http://127.0.0.1:${sink.address().port}`;
const portProbe=createServer(); await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
const port=portProbe.address().port; await new Promise(resolve=>portProbe.close(resolve));
const base=`http://127.0.0.1:${port}`;
async function request(path,method='GET',body,expected=200,extra={}) {
  const response=await fetch(base+path,{ method, headers:{ 'Content-Type':'application/json', Cookie:cookie, 'X-CSRF-Token':csrf, ...extra }, body:body===undefined?undefined:JSON.stringify(body) });
  const json=await response.json(); assert.equal(response.status,expected,`${path}: ${JSON.stringify(json)}`);
  return { response, json };
}
async function login(code,expected=200) {
  const result=await request('/api/auth/login','POST',{password,code},expected);
  if(expected===200) { cookie=result.response.headers.get('set-cookie').split(';')[0]; csrf=result.json.csrfToken; }
  return result;
}
function ageSession(column,milliseconds) { database.prepare(`UPDATE sessions SET ${column}=?`).run(new Date(Date.now()-milliseconds).toISOString()); }
try {
  const vector=Buffer.from('12345678901234567890').toString('base64');
  for(const [time,expected] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']]) assert.equal(totp(vector,Math.floor(time/30)),expected);
  assert.equal(base32(Buffer.from('foobar')),'MZXW6YTBOI');
  console.log('Security checks: TOTP vectors passed.');
  const keyDir=join(root,'key-fixture'); mkdirSync(keyDir); secureDataDirectory(keyDir);
  const keyPath=join(keyDir,'secrets.key'); const original=randomBytes(32); writeFileSync(keyPath,original.toString('base64'));
  assert.deepEqual(loadProtectedKey(keyPath),original,'Legacy encryption key must survive wrapping.');
  if(process.platform==='win32') { assert.ok(readFileSync(keyPath,'utf8').startsWith('dpapi-v1:')); assert.ok(!readFileSync(keyPath,'utf8').includes(original.toString('base64'))); }
  console.log('Security checks: local key protection passed.');
  for(const ip of ['169.254.169.254','100.100.100.200','0.0.0.0','::','fe80::1','fd00:ec2::254','::ffff:169.254.169.254']) assert.equal(addressPolicy(ip),'blocked',ip);
  assert.equal(addressPolicy('::ffff:127.0.0.1'),'private');
  const options={ allowedUrls:[sinkUrl] };
  assert.equal(await (await notificationFetch(sinkUrl,{},1000,options)).text(),'ok');
  await assert.rejects(notificationFetch(`${sinkUrl}/redirect`,{},1000,options));
  await assert.rejects(notificationFetch(`${sinkUrl}/oversize`,{},1000,options));
  await assert.rejects(notificationFetch('http://169.254.169.254',{},1000,{allowedUrls:['http://169.254.169.254']}));
  const named=`http://notify.example.test:${sink.address().port}`;
  const dns=async()=>[{address:'127.0.0.1',family:4}];
  await assert.rejects(notificationFetch(named,{},1000,{allowedUrls:[named],lookup:dns}));
  assert.equal(await (await notificationFetch(named,{},1000,{allowedUrls:[named],lookup:dns,privateHosts:['notify.example.test']})).text(),'ok');
  console.log('Security checks: outbound request protections passed.');
  child=spawn(process.execPath,['--no-warnings','backend/dist/index.js'],{ env:{...process.env,MOCK_MODE:'1',PORT:String(port),REGIONS:'us',GEARBEACON_DATA_DIR:data,GEARBEACON_SKIP_LEGACY_IMPORT:'1',GEARBEACON_GITHUB_RELEASE_API:'',GEARBEACON_AUTO_UPDATE_CHECKS:'0',GEARBEACON_ACCESS_MODE:'private',GEARBEACON_BIND_HOST:'127.0.0.1',GEARBEACON_OWNER_PASSWORD:password,GEARBEACON_OWNER_PASSWORD_FILE:'',GEARBEACON_BACKUP_INTERVAL_HOURS:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true });
  child.stdout.on('data',value=>output+=value); child.stderr.on('data',value=>output+=value);
  let ready=false;
  for(let i=0;i<150;i++) { if(child.exitCode!==null) throw new Error('Security fixture failed to start: '+output); try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{} await delay(100); }
  assert.ok(ready,'Security fixture readiness');
  database=new DatabaseSync(join(data,'gearbeacon.mock.sqlite3'));
  console.log('Security checks: isolated server ready.');
  await login();
  assert.equal((await request('/api/auth/status')).json.sessionPolicy.sessionHours,24);
  ageSession('verified_at',6*60000);
  for(const [route,method,body] of [['/api/data/export','GET'],['/api/data/export/encrypted','POST',{}],['/api/data/import','POST',{}],['/api/config','PUT',{}],['/api/auth/mfa/begin','POST',{}],['/api/auth/security','PUT',{}]]) {
    assert.equal((await request(route,method,body,403)).json.reauthenticationRequired,true);
  }
  await request('/api/auth/verify','POST',{password},403,{'X-CSRF-Token':'wrong'});
  await request('/api/auth/verify','POST',{password});
  await request('/api/data/export');
  ageSession('activity_at',5*60000);
  const before=database.prepare('SELECT activity_at FROM sessions').get().activity_at;
  await request('/api/status'); await request('/api/auth/status');
  assert.equal(database.prepare('SELECT activity_at FROM sessions').get().activity_at,before,'Polling cannot extend idle lock.');
  await request('/api/auth/activity','POST',{});
  assert.notEqual(database.prepare('SELECT activity_at FROM sessions').get().activity_at,before);
  ageSession('activity_at',31*60000); await request('/api/status','GET',undefined,401);
  assert.equal((await fetch(base+'/healthz')).status,200,'Monitoring stays alive after lock.');
  await login(); ageSession('created_at',25*3600000); await request('/api/status','GET',undefined,401); await login();
  await request('/api/auth/security','PUT',{sessionHours:12,idleMinutes:10,privateNotificationHosts:['notify.example.test']});
  assert.deepEqual((await request('/api/auth/security')).json.policy,{sessionHours:12,idleMinutes:10});
  const begin=(await request('/api/auth/mfa/begin','POST',{})).json;
  assert.match(begin.secret,/^[A-Z2-7]{32}$/);
  // Decode the generated fixture key independently of the implementation's encoder.
  const bits=[...begin.secret].map(c=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0')).join('');
  const secret=Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2))).toString('base64');
  const step=Math.floor(Date.now()/30000);
  const enabled=(await request('/api/auth/mfa/finish','POST',{code:totp(secret,step)})).json;
  assert.equal(enabled.recoveryCodes.length,10);
  const snapshot=(await request('/api/data/export')).json;
  assert.ok(!JSON.stringify(snapshot).includes('owner_totp')); assert.ok(!JSON.stringify(snapshot).includes('notification_private_hosts'));
  assert.ok(!JSON.stringify(snapshot).includes(begin.secret));
  const originalMfa = database.prepare("SELECT value FROM settings WHERE key='owner_totp'").get().value;
  snapshot.settings.owner_totp='invalid external authentication';
  snapshot.settings.owner_security_policy=JSON.stringify({sessionHours:9999,idleMinutes:9999});
  snapshot.settings.notification_private_hosts='unapproved.example.test';
  await request('/api/data/import','POST',{backup:snapshot});
  assert.equal(database.prepare("SELECT value FROM settings WHERE key='owner_totp'").get().value,originalMfa,'Restore must retain local MFA.');
  assert.deepEqual((await request('/api/auth/security')).json.privateNotificationHosts,['notify.example.test']);
  await login(undefined,401); await login(totp(secret,step),401); // Enrollment code cannot be replayed.
  await login(enabled.recoveryCodes[0]); await login(enabled.recoveryCodes[0],401);
  ageSession('verified_at',6*60000);
  await request('/api/auth/verify','POST',{password},403);
  await request('/api/auth/verify','POST',{password,code:enabled.recoveryCodes[1]});
  await request('/api/auth/mfa/disable','POST',{}); assert.equal((await request('/api/auth/status')).json.mfaEnabled,false);
  await request('/api/auth/mfa/begin','POST',{});
  for(let attempt=0;attempt<5;attempt++) await request('/api/auth/mfa/finish','POST',{code:'invalid'},400);
  await request('/api/auth/mfa/finish','POST',{code:'invalid'},429);
  database.prepare("INSERT INTO settings(key,value,updated_at) VALUES('app_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({accessMode:'local',bindHost:'0.0.0.0'}),new Date().toISOString());
  const stopped=child; stopped.kill(); await new Promise(resolve=>stopped.once('exit',resolve));
  const rejected=spawn(process.execPath,['--no-warnings','backend/dist/index.js'],{ env:{...process.env,MOCK_MODE:'1',PORT:String(port),REGIONS:'us',GEARBEACON_DATA_DIR:data,GEARBEACON_SKIP_LEGACY_IMPORT:'1',GEARBEACON_GITHUB_RELEASE_API:'',GEARBEACON_ACCESS_MODE:'local',GEARBEACON_BIND_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe'],windowsHide:true });
  let rejectedOutput=''; rejected.stdout.on('data',value=>rejectedOutput+=value); rejected.stderr.on('data',value=>rejectedOutput+=value);
  child=rejected;
  const timer=setTimeout(()=>rejected.kill(),10000);
  const exitCode=await new Promise(resolve=>rejected.once('exit',resolve)); clearTimeout(timer);
  assert.notEqual(exitCode,0); assert.match(rejectedOutput,/Saved configuration could not be applied/);
  console.log('Security hardening tests passed: RFC TOTP, recovery/replay, step-up, CSRF, idle/absolute expiry, protected keys, export privacy, and pinned notification destinations.');
} finally {
  database?.close(); if(child && child.exitCode===null) { child.kill(); await new Promise(resolve=>child.once('exit',resolve)); }
  sink.closeAllConnections(); await new Promise(resolve=>sink.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
