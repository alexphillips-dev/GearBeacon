import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const bash=process.platform==='win32' ? join(process.env.ProgramFiles || 'C:/Program Files','Git/bin/bash.exe') : 'sh';
if (process.platform==='win32' && !existsSync(bash)) throw new Error('Git Bash is needed to run the Unix updater fixtures on Windows.');
const fixture=mkdtempSync(join(tmpdir(),"gearbeacon-unix-update-space & quote'-"));
const runner=join(fixture,'run-updater.sh');
const bin=join(fixture,'bin'); const project=join(fixture,'compose'); const install=join(fixture,'gearbeacon');
const unix=value=>value.replaceAll('\\','/');
const executable=(name,body)=>{ const file=join(bin,name); writeFileSync(file,'#!/usr/bin/env sh\nset -eu\n'+body); chmodSync(file,0o755); };
const run=(script,args=[],scenario='success',platform='Linux')=>{
  writeFileSync(join(fixture,'clock'),'0\n');
  return spawnSync(bash,[unix(runner),unix(bin),unix(join(root,script)),...args],{cwd:project,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,TEST_ROOT:unix(fixture),TEST_CASE:scenario,TEST_PLATFORM:platform,COMPOSE_ENV_FILES:'',COMPOSE_DISABLE_ENV_FILE:'0',COMPOSE_FILE:'',GEARBEACON_IMAGE_TAG:''}});
};
const output=result=>`${result.stdout || ''}\n${result.stderr || ''}`;
const check=(result,success)=>assert.equal(result.status===0,success,output(result));
try {
  for (const dir of [bin,project,install]) mkdirSync(dir);
  // Keep shell source literal and pass every filesystem path as a separate argument.
  writeFileSync(runner,'#!/usr/bin/env sh\nset -eu\nexport PATH="$(cd "$1" && pwd -P):$PATH"\nshift\nexec sh "$@"\n');
  writeFileSync(join(project,'compose.yaml'),'services:\n  gearbeacon:\n    image: mock\n');
  // Advance deadline time only when the updater sleeps. Real one-second budgets
  // can expire before the first health probe on a busy Windows/Git Bash runner.
  executable('date','test "$1" = +%s\ncat "$TEST_ROOT/clock"\n');
  executable('sleep','now=$(cat "$TEST_ROOT/clock")\nprintf "%s\\n" "$((now + $1))" > "$TEST_ROOT/clock"\n');
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
  executable('gh',String.raw`printf '%s\n' "$*" >> "$TEST_ROOT/actions"
case "$*" in *'--repo alexphillips-dev/GearBeacon'*'--signer-workflow alexphillips-dev/GearBeacon/.github/workflows/'*'--source-ref refs/tags/v1.2.1 --source-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --deny-self-hosted-runners') ;; *) exit 9;; esac
case "$*" in *'--bundle '*.jsonl' --repo '*) ;; *) echo 'Expected a JSONL verification bundle' >&2; exit 9;; esac
test "$TEST_CASE" != provenance
`);
  executable('curl',String.raw`case "$*" in
  *api.github.com/repos/alexphillips-dev/GearBeacon/commits/refs%2Ftags%2Fv1.2.1*) printf '  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n' ;;
  *.attestation.jsonl*) test "$TEST_CASE" != missing-bundle || exit 22; printf 'mock signed bundle' > "$4" ;;
  *127.0.0.1:9876/healthz*)
    if test "$TEST_CASE" = delayed-start && test "$(cat "$TEST_ROOT/clock")" -lt 2; then exit 7; fi
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
  'image inspect --format {{index .RepoDigests 0}} '*) echo ghcr.io/alexphillips-dev/gearbeacon@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  'image inspect --format {{.Id}} '*) echo sha256:requested ;;
  'compose up -d --no-deps gearbeacon') test "$TEST_CASE" != restart ;;
  'compose ps -q gearbeacon') echo mock-container ;;
  'inspect --format {{.Image}} mock-container') if test "$TEST_CASE" = wrong-image; then echo sha256:old; else echo sha256:requested; fi ;;
  'compose exec -T gearbeacon node -e '*)
    test "$TEST_CASE" != wrong-version && test "$TEST_CASE" != unreachable || exit 1
    if test "$TEST_CASE" = delayed-start && test "$(cat "$TEST_ROOT/clock")" -lt 2; then exit 1; fi
    shift 5
    # Execute the actual verifier with a stub fetch, preserving its requested version argument.
    verifier=$2
    node -e "global.fetch=async()=>({ok:true,json:async()=>({ok:true,name:'GearBeacon',version:'1.2.1'})}); $verifier" "$3" ;;
  *) echo 'Unexpected Docker command' >&2; exit 9 ;;
esac
`);
  const original='# Preserve comments and unrelated settings\nMOCK_SETTING="fake value"\nGEARBEACON_IMAGE_TAG=1.2.0\nexport GEARBEACON_IMAGE_TAG = older\n';
  for (const scenario of ['pull','image-override','provenance','missing-bundle','restart','wrong-image','wrong-version','unreachable','success','delayed-start']) {
    writeFileSync(join(project,'.env'),original); writeFileSync(join(fixture,'actions'),'');
    const success=['success','delayed-start'].includes(scenario);
    const result=run('deploy/update-docker.sh',['1.2.1','--backup-confirmed',scenario==='delayed-start'?'3':'1'],scenario); check(result,success);
    if (scenario==='delayed-start') assert.equal(readFileSync(join(fixture,'clock'),'utf8').trim(),'2','Docker startup should retry until health is ready');
    const env=readFileSync(join(project,'.env'),'utf8');
    if (['pull','image-override','provenance','missing-bundle'].includes(scenario)) { assert.equal(env,original); assert.ok(!readFileSync(join(fixture,'actions'),'utf8').includes('compose up')); }
    else {
      assert.ok(env.includes('MOCK_SETTING="fake value"')); assert.ok(env.includes('# Preserve comments')); assert.equal((env.match(/GEARBEACON_IMAGE_TAG/g)||[]).length,1,`${scenario}: ${env}\n${output(result)}`); assert.ok(env.includes('GEARBEACON_IMAGE_TAG=1.2.1@sha256:'+'b'.repeat(64)));
      if (!success) assert.ok(output(result).includes('matching secrets.key'));
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
    for (const scenario of ['checksum','provenance','missing-bundle','stop','restart','wrong-version','wrong-app','unreachable','success','delayed-start']) {
      writeFileSync(join(fixture,'package.sha256'),`${scenario==='checksum'?'0'.repeat(64):hash}  package.tar.gz\n`);
      writeFileSync(join(install,'gearbeacon'),'old executable fixture'); mkdirSync(join(install,'web'),{recursive:true}); writeFileSync(join(install,'web/obsolete.html'),'old UI');
      writeFileSync(join(fixture,'actions'),'');
      const success=['success','delayed-start'].includes(scenario);
      const result=run('deploy/update-mac-linux.sh',['1.2.1','--backup-confirmed','--port','9876','--timeout-seconds',scenario==='delayed-start'?'3':'1','--install-dir',unix(install)],scenario,platform);
      check(result,success);
      if (scenario==='delayed-start') assert.equal(readFileSync(join(fixture,'clock'),'utf8').trim(),'2',`${platform} startup should retry until health is ready`);
      if (['checksum','provenance','missing-bundle','stop'].includes(scenario)) assert.equal(readFileSync(join(install,'gearbeacon'),'utf8'),'old executable fixture');
      if (success) { assert.ok(!existsSync(join(install,'web/obsolete.html'))); assert.ok(readFileSync(join(install,'build-info.json'),'utf8').includes('1.2.1')); }
      else if (!['checksum','provenance','missing-bundle'].includes(scenario)) assert.ok(output(result).includes('matching secrets.key'),output(result));
    }
  }
  console.log('Unix updater tests passed: Docker pin preservation/image verification; Linux/macOS checksum, stop/restart, health/version failures, deterministic startup retries, metadata and success.');
} finally { rmSync(fixture,{recursive:true,force:true}); }
