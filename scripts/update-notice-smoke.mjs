import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function testUpdateNotice({evaluate,waitForBrowser,assertAccessible,assert,cdp,screenshotRoot}) {
  await evaluate(`(() => {
    window.noticeOriginalApi=api;
    window.noticeFixture={currentVersion:'1.2.0',latestVersion:'1.3.0',channel:'main',verified:true,updateAvailable:false,releaseNotesUrl:'https://github.com/alexphillips-dev/GearBeacon/releases/tag/v1.3.0',releaseNotes:'Example update <notes>',compatibilityWarnings:[]};
    api=async(path,options)=>{
      if(path.split('?')[0]==='/api/update/check') return structuredClone(window.noticeFixture);
      const result=await window.noticeOriginalApi(path,options);
      return path.split('?')[0]==='/api/status' ? {...result,update:structuredClone(window.noticeFixture)} : result;
    };
    activateTab('activity'); resetActivityFilters();
  })()`);
  try {
    await waitForBrowser("!app.activityController && document.querySelectorAll('#activityList .event').length>=5",'Activity did not load for update-notice anchoring');
    await evaluate('refresh()');
    assert(await evaluate("document.getElementById('appUpdateNotice').classList.contains('hidden')"),'A current build showed an update notice');
    await evaluate("window.noticeReadRow=document.querySelectorAll('#activityList .event')[4]; window.noticeReadRow.scrollIntoView({block:'start'}); window.scrollBy(0,-60); window.noticeReadRow.focus({preventScroll:true}); window.noticeReadTop=window.noticeReadRow.getBoundingClientRect().top; window.noticeFixture.updateAvailable=true; refresh()");
    await waitForBrowser("!document.getElementById('appUpdateNotice').classList.contains('hidden')",'Status refresh did not reveal the update button');
    assert(await evaluate("window.noticeReadRow.isConnected && document.activeElement===window.noticeReadRow && Math.abs(window.noticeReadRow.getBoundingClientRect().top-window.noticeReadTop)<2"),'The new update notice moved the Activity reading position or lost focus');
    assert(await evaluate("document.getElementById('appUpdateNotice').children.length===1 && document.getElementById('appUpdateButton').textContent==='update available · v1.3.0'"),'Update notice contains extra controls or unexpected text');
    for(const channel of ['main','dev']) {
      await evaluate(`window.noticeFixture.channel='${channel}'; window.noticeFixture.latestVersion='${channel==='dev'?'1.3.0-dev.2':'1.3.0'}'; refresh()`);
      await waitForBrowser(`document.getElementById('appUpdateButton').textContent==='update available · v${channel==='dev'?'1.3.0-dev.2':'1.3.0'}'`,'Notice did not refresh its version');
      for(const tab of ['watchlist','browse','activity','settings']) {
        await evaluate(`activateTab('${tab}')`);
        assert(await evaluate("document.getElementById('appUpdateButton').getClientRects().length>0"),`Update button is missing from ${tab}`);
      }
    }
    await evaluate("window.noticeFixture.latestVersion='1.3.0-rc.1+build.2'; refresh()");
    assert(await evaluate("!document.getElementById('appUpdateNotice').classList.contains('hidden') && document.getElementById('appUpdateButton').textContent==='update available · v1.3.0-rc.1+build.2'"),'A version with build metadata hid the update button');
    for(const theme of ['dark','light']) {
      await evaluate(`applyTheme('${theme}')`);await delay(250);
      for(const width of [1280,390,640]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===640?450:900,screenWidth:width===640?1280:width,screenHeight:900,deviceScaleFactor:width===640?2:1,mobile:false});
        await evaluate('window.scrollTo(0,0)');
        const bounds=await evaluate("(() => {const button=document.getElementById('appUpdateButton'),r=button.getBoundingClientRect();return {x:r.left+8,y:r.top+8,fits:r.left>=0&&r.right<=innerWidth&&r.height>=32&&! (document.documentElement.scrollWidth>innerWidth+1)};})()");
        assert(bounds.fits,`Update button overflowed at ${width}px`);
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x,y:bounds.y});await delay(200);
        await assertAccessible(`Update notice ${theme} ${width}px`);
        if(screenshotRoot && width!==640) {
          const capture=await cdp.send('Page.captureScreenshot',{format:'png'});
          await writeFile(join(screenshotRoot,`update-notice-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
        }
      }
    }
    await evaluate("window.noticeClicked=null; document.getElementById('appUpdateButton').addEventListener('click',event=>{window.noticeClicked={href:event.currentTarget.href,target:event.currentTarget.target,rel:event.currentTarget.rel,prevented:event.defaultPrevented};event.preventDefault();},{once:true}); document.getElementById('appUpdateButton').focus()");
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    const click=await evaluate('window.noticeClicked');
    assert(click?.href.endsWith('/releases/tag/v1.3.0') && click.target==='_blank' && click.rel.includes('noopener') && !click.prevented,'Keyboard activation did not follow the release-notes link safely');
    await evaluate('window.noticeFixture.stale=true; refresh()');
    assert(await evaluate("!document.getElementById('appUpdateNotice').classList.contains('hidden')"),'A failed check erased a confirmed update');
    await evaluate("window.noticeFixture.releaseNotesUrl='javascript:alert(1)'; refresh()");
    await waitForBrowser("document.getElementById('appUpdateButton').getAttribute('href')==='#settings'",'Unsafe or unavailable notes did not use the local fallback');
    await evaluate("document.getElementById('appUpdateButton').click()");
    assert(await evaluate("app.activeTab==='settings' && app.activeSettingsTab==='general' && !document.getElementById('settingsGeneralApplicationPanel').hidden && document.getElementById('updateResult').textContent.includes('Example update <notes>') && !document.querySelector('#updateResult notes')"),'Missing notes did not open safe update details');
    await evaluate("window.noticeFixture={...window.noticeFixture,verified:false,updateAvailable:false,warning:'Mock update source unavailable'}; checkUpdates()");
    await waitForBrowser("!document.getElementById('updateBtn').disabled && document.getElementById('appUpdateNotice').classList.contains('hidden')",'Unknown update status showed a notice');
    assert(await evaluate("document.getElementById('updateResult').textContent.includes('Update status unavailable') && !document.getElementById('updateResult').textContent.includes('up to date')"),'Failed check incorrectly claimed the app was current');
  } finally {
    await evaluate("api=window.noticeOriginalApi; applyTheme('dark'); refresh()");
    await cdp.send('Emulation.clearDeviceMetricsOverride');await delay(250);
  }
}
