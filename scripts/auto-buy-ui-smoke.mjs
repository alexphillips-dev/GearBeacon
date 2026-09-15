import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function testAutoBuyUi({ evaluate,waitForBrowser,assertAccessible,assert,cdp,screenshotRoot }) {
  await evaluate(`(async()=>{
    app.currentRegion='us';activateTab('watchlist');
    await api('/api/mock/product/uvc-g5-ptz',{method:'POST',body:JSON.stringify({variants:[{id:'autobuy-ui',slug:'autobuy-ui',sku:'AUTO-UI',title:'Test exact variant',status:'SoldOut',displayPrice:'$299.00'}]})});
    await api('/api/check',{method:'POST',body:'{}'});
    window.autoBuyUiSlug='uvc-g5-ptz::autobuy-ui';
    await api('/api/watch',{method:'POST',body:JSON.stringify({slug:window.autoBuyUiSlug})});
    const pairing=await api('/api/auto-buy/pairing',{method:'POST',body:'{}'});
    const paired=await(await fetch('/api/auto-buy/worker/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:pairing.code,mode:'mock',protocol:1})})).json();
    window.autoBuyUiHeartbeat=()=>fetch('/api/auto-buy/worker/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+paired.token},body:JSON.stringify({protocol:1,mode:'mock',profiles:{us:{id:'ui-profile',state:'ready',addressLabel:'Home <test>',paymentLabel:'Visa ···· 4242'}}})});
    await window.autoBuyUiHeartbeat();window.autoBuyUiTimer=setInterval(window.autoBuyUiHeartbeat,5000);
    document.getElementById('watchSearch').value='';document.getElementById('watchStatus').value='all';document.getElementById('watchCollection').value='all';app.watchQuickFilter='all';app.pendingWatchCategory='all';
    await refresh();await refreshAutoBuy();
  })()`);
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
    await evaluate("showAutoBuy(window.autoBuyUiSlug)");
    await waitForBrowser("document.getElementById('autoBuyDialog').open",'Purchase dialog did not open for auth-expiry check');
    await evaluate("showAuth(false)");
    assert(await evaluate("!document.getElementById('autoBuyDialog').open && !document.getElementById('autoBuyDialogBody').textContent && !document.getElementById('autoBuyPairing').textContent"),'Owner access expiry left a purchase dialog or pairing code visible');
    await evaluate("enterApp()");
  } finally {
    await evaluate("clearInterval(window.autoBuyUiTimer);document.getElementById('autoBuyDialog').close();api('/api/auto-buy/disconnect',{method:'POST',body:'{}'});applyTheme('dark')");
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
}
