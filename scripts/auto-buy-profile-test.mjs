import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { openVault, VaultError } from '../checkout/vault.mjs';
import { windowsOperation } from '../checkout/windows-protection.mjs';
import { PROFILE_FIELDS, profileMatches, savedProfileReport, setupProfile } from '../checkout/profiles.mjs';
import { createTerminal } from '../checkout/terminal.mjs';

async function testSetupOutput() {
  const checks = [
    { name:'Shipping address',ok:true },
    { name:'Signed-in Store account',ok:false,help:'Sign in directly in the dedicated browser, finish any account challenge, and return to checkout review before trying again.' },
    { name:'Selected saved card',ok:false,help:'Select a saved card with a visible masked last-four label. New-card forms and wallets cannot be verified.' },
  ];
  for (const columns of [40,80,120]) for (const color of [false,true]) {
    const lines = [], output = createTerminal({ write:line=>lines.push(line),columns:()=>columns,color });
    output.checks('Checkout check 1',checks);
    output.checks('Checkout check 2',checks.map(check=>({...check,ok:true})));
    output.notice('SAVED',['Home (US) address profile and browser session are encrypted locally.'],'success');
    const prompt = await output.prompt(async value=>{ assert.equal(value,'  > ');return 'fixture answer'; },'Correct the checks above in the browser. Press Enter to check again, or Ctrl+C to cancel.');
    assert.equal(prompt,'fixture answer');
    const plain = lines.map(stripVTControlCharacters), text = plain.join('\n');
    assert.ok(plain.every(line=>line.length<=Math.min(columns,88)),`Terminal output overflowed ${columns} columns`);
    assert.match(text.replace(/\s+/g,' '),/1 of 3 checks passed \| 2 need attention/);
    assert.ok(text.indexOf('[FIX]')<text.indexOf('[PASS]'),'Failed checks were buried under passed checks');
    assert.ok(plain.includes('  [FIX]  Signed-in Store account'));
    assert.ok(plain.includes('  [PASS] Shipping address'),'Check labels were not aligned');
    for (const title of ['Checkout check 1','Checkout check 2','SAVED']) {
      const index=plain.indexOf(title);assert.ok(index>0 && plain[index-1]==='' && /^-+$/.test(plain[index+1]) && plain[index+2]==='','A retry or final result was not clearly separated');
    }
    assert.ok(text.replace(/\s+/g,' ').includes(checks[1].help),'Wrapping dropped or changed a help instruction');
    assert.equal(lines.some(line=>line.includes('\x1b[')),color);
    assert.ok(!lines.some(line=>/\x1b\[(?:2J|H|\d*A)/.test(line)),'Setup erased prior output or moved the cursor');
    const longLines=[];
    createTerminal({write:line=>longLines.push(line),columns:()=>columns,color:false}).text('x'.repeat(180));
    assert.equal(longLines.map(line=>line.trim()).join(''),'x'.repeat(180),'A long nickname was truncated');
    assert.ok(longLines.every(line=>line.length<=Math.min(columns,88)));
  }
  const previousNoColor=process.env.NO_COLOR;
  const previousTerm=process.env.TERM;
  try {
    process.env.NO_COLOR='1';
    const lines=[];
    createTerminal({stream:{isTTY:true,columns:80},write:line=>lines.push(line)}).checks('Checkout check 1',checks);
    assert.ok(!lines.join('').includes('\x1b'),'NO_COLOR was ignored');
    delete process.env.NO_COLOR;process.env.TERM='dumb';lines.length=0;
    createTerminal({stream:{isTTY:true,columns:80},write:line=>lines.push(line)}).checks('Checkout check 1',checks);
    assert.ok(!lines.join('').includes('\x1b'),'TERM=dumb was ignored');
  } finally {
    if(previousNoColor===undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR=previousNoColor;
    if(previousTerm===undefined) delete process.env.TERM; else process.env.TERM=previousTerm;
  }
}

export async function testProfileSetup() {
  await testSetupOutput();
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
    if (process.platform === 'win32') {
      const keyFile = join(directory, 'checkout.key');
      const protectedKey = await readFile(keyFile, 'utf8');
      assert.match(protectedKey, /^dpapi-v1:/, 'The checkout key was stored unprotected on Windows.');
      const legacyKey = Buffer.from(windowsOperation(keyFile, 'unprotect', protectedKey.slice(9)), 'base64');
      await writeFile(keyFile, legacyKey);
      assert.equal(openVault(directory,{readOnly:true}).read().token, secret, 'A legacy key could not be read without changing it.');
      assert.deepEqual(await readFile(keyFile), legacyKey, 'Read-only inspection migrated the legacy key.');
      assert.equal(openVault(directory).read().token, secret, 'Migrating a legacy key changed the vault contents.');
      assert.match(await readFile(keyFile, 'utf8'), /^dpapi-v1:/, 'A writable open did not protect the legacy key.');
      await promisify(execFile)('icacls', [directory, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide:true });
      assert.throws(()=>openVault(directory,{readOnly:true}), /Unable to secure the private checkout vault/, 'Read-only inspection accepted a broadly readable vault directory.');
      assert.equal(openVault(directory).read().token, secret, 'Restricting the vault ACL changed its contents.');
      assert.equal(openVault(directory,{readOnly:true}).read().token, secret, 'The repaired vault ACL was not verifiable.');
    }
    const oldBytes = await readFile(join(directory,'vault.checkout-state'));
    let writes = 0, prompts = 0, inspections = 0, emptyChecks = 0;
    const logs = [];
    const capture = write=>createTerminal({write,columns:()=>80,color:false});
    const checkedVault = { read:vault.read,write:value=>{ writes++;vault.write(value); } };
    const store = {
      inspectProfile:async()=>++inspections === 1 ? { checks:[{name:'Shipping address',ok:false,help:'Select the address in checkout.'}],profile:null }
        : { checks:[{name:'Shipping address',ok:true}],profile:structuredClone(profile) },
      confirmEmptyCart:async()=>++emptyChecks > 1,
      context:{storageState:async()=>structuredClone(storageState)},
    };
    await setupProfile({store,region:'us',addressLabel:'Home',state,vault:checkedVault,terminal:capture(line=>logs.push(line)),ask:async()=>{
      prompts++;assert.equal(writes,0,'Profile saved before the final empty-cart check');
      if(prompts > 2) assert.ok(logs.some(line=>line.includes('NOT SAVED YET')));
      return '';
    }});
    assert.equal(prompts,4);assert.equal(writes,1);assert.equal(vault.read().profiles.us.id,profile.id);
    assert.ok(Number.isFinite(Date.parse(vault.read().profiles.us.savedAt)));
    assert.ok(logs.includes('SAVED'));assert.ok(logs.some(line=>line.includes('Home (US) address profile')));
    assert.ok(logs.includes('Checkout check 1') && logs.includes('Checkout check 2'),'Retry headings were missing from the setup flow');
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
    await assert.rejects(setupProfile({store,region:'us',addressLabel:'Replacement',state,vault:checkedVault,terminal:capture(()=>{}),ask:async()=>{
      if(++cancelPrompts === 2) throw Error('Fixture cancellation');return '';
    }}),/cancellation/);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    assert.equal(state.profiles.us,saved);
    let entryPrompts=0;
    await assert.rejects(setupProfile({store:{...store,inspectProfile:async()=>({checks:[{name:'Selected saved card',ok:false,help:'Card-entry forms cannot be saved.'}],profile:null,paymentStatus:'card-entry'})},
      region:'us',addressLabel:'Home',state,vault:checkedVault,terminal:capture(()=>{}),ask:async prompt=>{
        if(++entryPrompts===2){assert.match(prompt,/no reusable saved card, press Ctrl\+C to exit/);throw Error('Fixture unsupported payment cancellation');}return '';
      }}),/unsupported payment cancellation/);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot,'An unsupported card-entry form changed the saved profile');
    const failedSaveLogs = [];
    await assert.rejects(setupProfile({store,region:'us',addressLabel:'Replacement',state,
      vault:{read:vault.read,write:()=>{throw Error('Fixture disk failure');}},terminal:capture(line=>failedSaveLogs.push(line)),ask:async()=>''}),/disk failure/);
    assert.ok(!failedSaveLogs.includes('SAVED'),'An unsuccessful write was reported as saved');
    assert.equal(state.profiles.us,saved);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    // Verify must compare each saved choice, allow correction, and never replace the profile.
    let comparisons = 0;const verificationLogs = [];
    const verifier = { ...store,inspectProfile:async()=>({checks:[{name:'Checkout',ok:true}],profile:{...profile,shipping:++comparisons === 1 ? 'e'.repeat(64) : profile.shipping}}) };
    await setupProfile({store:verifier,region:'us',addressLabel:'Home',saved,state,vault:checkedVault,terminal:capture(line=>verificationLogs.push(line)),ask:async()=>''});
    assert.equal(comparisons,2);assert.equal(writes,1);assert.equal(state.profiles.us,saved);
    assert.deepEqual(await readFile(join(directory,'vault.checkout-state')),snapshot);
    assert.ok(verificationLogs.includes('  [DIFF] Shipping address'));assert.ok(verificationLogs.includes('VERIFIED'));
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
    console.log('AUTO-BUY PROFILE TEST PASSED: readable terminal output, narrow wrapping, color/plain text, retry, save confirmation, cancellation, verification mismatch, no profile replacement, read-only CLI alongside worker, legacy profiles, and private output.');
  } finally { await rm(root,{recursive:true,force:true}); }
}
