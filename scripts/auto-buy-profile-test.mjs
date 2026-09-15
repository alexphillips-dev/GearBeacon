import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openVault, VaultError } from '../checkout/vault.mjs';
import { PROFILE_FIELDS, profileMatches, savedProfileReport, setupProfile } from '../checkout/profiles.mjs';

export async function testProfileSetup() {
  const root = await mkdtemp(join(tmpdir(),'gearbeacon-profile-test-'));
  const directory = join(root,'vault'), missing = join(root,'missing');
  const secret = 'fixture-session-must-stay-private';
  const storageState = { cookies:[{ name:'session',value:secret,domain:'store.ui.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax' }],origins:[] };
  const profile = { id:'fixture-profile',region:'us',state:'ready',addressLabel:'Home',paymentLabel:'Visa ···· 4242',payment:'visa:4242',
    shipping:'a'.repeat(64),billing:'b'.repeat(64),delivery:'c'.repeat(64),customer:'d'.repeat(64),storageState };
  const state = { profiles:{},journal:{},token:secret,base:'https://dashboard.example.invalid',mode:'live' };
  const cli = async (dir,command='profiles') => {
    try { const result = await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../checkout/companion.mjs',import.meta.url)),command],
      { env:{ ...process.env,GEARBEACON_CHECKOUT_DATA_DIR:dir },timeout:10000,encoding:'utf8' }); return { code:0,...result }; }
    catch (err) { return { code:err.code,stdout:err.stdout,stderr:err.stderr }; }
  };
  try {
    const empty = await cli(missing);
    assert.equal(empty.code,1);assert.match(empty.stdout,/No address profile is saved/);
    assert.deepEqual(await readdir(root),[],'Inspecting missing setup created private vault files');
    const vault = openVault(directory);vault.write(state);
    const oldBytes = await readFile(join(directory,'vault.checkout-state'));
    let writes = 0, prompts = 0, inspections = 0, emptyChecks = 0;
    const logs = [];
    const checkedVault = { read:vault.read,write:value=>{ writes++;vault.write(value); } };
    const store = {
      inspectProfile:async()=>++inspections === 1 ? { checks:[{name:'Shipping address',ok:false,help:'Select the address in checkout.'}],profile:null }
        : { checks:[{name:'Shipping address',ok:true}],profile:structuredClone(profile) },
      confirmEmptyCart:async()=>++emptyChecks > 1,
      context:{storageState:async()=>structuredClone(storageState)},
    };
    await setupProfile({store,region:'us',addressLabel:'Home',state,vault:checkedVault,log:line=>logs.push(line),ask:async()=>{
      prompts++;assert.equal(writes,0,'Profile saved before the final empty-cart check');
      if(prompts > 2) assert.ok(logs.some(line=>line.includes('NOT SAVED YET')));
      return '';
    }});
    assert.equal(prompts,4);assert.equal(writes,1);assert.equal(vault.read().profiles.us.id,profile.id);
    assert.ok(Number.isFinite(Date.parse(vault.read().profiles.us.savedAt)));
    assert.ok(logs.some(line=>line.startsWith('SAVED: Home (US)')));
    assert.ok(!logs.join('\n').includes(secret));
    assert.notDeepEqual(await readFile(join(directory,'vault.checkout-state')),oldBytes);
    const saved = state.profiles.us;
    const snapshot = await readFile(join(directory,'vault.checkout-state'));
    const lock = vault.lock();
    try {
      assert.throws(()=>vault.lock(),err=>err instanceof VaultError && err.code === 'locked');
      const report = await cli(directory);
      assert.equal(report.code,0);assert.match(report.stdout,/Home.*Saved profile complete/);assert.match(report.stdout,/visa ···· 4242/);
      assert.ok(!report.stdout.includes(secret));assert.ok(!report.stdout.includes(state.base));assert.ok(!report.stdout.includes(profile.shipping));
      const blocked = await cli(directory,'verify');
      assert.equal(blocked.code,1);assert.match(blocked.stderr,/already using this vault/);assert.ok(!blocked.stderr.includes(directory));
    } finally { lock(); }
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot,'Read-only inspection rewrote the encrypted vault');
    assert.throws(()=>openVault(directory,{readOnly:true}).write(state),err=>err.code === 'read-only');
    // Cancellation after successful checkout validation preserves an earlier profile.
    let cancelPrompts = 0;
    await assert.rejects(setupProfile({store,region:'us',addressLabel:'Replacement',state,vault:checkedVault,log:()=>{},ask:async()=>{
      if(++cancelPrompts === 2) throw Error('Fixture cancellation');return '';
    }}),/cancellation/);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    assert.equal(state.profiles.us,saved);
    const failedSaveLogs = [];
    await assert.rejects(setupProfile({store,region:'us',addressLabel:'Replacement',state,
      vault:{read:vault.read,write:()=>{throw Error('Fixture disk failure');}},log:line=>failedSaveLogs.push(line),ask:async()=>''}),/disk failure/);
    assert.ok(!failedSaveLogs.some(line=>line.startsWith('SAVED:')),'An unsuccessful write was reported as saved');
    assert.equal(state.profiles.us,saved);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    // Verify must compare each saved choice, allow correction, and never replace the profile.
    let comparisons = 0;const verificationLogs = [];
    const verifier = { ...store,inspectProfile:async()=>({checks:[{name:'Checkout',ok:true}],profile:{...profile,shipping:++comparisons === 1 ? 'e'.repeat(64) : profile.shipping}}) };
    await setupProfile({store:verifier,region:'us',addressLabel:'Home',saved,state,vault:checkedVault,log:line=>verificationLogs.push(line),ask:async()=>''});
    assert.equal(comparisons,2);assert.equal(writes,1);assert.equal(state.profiles.us,saved);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    assert.ok(verificationLogs.includes('DIFFERENT · Shipping address'));assert.ok(verificationLogs.some(line=>line.startsWith('VERIFIED:')));
    for(const [field,name] of Object.entries(PROFILE_FIELDS)) {
      const checks=profileMatches(profile,{...profile,[field]:'different-fixture-value'});
      assert.deepEqual(checks.filter(check=>!check.ok).map(check=>check.name),[name]);
    }
    const incomplete = savedProfileReport({...state,profiles:{us:{...profile,billing:null}}});
    assert.equal(incomplete.ok,false);assert.ok(incomplete.lines.includes('MISSING · Billing address'));
    const noSession = savedProfileReport({...state,profiles:{us:{...profile,storageState:{cookies:[],origins:[]}}}});
    assert.equal(noSession.ok,false);
    assert.ok(savedProfileReport({...state,profiles:{us:profile}}).lines.includes('Saved at: not recorded by this companion version'),'Existing profiles without timestamps must remain inspectable');
    // Failures must not expose private exception paths or create a replacement key.
    await writeFile(join(directory,'vault.checkout-state'),'fixture-corrupt-vault');
    const corrupt = await cli(directory);
    assert.equal(corrupt.code,1);assert.ok(!corrupt.stderr.includes(directory));assert.ok(!corrupt.stderr.includes(' at '));
    if(process.platform !== 'win32') {
      await chmod(directory,0o755);
      assert.throws(()=>openVault(directory,{readOnly:true}),err=>err.code === 'permissions');
      await chmod(directory,0o700);
    }
    await rm(join(directory,'checkout.key'));
    const noKey = await cli(directory);
    assert.equal(noKey.code,1);assert.deepEqual(await readdir(directory),['vault.checkout-state'],'Inspection generated a replacement encryption key');
    console.log('AUTO-BUY PROFILE TEST PASSED: retry, save confirmation, cancellation, verification mismatch, no profile replacement, read-only CLI alongside worker, legacy profiles, and private output.');
  } finally { await rm(root,{recursive:true,force:true}); }
}
