import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { buildMetadata } from './build-metadata.mjs';

const root=resolve(import.meta.dirname,'..'), scratch=await mkdtemp(join(tmpdir(),'gearbeacon-update-notice-'));
const current='a'.repeat(40), latest='b'.repeat(40), calls=[];
let scenario={}, child=null, output='', base='', instance=0;
const release=(version,extra={})=>({tag_name:`v${version}`,draft:false,prerelease:version.includes('-'),html_url:`https://github.com/alexphillips-dev/GearBeacon/releases/tag/v${version}`,body:'Example release notes',...extra});
const mock=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); calls.push(url.pathname);
  if (scenario.wait) await delay(scenario.wait);
  if (scenario.failure) {res.writeHead(scenario.failure,scenario.retry ? {'Retry-After':String(scenario.retry)} : {});res.end('{}');return;}
  if (scenario.notesFailure && url.pathname.startsWith('/repo/contents/docs/')) {res.writeHead(503);res.end('{}');return;}
  let value;
  if (url.pathname==='/repo/releases/latest') value=scenario.releases || release('1.5.0');
  else if (url.pathname==='/manifest/main' || url.pathname==='/manifest/dev') value=scenario.manifest;
  else if (url.pathname==='/repo/commits/dev') value={sha:scenario.head || latest,commit:{committer:{date:'2026-09-12T12:00:00Z'}}};
  else if (url.pathname.startsWith('/repo/compare/')) {
    if (scenario.comparison==='unknown') {res.writeHead(404);res.end('{}');return;}
    value={status:scenario.comparison || 'ahead'};
  } else if (url.pathname==='/repo/contents/release-manifest.json') {
    assert.equal(url.searchParams.get('ref'),scenario.head || latest,'Version lookup was not pinned to the selected dev commit');
    value={type:'file',encoding:'base64',content:Buffer.from(JSON.stringify({latestVersion:scenario.version || '1.4.0',releaseNotes:'Development notes',releasePageUrl:release('1.4.0').html_url})).toString('base64')};
  } else if (url.pathname.startsWith('/repo/contents/docs/') && !scenario.noNotes) value={type:'file',encoding:'base64',content:Buffer.from('# Development changes').toString('base64')};
  else if (url.pathname.startsWith('/repo/releases/tags/') && scenario.tagged) value=release(scenario.version);
  else if (url.pathname.startsWith('/repo/commits/v') && scenario.tagged) value={sha:latest};
  else {res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
});
await new Promise(done=>mock.listen(0,'127.0.0.1',done));
const source=`http://127.0.0.1:${mock.address().port}`;
async function stop() {
  if (child && child.exitCode===null && child.signalCode===null) {
    const exited=new Promise(done=>child.once('exit',done));child.kill('SIGINT');await Promise.race([exited,delay(2000)]);
    if (child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL');await exited;}
  }
  child=null;
}
async function request(path='/api/update/check') {
  const response=await fetch(base+path,{headers:{Connection:'close'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200);return response.json();
}
async function waitFor(check,message) {
  for(let i=0;i<150;i++) {if(await check())return;await delay(50);} throw new Error(message);
}
async function start({channel='main',automatic=false,metadata={},env={},gitBranch=null}={}) {
  await stop();calls.length=0;output='';
  const appRoot=join(scratch,`app-${++instance}`);await mkdir(join(appRoot,'backend','dist'),{recursive:true});
  for(const file of ['index.js','email.js','autobuy.js','security.js','key-protection.js','outbound.js']) await copyFile(join(root,'backend','dist',file),join(appRoot,'backend','dist',file));
  await copyFile(join(root,'release-manifest.json'),join(appRoot,'release-manifest.json'));
  await copyFile(join(root,'backend','package.json'),join(appRoot,'backend','package.json'));
  await writeFile(join(appRoot,'build-info.json'),JSON.stringify({version:'1.4.0',packageVersion:'1.4.0',branch:channel,commit:current,...metadata}));
  if (gitBranch) {
    execFileSync('git',['init','-b',gitBranch],{cwd:appRoot,stdio:'ignore',windowsHide:true});
    execFileSync('git',['add','backend/package.json'],{cwd:appRoot,stdio:'ignore',windowsHide:true});
    execFileSync('git',['-c','user.name=alexphillips-dev','-c','user.email=96605631+alexphillips-dev@users.noreply.github.com','commit','-m','Mock source identity'],{cwd:appRoot,stdio:'ignore',windowsHide:true});
  }
  const socket=net.createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['--no-warnings',join(appRoot,'backend','dist','index.js')],{cwd:appRoot,stdio:['ignore','pipe','pipe'],env:{...process.env,
    MOCK_MODE:'1',PORT:String(port),REGIONS:'us',POLL_SECONDS:'86400',GEARBEACON_DATA_DIR:join(appRoot,'mock-data'),GEARBEACON_SKIP_LEGACY_IMPORT:'1',GEARBEACON_BACKUP_INTERVAL_HOURS:'0',
    GEARBEACON_ACCESS_MODE:'local',GEARBEACON_BIND_HOST:'127.0.0.1',GEARBEACON_GITHUB_RELEASE_API:source+'/repo/releases/latest',GEARBEACON_UPDATE_MANIFEST_URL:'',GEARBEACON_AUTO_UPDATE_CHECKS:automatic?'1':'0',
    GEARBEACON_UPDATE_CHANNEL:'auto',GEARBEACON_BUILD_BRANCH:'',GEARBEACON_BUILD_COMMIT:'',GEARBEACON_PACKAGE_VERSION:'',GEARBEACON_IMAGE:'',
    NTFY_TOPIC:'',DISCORD_WEBHOOK_URL:'',GOTIFY_BASE_URL:'',GEARBEACON_WEBHOOK_URL:'',SMTP_HOST:'',SMTP_FROM:'',SMTP_TO:'',SMTP_USER:'',SMTP_PASSWORD:'',...env}});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
  await waitFor(async()=>{try{return (await request('/api/status')).lastSuccessAt;}catch{return false;}},'Update fixture did not start');
  return appRoot;
}

try {
  await start({automatic:true});
  await waitFor(async()=>(await request('/api/status')).update.verified,'Startup did not check for an update');
  let result=(await request('/api/status')).update;
  assert.equal(result.channel,'main');assert.equal(result.updateAvailable,true);assert.equal(result.latestVersion,'1.5.0');
  assert.equal(result.releaseNotesUrl,release('1.5.0').html_url);
  assert.ok(Math.abs(Date.parse(result.nextCheckAt)-Date.parse(result.checkedAt)-86400000)<1000,'Automatic checks are not scheduled daily');
  const before=calls.length;await Promise.all(Array.from({length:12},()=>request('/api/status')));assert.equal(calls.length,before,'Browser status polling triggered remote update requests');
  scenario={wait:100};await Promise.all(Array.from({length:8},()=>request()));assert.equal(calls.length,before+1,'Concurrent manual checks were not shared');
  scenario={releases:[release('9.0.0-rc.1'),release('8.0.0',{draft:true}),release('1.4.0')]};
  result=await request();assert.equal(result.latestVersion,'1.4.0');assert.equal(result.updateAvailable,false,'Stable installs received a prerelease or draft');
  scenario={};await request();scenario={failure:503};result=await request();
  assert.equal(result.updateAvailable,true);assert.equal(result.stale,true);assert.equal(result.latestVersion,'1.5.0','Failure erased the last verified update');
  scenario={failure:429,retry:7200};result=await request();const limited=calls.length;await request();
  assert.equal(calls.length,limited,'Manual check bypassed Retry-After');assert.ok(Date.parse(result.nextCheckAt)>Date.now()+7000000);

  scenario={};await start({channel:'dev'});assert.equal(calls.length,0,'Disabling automatic checks still contacted the update source');
  result=await request();assert.equal(result.channel,'dev');assert.equal(result.updateAvailable,true);assert.equal(result.latestVersion,'1.4.0','Same-version dev commits lost their version label');
  assert.ok(result.releaseNotesUrl.endsWith(`/blob/${latest}/docs/CHANGELOG.md`));assert.ok(!calls.includes('/repo/releases/latest'),'Dev checked stable releases');
  scenario={head:current};result=await request();assert.equal(result.updateAvailable,false,'Current dev commit was flagged as old');
  for(const comparison of ['behind','diverged','unknown']) {scenario={comparison};result=await request();assert.equal(result.updateAvailable,false,`Unsafe dev comparison: ${comparison}`);}
  scenario={comparison:'ahead',version:'1.1.0'};assert.equal((await request()).updateAvailable,false,'Dev offered a version downgrade');
  scenario={noNotes:true};result=await request();assert.equal(result.updateAvailable,true);assert.equal(result.releaseNotesUrl,null,'Missing notes used an unrelated stable release page');
  scenario={notesFailure:true};result=await request();assert.equal(result.updateAvailable,true,'Optional notes failure hid a confirmed update');assert.equal(result.releaseNotesUrl,null);
  scenario={version:'1.5.0-dev.2',tagged:true};result=await request();assert.equal(result.releaseNotesUrl,release('1.5.0-dev.2').html_url,'Exact prerelease notes were not preferred');

  scenario={manifest:{channel:'dev',latestVersion:'1.4.0-rc.10',releaseNotesUrl:'javascript:alert(1)'}};
  await start({channel:'dev',metadata:{packageVersion:'1.4.0-rc.2'},env:{GEARBEACON_UPDATE_MANIFEST_URL:source+'/manifest/{channel}'}});
  result=await request();assert.equal(result.updateAvailable,true,'Prerelease identifiers were not compared numerically');assert.equal(result.releaseNotesUrl,null);
  assert.equal((await request('/healthz')).packageVersion,'1.4.0-rc.2');assert.deepEqual(calls,['/manifest/dev']);
  scenario={manifest:{channel:'main',latestVersion:'9.0.0'}};result=await request();assert.equal(result.latestVersion,'1.4.0-rc.10','Wrong-channel manifest replaced the verified dev update');assert.equal(result.stale,true);

  scenario={releases:release('9.0.0-rc.1')};await start();result=await request();assert.equal(result.updateAvailable,false);assert.equal(result.verified,false,'Unknown update state claimed to be current');
  scenario={};await start({env:{GEARBEACON_GITHUB_RELEASE_API:''},automatic:true});result=await request();assert.equal(calls.length,0);assert.equal(result.updateAvailable,false);assert.equal(result.verified,false);
  const checkout=await start({channel:'main',gitBranch:'dev'});result=await request();assert.equal(result.channel,'dev','Source branch did not override stale package metadata');
  const built=buildMetadata(checkout,'1.4.0',{});assert.equal(built.branch,'dev');assert.match(built.commit,/^[a-f0-9]{40}$/);
  assert.equal(result.currentCommit,built.commit,'Source commit did not override stale package metadata');
  assert.equal(buildMetadata(checkout,'1.4.0-rc.1',{GITHUB_REF:'refs/tags/v1.4.0-rc.1'}).branch,'dev');
  assert.equal(buildMetadata(checkout,'1.4.0-rc.1',{GITHUB_REF:'refs/heads/main'}).branch,'dev','A candidate dispatched from main followed stable updates');
  assert.equal(buildMetadata(checkout,'1.4.0',{GITHUB_REF:'refs/heads/main'}).branch,'main');
  assert.equal(buildMetadata(checkout,'1.4.0',{GITHUB_REF:'refs/tags/v1.4.0'}).branch,'main');
  assert.throws(()=>buildMetadata(checkout,'../unsafe',{}));
  const staged=join(scratch,'source-package');await mkdir(staged);
  execFileSync(process.execPath,[join(root,'scripts','build-metadata.mjs'),staged,'1.4.0'],{cwd:root,stdio:'ignore',windowsHide:true,
    env:{...process.env,GEARBEACON_BUILD_BRANCH:'dev',GEARBEACON_BUILD_COMMIT:current}});
  const packaged=JSON.parse(await readFile(join(staged,'build-info.json'),'utf8'));
  assert.equal(packaged.branch,'dev');assert.equal(packaged.commit,current);assert.equal(packaged.packageVersion,'1.4.0');
  await start({env:{GEARBEACON_BUILD_BRANCH:'dev',GEARBEACON_BUILD_COMMIT:current,GEARBEACON_PACKAGE_VERSION:'v1.4.0',GEARBEACON_IMAGE:'ghcr.io/alexphillips-dev/gearbeacon:dev'}});
  result=await request();assert.equal(result.channel,'dev','Container build branch was ignored');assert.equal(result.currentCommit,current);assert.equal(result.updateAvailable,true);
  await start({channel:'dev',env:{GEARBEACON_UPDATE_CHANNEL:'main'}});assert.equal((await request()).channel,'main','Explicit channel override was ignored');
  console.log('UPDATE NOTICE TEST PASSED: startup/daily scheduling, shared checks, offline/rate limits, stable isolation, exact dev comparisons, prerelease ordering, notes/fallbacks, safe links, disabled checks, Git and packaged identity.');
} catch(error) {console.error(output.slice(-3500));throw error;}
finally {await stop();await new Promise(done=>mock.close(done));await rm(scratch,{recursive:true,force:true});}
