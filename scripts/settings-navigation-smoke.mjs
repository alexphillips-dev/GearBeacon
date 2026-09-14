import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Runs inside browser-smoke's isolated mock installation and authenticated browser.
export async function testSettingsNavigation({ evaluate, waitForBrowser, reloadBrowserPage, assertAccessible, assert, cdp, screenshotRoot }) {
  const sections = {
    general:['application', 'stores'],
    notifications:['alerts', 'channels', 'delivery', 'email'],
    data:['schedule', 'backups'],
    security:['overview', 'password', 'sessions'],
    privacy:['catalog', 'notifications'],
    operations:['overview', 'monitoring', 'delivery', 'backups', 'diagnostics', 'logs'],
  };
  assert(JSON.stringify(await evaluate('SETTINGS_SECTIONS')) === JSON.stringify(sections), 'Settings sections or their ordering changed unexpectedly');
  await evaluate('Promise.all([refreshConfiguration(), refreshNotificationPreferences(), refreshSessions(), refreshOperations()])');
  const connections = await evaluate("({catalog:[...document.querySelectorAll('#outboundList strong')].map(node=>node.textContent),notifications:[...document.querySelectorAll('#outboundNotificationList strong')].map(node=>node.textContent)})");
  assert(connections.catalog.join('|') === 'UniFi Store|GitHub Releases' && connections.notifications.join('|') === 'ntfy|Discord|Generic webhook|Gotify|Email', 'Privacy sections lost or misclassified an outbound connection');

  for (const theme of ['dark', 'light']) {
    await evaluate(`applyTheme('${theme}')`);
    await delay(250);
    for (const width of [1280, 390, 640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height:width === 640 ? 450 : 900, screenWidth:width === 640 ? 1280 : width, screenHeight:900, deviceScaleFactor:width === 640 ? 2 : 1, mobile:false });
      for (const [category, children] of Object.entries(sections)) {
        await evaluate(`document.querySelector('[data-settings-tab="${category}"]').click()`);
        assert(await evaluate(`(() => {const button=document.querySelector('[data-settings-tab="${category}"]');const r=button.getBoundingClientRect();const list=button.parentElement.getBoundingClientRect();return r.left>=list.left && r.right<=list.right;})()`), `Selected ${category} category is clipped in the scrolling tab row`);
        for (const section of children) {
          await evaluate(`document.querySelector('[data-settings-subtab="${category}/${section}"]').click(); window.scrollTo(0,0)`);
          const state = await evaluate(`(() => {
            const parent=document.querySelector('[data-settings-panel="${category}"]');
            const selected=parent.querySelector('[data-settings-subtab][aria-selected="true"]');
            const panel=document.getElementById(selected.getAttribute('aria-controls'));
            return {
              selection:selected.dataset.settingsSubtab, label:panel.getAttribute('aria-labelledby')===selected.id,
              selectedCount:parent.querySelectorAll('[data-settings-subtab][aria-selected="true"]').length,
              tabStops:parent.querySelectorAll('[data-settings-subtab][tabindex="0"]').length,
              visiblePanels:parent.querySelectorAll('[data-settings-section]:not([hidden])').length,
              visible:!parent.hidden && !panel.hidden && panel.getBoundingClientRect().height>0,
              overflow:document.documentElement.scrollWidth>innerWidth+1,
              contained:[...parent.querySelectorAll('[data-settings-subtab]')].every(button=>{const r=button.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.height>=24;}),
              leakedControls:[...parent.querySelectorAll('[data-settings-section][hidden] input,[data-settings-section][hidden] button,[data-settings-section][hidden] select')].some(input=>input.getClientRects().length>0)
            };
          })()`);
          assert(state.selection === `${category}/${section}` && state.label && state.selectedCount === 1 && state.tabStops === 1 && state.visiblePanels === 1 && state.visible && !state.overflow && state.contained && !state.leakedControls, `Settings ${category}/${section} (${theme}, ${width}px) is inaccessible or overflows: ${JSON.stringify(state)}`);
          if (category === 'general' && section === 'stores') {
            const spacing = await evaluate(`(() => {
              const form=document.getElementById('appConfigForm');
              const blocks=[...form.querySelector('fieldset').children].filter(node=>node.tagName!=='LEGEND').map(node=>node.getBoundingClientRect());
              const gaps=blocks.slice(1).map((bounds,index)=>bounds.top-blocks[index].bottom);
              for (const row of form.querySelectorAll('.form-row')) {
                const fields=[...row.children].map(node=>node.getBoundingClientRect());
                if (fields[1].top>fields[0].top+1) gaps.push(fields[1].top-fields[0].bottom);
              }
              return gaps;
            })()`);
            assert(spacing.length>=4 && spacing.every(gap=>gap>=12), `Stores & access labels crowd the preceding controls (${theme}, ${width}px): ${JSON.stringify(spacing)}`);
            if (screenshotRoot && width!==640) {
              await evaluate("document.getElementById('settingsGeneralStoresPanel').scrollIntoView({block:'start'})");
              const capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
              await writeFile(join(screenshotRoot,`settings-stores-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
            }
          }
          if (width !== 640) await assertAccessible(`Settings ${category}/${section} (${theme}, ${width}px)`);
          if (width === 390 && category === 'operations' && section === 'logs') {
            await evaluate("document.getElementById('operationsLogs').focus(); document.getElementById('operationsLogs').scrollTop=0");
            await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
            await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
            await waitForBrowser("document.activeElement.id==='operationsLogs' && document.getElementById('operationsLogs').scrollTop>0", 'Application logs cannot be scrolled from the keyboard');
          }
          if (screenshotRoot && width !== 640 && section === children[0]) {
            const capture = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
            await writeFile(join(screenshotRoot, `settings-${category}-${theme}-${width}.png`), Buffer.from(capture.data, 'base64'));
          }
        }
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate("applyTheme('dark'); activateSettingsTab('notifications'); activateSettingsSection('notifications','alerts',true)");
  for (const [key, selected] of [['ArrowRight','channels'], ['End','email'], ['ArrowLeft','delivery'], ['Home','alerts'], ['ArrowLeft','email'], ['ArrowRight','alerts']]) {
    await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key, code:key });
    await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key, code:key });
    assert(await evaluate(`app.activeSettingsTab==='notifications' && document.activeElement.dataset.settingsSubtab==='notifications/${selected}' && document.activeElement.getAttribute('aria-selected')==='true' && !document.getElementById(document.activeElement.getAttribute('aria-controls')).hidden`), `Section keyboard navigation failed for ${key}`);
  }
  await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
  await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
  assert(await evaluate("document.activeElement.id==='notifyRestock'"), 'Tab did not move from the section tab to its visible controls');

  await evaluate(`(async () => {
    window.settingsDraftNodes={email:document.getElementById('emailSubjectPrefix'),secret:document.querySelector('[data-secret="smtpPassword"]'),preference:document.getElementById('notifyRestock')};
    window.settingsDraftNodes.email.value='Unsaved section draft';
    window.settingsDraftNodes.secret.value='mock-unsaved-channel-password';
    window.settingsDraftNodes.preference.checked=!app.notificationPreferences.restock;
    document.querySelector('[data-settings-subtab="notifications/channels"]').click();
    document.querySelector('[data-settings-tab="general"]').click();
    document.querySelector('[data-settings-subtab="general/stores"]').click();
    document.querySelector('[data-settings-tab="notifications"]').click();
    await refresh({background:true});
  })()`);
  assert(await evaluate(`app.settingsSections.notifications==='channels'
    && window.settingsDraftNodes.email===document.getElementById('emailSubjectPrefix') && window.settingsDraftNodes.email.value==='Unsaved section draft'
    && window.settingsDraftNodes.secret===document.querySelector('[data-secret="smtpPassword"]') && window.settingsDraftNodes.secret.value==='mock-unsaved-channel-password'
    && window.settingsDraftNodes.preference.checked===!app.notificationPreferences.restock
    && !localStorage.getItem('gearbeacon.uiState.v1').includes('Unsaved section draft') && !localStorage.getItem('gearbeacon.uiState.v1').includes('mock-unsaved-channel-password')`), 'Settings switches or background refresh lost a draft, replaced inputs, or stored form entries in navigation preferences');

  // Operations shortcuts must reveal the destination even when a different child was remembered.
  for (const [source, label, target] of [['delivery','Delivery settings','notifications/delivery'], ['backups','Data settings','data/backups'], ['backups','Recovery settings','data/schedule']]) {
    await evaluate(`activateSettingsTab('operations'); activateSettingsSection('operations','${source}')`);
    await evaluate(`[...document.querySelectorAll('[data-settings-section="operations/${source}"] [data-settings-link]')].find(button=>button.textContent==='${label}').click()`);
    assert(await evaluate(`document.activeElement.dataset.settingsSubtab==='${target}' && !document.getElementById(document.activeElement.getAttribute('aria-controls')).hidden && document.activeElement.getClientRects().length>0`), `${label} did not open and focus its actual settings section`);
  }
  assert(await evaluate("document.querySelector('[data-secret=\"smtpPassword\"]').value==='mock-unsaved-channel-password'"), 'An Operations settings shortcut discarded an unsaved channel secret');
  const operationsRecovery = await evaluate(`(async () => {
    const originalApi=api; const snapshot=app.operations;
    try {
      api=async(path,options)=>{if(path==='/api/operations') throw new Error('Mock Operations connection failure');return originalApi(path,options);};
      activateSettingsTab('operations'); activateSettingsSection('operations','delivery'); await refreshOperations();
      const visibleError=document.getElementById('operationsError').getClientRects().length>0 && document.getElementById('operationsError').textContent.includes('Mock Operations connection failure');
      let releaseOlder;
      api=async(path,options)=>path==='/api/operations' ? new Promise(resolve=>{releaseOlder=resolve;}) : originalApi(path,options);
      const olderRefresh=refreshOperations();
      api=async(path,options)=>path==='/api/operations' ? {...snapshot,securityWarnings:[{severity:'warn',code:'smtp-certificates',settingsTab:'notifications',message:'Mock SMTP certificate warning'}]} : originalApi(path,options);
      await refreshOperations();
      releaseOlder({...snapshot,securityWarnings:[{severity:'warn',code:'old-response',settingsTab:'general',message:'Stale warning'}]});
      await olderRefresh;
      const recovered=document.getElementById('operationsError').classList.contains('hidden');
      activateSettingsSection('operations','overview'); document.querySelector('#securityWarnings [data-settings-link]').click();
      const warningTarget=document.activeElement.dataset.settingsSubtab;
      document.getElementById('attentionAction').click();
      return {visibleError,recovered,warningTarget,bannerTarget:document.activeElement.dataset.settingsSubtab};
    } finally { api=originalApi; await refreshOperations(); }
  })()`);
  assert(operationsRecovery.visibleError && operationsRecovery.recovered && operationsRecovery.warningTarget === 'notifications/channels' && operationsRecovery.bannerTarget === 'operations/overview', `Operations errors or shortcuts failed across sections: ${JSON.stringify(operationsRecovery)}`);

  // Selection is saved independently for every parent, and restored before a reload displays it.
  for (const [category, children] of Object.entries(sections)) {
    await evaluate(`activateSettingsTab('${category}'); activateSettingsSection('${category}','${children.at(-1)}')`);
  }
  await reloadBrowserPage();
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.config && app.operations", 'Settings did not reload');
  for (const [category, children] of Object.entries(sections)) {
    await evaluate(`document.querySelector('[data-settings-tab="${category}"]').click()`);
    assert(await evaluate(`document.querySelector('[data-settings-panel="${category}"] [data-settings-subtab][aria-selected="true"]').dataset.settingsSubtab==='${category}/${children.at(-1)}' && document.querySelector('[data-settings-panel="${category}"] [data-settings-section]:not([hidden])').dataset.settingsSection==='${category}/${children.at(-1)}'`), `${category} did not restore its own last section`);
  }
  assert(await evaluate("document.querySelector('[data-secret=\"smtpPassword\"]').value==='' && document.getElementById('emailSubjectPrefix').value!=='Unsaved section draft'"), 'Unsaved inputs unexpectedly survived a reload');
  await evaluate("history.replaceState(null,'',location.pathname+'#operations')");
  await reloadBrowserPage();
  await waitForBrowser("app.activeTab==='settings' && app.activeSettingsTab==='operations' && !document.getElementById('settingsOperationsOverviewPanel').hidden", 'Legacy Operations hash did not reveal Overview');

  await evaluate(`(() => {
    const state=JSON.parse(localStorage.getItem('gearbeacon.uiState.v1'));
    state.settingsSections.notifications='removed-section'; state.settingsSections.security={unknown:true};
    localStorage.setItem('gearbeacon.uiState.v1',JSON.stringify(state));
    localStorage.setItem('gearbeacon.settingsTab','notifications');
  })()`);
  await reloadBrowserPage();
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.config && app.activeSettingsTab==='notifications'", 'Settings did not recover from obsolete section preferences');
  assert(await evaluate("app.settingsSections.notifications==='alerts' && app.settingsSections.security==='overview' && !document.getElementById('settingsNotificationsAlertsPanel').hidden"), 'Invalid saved section values did not fall back to a visible first section');
  await evaluate(`(() => {
    const state=JSON.parse(localStorage.getItem('gearbeacon.uiState.v1')); state.activeTab='operations'; delete state.settingsSections;
    localStorage.setItem('gearbeacon.uiState.v1',JSON.stringify(state)); history.replaceState(null,'',location.pathname);
  })()`);
  await reloadBrowserPage();
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.activeTab==='settings' && app.activeSettingsTab==='operations' && !document.getElementById('settingsOperationsOverviewPanel').hidden", 'Legacy saved Operations navigation stopped working');
  await evaluate("activateSettingsTab('security'); activateSettingsSection('security','sessions')");
}
