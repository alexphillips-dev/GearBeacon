import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function testAutoBuyUi({ evaluate,waitForBrowser,assertAccessible,assert,cdp,screenshotRoot }) {
  await evaluate("autoBuyNavigate('settings');refreshAutoBuy()");
  await waitForBrowser("autoBuyState && !autoBuyState.connection && document.getElementById('autoBuyGuide').open",'Unpaired checkout setup did not expand automatically');
  await waitForBrowser('!autoBuyLoading','Auto-buy status did not settle');
  await evaluate("document.querySelector('#autoBuyGuide summary').click();refreshAutoBuy()");
  await waitForBrowser('!autoBuyLoading','Auto-buy status did not settle after a manual toggle');
  assert(await evaluate("!document.getElementById('autoBuyGuide').open"),'Background polling reopened manually collapsed setup instructions');
  await evaluate("document.querySelector('#autoBuyGuide summary').click();document.getElementById('autoBuyPair').click()");
  await waitForBrowser("!document.getElementById('autoBuyPairing').hidden && /^[A-Za-z0-9_-]{32}$/.test(document.getElementById('autoBuyPairing').value)",'Pairing field did not show only the one-time code');
  assert(await evaluate("document.getElementById('autoBuyPairing').labels[0]?.textContent==='Pairing code (mock mode, expires in 5 minutes):'"),'The pairing mode and expiry label is missing or not associated with the code');
  await evaluate("document.querySelector('#settingsGeneralAutoBuyPanel [data-auto-purchases]').focus()");
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert(await evaluate("(() => {const field=document.getElementById('autoBuyPairing');return document.activeElement===field && field.readOnly && field.selectionStart===0 && field.selectionEnd===field.value.length;})()"),'Tab focus did not select the code alone for copying');
  await evaluate("document.getElementById('autoBuyPairing').setSelectionRange(3,8);document.getElementById('autoBuyPairing').click()");
  assert(await evaluate("(() => {const field=document.getElementById('autoBuyPairing');return field.value.slice(field.selectionStart,field.selectionEnd)===field.value && !field.value.includes('Pairing code');})()"),'Clicking the code did not select only the code');
  for(const theme of ['dark','light'])for(const width of [1280,390,640]) {
    await evaluate(`applyTheme('${theme}')`);await delay(300);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===640?450:900,deviceScaleFactor:width===640?2:1,mobile:false});
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.getElementById('autoBuyPairing').scrollWidth<=document.getElementById('autoBuyPairing').clientWidth+1"),`Pairing setup overflowed in ${theme} at ${width}px`);
    if(width===1280)assert(await evaluate("(() => {const label=document.getElementById('autoBuyPairingLabel').getBoundingClientRect(),field=document.getElementById('autoBuyPairing').getBoundingClientRect();return field.width<320 && field.left>=label.right+8 && Math.abs(field.top+field.height/2-label.top-label.height/2)<1;})()"),'The code field was not compact and aligned to the right of its label');
    await assertAccessible(`Auto-buy pairing ${theme} ${width}px`);
  }
  await evaluate(`(async()=>{
    app.currentRegion='us';activateTab('watchlist');
    await api('/api/mock/product/uvc-g5-ptz',{method:'POST',body:JSON.stringify({variants:[{id:'autobuy-ui',slug:'autobuy-ui',sku:'AUTO-UI',title:'Test exact variant',status:'SoldOut',displayPrice:'$299.00'}]})});
    await api('/api/check',{method:'POST',body:'{}'});
    window.autoBuyUiSlug='uvc-g5-ptz::autobuy-ui';
    await api('/api/watch',{method:'POST',body:JSON.stringify({slug:window.autoBuyUiSlug})});
    const paired=await(await fetch('/api/auto-buy/worker/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('autoBuyPairing').value,mode:'mock',protocol:1})})).json();
    window.autoBuyUiHeartbeat=()=>fetch('/api/auto-buy/worker/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+paired.token},body:JSON.stringify({protocol:1,mode:'mock',profiles:{us:{id:'ui-profile',state:'ready',addressLabel:'Home <test>',paymentLabel:'Visa ···· 4242'}}})});
  })()`);
  await waitForBrowser("autoBuyState?.connection && !document.getElementById('autoBuyGuide').open",'Pairing did not collapse the setup instructions');
  assert(await evaluate("document.getElementById('autoBuyConnection').textContent.includes('no saved address profile has been reported')"),'Pairing alone was presented as completed address setup');
  assert(await evaluate("document.getElementById('autoBuyPairingRow').hidden && !document.getElementById('autoBuyPairingLabel').textContent && document.getElementById('autoBuyPairing').hidden && !document.getElementById('autoBuyPairing').value"),'The consumed pairing code or its label remained visible');
  await waitForBrowser('!autoBuyLoading','Paired auto-buy status did not settle');
  assert(await evaluate(`(async()=>{
    const originalFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(new URL(String(args[0]),location.href).pathname==='/api/auto-buy' && response.ok) {
        const state=await response.json();state.connection.connected=false;
        return new Response(JSON.stringify(state),{headers:{'Content-Type':'application/json'}});
      }
      return response;
    };
    try { await refreshAutoBuy();return autoBuyState.connection && !autoBuyState.connection.connected && !document.getElementById('autoBuyGuide').open; }
    finally { window.fetch=originalFetch; }
  })()`),'An offline paired companion expanded setup as if it were unpaired');
  await evaluate("autoBuyNavigate('settings');document.querySelector('#autoBuyGuide summary').click();refreshAutoBuy()");
  await waitForBrowser('!autoBuyLoading','Paired auto-buy status did not settle');
  assert(await evaluate("document.getElementById('autoBuyGuide').open"),'Background polling collapsed manually expanded setup instructions');
  await evaluate(`(async()=>{
    await window.autoBuyUiHeartbeat();window.autoBuyUiTimer=setInterval(window.autoBuyUiHeartbeat,5000);
    activateTab('watchlist');
    document.getElementById('watchSearch').value='';document.getElementById('watchStatus').value='all';document.getElementById('watchCollection').value='all';app.watchQuickFilter='all';app.pendingWatchCategory='all';
    await refresh();await refreshAutoBuy();
  })()`);
  assert(await evaluate("document.getElementById('autoBuyConnection').textContent.includes('Saved profile · US · Home <test>') && !document.querySelector('#autoBuyConnection test')"),'The saved address profile was not reported safely');
  try {
    await waitForBrowser("document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]')",'Auto-buy setup button is missing');
    await evaluate("document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]').focus(); document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]').click()");
    await waitForBrowser("document.getElementById('autoBuyDialog').open && document.querySelector('[data-auto-form]')",'Auto-buy dialog did not open');
    await evaluate("document.querySelector('[data-auto-form] [name=total]').value='700.00';document.querySelector('[data-auto-form] [name=quantity]').value='2';refreshAutoBuy()");
    assert(await evaluate("document.querySelector('[data-auto-form] [name=total]').value==='700.00' && !document.querySelector('#autoBuyDialog test')"),'Background refresh lost a purchase draft or interpreted a checkout label as markup');
    for(const theme of ['dark','light'])for(const width of [1280,390,640]) {
      await evaluate(`applyTheme('${theme}')`);
      await delay(300);
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===640?450:900,deviceScaleFactor:width===640?2:1,mobile:false});
      assert(await evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.getElementById('autoBuyDialog').scrollWidth<=document.getElementById('autoBuyDialog').clientWidth+1"),`Auto-buy dialog overflowed in ${theme} at ${width}px`);
      await assertAccessible(`Auto-buy ${theme} ${width}px`);
      if(screenshotRoot&&width!==640){const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});await writeFile(join(screenshotRoot,`auto-buy-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));}
    }
    await evaluate("document.querySelector('[data-auto-form] [name=authorized]').checked=true;document.querySelector('[data-auto-form]').requestSubmit()");
    await waitForBrowser("!document.getElementById('autoBuyDialog').open && document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]').textContent==='Auto-buy armed'",'Arming did not persist the purchase instruction');
    assert(await evaluate("autoBuyState.rules.some(r=>r.sku==='AUTO-UI' && r.quantity===2 && r.maxTotalMinor===70000 && r.state==='armed')"),'The armed rule lost its exact SKU, quantity, or spending limit');
    await evaluate("document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]').focus();document.querySelector('[data-auto-buy=\"uvc-g5-ptz::autobuy-ui\"]').click()");
    await waitForBrowser("document.getElementById('autoBuyDialog').open",'Edit dialog did not reopen');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert(await evaluate("!document.getElementById('autoBuyDialog').open && document.activeElement.dataset.autoBuy==='uvc-g5-ptz::autobuy-ui'"),'Escape did not close the purchase dialog and restore focus');
    await evaluate("document.querySelector('#autoBuyWatchStatus [data-auto-pause-all]').click()");
    await waitForBrowser("autoBuyState.rules.find(r=>r.sku==='AUTO-UI')?.state==='paused'",'Pause all did not pause the armed instruction');
    await evaluate("autoBuyNavigate('purchases')");
    assert(await evaluate("app.activeTab==='settings' && app.activeSettingsTab==='operations' && !document.getElementById('settingsOperationsPurchasesPanel').hidden"),'Purchase history navigation failed');
    await evaluate("clearInterval(window.autoBuyUiTimer);autoBuyNavigate('settings');document.querySelector('#autoBuyGuide summary').click();document.getElementById('autoBuyDisconnect').click()");
    await waitForBrowser("!autoBuyState.connection && document.getElementById('autoBuyGuide').open",'Disconnecting did not expand the unpaired setup instructions');
    await evaluate("document.getElementById('autoBuyPair').click()");
    await waitForBrowser("!document.getElementById('autoBuyPairing').hidden && document.getElementById('autoBuyPairing').value",'Pairing code did not appear for auth-expiry check');
    await evaluate("showAutoBuy(window.autoBuyUiSlug)");
    await waitForBrowser("document.getElementById('autoBuyDialog').open",'Purchase dialog did not open for auth-expiry check');
    await evaluate("showAuth(false)");
    assert(await evaluate("!document.getElementById('autoBuyDialog').open && !document.getElementById('autoBuyDialogBody').textContent && document.getElementById('autoBuyPairing').hidden && !document.getElementById('autoBuyPairing').value"),'Owner access expiry left a purchase dialog or pairing code visible');
    await evaluate("enterApp()");
  } finally {
    await evaluate("clearInterval(window.autoBuyUiTimer);document.getElementById('autoBuyDialog').close();api('/api/auto-buy/disconnect',{method:'POST',body:'{}'});applyTheme('dark')");
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
}
