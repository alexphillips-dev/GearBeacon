import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-browser-smoke-'));
const chromeProfile = await mkdtemp(join(tmpdir(), 'gearbeacon-chrome-'));
const port = 9200 + (process.pid % 500);
const baseUrl = `http://127.0.0.1:${port}`;
const setupToken = 'v19-browser-setup-token';
const serverOutput = [];
let server = null;
let chrome = null;
let cdp = null;

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' ? join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.platform === 'win32' ? join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean).map((candidate) => resolve(candidate));
  return candidates.find(existsSync) || null;
}

async function waitFor(predicate, message, attempts = 200, waitMs = 100) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await delay(waitMs);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function startServer() {
  server = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOCK_MODE: '1',
      PORT: String(port),
      POLL_SECONDS: '60',
      REGIONS: 'us',
      GEARBEACON_DATA_DIR: testRoot,
      GEARBEACON_SKIP_LEGACY_IMPORT: '1',
      GEARBEACON_GITHUB_RELEASE_API: '',
      GEARBEACON_BACKUP_INTERVAL_HOURS: '0',
      GEARBEACON_ACCESS_MODE: 'private',
      GEARBEACON_BIND_HOST: '127.0.0.1',
      GEARBEACON_SETUP_TOKEN: setupToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => serverOutput.push(String(data)));
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once:true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools connection failed.')), { once:true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = nextId++;
    pending.set(id, { resolve:resolveSend, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser evaluation failed.');
  return response.result?.value;
}

async function waitForBrowser(expression, message, attempts = 200) {
  await waitFor(async () => Boolean(await evaluate(`Boolean(${expression})`)), message, attempts, 100);
}

async function assertAccessible(label) {
  if (!await evaluate("Boolean(globalThis.axe?.run)")) {
    const injected = await cdp.send('Runtime.evaluate', { expression:axeSource });
    if (injected.exceptionDetails) throw new Error(`Could not load axe-core for ${label}.`);
  }
  const violations = await evaluate(`axe.run(document, {
    runOnly:{ type:'tag', values:['wcag2a','wcag2aa','wcag21aa','wcag22aa'] },
    resultTypes:['violations']
  }).then(({ violations }) => violations.map((violation) => ({
    id:violation.id, impact:violation.impact, help:violation.help,
    targets:violation.nodes.slice(0,5).map((node) => node.target.join(' '))
  })))`);
  assert(violations.length === 0, `${label} has accessibility violations: ${JSON.stringify(violations)}`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

try {
  const executable = chromeExecutable();
  if (!executable) throw new Error('Chrome or Chromium was not found. Set CHROME_PATH to run the browser smoke test.');
  startServer();
  await waitFor(async () => {
    try { return (await fetch(`${baseUrl}/healthz`)).ok; } catch { return false; }
  }, 'GearBeacon did not become ready');

  chrome = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
    '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${chromeProfile}`, baseUrl,
  ], { stdio:['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const activePortFile = join(chromeProfile, 'DevToolsActivePort');
  let debugPort = null;
  await waitFor(async () => {
    if (!existsSync(activePortFile)) return false;
    try {
      const candidate = Number((await readFile(activePortFile, 'utf8')).split(/\r?\n/)[0]);
      if (!Number.isFinite(candidate) || candidate <= 0) return false;
      debugPort = candidate;
      return true;
    } catch { return false; }
  }, 'Chrome did not expose a readable DevTools port');
  let pageTarget = null;
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    pageTarget = targets.find((target) => target.type === 'page' && target.url.startsWith(baseUrl));
    return Boolean(pageTarget?.webSocketDebuggerUrl);
  }, 'GearBeacon browser page was not available');
  cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')", 'Owner setup screen did not appear');
  await assertAccessible('Owner setup screen');
  await evaluate(`(() => {
    document.getElementById('setupToken').value = 'v19-browser-setup-token';
    document.getElementById('authPassword').value = 'V1.10 browser owner password';
    document.getElementById('authPasswordConfirm').value = 'V1.10 browser owner password';
    document.getElementById('authForm').requestSubmit();
  })()`);
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.products.length >= 5", 'Authenticated dashboard did not load');
  await waitForBrowser("!document.getElementById('setupWizard').classList.contains('hidden') && app.wizardStep === 2", 'Guided setup did not start');
  await assertAccessible('Guided setup wizard');
  assert(await evaluate("document.getElementById('appShell').inert && Boolean(document.activeElement.closest('#setupWizard'))"), 'Guided setup did not isolate background content and move focus into the dialog.');
  for (const step of [3, 4, 5]) {
    await evaluate("document.getElementById('wizardNext').click()");
    await waitForBrowser(`app.wizardStep === ${step}`, `Guided setup did not advance to step ${step}`);
  }
  await evaluate("document.getElementById('wizardNext').click()");
  await waitForBrowser("document.getElementById('setupWizard').classList.contains('hidden') && app.auth.onboardingComplete", 'Guided setup did not complete');
  await assertAccessible('Watchlist dashboard');

  await evaluate("document.getElementById('tabWatchlist').focus(); document.getElementById('tabWatchlist').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  assert(await evaluate("document.activeElement === document.getElementById('tabBrowse') && document.getElementById('browse').classList.contains('active') && document.getElementById('watchlist').hidden"), 'Main tabs do not support roving keyboard focus and panel state.');
  await evaluate("activateTab('watchlist')");

  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  const reducedMotion = await evaluate("(() => { const item=document.createElement('div'); item.className='skeleton'; document.body.append(item); const animation=getComputedStyle(item,'::after').animationName; item.remove(); return animation; })()");
  assert(reducedMotion === 'none', `Reduced-motion preference did not disable loading animation: ${reducedMotion}`);
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640, height:450, screenWidth:1280, screenHeight:900, deviceScaleFactor:2, mobile:false });
  const zoomReflow = await evaluate("({ viewport:window.innerWidth, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, scrollWidth:document.documentElement.scrollWidth })");
  assert(zoomReflow.viewport === 640 && zoomReflow.overflow, `Dashboard does not reflow at a 200% equivalent viewport: ${JSON.stringify(zoomReflow)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const watchImportPlacement = await evaluate("(() => { const heading=document.querySelector('#watchlist .section-heading').getBoundingClientRect(); const button=document.getElementById('openWatchImport').getBoundingClientRect(); return { headingRight:heading.right, buttonRight:button.right, buttonLeft:button.left, headingMid:heading.left + heading.width / 2, visible:button.width > 0 && button.height > 0 }; })()");
  assert(watchImportPlacement.visible && Math.abs(watchImportPlacement.headingRight - watchImportPlacement.buttonRight) <= 3 && watchImportPlacement.buttonLeft > watchImportPlacement.headingMid, `Watchlist import action is not positioned at the top right: ${JSON.stringify(watchImportPlacement)}`);

  const navigationTheme = await evaluate("document.documentElement.dataset.theme");
  const documentNode = await cdp.send('DOM.getDocument');
  const browseTabNode = await cdp.send('DOM.querySelector', { nodeId:documentNode.root.nodeId, selector:'[data-tab="browse"]' });
  for (const theme of ['dark', 'light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`);
    await cdp.send('CSS.forcePseudoState', { nodeId:browseTabNode.nodeId, forcedPseudoClasses:['hover'] });
    const navigationHover = await evaluate("(() => { const tab=document.querySelector('[data-tab=\"browse\"]'); const tabs=document.querySelector('.tabs'); return { transform:getComputedStyle(tab).transform, tabTop:tab.getBoundingClientRect().top, containerTop:tabs.getBoundingClientRect().top }; })()");
    assert(navigationHover.transform === 'none' && navigationHover.tabTop >= navigationHover.containerTop, `Top navigation clipped on hover in ${theme} mode: ${JSON.stringify(navigationHover)}`);
  }
  await cdp.send('CSS.forcePseudoState', { nodeId:browseTabNode.nodeId, forcedPseudoClasses:[] });
  await evaluate(`applyTheme(${JSON.stringify(navigationTheme)})`);

  await evaluate("document.querySelector('[data-tab=\"browse\"]').click()");
  await waitForBrowser("document.getElementById('browse').classList.contains('active') && document.querySelectorAll('#browseGrid .store-card:not(.skeleton-card)').length >= 5", 'Browse catalog did not render');
  await assertAccessible('Browse catalog');
  const browseAvailabilityLabel = await evaluate("(() => { const label=document.querySelector('#browseGrid .stock-label'); const style=getComputedStyle(label); return { text:label.textContent, fontSize:style.fontSize, fontWeight:Number(style.fontWeight), nowrap:style.whiteSpace }; })()");
  assert(browseAvailabilityLabel.fontSize === '13px' && browseAvailabilityLabel.fontWeight >= 600 && browseAvailabilityLabel.nowrap === 'nowrap', `Browse availability labels are not large and readable: ${JSON.stringify(browseAvailabilityLabel)}`);
  const soldOutBadge = await evaluate("(() => { const label=document.querySelector('#browseGrid .stock-label.sold-out'); const style=getComputedStyle(label); return { text:label?.textContent, borderStyle:style.borderStyle, borderWidth:style.borderWidth, borderRadius:style.borderRadius, paddingLeft:style.paddingLeft }; })()");
  assert(soldOutBadge.text === 'Sold out' && soldOutBadge.borderStyle === 'solid' && soldOutBadge.borderWidth === '1px' && soldOutBadge.borderRadius === '5px' && soldOutBadge.paddingLeft === '7px', `Browse sold-out badge is not outlined correctly: ${JSON.stringify(soldOutBadge)}`);
  await waitForBrowser("document.querySelectorAll('#browseGrid .image-loaded img[data-product-image]').length > 0", 'No product image loaded in the real browser', 250);
  const retryImageUrl = await evaluate("(() => { const image=document.querySelector('#browseGrid .image-loaded img[data-product-image]'); const url=image.dataset.productImage; image.dispatchEvent(new Event('error')); return url; })()");
  await waitForBrowser("document.querySelector('#browseGrid [data-image-retry]')", 'Failed image did not expose a retry action');
  await evaluate("document.querySelector('#browseGrid [data-image-retry]').click()");
  await waitForBrowser(`document.querySelector('#browseGrid .image-loaded img[data-product-image=${JSON.stringify(retryImageUrl)}]')`, 'Product image retry did not reload the image', 250);

  const initialTheme = await evaluate("document.documentElement.dataset.theme");
  await evaluate("document.getElementById('themeBtn').click()");
  assert(await evaluate("document.documentElement.dataset.theme") !== initialTheme, 'Theme switching failed.');

  await evaluate(`(() => { const input=document.getElementById('search'); input.value='U7 Pro XGS'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitForBrowser("document.querySelectorAll('#browseGrid .store-card').length === 1", 'Debounced Browse search failed');
  assert(await evaluate("!document.getElementById('resetBrowseFilters').classList.contains('hidden')"), 'Browse reset action did not appear for an active search.');
  await evaluate("document.getElementById('search').focus(); openProductDialog('u7-pro-xgs')");
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.querySelector('#productDialogBody .product-watch-prompt [data-watch]')", 'Unwatched product details did not render');
  await assertAccessible('Product details dialog');
  const dialogTrap = await evaluate(`(() => {
    const dialog=document.getElementById('productDialog');
    const focusable=[...dialog.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not(:disabled):not([tabindex="-1"]),select:not(:disabled):not([tabindex="-1"]),textarea:not(:disabled):not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])')].filter((item) => item.offsetParent !== null);
    focusable.at(-1).focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    return { first:focusable[0].id, active:document.activeElement.id };
  })()`);
  assert(dialogTrap.first === 'closeProductDialog' && dialogTrap.active === 'closeProductDialog', `Product dialog focus is not trapped: ${JSON.stringify(dialogTrap)}`);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await waitForBrowser("document.getElementById('productDialog').classList.contains('hidden')", 'Escape did not close product details');
  assert(await evaluate("document.activeElement === document.getElementById('search')"), 'Product details did not restore focus after Escape.');
  await evaluate("openProductDialog('u7-pro-xgs')");
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden')", 'Product details did not reopen after the Escape test');
  const productPromptActions = await evaluate(`(() => {
    const watchButton=document.querySelector('#productDialogBody .product-watch-prompt [data-watch]');
    const storeButton=document.querySelector('#productDialogBody .product-link-actions a.button-link');
    return { watchHeight:watchButton?.getBoundingClientRect().height, storeHeight:storeButton?.getBoundingClientRect().height, watchFont:getComputedStyle(watchButton).fontSize, storeFont:getComputedStyle(storeButton).fontSize };
  })()`);
  assert(Math.abs(productPromptActions.watchHeight - productPromptActions.storeHeight) <= 1 && productPromptActions.watchFont === productPromptActions.storeFont, `Product watch action does not match the compact store action: ${JSON.stringify(productPromptActions)}`);
  await evaluate("document.getElementById('closeProductDialog').click()");
  await evaluate("document.querySelector('#browseGrid [data-watch=\"u7-pro-xgs\"]').click()");
  await waitForBrowser("app.products.find((product) => product.slug === 'u7-pro-xgs')?.watched === true", 'Browser watch action failed');
  await evaluate(`(() => { const input=document.getElementById('search'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitForBrowser("document.querySelectorAll('#browseGrid .store-card').length >= 5", 'Browse search did not clear');
  await evaluate("document.querySelector('[data-category=\"WiFi\"]').click()");
  await waitForBrowser("app.browseCategory === 'WiFi' && app.products.filter((product) => product.category === 'WiFi').length === document.querySelectorAll('#browseGrid .store-card').length", 'Browse category filtering failed');
  await evaluate(`(() => { const input=document.getElementById('search'); input.value='no-such-product'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitForBrowser("!document.getElementById('browseEmpty').classList.contains('hidden') && !document.getElementById('resetBrowseEmpty').classList.contains('hidden')", 'Filtered Browse empty state did not offer a reset action');
  await evaluate("document.getElementById('resetBrowseEmpty').click()");
  await waitForBrowser("app.browseCategory === 'All' && document.getElementById('search').value === '' && document.querySelectorAll('#browseGrid .store-card').length >= 5", 'Browse reset action did not restore the catalog');
  await evaluate("document.querySelector('[data-category=\"All\"]').click(); app.browseVisibleCount=2; renderProducts(true)");
  await waitForBrowser("!document.getElementById('browseLoadMore').classList.contains('hidden') && document.querySelectorAll('#browseGrid .store-card').length === 2", 'Incremental catalog loading did not activate');
  await evaluate("document.getElementById('browseLoadMore').click()");
  await waitForBrowser("document.querySelectorAll('#browseGrid .store-card').length > 2", 'Load-more control did not expand the catalog');

  await evaluate("openProductDialog('u7-pro-xgs')");
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.getElementById('productRuleForm')", 'Product details or rule editor did not open');
  const copiedProductDetails = await evaluate(`(async () => {
    window.__gearbeaconCopies=[];
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async (value) => window.__gearbeaconCopies.push(value) } });
    const buttons=[...document.querySelectorAll('#productDialogBody [data-copy-text]')];
    buttons[0].click(); await new Promise((resolve) => setTimeout(resolve, 20));
    buttons[1].click(); await new Promise((resolve) => setTimeout(resolve, 20));
    return { copies:window.__gearbeaconCopies, toast:document.getElementById('toast').textContent, success:document.getElementById('toast').classList.contains('success') };
  })()`);
  assert(copiedProductDetails.copies[0] === 'u7-pro-xgs' && /^https:\/\/store\.ui\.com\//.test(copiedProductDetails.copies[1]) && copiedProductDetails.success && /Store link copied/.test(copiedProductDetails.toast), `Product copy actions failed: ${JSON.stringify(copiedProductDetails)}`);
  const dialogHoverPoints = await evaluate("(() => { const panel=document.querySelector('.product-dialog-panel').getBoundingClientRect(); return { panelX:window.innerWidth-20, backdropX:Math.max(4,Math.floor(panel.left/2)), y:Math.min(window.innerHeight-20,220) }; })()");
  for (const theme of ['dark', 'light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`);
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:dialogHoverPoints.panelX, y:dialogHoverPoints.y });
    const normalBackdrop = await evaluate("getComputedStyle(document.getElementById('productDialogBackdrop')).backgroundColor");
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:dialogHoverPoints.backdropX, y:dialogHoverPoints.y });
    const hoveredBackdrop = await evaluate("getComputedStyle(document.getElementById('productDialogBackdrop')).backgroundColor");
    assert(await evaluate("document.getElementById('productDialogBackdrop').matches(':hover')"), `Pointer did not reach the product dialog backdrop in ${theme} mode.`);
    assert(hoveredBackdrop === normalBackdrop && hoveredBackdrop === 'rgba(0, 0, 0, 0.58)', `Product dialog backdrop changed on hover in ${theme} mode: ${normalBackdrop} -> ${hoveredBackdrop}`);
  }
  await evaluate(`(() => { const form=document.getElementById('productRuleForm'); form.elements.targetPrice.value='250'; form.elements.immediateRestock.checked=true; form.requestSubmit(); })()`);
  await waitForBrowser("app.products.find((product) => product.slug === 'u7-pro-xgs')?.watchRule?.targetPrice === 250", 'Product-specific alert rule did not save');
  await evaluate("document.getElementById('closeProductDialog').click(); toggleWatch('uvc-ai-turret')");
  await waitForBrowser("app.products.find((product) => product.slug === 'uvc-ai-turret')?.watched === true", 'Second product watch action failed');

  await evaluate("document.querySelector('[data-tab=\"watchlist\"]').click()");
  await waitForBrowser("document.querySelectorAll('#watchGrid .watch-card').length === 2", 'Watchlist did not render watched products');
  await evaluate(`(() => { const input=document.getElementById('watchSearch'); input.value='no watched product'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitForBrowser("!document.getElementById('watchEmpty').classList.contains('hidden') && !document.getElementById('resetWatchEmpty').classList.contains('hidden')", 'Filtered Watchlist empty state did not offer a reset action');
  await evaluate("document.getElementById('resetWatchEmpty').click()");
  await waitForBrowser("document.getElementById('watchSearch').value === '' && document.querySelectorAll('#watchGrid .watch-card').length === 2", 'Watchlist reset action did not restore watched products');
  await evaluate(`document.querySelectorAll('#watchGrid [data-watch-select]').forEach((input) => { input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); })`);
  await waitForBrowser("!document.getElementById('bulkActions').classList.contains('hidden') && app.selectedWatch.size === 2", 'Bulk watchlist selection failed');
  await evaluate("document.getElementById('bulkPause').click()");
  await waitForBrowser("app.products.filter((product) => product.watched).every((product) => product.watchRule?.pausedUntil)", 'Bulk pause failed');
  await evaluate(`document.querySelectorAll('#watchGrid [data-watch-select]').forEach((input) => { input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); })`);
  await evaluate("document.getElementById('bulkResume').click()");
  await waitForBrowser("app.products.filter((product) => product.watched).every((product) => !product.watchRule?.pausedUntil)", 'Bulk resume failed');

  await evaluate(`(() => {
    document.getElementById('openWatchImport').click();
    const input=document.getElementById('watchImportInput');
    input.value=${JSON.stringify('https://store.ui.com/us/en/category/all-cloud-gateways/products/udm-se\nu7-pro-xgs\nhttps://store.ui.com/us/en/category/all-cloud-gateways/products/udm-se\nhttps://store.ui.com/ca/en/category/network-storage/products/unas-pro\nretired-product')};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('previewWatchImport').click();
  })()`);
  await waitForBrowser("app.watchImportPreview?.summary?.addable === 1 && document.querySelectorAll('#watchImportResults .watch-import-result').length === 5", 'Watchlist import review did not render');
  const watchImportReview = await evaluate("({ ready:app.watchImportPreview.summary.addable, already:app.watchImportPreview.summary.alreadyWatched, duplicates:app.watchImportPreview.summary.duplicates, mismatch:app.watchImportPreview.summary.regionMismatch, unrecognized:app.watchImportPreview.summary.unrecognized, selected:document.querySelectorAll('#watchImportResults [data-import-slug]:checked').length, button:document.getElementById('confirmWatchImport').textContent, region:document.getElementById('watchImportRegion').textContent })");
  assert(watchImportReview.ready === 1 && watchImportReview.already === 1 && watchImportReview.duplicates === 1 && watchImportReview.mismatch === 1 && watchImportReview.unrecognized === 1 && watchImportReview.selected === 1 && watchImportReview.button === 'Add 1 product' && /United States Store/.test(watchImportReview.region), `Watchlist import classifications are incomplete: ${JSON.stringify(watchImportReview)}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const responsiveImport = await evaluate("(() => { const panel=document.querySelector('.watch-import-panel').getBoundingClientRect(); return { width:panel.width, height:panel.height, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, summaryColumns:getComputedStyle(document.getElementById('watchImportSummary')).gridTemplateColumns.split(' ').length }; })()");
  assert(responsiveImport?.width === 390 && responsiveImport.height === 844 && responsiveImport.overflow && responsiveImport.summaryColumns === 2, `Watchlist importer is not responsive at 390px: ${JSON.stringify(responsiveImport)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate("document.getElementById('confirmWatchImport').click()");
  await waitForBrowser("document.getElementById('watchImportDialog').classList.contains('hidden') && app.products.find((product) => product.slug === 'udm-se')?.watched === true && document.getElementById('watchCount').textContent === '3'", 'Confirmed watchlist import did not add the matched product');
  assert(await evaluate("app.products.find((product) => product.slug === 'u7-pro-xgs')?.watchRule?.targetPrice === 250"), 'Watchlist import changed an existing product alert rule');
  await evaluate("toggleWatch('udm-se')");
  await waitForBrowser("app.products.find((product) => product.slug === 'udm-se')?.watched === false && document.getElementById('watchCount').textContent === '2'", 'Browser watchlist import cleanup failed');

  await evaluate(`(async () => {
    await api('/api/mock/toggle/u7-pro-xgs', { method:'POST' });
    await api('/api/check', { method:'POST' });
    await refresh();
    document.querySelector('[data-tab="activity"]').click();
  })()`);
  await waitForBrowser("document.getElementById('activity').classList.contains('active') && document.querySelector('#activityList .event')", 'Stock activity did not render');
  await assertAccessible('Stock activity');
  const activityRow = await evaluate(`(() => {
    const row = document.querySelector('#activityList .event');
    const meta = row.querySelector('.event-meta');
    return {
      height:row.getBoundingClientRect().height,
      meta:meta.textContent,
      metaTitle:meta.title,
      metaWhiteSpace:getComputedStyle(meta).whiteSpace,
      alert:row.querySelector('.event-alert-label').textContent,
      alertTitle:row.querySelector('.event-alert').title,
      timeTitle:row.querySelector('time').title,
      aria:row.getAttribute('aria-label'),
    };
  })()`);
  assert(activityRow?.height === 64, `Desktop activity row height changed: ${JSON.stringify(activityRow)}`);
  assert(activityRow.meta.includes('Sold out → In stock') && activityRow.meta.includes('$299.00') && activityRow.meta.includes('Back after') && activityRow.metaWhiteSpace === 'nowrap', `Compact activity transition details are incomplete: ${JSON.stringify(activityRow)}`);
  assert(activityRow.alert === 'No channel' && /no server notification channel was configured/i.test(activityRow.alertTitle), `Activity server-alert outcome is incomplete: ${JSON.stringify(activityRow)}`);
  assert(/U7 Pro XGS activity details/i.test(activityRow.aria) && activityRow.timeTitle && !/^\d{4}-\d{2}-\d{2}T/.test(activityRow.timeTitle), `Activity accessibility or exact-time details are incomplete: ${JSON.stringify(activityRow)}`);
  await evaluate(`(() => {
    document.getElementById('activitySearch').value='U7 Pro';
    document.getElementById('activityType').value='restock';
    document.getElementById('activityDelivery').value='not-sent';
    document.getElementById('activityFilters').requestSubmit();
  })()`);
  await waitForBrowser("app.activity.loaded && app.activity.count === 1 && document.querySelectorAll('#activityList .event').length === 1 && document.getElementById('activityResultCount').textContent === '1 matching event'", 'Searchable activity filters did not return the expected event');
  await evaluate("document.querySelector('#activityList .event time').click()");
  await waitForBrowser("!document.getElementById('activityDialog').classList.contains('hidden') && document.getElementById('activityDialogTitle').textContent === 'U7 Pro XGS' && document.getElementById('activityDialogBody').textContent.includes('1 of 1')", 'Whole-row activity navigation did not open confirmation evidence');
  await assertAccessible('Activity evidence dialog');
  const activityEvidence = await evaluate(`(() => {
    const productButton=document.querySelector('#activityDialogBody [data-activity-product="u7-pro-xgs"]');
    const storeButton=document.querySelector('#activityDialogBody .activity-detail-actions a.button-link');
    return { text:document.getElementById('activityDialogBody').textContent, productButton:Boolean(productButton), productButtonHeight:productButton?.getBoundingClientRect().height, storeButtonHeight:storeButton?.getBoundingClientRect().height };
  })()`);
  assert(/Monitor evidence/.test(activityEvidence.text) && /Server notification/.test(activityEvidence.text) && /No channel/.test(activityEvidence.text) && activityEvidence.productButton, `Activity evidence drawer is incomplete: ${JSON.stringify(activityEvidence)}`);
  assert(Math.abs(activityEvidence.productButtonHeight - activityEvidence.storeButtonHeight) <= 1, `Activity detail actions do not share compact sizing: ${JSON.stringify(activityEvidence)}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const responsiveEvidence = await evaluate("(() => { const panel=document.querySelector('#activityDialog .product-dialog-panel').getBoundingClientRect(); return { width:panel.width, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, columns:getComputedStyle(document.querySelector('.activity-evidence')).gridTemplateColumns.split(' ').length }; })()");
  assert(responsiveEvidence?.width === 390 && responsiveEvidence.overflow && responsiveEvidence.columns === 1, `Activity evidence drawer is not responsive at 390px: ${JSON.stringify(responsiveEvidence)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate("document.querySelector('#activityDialogBody [data-activity-product]').click()");
  await waitForBrowser("document.getElementById('activityDialog').classList.contains('hidden') && !document.getElementById('productDialog').classList.contains('hidden') && document.getElementById('productDialogTitle').textContent === 'U7 Pro XGS'", 'Activity evidence did not open the associated product details');
  await evaluate("document.getElementById('closeProductDialog').click()");
  await evaluate("document.getElementById('clearActivityFilters').click()");
  await waitForBrowser("app.activity.loaded && document.getElementById('activitySearch').value === '' && document.getElementById('activityType').value === 'all'", 'Activity filters did not clear');
  await evaluate(`(() => { document.getElementById('activitySearch').value='no such activity'; document.getElementById('activityFilters').requestSubmit(); })()`);
  await waitForBrowser("app.activity.loaded && app.activity.count === 0 && !document.getElementById('activityEmpty').classList.contains('hidden') && !document.getElementById('resetActivityEmpty').classList.contains('hidden')", 'Filtered Activity empty state did not offer a reset action');
  await evaluate("document.getElementById('resetActivityEmpty').click()");
  await waitForBrowser("app.activity.loaded && app.activity.count > 0 && document.getElementById('activitySearch').value === ''", 'Activity reset action did not restore retained events');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const compactActivity = await evaluate("(() => { const row=document.querySelector('#activityList .event'); return { height:row.getBoundingClientRect().height, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, alertLabel:getComputedStyle(row.querySelector('.event-alert-label')).display, timeColumn:row.querySelector('time').getBoundingClientRect().top - row.getBoundingClientRect().top, filterColumns:getComputedStyle(document.getElementById('activityFilters')).gridTemplateColumns.split(' ').length }; })()");
  assert(compactActivity?.height === 64 && compactActivity.overflow && compactActivity.alertLabel === 'none' && compactActivity.timeColumn < 32 && compactActivity.filterColumns === 1, `Mobile activity feed or filters did not remain compact: ${JSON.stringify(compactActivity)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabNotifications').click()");
  await waitForBrowser("!document.getElementById('settingsPanelNotifications').hidden && document.getElementById('settingsPanelData').hidden", 'Notification settings tab failed');
  await assertAccessible('Notification settings');
  assert(await evaluate("Boolean(document.getElementById('notifyAllActivity')) && !document.getElementById('notifyAllActivity').checked"), 'All-activity notification setting is missing or not safely disabled by default');
  await evaluate("document.getElementById('notifyAllActivity').click(); document.getElementById('saveNotificationPrefs').click()");
  await waitForBrowser("app.notificationPreferences?.allActivity === true && document.getElementById('notifyAllActivity').checked", 'All-activity notification setting did not save');
  await waitForBrowser("document.getElementById('emailPreviewProduct').options.length >= 5", 'Email preview products did not load');
  await evaluate(`(() => {
    document.getElementById('emailDetailLevel').value='detailed';
    document.getElementById('emailTheme').value='light';
    document.getElementById('emailSubjectPrefix').value='[Browser Test]';
    document.getElementById('emailDigestMaxItems').value='4';
    document.getElementById('emailAppearanceForm').requestSubmit();
  })()`);
  await waitForBrowser("app.config?.config?.emailDetailLevel === 'detailed' && app.config?.config?.emailSubjectPrefix === '[Browser Test]' && app.config?.config?.emailDigestMaxItems === 4", 'Email appearance settings did not save');
  await evaluate(`(() => {
    document.getElementById('emailPreviewProduct').value='u7-pro-xgs';
    document.getElementById('emailPreviewType').value='target_price';
    document.getElementById('emailPreviewViewport').value='mobile';
    document.getElementById('previewEmail').click();
  })()`);
  await waitForBrowser("document.getElementById('emailPreviewFrame').contentDocument?.body?.innerText.includes('PRICE TARGET') && document.getElementById('emailPreviewCanvas').classList.contains('mobile') && getComputedStyle(document.getElementById('emailPreviewFrame').contentDocument.body).backgroundColor === 'rgb(242, 244, 246)'", 'Mobile light email preview did not render');
  await evaluate(`(() => { document.getElementById('emailTheme').value='dark'; document.getElementById('emailPreviewType').value='digest'; document.getElementById('emailPreviewViewport').value='desktop'; document.getElementById('previewEmail').click(); })()`);
  await waitForBrowser("document.getElementById('emailPreviewFrame').contentDocument?.body?.innerText.includes('GEARBEACON DIGEST') && !document.getElementById('emailPreviewCanvas').classList.contains('mobile') && getComputedStyle(document.getElementById('emailPreviewFrame').contentDocument.body).backgroundColor === 'rgb(13, 16, 18)'", 'Desktop dark digest preview did not render');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && getComputedStyle(document.querySelector('.email-preview-toolbar')).gridTemplateColumns.split(' ').length === 1"), 'Email appearance settings overflow at a 390px viewport.');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`location.href=${JSON.stringify(`${baseUrl}/?region=us&product=u7-pro-xgs#browse`)}`);
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.getElementById('productDialogTitle').textContent === 'U7 Pro XGS' && document.getElementById('browse').classList.contains('active')", 'Authenticated email product deep link did not open the matching product');
  await evaluate("document.getElementById('closeProductDialog').click(); document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabData').click()");
  await waitForBrowser("!document.getElementById('settingsPanelData').hidden && document.getElementById('settingsPanelNotifications').hidden", 'Data settings tab failed');
  const recoverySettings = await evaluate("({ activityRetention:document.getElementById('configEventRetention').value, secondaryDirectory:document.getElementById('configSecondaryBackupDir').value, encrypted:document.getElementById('configSecondaryEncrypted').checked, hasPrimaryTest:Boolean(document.getElementById('testPrimaryBackup')), hasSecondaryTest:Boolean(document.getElementById('testSecondaryBackup')) })");
  assert(recoverySettings.activityRetention === '365' && recoverySettings.secondaryDirectory === '' && !recoverySettings.encrypted && recoverySettings.hasPrimaryTest && recoverySettings.hasSecondaryTest, `V1.10 recovery settings are incomplete: ${JSON.stringify(recoverySettings)}`);
  const browserBackup = await evaluate(`(async () => {
    const backup = await api('/api/data/export/encrypted', { method:'POST', body:JSON.stringify({ passphrase:'browser backup passphrase' }) });
    const preview = await api('/api/data/preview', { method:'POST', body:JSON.stringify({ backup, passphrase:'browser backup passphrase' }) });
    const restored = await api('/api/data/import', { method:'POST', body:JSON.stringify({ backup, passphrase:'browser backup passphrase' }) });
    await refreshDataInfo();
    return { format:backup.format, historyCount:preview.regions[0].historyCount, watchCount:restored.watchCount };
  })()`);
  assert(browserBackup?.format === 'GearBeaconEncryptedBackup' && browserBackup.watchCount === 2 && browserBackup.historyCount >= 1, 'Browser backup preview/import flow failed.');
  await waitForBrowser("!document.getElementById('testPrimaryBackup').disabled", 'Primary restore test did not become available after the safety backup');
  await evaluate("document.getElementById('testPrimaryBackup').click()");
  await waitForBrowser("!document.getElementById('testPrimaryBackup').disabled && /Restore test passed/.test(document.getElementById('backupTestResult').textContent)", 'Non-destructive browser restore test did not pass');

  await evaluate("document.querySelector('[data-tab=\"operations\"]').click()");
  await waitForBrowser("app.operations?.summary?.state && document.getElementById('operationsSummary').textContent.trim().length > 0", 'Operations summary did not render');
  await assertAccessible('Operations dashboard');
  await evaluate("document.getElementById('runDiagnostics').click()");
  await waitForBrowser("!document.getElementById('runDiagnostics').disabled && document.querySelectorAll('#diagnosticsPanel .diagnostic-item').length >= 7", 'Installation diagnostics did not render');
  const diagnostics = await evaluate("({ heading:document.querySelector('#diagnosticsPanel h3')?.textContent, text:document.getElementById('diagnosticsPanel').textContent, hidden:document.getElementById('diagnosticsPanel').classList.contains('hidden') })");
  assert(!diagnostics.hidden && /Diagnostics/.test(diagnostics.heading) && /Database integrity/.test(diagnostics.text) && /United States store/.test(diagnostics.text), `Installation diagnostics are incomplete: ${JSON.stringify(diagnostics)}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const responsive = await evaluate("({ overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, width:window.innerWidth, scrollWidth:document.documentElement.scrollWidth, widest:[...document.querySelectorAll('body *')].map((element) => ({ tag:element.tagName, id:element.id, cls:element.className, right:element.getBoundingClientRect().right, width:element.getBoundingClientRect().width })).filter((item) => item.right > window.innerWidth + 1).sort((a,b) => b.right-a.right).slice(0,5) })");
  assert(responsive?.overflow && responsive.width === 390, `Responsive layout overflows a 390px viewport: ${JSON.stringify(responsive)}`);
  await evaluate("window.scrollTo(0,document.documentElement.scrollHeight)");
  await waitForBrowser("window.scrollY > 360 && document.getElementById('toTop').classList.contains('visible') && getComputedStyle(document.getElementById('toTop')).opacity === '1'", 'To-top control did not finish appearing after scrolling');
  const toTop = await evaluate("(() => { const button=document.getElementById('toTop'); const rect=button.getBoundingClientRect(); const style=getComputedStyle(button); return { ariaHidden:button.getAttribute('aria-hidden'), tabIndex:button.tabIndex, opacity:style.opacity, opacityDuration:style.transitionDuration.split(',')[0].trim(), pointerEvents:style.pointerEvents, right:rect.right, bottom:rect.bottom, width:window.innerWidth, height:window.innerHeight }; })()");
  assert(toTop.ariaHidden === 'false' && toTop.tabIndex === 0 && toTop.opacity === '1' && toTop.opacityDuration === '0.36s' && toTop.pointerEvents === 'auto' && toTop.right <= toTop.width && toTop.bottom <= toTop.height, `To-top control is not visibly fading, reachable, and contained on mobile: ${JSON.stringify(toTop)}`);
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  await evaluate("document.getElementById('toTop').click()");
  await waitForBrowser("window.scrollY === 0 && !document.getElementById('toTop').classList.contains('visible')", 'To-top control did not return to the page start and hide');
  assert(await evaluate("document.activeElement === document.getElementById('appShell')"), 'To-top control did not restore keyboard focus to the page start');
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await evaluate("document.getElementById('logoutBtn').click()");
  await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')", 'Browser logout did not return to the owner gate');
  await evaluate("(() => { document.getElementById('authPassword').value='V1.10 browser owner password'; document.getElementById('authForm').requestSubmit(); })()");
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.auth.authenticated", 'Browser login after logout failed');
  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabSecurity').click()");
  await waitForBrowser("document.querySelectorAll('#sessionList [data-revoke-session]').length >= 1", 'Authenticated session management did not render');

  await evaluate("history.replaceState(null, '', location.pathname + '#settings'); location.reload()");
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && document.getElementById('settings').classList.contains('active') && !document.getElementById('settingsPanelSecurity').hidden", 'Selected tab and Settings subsection did not survive refresh');
  await evaluate(`(() => {
    document.querySelector('[data-tab="browse"]').click();
    document.querySelector('[data-category="WiFi"]').click();
    const input=document.getElementById('search'); input.value='U7'; input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitForBrowser("app.browseCategory === 'WiFi' && document.getElementById('search').value === 'U7' && JSON.parse(localStorage.getItem('gearbeacon.uiState.v1')).browse.search === 'U7' && document.querySelectorAll('#browseGrid .store-card').length === 1", 'Browse state was not ready to persist');
  await evaluate("location.reload()");
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.products.length >= 5", 'Dashboard did not reload for filter persistence');
  const restoredBrowse = await evaluate("({ active:document.getElementById('browse').classList.contains('active'), category:app.browseCategory, search:document.getElementById('search').value, cards:document.querySelectorAll('#browseGrid .store-card').length, stored:JSON.parse(localStorage.getItem('gearbeacon.uiState.v1')) })");
  assert(restoredBrowse.active && restoredBrowse.category === 'WiFi' && restoredBrowse.search === 'U7' && restoredBrowse.cards === 1, `Browse filters and active tab did not survive refresh: ${JSON.stringify(restoredBrowse)}`);
  const savedFilters = await evaluate("JSON.parse(localStorage.getItem('gearbeacon.uiState.v1'))");
  assert(savedFilters.browse.category === 'WiFi' && savedFilters.browse.search === 'U7' && savedFilters.watch.search === '' && savedFilters.activity.search === '', `Saved filter state is incomplete: ${JSON.stringify(savedFilters)}`);
  await evaluate("document.getElementById('resetBrowseFilters').click(); window.dispatchEvent(new Event('offline'))");
  await waitForBrowser("app.browserOffline && !document.getElementById('attentionBanner').classList.contains('hidden') && document.getElementById('attentionTitle').textContent.includes('offline') && document.getElementById('attentionAction').classList.contains('hidden')", 'Offline state did not preserve the dashboard with clear feedback');
  await evaluate("window.dispatchEvent(new Event('online'))");
  await waitForBrowser("!app.browserOffline && document.getElementById('toast').textContent === 'Connection restored' && document.getElementById('toast').classList.contains('success')", 'Reconnect state did not confirm recovery');

  console.log(`BROWSER SMOKE PASSED: ${process.platform} · setup/auth · WCAG axe scans · keyboard/focus/reduced-motion · persistent navigation/filters · resettable empty states · offline recovery · copy actions · unclipped navigation · dark/light · images · watch/rules/bulk/import · compact searchable activity/evidence · email settings/preview/deep-link · backup/import · diagnostics/operations · responsive`);
} catch (error) {
  if (serverOutput.length) process.stderr.write(`\nGearBeacon server output:\n${serverOutput.join('').slice(-12000)}\n`);
  throw error;
} finally {
  try { cdp?.socket?.close(); } catch {}
  await stopProcess(chrome);
  await stopProcess(server);
  await rm(chromeProfile, { recursive:true, force:true });
  await rm(testRoot, { recursive:true, force:true });
}
