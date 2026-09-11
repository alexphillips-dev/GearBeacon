import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const bash=process.platform==='win32' ? join(process.env.ProgramFiles || 'C:/Program Files','Git/bin/bash.exe') : 'sh';
if (process.platform==='win32' && !existsSync(bash)) throw new Error('Git Bash is needed to run the Unix updater fixtures on Windows.');
const fixture=mkdtempSync(join(tmpdir(),'gearbeacon-unix-update-'));
const bin=join(fixture,'bin'); const project=join(fixture,'compose'); const install=join(fixture,'gearbeacon');
const unix=value=>value.replaceAll('\\','/');
const executable=(name,body)=>{ const file=join(bin,name); writeFileSync(file,'#!/usr/bin/env sh\nset -eu\n'+body); chmodSync(file,0o755); };
const run=(script,args=[],scenario='success',platform='Linux')=>spawnSync(bash,['-c','export PATH="$(cd "$1" && pwd -P):$PATH"; shift; exec sh "$@"','fixture',unix(bin),unix(join(root,script)),...args],{cwd:project,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,TEST_ROOT:unix(fixture),TEST_CASE:scenario,TEST_PLATFORM:platform,COMPOSE_ENV_FILES:'',COMPOSE_DISABLE_ENV_FILE:'0',COMPOSE_FILE:'',GEARBEACON_IMAGE_TAG:''}});
const output=result=>`${result.stdout || ''}\n${result.stderr || ''}`;
const check=(result,success)=>assert.equal(result.status===0,success,output(result));
try {
  for (const dir of [bin,project,install]) mkdirSync(dir);
  writeFileSync(join(project,'compose.yaml'),'services:\n  gearbeacon:\n    image: mock\n');
  executable('uname','if test "$1" = -s; then echo "$TEST_PLATFORM"; else echo x86_64; fi\n');
  executable('sudo',String.raw`printf '%s\n' "$*" >> "$TEST_ROOT/actions"
case "$1" in
  systemctl|launchctl)
    case "$TEST_CASE:$*" in stop:*stop*|stop:*bootout*|restart:*start*|restart:*bootstrap*) exit 1;; esac
    exit 0 ;;
esac
# Fixture paths must be inside the generated test directory before any file operation.
for arg in "$@"; do case "$arg" in /opt/*|/usr/local/*|/Library/*) echo 'Unsafe test path' >&2; exit 9;; esac; done
exec "$@"
`);
  executable('curl',String.raw`case "$*" in
  *127.0.0.1:9876/healthz*)
    case "$TEST_CASE" in unreachable) exit 7;; wrong-version) echo '{"ok":true,"name":"GearBeacon","version":"1.2.0","packageVersion":"1.2.1"}';; wrong-app) echo '{"ok":true,"name":"Other","version":"1.2.1"}';; *) echo '{"ok":true,"name":"GearBeacon","version":"1.2.1","packageVersion":"1.2.1"}';; esac ;;
  *releases/download/v1.2.1/*)
    url=$2
    case "$url" in *.sha256) cp "$TEST_ROOT/package.sha256" "$4";; *) cp "$TEST_ROOT/package.tar.gz" "$4";; esac ;;
  *) echo 'Unexpected curl request' >&2; exit 9 ;;
esac
`);
  executable('docker',String.raw`printf '%s\n' "$*" >> "$TEST_ROOT/actions"
case "$*" in
  'compose config --images gearbeacon') test "$TEST_CASE" != image-override || { echo other; exit 0; }; echo "ghcr.io/alexphillips-dev/gearbeacon:$GEARBEACON_IMAGE_TAG" ;;
  'compose pull gearbeacon') test "$TEST_CASE" != pull ;;
  'image inspect --format {{.Id}} '*) echo sha256:requested ;;
  'compose up -d --no-deps gearbeacon') test "$TEST_CASE" != restart ;;
  'compose ps -q gearbeacon') echo mock-container ;;
  'inspect --format {{.Image}} mock-container') if test "$TEST_CASE" = wrong-image; then echo sha256:old; else echo sha256:requested; fi ;;
  'compose exec -T gearbeacon node -e '*)
    test "$TEST_CASE" != wrong-version && test "$TEST_CASE" != unreachable || exit 1
    shift 5
    # Execute the actual verifier with a stub fetch, preserving its requested version argument.
    verifier=$2
    node -e "global.fetch=async()=>({ok:true,json:async()=>({ok:true,name:'GearBeacon',version:'1.2.1'})}); $verifier" "$3" ;;
  *) echo 'Unexpected Docker command' >&2; exit 9 ;;
esac
`);
  const original='# Preserve comments and unrelated settings\nMOCK_SETTING="fake value"\nGEARBEACON_IMAGE_TAG=1.2.0\nexport GEARBEACON_IMAGE_TAG = older\n';
  for (const scenario of ['pull','image-override','restart','wrong-image','wrong-version','unreachable','success']) {
    writeFileSync(join(project,'.env'),original); writeFileSync(join(fixture,'actions'),'');
    const result=run('deploy/update-docker.sh',['1.2.1','--backup-confirmed','1'],scenario); check(result,scenario==='success');
    const env=readFileSync(join(project,'.env'),'utf8');
    if (['pull','image-override'].includes(scenario)) { assert.equal(env,original); assert.ok(!readFileSync(join(fixture,'actions'),'utf8').includes('compose up')); }
    else {
      assert.ok(env.includes('MOCK_SETTING="fake value"')); assert.ok(env.includes('# Preserve comments')); assert.equal((env.match(/GEARBEACON_IMAGE_TAG/g)||[]).length,1,`${scenario}: ${env}\n${output(result)}`); assert.ok(env.includes('GEARBEACON_IMAGE_TAG=1.2.1'));
      if (scenario!=='success') assert.ok(output(result).includes('matching secrets.key'));
    }
    assert.ok(!existsSync(join(project,'.gearbeacon-update.lock')));
  }
  // The shell updater never calls real service commands or downloads in these fixtures.
  for (const platform of ['Linux','Darwin']) {
    const name=`GearBeacon-v1.2.1-${platform==='Linux'?'linux':'macos'}-x64`;
    const packageDir=join(fixture,name); mkdirSync(join(packageDir,'web'),{recursive:true});
    writeFileSync(join(packageDir,'gearbeacon'),'new executable fixture'); writeFileSync(join(packageDir,'web/index.html'),'new UI');
    writeFileSync(join(packageDir,'release-manifest.json'),'{"version":"1.2.1"}'); writeFileSync(join(packageDir,'build-info.json'),'{"packageVersion":"1.2.1"}');
    const packed=spawnSync(bash,['-c','tar -czf package.tar.gz "$1"','fixture',name],{cwd:fixture,encoding:'utf8',windowsHide:true}); check(packed,true);
    const hash=createHash('sha256').update(readFileSync(join(fixture,'package.tar.gz'))).digest('hex');
    for (const scenario of ['checksum','stop','restart','wrong-version','wrong-app','unreachable','success']) {
      writeFileSync(join(fixture,'package.sha256'),`${scenario==='checksum'?'0'.repeat(64):hash}  package.tar.gz\n`);
      writeFileSync(join(install,'gearbeacon'),'old executable fixture'); mkdirSync(join(install,'web'),{recursive:true}); writeFileSync(join(install,'web/obsolete.html'),'old UI');
      writeFileSync(join(fixture,'actions'),'');
      const result=run('deploy/update-mac-linux.sh',['1.2.1','--backup-confirmed','--port','9876','--timeout-seconds','1','--install-dir',unix(install)],scenario,platform);
      check(result,scenario==='success');
      if (['checksum','stop'].includes(scenario)) assert.equal(readFileSync(join(install,'gearbeacon'),'utf8'),'old executable fixture');
      if (scenario==='success') { assert.ok(!existsSync(join(install,'web/obsolete.html'))); assert.ok(readFileSync(join(install,'build-info.json'),'utf8').includes('1.2.1')); }
      else if (scenario!=='checksum') assert.ok(output(result).includes('matching secrets.key'),output(result));
    }
  }
  console.log('Unix updater tests passed: Docker pin preservation/image verification; Linux/macOS checksum, stop/restart, health/version failures, metadata and success.');
} finally { rmSync(fixture,{recursive:true,force:true}); }
