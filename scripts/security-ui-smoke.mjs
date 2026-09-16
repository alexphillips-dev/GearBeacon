import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { totp } from '../backend/dist/security.js';

export async function testSecurityUi({evaluate,waitForBrowser,assertAccessible,assert,cdp,testRoot}) {
  const database = new DatabaseSync(join(testRoot,'gearbeacon.mock.sqlite3'));
  const password='V1.3.0 browser owner password';
  const expireVerification=()=>database.prepare('UPDATE sessions SET verified_at=?').run(new Date(Date.now()-360000).toISOString());
  try {
    await evaluate("activateSettingsTab('security'); activateSettingsSection('security','sessions'); refreshSecuritySettings()");
    expireVerification();
    await evaluate("document.getElementById('sessionHours').value='12'; document.getElementById('sessionPolicyForm').requestSubmit()");
    await waitForBrowser("document.getElementById('securityVerifyDialog').open",'Sensitive setting did not require fresh verification');
    for (const theme of ['light','dark']) {
      await evaluate(`applyTheme('${theme}')`);
      for (const width of [390,640,1280]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:width===640?2:1,mobile:false});
        assert(await evaluate("(() => { const dialog=document.getElementById('securityVerifyDialog'), r=dialog.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && dialog.scrollWidth<=dialog.clientWidth+1; })()"),'Verification modal overflows');
      }
      await assertAccessible('Owner verification '+theme);
    }
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitForBrowser("!document.getElementById('securityVerifyDialog').open",'Escape did not cancel verification');
    assert((await evaluate("authRequest('/api/auth/security')")).policy.sessionHours===24,'Cancelled verification changed policy');
    await evaluate("document.getElementById('sessionPolicyForm').requestSubmit()");
    await waitForBrowser("document.getElementById('securityVerifyDialog').open",'Verification did not reopen');
    await evaluate(`document.getElementById('verifyPassword').value=${JSON.stringify(password)}; document.getElementById('securityVerifyForm').requestSubmit()`);
    await waitForBrowser("!document.getElementById('securityVerifyDialog').open && document.getElementById('sessionHours').value==='12'",'Verification did not resume the saved action');
    await evaluate("activateSettingsSection('security','password'); document.getElementById('mfaBegin').click()");
    await waitForBrowser("!document.getElementById('mfaSetup').hidden && document.getElementById('mfaSecret').value.length===32",'Authenticator setup key unavailable');
    const secret=await evaluate("document.getElementById('mfaSecret').value");
    const bits=[...secret].map(c=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0')).join('');
    const bytes=Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2)));
    await evaluate(`document.getElementById('mfaCode').value=${JSON.stringify(totp(bytes.toString('base64')))}; document.getElementById('mfaSetup').requestSubmit()`);
    await waitForBrowser("!document.getElementById('mfaRecovery').hidden && app.auth.mfaEnabled",'Authenticator was not enabled');
    const codes=(await evaluate("document.getElementById('mfaRecoveryCodes').value")).split('\n');
    assert(codes.length===10,'Recovery codes were not displayed');
    await evaluate('logout()');
    assert(await evaluate("document.getElementById('mfaSecret').value==='' && document.getElementById('mfaRecoveryCodes').value===''"),'Lock retained setup secrets');
    await evaluate(`document.getElementById('authPassword').value=${JSON.stringify(password)}; document.getElementById('authCode').value=${JSON.stringify(codes[0])}; document.getElementById('authForm').requestSubmit()`);
    await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden')",'Recovery code login failed');
    await evaluate("authRequest('/api/auth/mfa/disable',{method:'POST',body:'{}'})");
    await evaluate("refreshSecuritySettings()");
    await evaluate("openProductDialog('u7-pro-xgs')");
    database.prepare('UPDATE sessions SET activity_at=?').run(new Date(Date.now()-31*60000).toISOString());
    await evaluate("api('/api/status').catch(()=>null)");
    await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')",'Idle expiry did not lock the dashboard');
    await evaluate(`document.getElementById('authPassword').value=${JSON.stringify(password)}; document.getElementById('authForm').requestSubmit()`);
    await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden')",'Dashboard could not unlock');
    assert(await evaluate("!document.querySelector('main').inert && !document.getElementById('appShell').inert"),'Unlock retained the previous dialog focus lock');
    await evaluate("authRequest('/api/auth/security',{method:'PUT',body:JSON.stringify({sessionHours:24,idleMinutes:30,privateNotificationHosts:[]})})");
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    console.log('Security UI passed: responsive verification, cancellation, authenticator enrollment/recovery login, secret clearing, and idle lock.');
  } finally { database.close(); }
}
