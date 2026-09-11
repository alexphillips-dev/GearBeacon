import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-browser-smoke-'));
const chromeProfile = await mkdtemp(join(tmpdir(), 'gearbeacon-chrome-'));
const screenshotRoot = process.env.GEARBEACON_BROWSER_SCREENSHOTS === '1' ? await mkdtemp(join(tmpdir(), 'gearbeacon-browse-review-')) : null;
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

async function reloadBrowserPage() {
  const previousDocument = await evaluate('performance.timeOrigin');
  await cdp.send('Page.reload');
  // Reload is asynchronous: the old document can still satisfy a saved-state check.
  await waitForBrowser(`performance.timeOrigin !== ${previousDocument} && typeof app !== 'undefined'`, 'Browser reload did not initialize a new document');
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
    document.getElementById('authPassword').value = 'V1.2.0 browser owner password';
    document.getElementById('authPasswordConfirm').value = 'V1.2.0 browser owner password';
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
  const operationsNavigation = await evaluate("({ topLevel:Boolean(document.querySelector('[data-tab=\"operations\"]')), lastSettingsTab:document.querySelector('.settings-tabs [data-settings-tab]:last-child')?.dataset.settingsTab })");
  assert(!operationsNavigation.topLevel && operationsNavigation.lastSettingsTab === 'operations', `Operations was not moved to the final Settings subtab: ${JSON.stringify(operationsNavigation)}`);
  await evaluate("activateTab('watchlist')");

  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  const reducedMotion = await evaluate("(() => { const item=document.createElement('div'); item.className='skeleton'; document.body.append(item); const animation=getComputedStyle(item,'::after').animationName; item.remove(); return animation; })()");
  assert(reducedMotion === 'none', `Reduced-motion preference did not disable loading animation: ${reducedMotion}`);
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640, height:450, screenWidth:1280, screenHeight:900, deviceScaleFactor:2, mobile:false });
  const zoomReflow = await evaluate("({ viewport:window.innerWidth, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, scrollWidth:document.documentElement.scrollWidth })");
  assert(zoomReflow.viewport === 640 && zoomReflow.overflow, `Dashboard does not reflow at a 200% equivalent viewport: ${JSON.stringify(zoomReflow)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const watchManagePlacement = await evaluate("(() => { const heading=document.querySelector('#watchlist .section-heading').getBoundingClientRect(); const button=document.getElementById('watchManageToggle').getBoundingClientRect(); return { headingRight:heading.right, buttonRight:button.right, buttonLeft:button.left, headingMid:heading.left + heading.width / 2, visible:button.width > 0 && button.height > 0 }; })()");
  assert(watchManagePlacement.visible && Math.abs(watchManagePlacement.headingRight - watchManagePlacement.buttonRight) <= 3 && watchManagePlacement.buttonLeft > watchManagePlacement.headingMid, `Watchlist Manage control is not positioned at the top right: ${JSON.stringify(watchManagePlacement)}`);

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
  // Axe must inspect the final theme colors, not an intermediate frame from
  // the 180 ms body/button color transition.
  await delay(250);

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
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.querySelector('#productDialogBody .product-watch-prompt [data-add-watch]')", 'Unwatched product details did not render');
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
    const watchButton=document.querySelector('#productDialogBody .product-watch-prompt [data-add-watch]');
    const storeButton=document.querySelector('#productDialogBody .product-link-actions a.button-link');
    return { watchHeight:watchButton?.getBoundingClientRect().height, storeHeight:storeButton?.getBoundingClientRect().height, watchFont:getComputedStyle(watchButton).fontSize, storeFont:getComputedStyle(storeButton).fontSize };
  })()`);
  assert(Math.abs(productPromptActions.watchHeight - productPromptActions.storeHeight) <= 1 && productPromptActions.watchFont === productPromptActions.storeFont, `Product watch action does not match the compact store action: ${JSON.stringify(productPromptActions)}`);
  await evaluate("document.getElementById('closeProductDialog').click()");
  await evaluate("document.querySelector('#browseGrid [data-add-watch=\"u7-pro-xgs\"]').click()");
  await waitForBrowser("!document.getElementById('saveAddWatch').disabled", 'Browse destination picker did not load');
  await evaluate("document.getElementById('addWatchForm').requestSubmit()");
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

  // Store-style navigation must keep focus while the monitor refreshes the catalog.
  await evaluate("document.querySelector('#categoryTabs [aria-selected=true]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  assert(await evaluate("document.activeElement.dataset.category === app.browseCategory && app.browseCategory !== 'All' && document.querySelectorAll('#categoryTabs [tabindex=\"0\"]').length === 1"), 'Browse categories do not support roving keyboard focus');
  assert(await evaluate("(() => { const focused=document.activeElement; renderProducts(); return document.activeElement === focused; })()"), 'Catalog refresh removed the focused category');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
  assert(await evaluate("document.activeElement === document.querySelector('#categoryTabs button:last-child')"), 'End did not select the last Browse category');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert(await evaluate("app.browseCategory === 'All'"), 'Home did not select all Browse products');
  for (const availability of ['in','out']) {
    await evaluate(`document.querySelector('#browseFilters input[name=availability][value=${availability}]').click()`);
    assert(await evaluate(`(() => { const cards=[...document.querySelectorAll('#browseGrid .store-card')]; return cards.length > 0 && cards.every(card => { const product=app.products.find(item=>item.slug===card.dataset.productCard); return !product.unlisted && ${availability === 'in' ? 'product.inStock' : '!product.inStock && !product.comingSoon'}; }); })()`), `Browse ${availability} availability filter returned the wrong products`);
  }
  await evaluate("document.getElementById('resetBrowseFilters').focus(); document.activeElement.click()");
  assert(await evaluate("document.activeElement.id === 'search' && document.getElementById('browseFilters').elements.availability.value === 'all'"), 'Resetting Browse filters lost focus or did not clear availability');
  await evaluate("document.querySelector('#browseFilters input[name=watching][value=watched]').click()");
  assert(await evaluate("document.querySelectorAll('#browseGrid .store-card').length === 1 && Boolean(document.querySelector('#browseGrid .store-watching-badge'))"), 'Watching filter or watched card indicator failed');
  await evaluate("document.querySelector('#browseFilters input[name=watching][value=unwatched]').click()");
  assert(await evaluate("document.querySelectorAll('#browseGrid .store-card').length > 0 && !document.querySelector('#browseGrid .store-watching-badge')"), 'Not watched filter included watched products');
  await evaluate("resetBrowseFilters()");

  // Deterministic presentation fixtures exercise exact SKU search and price ordering.
  const browseFixtureResult = await evaluate(`(() => {
    const products=app.products, variants=app.catalogVariants;
    try {
      const parent={slug:'browse-fixture', name:'Browse fixture', category:'WiFi', inStock:true, status:'Available', price:'$999.00', watched:false, variantKeys:['browse-fixture::one','browse-fixture::two']};
      const exact=[{...parent,slug:'browse-fixture::one',parentSlug:parent.slug,variantId:'one',sku:'SKU-FIXTURE-ONE',price:'$120.00',watched:true},{...parent,slug:'browse-fixture::two',parentSlug:parent.slug,variantId:'two',sku:'SKU-FIXTURE-TWO',price:'$45.00',watched:false}];
      app.products=[parent,{...parent,slug:'unknown-fixture',name:'Unknown fixture',price:null,variantKeys:[]}, {...parent,slug:'free-fixture',name:'Free fixture',price:'$0.00',variantKeys:[]}];
      app.catalogVariants=exact;
      document.getElementById('browseSort').value='price-low'; renderProducts(true);
      const low=[...document.querySelectorAll('#browseGrid .store-card')].map(card=>card.dataset.productCard);
      const price=document.querySelector('[data-product-card="browse-fixture"] .store-price-row strong').textContent;
      document.getElementById('browseSort').value='price-high'; renderProducts(true);
      const high=[...document.querySelectorAll('#browseGrid .store-card')].map(card=>card.dataset.productCard);
      document.getElementById('search').value='SKU-FIXTURE-TWO'; renderProducts(true);
      const search=[...document.querySelectorAll('#browseGrid .store-card')].map(card=>card.dataset.productCard);
      document.getElementById('browseFilters').elements.watching.value='watched'; renderProducts(true);
      const exactWatching=document.querySelectorAll('#browseGrid .store-card').length === 1 && Boolean(document.querySelector('.store-watching-badge'));
      exact[1].price=null; renderProducts(true);
      const unknown=document.querySelector('.store-price-row strong').textContent;
      exact[1].price='$0.00'; renderProducts(true);
      const zero=document.querySelector('.store-price-row strong').textContent;
      exact[1].unlisted=true; renderProducts(true);
      const retired=document.querySelector('.store-product-meta').textContent;
      const single=document.querySelector('.store-price-row strong').textContent;
      return {low,high,price,search,exactWatching,unknown,zero,retired,single};
    } finally { app.products=products; app.catalogVariants=variants; resetBrowseFilters(); }
  })()`);
  assert(JSON.stringify(browseFixtureResult.low) === JSON.stringify(['free-fixture','browse-fixture','unknown-fixture']) && JSON.stringify(browseFixtureResult.high) === JSON.stringify(['browse-fixture','free-fixture','unknown-fixture']), `Browse price ordering mishandled variants, zero, or unknown prices: ${JSON.stringify(browseFixtureResult)}`);
  assert(browseFixtureResult.price === 'From $45.00' && browseFixtureResult.unknown === 'Prices vary' && browseFixtureResult.zero === 'From $0.00' && !browseFixtureResult.retired.includes('2 variants') && browseFixtureResult.single === '$120.00', 'Browse variant prices or retired options are misleading');
  assert(browseFixtureResult.exactWatching && JSON.stringify(browseFixtureResult.search) === JSON.stringify(['browse-fixture']), 'Exact SKU search or exact-only watched status did not find the parent card');

  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    for (const width of [1280,390,640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width,height:900,screenWidth:width === 640 ? 1280 : width,screenHeight:900,deviceScaleFactor:width === 640 ? 2 : 1,mobile:false });
      if (width !== 640) await waitForBrowser(`document.getElementById('browseFilterPanel').open === ${width > 820}`, 'Browse filters did not adapt after crossing the mobile breakpoint');
      const browseLayout=await evaluate("(() => { const filters=document.getElementById('browseFilterPanel'), grid=document.getElementById('browseGrid'); return { overflow:document.documentElement.scrollWidth > window.innerWidth + 1, sidebar:filters.getBoundingClientRect().right < grid.getBoundingClientRect().left, open:filters.open, cards:[...grid.children].every(card=>card.scrollWidth <= card.clientWidth + 1) }; })()");
      assert(!browseLayout.overflow && browseLayout.cards && (width === 1280 ? browseLayout.sidebar && browseLayout.open : !browseLayout.sidebar), `Browse does not reflow in ${theme} at ${width}px: ${JSON.stringify(browseLayout)}`);
      if (width === 390) {
        assert(!browseLayout.open, 'Mobile Browse filters did not start collapsed');
        await evaluate("document.querySelector('#browseFilterPanel summary').click()");
        assert(await evaluate("document.getElementById('browseFilterPanel').open && document.querySelector('#browseFilters input').getBoundingClientRect().height > 0"), 'Mobile Browse filters did not open');
      }
      await assertAccessible(`Browse ${theme} at ${width}px`);
      await evaluate("document.getElementById('browseViewToggle').click()");
      const browseViews=await evaluate("(() => { const panel=document.getElementById('browseViewOptions'),rect=panel.getBoundingClientRect(),style=getComputedStyle(document.getElementById('browseSavedView')); return {open:!document.getElementById('browseViewOptions').classList.contains('hidden'),left:rect.left,right:rect.right,viewport:window.innerWidth,scroll:panel.scrollWidth,client:panel.clientWidth,radius:style.borderRadius,height:style.minHeight}; })()");
      assert(browseViews.open && browseViews.left>=0 && browseViews.right<=browseViews.viewport+1 && browseViews.scroll<=browseViews.client+1 && browseViews.radius==='9px' && parseFloat(browseViews.height)>=42, `Browse views were clipped or retained unstyled dropdowns: ${JSON.stringify(browseViews)}`);
      await assertAccessible(`Browse view options ${theme} ${width}px`);
      await evaluate("document.getElementById('search').click()");
      assert(await evaluate("document.getElementById('browseViewOptions').classList.contains('hidden')"), 'Outside click did not close Browse views');

      if (screenshotRoot) {
        if (width === 390) await evaluate("document.querySelector('#browseFilterPanel summary').click()");
        await evaluate("document.getElementById('browse').scrollIntoView()");
        const capture=await cdp.send('Page.captureScreenshot', { format:'png' });
        await writeFile(join(screenshotRoot, `browse-${theme}-${width}.png`), Buffer.from(capture.data,'base64'));
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  if (screenshotRoot) console.log(`Browse screenshots: ${screenshotRoot}`);

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
  // Secondary controls use themed, keyboard-accessible panels instead of extra rows.
  assert(await evaluate("document.getElementById('watchManageMenu').classList.contains('hidden') && document.getElementById('watchViewOptions').classList.contains('hidden') && document.querySelectorAll('.watch-toolbar > select').length===3 && !document.querySelector('.collection-toolbar')"), 'Watchlist secondary controls were not consolidated');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme('${theme}')`); await delay(250);
    for (const width of [1280,390,640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,screenWidth:width===640?1280:width,screenHeight:900,deviceScaleFactor:width===640?2:1,mobile:false});
      await evaluate("document.getElementById('watchlist').scrollIntoView(); document.getElementById('watchViewToggle').focus()");
      const toolbarFocus=await evaluate("({active:document.activeElement.outerHTML,inert:document.querySelector('main').inert,open:!document.getElementById('watchViewOptions').classList.contains('hidden')})");
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      assert(await evaluate("!document.getElementById('watchViewOptions').classList.contains('hidden')"), `Keyboard activation did not open View options (${width}px): ${JSON.stringify(toolbarFocus)}; after: ${await evaluate('document.activeElement.outerHTML')}`);
      assert(await evaluate("(() => { const base=getComputedStyle(document.getElementById('watchStatus')); return ['watchLayout','watchSavedView','watchCategory'].every(id=>{const style=getComputedStyle(document.getElementById(id));return ['backgroundColor','color','borderRadius','padding','fontSize','minHeight'].every(key=>style[key]===base[key]);}); })()"), 'Saved view or layout selects do not match the existing dropdown styling');
      assert(await evaluate("(() => { const panel=document.getElementById('watchViewOptions'), rect=panel.getBoundingClientRect(); return rect.left>=0 && rect.right<=window.innerWidth+1 && panel.scrollWidth<=panel.clientWidth+1 && document.documentElement.scrollWidth<=window.innerWidth+1; })()"), `View options overflow at ${width}px in ${theme}`);
      await assertAccessible(`Watchlist view options ${theme} ${width}px`);
      if (screenshotRoot) {
        const capture=await cdp.send('Page.captureScreenshot',{format:'png'});
        await writeFile(join(screenshotRoot,`watch-options-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
      }
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      assert(await evaluate("document.activeElement.id==='watchCategory'"), 'Tab did not enter View options');
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      assert(await evaluate("document.getElementById('watchViewOptions').classList.contains('hidden') && document.activeElement.matches('#watchViewToggle')"), 'Escape did not close View options and restore focus');
      await evaluate("document.getElementById('watchManageToggle').click()");
      assert(await evaluate("!document.getElementById('watchManageMenu').classList.contains('hidden') && document.getElementById('watchViewOptions').classList.contains('hidden')"), 'Manage actions were not discoverable');
      await assertAccessible(`Manage watchlist ${theme} ${width}px`);
      await evaluate("document.getElementById('watchSearch').focus()");
      assert(await evaluate("document.getElementById('watchManageMenu').classList.contains('hidden')"), 'Leaving the panel did not dismiss it');
      if (screenshotRoot) {
        await evaluate("document.getElementById('watchlist').scrollIntoView()");
        const capture=await cdp.send('Page.captureScreenshot',{format:'png'});
        await writeFile(join(screenshotRoot,`watch-toolbar-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
      }
    }
  }
  await evaluate("document.getElementById('watchViewToggle').click(); const category=document.getElementById('watchCategory'); category.value=category.options[1].value; category.dispatchEvent(new Event('change')); document.getElementById('watchSearch').focus()");
  assert(await evaluate("document.getElementById('watchViewOptions').classList.contains('hidden') && document.getElementById('watchViewContext').textContent.includes(document.getElementById('watchCategory').value) && !document.getElementById('watchViewContext').classList.contains('hidden')"), 'A hidden category filter was not explained outside View options');
  await evaluate("document.getElementById('resetWatchFilters').click(); document.getElementById('watchManageToggle').click(); document.getElementById('selectVisibleWatches').click()");
  assert(await evaluate("document.getElementById('watchManageMenu').classList.contains('hidden') && !document.getElementById('bulkActions').classList.contains('hidden') && app.selectedWatch.size===2"), 'Manage > Select visible watches did not reveal bulk actions');
  await evaluate("document.getElementById('bulkClear').click()");
  await cdp.send('Emulation.clearDeviceMetricsOverride');

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
  const responsiveImport = await evaluate("(() => { const panel=document.querySelector('#watchImportDialog .watch-import-panel').getBoundingClientRect(); return { width:panel.width, height:panel.height, overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, summaryColumns:getComputedStyle(document.getElementById('watchImportSummary')).gridTemplateColumns.split(' ').length }; })()");
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
  assert(await evaluate("document.getElementById('activityPageSize').value === '20' && app.activity.limit === 20"), 'Activity did not default to 20 entries per page');
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
  assert(recoverySettings.activityRetention === '365' && recoverySettings.secondaryDirectory === '' && !recoverySettings.encrypted && recoverySettings.hasPrimaryTest && recoverySettings.hasSecondaryTest, `V1.2.0 recovery settings are incomplete: ${JSON.stringify(recoverySettings)}`);
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

  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabOperations').click()");
  await waitForBrowser("document.getElementById('settings').classList.contains('active') && !document.getElementById('settingsPanelOperations').hidden && app.operations?.summary?.state && document.getElementById('operationsSummary').textContent.trim().length > 0", 'Settings Operations summary did not render');
  await assertAccessible('Operations dashboard');
  await evaluate("document.getElementById('runDiagnostics').click()");
  await waitForBrowser("!document.getElementById('runDiagnostics').disabled && document.querySelectorAll('#diagnosticsPanel .diagnostic-item').length >= 7", 'Installation diagnostics did not render');
  const diagnostics = await evaluate("({ heading:document.querySelector('#diagnosticsPanel h3')?.textContent, text:document.getElementById('diagnosticsPanel').textContent, hidden:document.getElementById('diagnosticsPanel').classList.contains('hidden') })");
  assert(!diagnostics.hidden && /Diagnostics/.test(diagnostics.heading) && /Database integrity/.test(diagnostics.text) && /United States store/.test(diagnostics.text), `Installation diagnostics are incomplete: ${JSON.stringify(diagnostics)}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const responsive = await evaluate("({ overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, width:window.innerWidth, scrollWidth:document.documentElement.scrollWidth, widest:[...document.querySelectorAll('body *')].map((element) => ({ tag:element.tagName, id:element.id, cls:element.className, right:element.getBoundingClientRect().right, width:element.getBoundingClientRect().width })).filter((item) => item.right > window.innerWidth + 1).sort((a,b) => b.right-a.right).slice(0,5) })");
  assert(responsive?.overflow && responsive.width === 390, `Responsive layout overflows a 390px viewport: ${JSON.stringify(responsive)}`);
  await evaluate("window.scrollTo(0,document.documentElement.scrollHeight)");
  await waitForBrowser("window.scrollY > 360 && document.getElementById('toTop').classList.contains('visible') && Number(getComputedStyle(document.getElementById('toTop')).opacity) > 0 && Number(getComputedStyle(document.getElementById('toTop')).opacity) < 1", 'To-top control did not begin fading after scrolling');
  const enteringToTop = await evaluate("(() => { const style=getComputedStyle(document.getElementById('toTop')); return { opacity:Number(style.opacity), animationName:style.animationName, animationDuration:style.animationDuration }; })()");
  assert(enteringToTop.opacity > 0 && enteringToTop.opacity < 1 && enteringToTop.animationName === 'to-top-fade-in' && enteringToTop.animationDuration === '1.2s', `To-top control did not enter through the complete slow fade: ${JSON.stringify(enteringToTop)}`);
  await waitForBrowser("getComputedStyle(document.getElementById('toTop')).opacity === '1'", 'To-top control did not finish its fade-in animation');
  const toTop = await evaluate("(() => { const button=document.getElementById('toTop'); const rect=button.getBoundingClientRect(); const style=getComputedStyle(button); return { ariaHidden:button.getAttribute('aria-hidden'), tabIndex:button.tabIndex, opacity:style.opacity, pointerEvents:style.pointerEvents, right:rect.right, bottom:rect.bottom, width:window.innerWidth, height:window.innerHeight }; })()");
  assert(toTop.ariaHidden === 'false' && toTop.tabIndex === 0 && toTop.opacity === '1' && toTop.pointerEvents === 'auto' && toTop.right <= toTop.width && toTop.bottom <= toTop.height, `To-top control is not visible, reachable, and contained on mobile: ${JSON.stringify(toTop)}`);
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  await evaluate("document.getElementById('toTop').click()");
  await waitForBrowser("window.scrollY === 0 && !document.getElementById('toTop').classList.contains('visible')", 'To-top control did not return to the page start and hide');
  assert(await evaluate("document.activeElement === document.getElementById('appShell')"), 'To-top control did not restore keyboard focus to the page start');
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await evaluate("document.getElementById('logoutBtn').click()");
  await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')", 'Browser logout did not return to the owner gate');
  await evaluate("(() => { document.getElementById('authPassword').value='V1.2.0 browser owner password'; document.getElementById('authForm').requestSubmit(); })()");
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.auth.authenticated", 'Browser login after logout failed');
  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabSecurity').click()");
  await waitForBrowser("document.querySelectorAll('#sessionList [data-revoke-session]').length >= 1", 'Authenticated session management did not render');

  await evaluate("history.replaceState(null, '', location.pathname + '#settings')");
  await reloadBrowserPage();
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && document.getElementById('settings').classList.contains('active') && !document.getElementById('settingsPanelSecurity').hidden", 'Selected tab and Settings subsection did not survive refresh');
  await evaluate(`(() => {
    document.querySelector('[data-tab="browse"]').click();
    document.querySelector('[data-category="WiFi"]').click();
    const input=document.getElementById('search'); input.value='U7'; input.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#browseFilters input[name=watching][value=watched]').click();
    const sort=document.getElementById('browseSort'); sort.value='price-high'; sort.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitForBrowser("app.browseCategory === 'WiFi' && document.getElementById('search').value === 'U7' && JSON.parse(localStorage.getItem('gearbeacon.uiState.v1')).browse.search === 'U7' && document.querySelectorAll('#browseGrid .store-card').length === 1", 'Browse state was not ready to persist');
  await reloadBrowserPage();
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.products.length >= 5", 'Dashboard did not reload for filter persistence');
  const restoredBrowse = await evaluate("({ active:document.getElementById('browse').classList.contains('active'), category:app.browseCategory, search:document.getElementById('search').value, cards:document.querySelectorAll('#browseGrid .store-card').length, stored:JSON.parse(localStorage.getItem('gearbeacon.uiState.v1')) })");
  assert(restoredBrowse.active && restoredBrowse.category === 'WiFi' && restoredBrowse.search === 'U7' && restoredBrowse.cards === 1, `Browse filters and active tab did not survive refresh: ${JSON.stringify(restoredBrowse)}`);
  assert(await evaluate("document.getElementById('browseFilters').elements.watching.value === 'watched' && document.getElementById('browseSort').value === 'price-high'"), 'Browse watching and sort controls did not survive refresh');
  const savedFilters = await evaluate("JSON.parse(localStorage.getItem('gearbeacon.uiState.v1'))");
  assert(savedFilters.browse.category === 'WiFi' && savedFilters.browse.search === 'U7' && savedFilters.watch.search === '' && savedFilters.activity.search === '', `Saved filter state is incomplete: ${JSON.stringify(savedFilters)}`);
  await evaluate("document.getElementById('resetBrowseFilters').click(); window.dispatchEvent(new Event('offline'))");
  await waitForBrowser("app.browserOffline && !document.getElementById('attentionBanner').classList.contains('hidden') && document.getElementById('attentionTitle').textContent.includes('offline') && document.getElementById('attentionAction').classList.contains('hidden')", 'Offline state did not preserve the dashboard with clear feedback');
  await evaluate("window.dispatchEvent(new Event('online'))");
  await waitForBrowser("!app.browserOffline && document.getElementById('toast').textContent === 'Connection restored' && document.getElementById('toast').classList.contains('success')", 'Reconnect state did not confirm recovery');

  // Precision watch workflows use browser controls, real API calls, and isolated mock data.
  await evaluate("activateTab('watchlist'); document.getElementById('openCollectionManager').focus(); document.getElementById('openCollectionManager').click(); document.getElementById('firstCollection').click(); document.getElementById('collectionName').value='Camera project'; document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("app.collections.some((item) => item.name === 'Camera project')", 'Collection creation failed');
  await assertAccessible('Collection manager');
  await evaluate("document.getElementById('closeCollectionManager').click()");
  assert(await evaluate("document.activeElement.matches('#watchManageToggle') && !document.querySelector('main').inert"), 'Collection manager did not restore focus or release the page');
  await evaluate("activateTab('browse'); resetBrowseFilters(); document.getElementById('tabBrowse').focus(); openProductDialog('uvc-g5-ptz')");
  await waitForBrowser("document.querySelector('[data-variant-selector]')?.options.length === 3", 'Variant choices did not render');
  await evaluate("(() => { const picker=document.querySelector('[data-variant-selector]'); picker.value='uvc-g5-ptz::mock-black'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitForBrowser("app.currentProductDetails?.product.variantId === 'mock-black' && document.activeElement.matches('[data-variant-selector]')", 'Variant selection did not restore keyboard focus');
  assert(await evaluate("document.getElementById('productDialogBody').textContent.includes('MOCK-G5-PTZ-B') && document.querySelector('.product-link-actions a').href.includes('variant=uvc-g5-ptz-black')"), 'Variant SKU or exact Store link is incorrect');
  await evaluate("document.querySelector('.product-watch-prompt [data-add-watch]').click()");
  await waitForBrowser("!document.getElementById('saveAddWatch').disabled", 'Variant destination picker did not load');
  await evaluate("document.getElementById('addWatchForm').requestSubmit()");
  await waitForBrowser("document.getElementById('productRuleForm') && app.currentProductDetails?.product.watched", 'Exact variant watch could not be added');
  await evaluate("(() => { const form=document.getElementById('productRuleForm'); form.elements.targetPrice.value='320'; form.elements.availableUnderTarget.checked=true; form.querySelector('[name=collection]').checked=true; form.querySelector('[data-preview-rule]').click(); })()");
  await waitForBrowser("/Black.*320 USD/.test(document.querySelector('[data-rule-result]')?.textContent || '')", 'Combined rule preview did not describe the selected variant and regional target');
  await evaluate("document.getElementById('productRuleForm').requestSubmit()");
  await waitForBrowser("app.products.find((item) => item.slug === 'uvc-g5-ptz::mock-black')?.watchRule?.availableUnderTarget && app.currentProductDetails?.product.collections.length === 1", 'Combined rule or collection membership was not saved');
  assert(await evaluate("document.querySelector('[data-product-insights]').textContent.includes('partial history') && document.querySelectorAll('.insight-prices tbody tr').length === 3"), 'Insight windows or insufficient-history explanation are missing');
  await evaluate("document.getElementById('productRuleForm').elements.targetPrice.value='310'; const windowPicker=document.querySelector('[data-insight-days]'); windowPicker.value='90'; windowPicker.dispatchEvent(new Event('change',{bubbles:true}))");
  await waitForBrowser("app.currentProductDetails.insights.days === 90 && document.activeElement.matches('[data-insight-days]')", 'Insight window did not load or restore focus');
  assert(await evaluate("document.getElementById('productRuleForm').elements.targetPrice.value === '310'"), 'Changing the history window discarded unsaved watch rules');
  await evaluate("document.querySelector('.insight-observations').open=true");
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`);
    // Match the existing theme scan: measure settled colors after CSS transitions.
    await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,screenWidth:390,screenHeight:844,deviceScaleFactor:1,mobile:false });
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.product-dialog-panel').scrollWidth <= document.querySelector('.product-dialog-panel').clientWidth + 1"), `Variant rule dialog overflows at 390px in ${theme}`);
    await assertAccessible(`Variant rule dialog ${theme}`);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640,height:450,screenWidth:1280,screenHeight:900,deviceScaleFactor:2,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Precision controls overflow at 200% equivalent zoom');
  await evaluate("document.querySelector('#productDialogBody [data-purchased]').click()");
  await waitForBrowser("app.currentProductDetails?.product.watchRule?.purchasedAt && document.activeElement.matches('[data-purchased]')", 'Purchased action did not stop alerts and restore focus');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await waitForBrowser("document.getElementById('productDialog').classList.contains('hidden')", 'Variant dialog did not close with Escape');
  assert(await evaluate("document.activeElement === document.getElementById('tabBrowse')"), 'Variant dialog did not restore its original trigger focus');
  await evaluate("activateTab('watchlist'); resetWatchFilters(); const picker=document.getElementById('watchCollection'); picker.value=app.collections.find((item) => item.name === 'Camera project').id; picker.dispatchEvent(new Event('change',{bubbles:true}))");
  assert(await evaluate("document.querySelectorAll('#watchGrid .watch-card').length === 1 && /Purchased/.test(document.getElementById('watchGrid').textContent)"), 'Collection filter or purchased marker failed');
  await evaluate("document.querySelector('#watchGrid [data-purchased]').click()");
  await waitForBrowser("!app.products.find((item) => item.slug === 'uvc-g5-ptz::mock-black').watchRule.purchasedAt", 'Still wanted did not clear purchased state');
  await evaluate("document.getElementById('selectVisibleWatches').click(); document.getElementById('bulkPause').click()");
  await waitForBrowser("app.products.find((item) => item.slug === 'uvc-g5-ptz::mock-black').watchRule.pausedUntil", 'Collection bulk pause failed');
  assert(await evaluate("!app.products.find((item) => item.slug === 'u7-pro-xgs').watchRule.pausedUntil"), 'Collection bulk pause changed an unrelated watch');
  await evaluate("document.getElementById('selectVisibleWatches').click(); document.getElementById('bulkResume').click()");
  await waitForBrowser("!app.products.find((item) => item.slug === 'uvc-g5-ptz::mock-black').watchRule.pausedUntil", 'Collection bulk resume failed');
  await evaluate("api('/api/check', { method:'POST',body:'{}' }).then(() => refresh())");
  assert(await evaluate("app.collections[0].readiness.waiting === 1 && document.querySelector('.readiness-status').textContent.includes('0 of 1')"), 'Collection did not show its confirmed blocking item');
  assert(await evaluate("document.querySelector('.collection-card .card-actions [data-collection-alerts]').textContent === 'Alerts'"), 'Collection cards did not provide a clearly labeled Alerts action');
  await evaluate("window.collectionAlertWatchRules=JSON.stringify(app.products.filter(item=>item.watched).map(item=>[item.slug,item.watchRule])); document.querySelector('.collection-card .card-actions [data-collection-alerts]').focus(); document.activeElement.click()");
  assert(await evaluate("document.getElementById('collectionAlertHeading').textContent === 'Collection alerts' && document.querySelector('[data-notify-collection]').getAttribute('aria-describedby').includes('collectionAlertInteraction') && document.getElementById('collectionAlertInteraction').offsetHeight > 0 && document.getElementById('collectionAlertInteraction').textContent.includes('unless another collection suppresses') && document.getElementById('collectionAlertDelivery').textContent.includes('Saves automatically')"), 'Collection alerts did not visibly explain saving, delivery, or their interaction with item rules');
  await evaluate("document.querySelector('[data-notify-collection]').click()");
  await waitForBrowser("app.collections[0].notifyReady && document.activeElement.matches('[data-notify-collection]')", 'Collection notification opt-in failed or lost focus');
  assert(await evaluate("window.collectionAlertWatchRules === JSON.stringify(app.products.filter(item=>item.watched).map(item=>[item.slug,item.watchRule]))"), 'Enabling collection alerts changed individual item rules');
  await evaluate(`(async () => {
    await api('/api/mock/product/uvc-g5-ptz', { method:'POST', body:JSON.stringify({ variants:[
      { id:'mock-black',slug:'uvc-g5-ptz-black',sku:'MOCK-G5-PTZ-B',title:'Black',status:'Available',displayPrice:'$299.00' },
      { id:'mock-white',slug:'uvc-g5-ptz-white',sku:'MOCK-G5-PTZ-W',title:'White',status:'Available',displayPrice:'$329.00' }
    ] }) });
    await api('/api/check', { method:'POST',body:'{}' }); await refresh();
  })()`);
  await waitForBrowser("app.collections[0].readiness.ready && document.querySelector('.readiness-status').textContent.includes('1 of 1')", 'Collection did not become ready after a confirmed restock');
  await evaluate("document.querySelector('[data-close-collection-alerts]').click()");
  assert(await evaluate("document.getElementById('collectionDialog').classList.contains('hidden') && document.activeElement.matches('.collection-card .card-actions [data-collection-alerts]')"), 'Closing collection alerts did not restore the card action');
  await evaluate("document.querySelector('.collection-card .collection-preview').focus(); document.activeElement.click(); document.querySelector('#collectionDetails [data-collection-image]').focus()");
  await evaluate("api('/api/check', { method:'POST',body:'{}' }).then(() => refresh())");
  assert(await evaluate("document.activeElement.matches('#collectionDetails [data-collection-image]') && document.querySelector('#collectionDetails .collection-member-row').offsetHeight > 0 && !document.querySelector('#collectionDetails details')"), 'Refreshing collection details collapsed the items or lost thumbnail focus');
  await evaluate("document.getElementById('closeCollectionManager').click()");
  assert(await evaluate("document.activeElement.matches('.collection-card .collection-preview')"), 'Collection details did not restore preview focus after refresh');
  await evaluate("activateTab('activity'); document.getElementById('activityType').value='collection_ready'; refreshActivity(1)");
  await waitForBrowser("app.activity.events.some((event) => event.type === 'collection_ready')", 'Collection readiness is missing from Activity');
  assert(await evaluate("Math.round(document.querySelector('#activityList .event').getBoundingClientRect().height) === 64"), 'Collection readiness changed compact Activity row height');
  await evaluate("document.querySelector('#activityList [data-activity-event]').click()");
  await waitForBrowser("document.querySelector('[data-activity-collection]')", 'Collection event did not provide a collection action');
  await evaluate("document.querySelector('[data-activity-collection]').click()");
  await waitForBrowser("app.activeTab === 'watchlist' && document.activeElement.id === 'watchCollection'", 'Activity did not route to the collection and restore focus');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await assertAccessible(`Collection readiness ${theme}`);
  }
  await evaluate("document.getElementById('openCollectionManager').click(); document.querySelector('[data-edit-collection]').click(); document.getElementById('collectionName').value='Renamed cameras'; document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("app.collections.some((item) => item.name === 'Renamed cameras')", 'Collection rename failed');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,screenWidth:390,screenHeight:844,deviceScaleFactor:1,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Collection manager overflows on mobile');
  await assertAccessible('Mobile collections and precision watchlist');
  await evaluate("document.getElementById('closeCollectionManager').click()");
  const selectedCollection = await evaluate("document.getElementById('watchCollection').value");
  await reloadBrowserPage();
  await waitFor(async () => await evaluate("app.products.some((item) => item.slug === 'uvc-g5-ptz::mock-black') ? document.getElementById('watchCollection').value : null") === selectedCollection, 'Collection filter did not survive reload');
  await cdp.send('Page.navigate', { url:`${baseUrl}/?region=us&collection=${encodeURIComponent(selectedCollection)}#watchlist` });
  await waitFor(async () => await evaluate("app.activeTab === 'watchlist' && app.pendingCollectionId === null ? document.getElementById('watchCollection').value : null") === selectedCollection, 'Collection notification deep link did not open its Watchlist collection');
  await evaluate("document.getElementById('openCollectionManager').focus(); document.getElementById('openCollectionManager').click(); document.querySelector('[data-edit-collection]').click(); document.getElementById('askDeleteCollection').click(); document.getElementById('confirmDeleteCollection').click()");
  await waitForBrowser("app.collections.length === 0 && !app.collectionBusy", 'Collection deletion failed');
  assert(await evaluate("app.products.some((item) => item.slug === 'uvc-g5-ptz::mock-black' && item.watched)"), 'Collection deletion removed its watch');
  assert(await evaluate("document.getElementById('collectionDialog').classList.contains('hidden') && !document.querySelector('main').inert && !document.getElementById('toTop').inert && !document.body.classList.contains('dialog-open') && document.activeElement.matches('#watchManageToggle')"), 'Deleting the last collection reopened its empty manager or failed to restore page focus');

  // Collection management keeps name/membership edits together and preserves drafts until saved.
  const collectionTestSlugs = await evaluate("app.products.filter((product) => product.watched).slice(0,2).map((product) => product.slug)");
  assert(collectionTestSlugs.length === 2, 'Collection manager fixture needs two watched products');
  await evaluate("document.getElementById('openCollectionManager').focus(); document.getElementById('openCollectionManager').click()");
  assert(await evaluate("document.activeElement.id === 'firstCollection' && document.querySelector('main').inert && !document.getElementById('collectionEmpty').classList.contains('hidden')"), 'Collection empty state did not provide a focused first action');
  await evaluate("document.getElementById('firstCollection').click(); document.getElementById('collectionName').value='Home network'");
  await evaluate(`document.querySelector('[data-collection-watch="${collectionTestSlugs[0]}"]').click()`);
  await evaluate("document.getElementById('collectionWatchSearch').value='no-such-mock-watch'; document.getElementById('collectionWatchSearch').dispatchEvent(new Event('input'))");
  assert(await evaluate("document.getElementById('collectionWatchChoices').textContent.includes('No watches match') && document.getElementById('collectionSelection').textContent === '1 selected'"), 'Filtering collection choices lost the selection or empty-state guidance');
  await evaluate("document.getElementById('collectionWatchSearch').value=''; document.getElementById('collectionWatchSearch').dispatchEvent(new Event('input'))");
  assert(await evaluate(`document.querySelector('[data-collection-watch="${collectionTestSlugs[0]}"]').checked && document.querySelector('.collection-watch-image img')`), 'Selected watch or product thumbnails were missing');
  await evaluate("refresh()");
  assert(await evaluate("document.getElementById('collectionName').value === 'Home network' && app.collectionDraft.slugs.size === 1"), 'Background refresh erased an unsaved collection draft');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await assertAccessible(`Collection editor ${theme}`);
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth + 1"), 'Collection editor overflowed at 390px');
  }
  await evaluate("document.getElementById('saveCollection').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))");
  assert(await evaluate("document.activeElement.id === 'closeCollectionManager'"), 'Collection editor did not contain forward keyboard focus');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}))");
  assert(await evaluate("document.activeElement.id === 'saveCollection'"), 'Collection editor did not contain reverse keyboard focus');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640,height:450,screenWidth:1280,screenHeight:900,deviceScaleFactor:2,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Collection editor overflowed at 200% equivalent zoom');
  await evaluate("document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("app.collections.some((item) => item.name === 'Home network' && item.slugs.length === 1) && !app.collectionBusy", 'Creating a collection did not save its selected watch');
  const homeCollection = await evaluate("app.collections.find((item) => item.name === 'Home network').id");
  assert(await evaluate(`document.activeElement.dataset.editCollection === '${homeCollection}'`), 'Saving a new collection did not focus its Edit action');
  // An older running backend ignores member edits while still returning HTTP 200.
  await evaluate(`document.querySelector('[data-edit-collection="${homeCollection}"]').click(); document.querySelector('[data-collection-watch="${collectionTestSlugs[1]}"]').click()`);
  await evaluate(`(() => {
    window.collectionOriginalFetch=window.fetch; window.collectionMutationRequests=0;
    window.fetch=(input,options={}) => {
      const url=new URL(String(input),location.origin);
      if (url.pathname.startsWith('/api/collections')) {
        if ((options.method || 'GET') === 'GET') return Promise.resolve(new Response(JSON.stringify({collections:app.collections}),{status:200,headers:{'Content-Type':'application/json'}}));
        window.collectionMutationRequests++;
      }
      return window.collectionOriginalFetch(input,options);
    };
    document.getElementById('collectionForm').requestSubmit();
  })()`);
  await waitForBrowser("!app.collectionBusy && document.getElementById('collectionResult').textContent.includes('updated and restarted')", 'An older backend did not show the restart guidance');
  assert(await evaluate("window.collectionMutationRequests === 0 && app.collectionDraft.slugs.size === 2 && !document.getElementById('collectionForm').classList.contains('hidden') && !document.getElementById('saveCollection').disabled"), 'An unsupported server save changed data, dismissed the editor, or erased selected watches');
  // Even a capable server must return the requested membership before success is shown.
  await evaluate(`(() => {
    window.fetch=(input,options={}) => {
      if (new URL(String(input),location.origin).pathname.startsWith('/api/collections/') && options.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ok:true,collections:app.collections}),{status:200,headers:{'Content-Type':'application/json'}}));
      return window.collectionOriginalFetch(input,options);
    };
    document.getElementById('collectionForm').requestSubmit();
  })()`);
  await waitForBrowser("!app.collectionBusy && document.getElementById('collectionResult').textContent.includes('did not confirm')", 'A response missing the selected watch was reported as a successful save');
  assert(await evaluate("app.collectionDraft.slugs.size === 2 && !document.getElementById('collectionForm').classList.contains('hidden')"), 'An incomplete save response erased the collection draft');
  await evaluate("window.fetch=window.collectionOriginalFetch; document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser(`!app.collectionBusy && app.collections.find((item) => item.id === '${homeCollection}').slugs.length === 2 && !document.getElementById('collectionOverview').classList.contains('hidden')`, 'Retrying against a compatible server did not save the retained selections');
  assert(await evaluate(`api('/api/collections').then(result => result.collections.find(item => item.id === '${homeCollection}').slugs.length === 2)`), 'Saved membership did not persist on the server');
  await evaluate(`document.querySelector('[data-edit-collection="${homeCollection}"]').click(); document.querySelector('[data-collection-watch="${collectionTestSlugs[1]}"]').click(); document.getElementById('collectionForm').requestSubmit()`);
  await waitForBrowser(`!app.collectionBusy && app.collections.find((item) => item.id === '${homeCollection}').slugs.length === 1`, 'Removing a selected watch did not save');
  await evaluate(`document.querySelector('[data-edit-collection="${homeCollection}"]').click(); document.getElementById('collectionName').value='Discarded name'; document.querySelector('[data-collection-watch="${collectionTestSlugs[1]}"]').click(); document.getElementById('cancelCollectionEdit').click()`);
  assert(await evaluate(`app.collections.find((item) => item.id === '${homeCollection}').name === 'Home network' && app.collections[0].slugs.length === 1`), 'Cancel saved collection edits');
  await evaluate("document.getElementById('newCollection').click(); document.getElementById('collectionName').value='Home network'; document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("document.getElementById('collectionResult').textContent.includes('already exists') && !app.collectionBusy", 'Duplicate collection name did not report a recoverable error');
  assert(await evaluate("document.getElementById('collectionName').value === 'Home network' && !document.getElementById('saveCollection').disabled"), 'Failed collection save erased the draft or left controls disabled');
  await evaluate("document.getElementById('collectionName').value='Camera upgrade'; document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("app.collections.length === 2 && !app.collectionBusy", 'Empty collection creation failed');
  const cameraCollection = await evaluate("app.collections.find((item) => item.name === 'Camera upgrade').id");
  await evaluate(`document.querySelector('[data-view-collection="${homeCollection}"]').click()`);
  assert(await evaluate(`document.getElementById('collectionDialog').classList.contains('hidden') && document.getElementById('watchCollection').value === '${homeCollection}' && document.activeElement.id === 'watchCollection'`), 'View watches did not close the manager and filter the Watchlist');
  assert(await evaluate(`document.querySelector('#watchGrid [data-product-card="${collectionTestSlugs[0]}"]').textContent.includes('Collection: Home network')`), 'The watched item did not identify its collection by name');
  await evaluate(`resetWatchFilters(); app.selectedWatch=new Set(${JSON.stringify(collectionTestSlugs)}); renderProducts(true); document.getElementById('bulkAddCollection').click(); document.getElementById('collectionDestination').value='${cameraCollection}'; document.getElementById('collectionBulkForm').requestSubmit()`);
  await waitForBrowser(`app.collections.find((item) => item.id === '${cameraCollection}').slugs.length === 2 && document.getElementById('collectionDialog').classList.contains('hidden')`, 'Bulk Add to collection failed');
  assert(await evaluate(`app.collections.find((item) => item.id === '${homeCollection}').slugs.length === 1 && app.selectedWatch.size === 0`), 'Bulk assignment replaced other memberships or retained the completed selection');
  assert(await evaluate(`(() => { const card=document.querySelector('#watchGrid [data-product-card="${collectionTestSlugs[0]}"]'); return ['Collection: Home network','Collection: Camera upgrade'].every(text=>[...card.querySelectorAll('.rule-chip')].some(badge=>badge.textContent===text)); })()`), 'An item in multiple collections did not label each membership');
  await evaluate(`app.selectedWatch=new Set(${JSON.stringify(collectionTestSlugs)}); renderProducts(true); document.getElementById('bulkAddCollection').click(); document.getElementById('newBulkCollection').click()`);
  assert(await evaluate("app.collectionDraft.slugs.size === 2 && document.getElementById('collectionSelection').textContent === '2 selected'"), 'Creating from bulk selection did not preselect the watches');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert(await evaluate("document.getElementById('collectionDialog').classList.contains('hidden') && app.selectedWatch.size === 2"), 'Escape saved bulk collection changes or lost the watch selection');
  await evaluate(`document.getElementById('openCollectionManager').click(); document.querySelector('[data-edit-collection="${cameraCollection}"]').click(); document.getElementById('collectionName').value='Camera upgrade edited'; document.querySelector('[data-collection-watch="${collectionTestSlugs[1]}"]').click(); document.getElementById('collectionForm').requestSubmit()`);
  await waitForBrowser(`app.collections.find((item) => item.id === '${cameraCollection}').name === 'Camera upgrade edited' && app.collections.find((item) => item.id === '${cameraCollection}').slugs.length === 1`, 'Editing membership and name together failed');
  assert(await evaluate(`document.querySelector('#watchGrid [data-product-card="${collectionTestSlugs[0]}"]').textContent.includes('Collection: Camera upgrade edited') && !document.querySelector('#watchGrid [data-product-card="${collectionTestSlugs[1]}"]').textContent.includes('Collection:')`), 'Collection badges did not update after renaming a collection and removing a member');
  await evaluate(`document.getElementById('closeCollectionManager').click(); const edit=document.querySelector('[data-collection-card="${cameraCollection}"] [data-edit-collection]'); edit.focus(); edit.click(); document.getElementById('askDeleteCollection').click()`);
  assert(await evaluate("document.activeElement.id === 'cancelDeleteCollection' && document.getElementById('collectionDeleteDescription').textContent.includes('watches, alert rules, and history will be kept')"), 'Delete confirmation did not explain retained watches or focus the safe action');
  await assertAccessible('Collection deletion confirmation');
  await evaluate("document.getElementById('cancelDeleteCollection').click()");
  assert(await evaluate("!document.getElementById('collectionForm').classList.contains('hidden') && document.activeElement.id === 'askDeleteCollection'"), 'Cancelling deletion did not restore the editor');
  await evaluate("document.getElementById('askDeleteCollection').click(); document.getElementById('confirmDeleteCollection').click()");
  await waitForBrowser("app.collections.length === 1 && !app.collectionBusy", 'Confirmed collection deletion failed');
  assert(await evaluate(`${JSON.stringify(collectionTestSlugs)}.every((slug) => app.products.some((product) => product.slug === slug && product.watched))`), 'Collection deletion removed watched products');
  assert(await evaluate(`document.getElementById('collectionDialog').classList.contains('hidden') && !document.querySelector('main').inert && document.activeElement.matches('#watchManageToggle') && !document.querySelector('[data-collection-card="${cameraCollection}"]')`), 'Deleting from a collection card reopened the manager or left focus on the removed card');
  await evaluate("app.selectedWatch.clear(); renderProducts(true)");
  // Collections share the product grid and keep large checklists out of the card.
  await evaluate(`(async () => {
    for (const product of app.products.filter((item) => !item.variantId)) await api('/api/watch',{method:'POST',body:JSON.stringify({slug:product.slug})});
    await api('/api/collections',{method:'POST',body:JSON.stringify({name:'Preview project'})});
    await refresh(); resetWatchFilters();
    window.previewCollectionId=app.collections.find((item) => item.name === 'Preview project').id;
    window.previewSlugs=app.products.filter((item) => item.watched && !item.variantId).slice(0,5).map((item) => item.slug);
  })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:1280,height:900,deviceScaleFactor:1,mobile:false });
  for (const count of [0,1,2,3,4,5]) {
    await evaluate(`api('/api/collections/'+window.previewCollectionId,{method:'PUT',body:JSON.stringify({slugs:window.previewSlugs.slice(0,${count})})}).then(() => refresh())`);
    assert(await evaluate(`(() => { const card=document.querySelector('[data-collection-card="'+window.previewCollectionId+'"]'); return card.querySelectorAll('.collection-preview-tile').length === ${Math.min(count,4)} && (card.querySelector('.collection-preview-more')?.textContent || '') === '${count > 4 ? '+1 more' : ''}' && !card.querySelector('details,progress,[data-notify-collection]'); })()`), `Collection preview for ${count} items was incorrect or expanded the card`);
  }
  const cardDimensions = await evaluate(`(() => {
    const card=document.querySelector('[data-collection-card="'+window.previewCollectionId+'"]');
    const product=document.querySelector('#watchGrid .watch-card');
    const a=card.getBoundingClientRect(),b=product.getBoundingClientRect();
    return { width:a.width,productWidth:b.width,height:a.height,productHeight:b.height,image:card.querySelector('.watch-image').getBoundingClientRect().height,productImage:product.querySelector('.watch-image').getBoundingClientRect().height,priceOffset:card.querySelector('.price').getBoundingClientRect().top-a.top,productPriceOffset:product.querySelector('.price').getBoundingClientRect().top-b.top };
  })()`);
  assert(Math.abs(cardDimensions.width-cardDimensions.productWidth) < 1 && Math.abs(cardDimensions.height-cardDimensions.productHeight) < 1 && cardDimensions.image === cardDimensions.productImage && Math.abs(cardDimensions.priceOffset-cardDimensions.productPriceOffset) < 1, `Collection card does not match product card dimensions/price position: ${JSON.stringify(cardDimensions)}`);
  assert(await evaluate("(() => { const collection=app.collections.find(item=>item.id===window.previewCollectionId); const card=document.querySelector('[data-collection-card=\"'+collection.id+'\"]'); return card.querySelector('.price').textContent === insightMoney(collection.pricing.total,'USD') && card.querySelector('.rule-chips').textContent.includes('Total for 5 units'); })()"), 'Collection total price was missing from the product price position');
  // Missing prices must be disclosed, rather than implying that the subtotal is complete.
  await evaluate("window.savedPreviewPricing={...app.collections.find(item=>item.id===window.previewCollectionId).pricing}; Object.assign(app.collections.find(item=>item.id===window.previewCollectionId).pricing,{total:123.45,priced:4,missing:1}); renderCollectionReadiness()");
  assert(await evaluate("(() => { const card=document.querySelector('[data-collection-card=\"'+window.previewCollectionId+'\"]'); return card.querySelector('.price').textContent.endsWith('+') && card.textContent.includes('1 item with unknown costs'); })()"), 'A partial collection total was presented as complete');
  await evaluate("app.collections.find(item=>item.id===window.previewCollectionId).pricing=window.savedPreviewPricing; renderCollectionReadiness()");
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:false });
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.collection-card').getBoundingClientRect().width === document.querySelector('.watch-card').getBoundingClientRect().width"), 'Collection cards overflowed or changed width on mobile');
    await assertAccessible(`Collection product cards ${theme}`);
  }
  await evaluate("document.querySelector('[data-collection-card=\"'+window.previewCollectionId+'\"] .collection-preview').focus(); document.activeElement.click()");
  assert(await evaluate("!document.getElementById('collectionDetails').classList.contains('hidden') && document.getElementById('collectionDialogTitle').textContent === 'Preview project'"), 'Collection Details did not open from its card');
  assert(await evaluate("!document.querySelector('#collectionDetails details, #collectionDetails [data-notify-collection], #collectionDetails .collection-alert-settings') && document.querySelectorAll('#collectionDetails .collection-member-row').length === 5 && [...document.querySelectorAll('#collectionDetails .collection-member-row')].every(row=>row.offsetHeight > 0 && row.querySelector('.collection-watch-image img, .collection-watch-image .image-placeholder') && row.querySelector('.collection-watch-copy strong').textContent && row.textContent.includes('$') && row.querySelector('.collection-member-status').textContent)"), 'Collection items were collapsed, missing their images/prices/status, or mixed with alert settings');
  await evaluate("document.querySelector('#collectionDetails .collection-watch-image img').dispatchEvent(new Event('error'))");
  assert(await evaluate("Boolean(document.querySelector('#collectionDetails [data-image-retry]'))"), 'A failed collection item image did not offer retry');
  assert(await evaluate("(() => { const button=document.querySelector('#collectionDetails [data-image-retry]').closest('button'); button.click(); return Boolean(button.querySelector('img')); })()"), 'Retrying a collection item image did not reload it');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await assertAccessible(`Collection item rows ${theme}`);
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth + 1"), 'Collection item rows overflowed at 390px');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640,height:450,screenWidth:1280,screenHeight:900,deviceScaleFactor:2,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Collection item rows overflowed at 200% equivalent zoom');
  await evaluate("document.querySelector('#collectionDetails [data-collection-alerts]').focus(); document.activeElement.click()");
  assert(await evaluate("!document.getElementById('collectionAlerts').classList.contains('hidden') && document.getElementById('collectionDetails').classList.contains('hidden') && document.activeElement.matches('[data-notify-collection]')"), 'The bottom Alerts action did not open separate alert settings');
  await evaluate("document.querySelector('[data-close-collection-alerts]').click()");
  assert(await evaluate("!document.getElementById('collectionDetails').classList.contains('hidden') && document.activeElement.matches('#collectionDetails [data-collection-alerts]')"), 'Returning from alerts did not restore collection details and focus');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert(await evaluate("document.activeElement.closest('[data-collection-card]')?.dataset.collectionCard === window.previewCollectionId"), 'Closing collection details lost card focus');
  await evaluate("renderCollectionReadiness(true)");
  assert(await evaluate("document.activeElement.matches('.collection-card .collection-preview')"), 'Refreshing collection cards changed the focused action');
  await evaluate("document.getElementById('openCollectionManager').focus(); document.getElementById('openCollectionManager').click(); document.querySelector('[data-collection-row=\"'+window.previewCollectionId+'\"] [data-collection-alerts]').focus(); renderCollections(true)");
  assert(await evaluate("document.activeElement.textContent === 'Alerts' && document.activeElement.dataset.collectionAlerts === window.previewCollectionId"), 'Manage collections did not expose Alerts or preserve its keyboard focus on refresh');
  await assertAccessible('Collection manager with Alerts actions');
  await evaluate("document.activeElement.click()");
  assert(await evaluate("document.querySelector('[data-notify-collection]').dataset.notifyCollection === window.previewCollectionId && !document.getElementById('collectionAlerts').classList.contains('hidden') && document.getElementById('collectionDetails').classList.contains('hidden')"), 'Manage collections Alerts opened the wrong collection');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert(await evaluate("document.activeElement.dataset.collectionAlerts === window.previewCollectionId && !document.getElementById('collectionOverview').classList.contains('hidden')"), 'Closing alerts did not return to Manage collections');
  await evaluate("document.getElementById('closeCollectionManager').click()");
  assert(await evaluate("document.activeElement.matches('#watchManageToggle') && !document.querySelector('main').inert"), 'Closing Manage collections did not restore page focus');
  await evaluate("document.querySelector('[data-collection-card=\"'+window.previewCollectionId+'\"] [data-edit-collection]').click()");
  assert(await evaluate("app.collectionDraft.id === window.previewCollectionId && !document.getElementById('collectionForm').classList.contains('hidden')"), 'Edit did not open the selected collection from its card');
  await evaluate("document.getElementById('collectionName').value='Unsaved preview name'; document.querySelector('[data-collection-watch=\"'+window.previewSlugs[0]+'\"]').click(); document.getElementById('collectionWatchSearch').value=window.previewSlugs[0]; document.getElementById('collectionWatchSearch').dispatchEvent(new Event('input')); window.collectionEditorSnapshot=JSON.stringify([document.getElementById('collectionName').value,document.getElementById('collectionWatchSearch').value,[...app.collectionDraft.slugs]]); document.getElementById('editCollectionAlerts').click()");
  assert(await evaluate("!document.getElementById('collectionAlerts').classList.contains('hidden') && document.getElementById('collectionForm').classList.contains('hidden') && document.querySelector('[data-close-collection-alerts]').textContent === 'Back to editing'"), 'The editor did not provide a separate Alerts view with a return action');
  await assertAccessible('Collection alerts from editor');
  await evaluate("document.querySelector('[data-notify-collection]').click()");
  await waitForBrowser("app.collections.find(item=>item.id===window.previewCollectionId).notifyReady && document.activeElement.matches('[data-notify-collection]')", 'Collection alerts did not save from the editor');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert(await evaluate("window.collectionEditorSnapshot === JSON.stringify([document.getElementById('collectionName').value,document.getElementById('collectionWatchSearch').value,[...app.collectionDraft.slugs]]) && document.activeElement.id === 'editCollectionAlerts' && !document.getElementById('collectionForm').classList.contains('hidden') && app.collections.find(item=>item.id===window.previewCollectionId).name === 'Preview project' && app.collections.find(item=>item.id===window.previewCollectionId).slugs.length === 5"), 'Returning from alerts lost or silently saved the collection draft');
  await evaluate("document.getElementById('editCollectionAlerts').click(); document.querySelector('[data-close-collection-alerts]').click()");
  assert(await evaluate("document.activeElement.id === 'editCollectionAlerts' && document.getElementById('collectionName').value === 'Unsaved preview name'"), 'Back to editing lost the draft or keyboard focus');
  await evaluate("document.getElementById('closeCollectionManager').click(); document.querySelector('[data-collection-card=\"'+window.previewCollectionId+'\"] [data-view-collection]').click()");
  assert(await evaluate("document.getElementById('watchCollection').value === window.previewCollectionId && document.querySelectorAll('.collection-card').length === 1"), 'View items did not filter the selected collection');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640,height:450,screenWidth:1280,screenHeight:900,deviceScaleFactor:2,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Collection cards overflowed at 200% equivalent zoom');
  // Grouping is a saved display preference; watches and their rules remain intact.
  const groupedCollectionId = await evaluate("window.previewCollectionId");
  const groupedMemberSlug = await evaluate("app.collections.find(item=>item.id===window.previewCollectionId).slugs[0]");
  await evaluate("resetWatchFilters(); window.groupingWatchSnapshot=JSON.stringify(app.products.filter(item=>item.watched).map(({slug,watchRule,collections})=>({slug,watchRule,collections}))); app.selectedWatch=new Set(app.products.filter(item=>item.watched).map(item=>item.slug)); renderProducts(true)");
  assert(await evaluate("!document.getElementById('groupCollectedWatches').checked"), 'Collection grouping unexpectedly changed the existing default view');
  await evaluate("document.getElementById('groupCollectedWatches').focus(); document.getElementById('groupCollectedWatches').click()");
  assert(await evaluate("document.querySelectorAll('#watchGrid .watch-card').length === app.products.filter(item=>item.watched && !item.collections.length).length && [...app.selectedWatch].every(slug=>!app.products.find(item=>item.slug===slug).collections.length) && document.querySelectorAll('.collection-card').length === app.collections.length"), 'Grouping left duplicate cards or selected hidden members');
  assert(await evaluate("window.groupingWatchSnapshot === JSON.stringify(app.products.filter(item=>item.watched).map(({slug,watchRule,collections})=>({slug,watchRule,collections}))) && Number(document.getElementById('watchCount').textContent) === app.products.filter(item=>item.watched).length"), 'Grouping changed watch data or the total monitored count');
  await evaluate("document.getElementById('selectVisibleWatches').click()");
  assert(await evaluate("[...app.selectedWatch].every(slug=>!app.products.find(item=>item.slug===slug).collections.length)"), 'Select visible watches included hidden collection members');
  await reloadBrowserPage();
  await waitForBrowser("app.collections.length > 0 && document.getElementById('groupCollectedWatches').checked && document.getElementById('watchCollection').value === 'all'", 'The grouping preference did not survive reload');
  assert(await evaluate("document.querySelectorAll('#watchGrid .watch-card').length === app.products.filter(item=>item.watched && !item.collections.length).length"), 'Reload displayed duplicate collection members');
  await evaluate(`document.querySelector('[data-collection-card="${groupedCollectionId}"] [data-view-collection]').click()`);
  assert(await evaluate(`document.getElementById('watchCollection').value === '${groupedCollectionId}' && document.querySelectorAll('#watchGrid .watch-card').length === app.collections.find(item=>item.id==='${groupedCollectionId}').slugs.length && document.getElementById('groupCollectedWatches').checked`), 'Opening a grouped collection did not reveal its members');
  await evaluate(`resetWatchFilters(); document.getElementById('watchSearch').value='${groupedMemberSlug}'; document.getElementById('watchSearch').dispatchEvent(new Event('input'))`);
  assert(await evaluate(`Boolean(document.querySelector('[data-collection-card="${groupedCollectionId}"]')) && !document.querySelector('#watchGrid [data-product-card="${groupedMemberSlug}"]')`), 'Searching for a grouped item did not retain its collection card');
  await evaluate("document.getElementById('watchSearch').value='Preview project'; document.getElementById('watchSearch').dispatchEvent(new Event('input'))");
  assert(await evaluate(`document.querySelectorAll('.collection-card').length === 1 && document.querySelector('.collection-card').dataset.collectionCard === '${groupedCollectionId}'`), 'Searching by collection name did not find the folder');
  await evaluate("document.getElementById('watchSearch').value='no-such-grouped-item'; document.getElementById('watchSearch').dispatchEvent(new Event('input'))");
  assert(await evaluate("!document.getElementById('watchEmpty').classList.contains('hidden') && !document.getElementById('resetWatchEmpty').classList.contains('hidden')"), 'A grouped search with no matches did not offer a reset');
  await evaluate("document.getElementById('resetWatchEmpty').click()");
  assert(await evaluate("document.getElementById('groupCollectedWatches').checked && document.querySelectorAll('.collection-card').length === app.collections.length"), 'Reset filters discarded the grouping preference');
  const ungroupedSlug = await evaluate("app.products.find(item=>item.watched && !item.collections.length).slug");
  const groupingFolders = await evaluate(`(async()=>{ const ids=[]; for(const name of ['Grouping first','Grouping second']) ids.push((await api('/api/collections',{method:'POST',body:JSON.stringify({name,slugs:['${ungroupedSlug}']})})).id); await refresh(); return ids; })()`);
  assert(await evaluate(`!document.querySelector('#watchGrid [data-product-card="${ungroupedSlug}"]')`), 'Adding a watch to collections left its duplicate card visible');
  await evaluate(`api('/api/collections/${groupingFolders[0]}',{method:'DELETE'}).then(()=>refresh())`);
  assert(await evaluate(`!document.querySelector('#watchGrid [data-product-card="${ungroupedSlug}"]')`), 'Removing one of two memberships exposed a duplicate card');
  await evaluate(`api('/api/collections/${groupingFolders[1]}',{method:'DELETE'}).then(()=>refresh())`);
  assert(await evaluate(`Boolean(document.querySelector('#watchGrid [data-product-card="${ungroupedSlug}"]')) && app.products.find(item=>item.slug==='${ungroupedSlug}').watched`), 'Removing the last collection did not restore its watched item');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:false });
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Grouping controls overflowed the mobile Watchlist');
    await assertAccessible(`Grouped Watchlist ${theme}`);
  }
  await evaluate("document.getElementById('groupCollectedWatches').click()");
  assert(await evaluate("document.querySelectorAll('#watchGrid .watch-card').length === app.products.filter(item=>item.watched).length"), 'Turning grouping off did not restore all watched item cards');
  // Purchase planning and collection-only alerts are editable entirely from collection rows.
  await evaluate("resetWatchFilters(); document.getElementById('openCollectionManager').focus(); document.getElementById('openCollectionManager').click(); document.getElementById('newCollection').click(); document.getElementById('collectionName').value='Purchase test'; document.getElementById('collectionBudget').value='2000'; document.querySelector('[data-collection-watch=\"udm-se\"]').click(); document.getElementById('collectionForm').requestSubmit()");
  await waitForBrowser("app.collections.some(item=>item.name==='Purchase test' && item.budget===2000) && !app.collectionBusy", 'Collection budget did not save');
  const purchaseCollectionId=await evaluate("app.collections.find(item=>item.name==='Purchase test').id");
  await evaluate(`document.getElementById('closeCollectionManager').click(); document.querySelector('[data-collection-card="${purchaseCollectionId}"] .collection-preview').focus(); document.activeElement.click(); document.querySelector('#collectionDetails [data-collection-item-edit="udm-se"]').click()`);
  assert(await evaluate("!document.getElementById('collectionItemForm').classList.contains('hidden') && document.activeElement.id==='collectionItemQuantity' && document.querySelector('#collectionItemSummary img')"), 'Edit item did not open quantity, purchase, and target controls with its image');
  await evaluate("(() => { const image=document.querySelector('#collectionItemSummary img'); image.dispatchEvent(new Event('error')); const button=document.querySelector('#collectionItemSummary [data-image-retry]').closest('button'); button.click(); })()");
  assert(await evaluate("Boolean(document.querySelector('#collectionItemSummary img'))"), 'Purchase form image retry did not reload its thumbnail');
  await evaluate("document.getElementById('collectionItemQuantity').value='3'; document.getElementById('collectionItemPurchased').value='1'; document.getElementById('collectionItemPaid').value='400'; document.getElementById('collectionItemTarget').value='450'; document.getElementById('collectionItemForm').requestSubmit()");
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${purchaseCollectionId}').planning.purchasedQuantity===1 && !document.getElementById('collectionDetails').classList.contains('hidden')`, 'Partial purchase did not save or return to the collection');
  assert(await evaluate(`(() => { const plan=app.collections.find(item=>item.id==='${purchaseCollectionId}'); return plan.planning.quantity===3 && plan.planning.spent===400 && plan.planning.remainingCost===998 && plan.pricing.total===1398 && plan.planning.budgetDifference===602 && app.products.find(item=>item.slug==='udm-se').watchRule.targetPrice===450 && document.querySelector('#collectionDetails .collection-plan-summary').textContent.includes('$998.00'); })()`), 'Collection planning totals, budget, or shared target did not update');
  assert(await evaluate("document.querySelector('#collectionDetails .collection-member-actions a').href.startsWith('https://store.ui.com/') && document.activeElement.dataset.collectionItemEdit==='udm-se'"), 'Item actions lost the Store link or focus');
  assert(await evaluate("(() => { const sizes=[...document.querySelector('#collectionDetails .collection-member-actions').children].map(node=>node.getBoundingClientRect().height); return Math.max(...sizes)-Math.min(...sizes)<1; })()"), 'Collection action buttons did not use consistent heights');
  await evaluate(`(() => { const collection=app.collections.find(item=>item.id==='${purchaseCollectionId}'); const row=collection.readiness.items.find(item=>item.slug==='udm-se'); window.originalCollectionUnitPrice=row.unitPrice; row.unitPrice=1234.56; document.querySelector('#collectionDetails [data-collection-item-purchase="udm-se"]').click(); })()`);
  assert(await evaluate("document.getElementById('collectionItemPaid').value==='2869.12'"), 'Purchase suggestion ignored the server-normalized unit price');
  await evaluate(`document.getElementById('cancelCollectionItem').click(); app.collections.find(item=>item.id==='${purchaseCollectionId}').readiness.items.find(item=>item.slug==='udm-se').unitPrice=window.originalCollectionUnitPrice`);
  await evaluate("document.querySelector('#collectionDetails [data-collection-item-purchase=\"udm-se\"]').click()");
  assert(await evaluate("document.getElementById('collectionItemPurchased').value==='3' && document.getElementById('collectionItemPaid').value==='1398' && document.activeElement.id==='collectionItemPaid'"), 'Record purchase did not offer the remaining quantity and editable total cost');
  await evaluate("document.getElementById('collectionItemPaid').value='1200'; document.getElementById('collectionItemForm').requestSubmit()");
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${purchaseCollectionId}').planning.spent===1200`, 'Actual purchase cost did not save');
  assert(await evaluate(`app.collections.find(item=>item.id==='${purchaseCollectionId}').planning.remainingCost===0 && app.collections.find(item=>item.id==='${purchaseCollectionId}').readiness.purchased===1 && !app.products.find(item=>item.slug==='udm-se').watchRule.purchasedAt`), 'Completing a project purchase changed the shared watch or left remaining costs');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await assertAccessible(`Purchase plan ${theme}`);
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth+1 && document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth+1"), 'Purchase planning rows overflowed on mobile');
  }
  await evaluate("document.querySelector('#collectionDetails [data-collection-item-edit=\"udm-se\"]').click()");
  await assertAccessible('Collection item purchase form');
  assert(await evaluate("document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth+1"), 'Purchase entry fields overflowed on mobile');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:450,deviceScaleFactor:2,mobile:false});
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth+1 && document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth+1"), 'Purchase entry overflowed at 200% equivalent zoom');
  await evaluate("document.getElementById('collectionItemPaid').value='5'; document.getElementById('cancelCollectionItem').click()");
  assert(await evaluate(`app.collections.find(item=>item.id==='${purchaseCollectionId}').planning.spent===1200`), 'Cancel saved item purchase edits');
  await evaluate("document.querySelector('#collectionDetails [data-collection-alerts]').click(); document.querySelector('[data-notify-collection]').click()");
  await waitForBrowser(`app.collections.find(item=>item.id==='${purchaseCollectionId}').notifyReady && !document.querySelector('[data-notify-collection]').disabled`, 'Purchase collection alerts did not enable');
  await evaluate("document.querySelector('[data-collection-alert-mode]').value='only'; document.querySelector('[data-collection-alert-mode]').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitForBrowser(`app.collections.find(item=>item.id==='${purchaseCollectionId}').alertsOnly && document.activeElement.matches('[data-collection-alert-mode]')`, 'Collection-only alert mode did not save or retain focus');
  await assertAccessible('Collection-only alert mode');
  await evaluate("document.querySelector('[data-close-collection-alerts]').click()");
  assert(await evaluate("document.querySelector('#collectionDetails .collection-member-plan').textContent.includes('Item alerts suppressed by: Purchase test') && document.querySelector('#watchGrid [data-product-card=\"udm-se\"]').textContent.includes('Individual alerts suppressed by Purchase test')"), 'The effective collection alert override was not visible on the item');
  await evaluate("document.querySelector('#collectionDetails [data-collection-item-remove=\"udm-se\"]').click()");
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${purchaseCollectionId}').slugs.length===0`, 'Remove did not remove the item from its collection');
  assert(await evaluate("app.products.find(item=>item.slug==='udm-se').watched && !document.getElementById('collectionDetails').classList.contains('hidden') && document.querySelector('#collectionDetails .collection-no-watches') && !document.querySelector('#watchGrid [data-product-card=\"udm-se\"]').textContent.includes('Individual alerts suppressed by Purchase test')"), 'Removing a collection item lost its watch, left an override, or reopened the manager');
  await evaluate("document.getElementById('closeCollectionManager').click()");
  // Add from Browse, preserve existing plans, filter by readiness, and archive/undo through real controls.
  await evaluate("activateTab('browse'); resetBrowseFilters(); document.querySelector('#browseGrid [data-add-watch=\"uvc-g5-ptz\"]').focus(); document.activeElement.click()");
  await waitForBrowser("!document.getElementById('saveAddWatch').disabled && document.getElementById('addWatchVariant').options.length===3", 'Add picker did not load the product variants');
  await evaluate("document.getElementById('addWatchVariant').value='uvc-g5-ptz::mock-white'; document.getElementById('addWatchVariant').dispatchEvent(new Event('change')); document.getElementById('addWatchDestination').value='new'; document.getElementById('addWatchDestination').dispatchEvent(new Event('change')); document.getElementById('addWatchName').value='Browse project'; document.getElementById('addWatchQuantity').value='4'");
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await assertAccessible(`Browse collection destination ${theme}`);
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth+1 && document.querySelector('.collection-panel').scrollWidth <= document.querySelector('.collection-panel').clientWidth+1"), 'Add destination form overflowed at 390px');
  }
  await evaluate("document.getElementById('addWatchForm').requestSubmit()");
  await waitForBrowser("!app.collectionBusy && app.collections.some(item=>item.name==='Browse project') && document.getElementById('collectionDialog').classList.contains('hidden')", 'Direct Browse add did not save and close');
  const workflowCollection=await evaluate("app.collections.find(item=>item.name==='Browse project').id");
  assert(await evaluate(`app.collections.find(item=>item.id==='${workflowCollection}').items[0].quantity===4 && app.products.find(item=>item.slug==='uvc-g5-ptz::mock-white').watched && document.activeElement.dataset.addWatch==='uvc-g5-ptz'`), 'Direct add lost its quantity, selected variant, or Browse focus');
  await evaluate(`activateTab('watchlist'); resetWatchFilters(); document.querySelector('[data-collection-card="${workflowCollection}"] .collection-preview').click(); document.querySelector('#collectionDetails [data-collection-item-edit]').click(); document.getElementById('collectionItemPurchased').value='1'; document.getElementById('collectionItemPaid').value='300'; document.getElementById('collectionItemTarget').value='400'; document.getElementById('collectionItemForm').requestSubmit()`);
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${workflowCollection}').planning.spent===300`, 'Workflow purchase record did not save');
  await evaluate("document.querySelector('#collectionDetails [data-collection-item-remove]').click()");
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${workflowCollection}').items.length===0`, 'Workflow removal failed');
  const undoKey=await evaluate(`app.collectionUndos.find(item=>item.id==='${workflowCollection}').key`);
  await assertAccessible('Collection removal Undo');
  await evaluate(`document.querySelector('[data-undo-collection="${undoKey}"]').click()`);
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${workflowCollection}').items.length===1`, 'Undo did not restore the collection item');
  assert(await evaluate(`(() => { const item=app.collections.find(item=>item.id==='${workflowCollection}').items[0]; return item.quantity===4 && item.purchasedQuantity===1 && item.paidTotal===300 && document.activeElement.dataset.collectionItemEdit==='uvc-g5-ptz::mock-white'; })()`), 'Undo lost quantities, payment, or keyboard focus');
  await evaluate("document.getElementById('closeCollectionManager').click(); activateTab('browse'); document.querySelector('#browseGrid [data-add-watch=\"uvc-g5-ptz\"]').click()");
  await waitForBrowser("!document.getElementById('saveAddWatch').disabled", 'Repeated Add picker did not load');
  await evaluate(`document.getElementById('addWatchVariant').value='uvc-g5-ptz::mock-white'; document.getElementById('addWatchDestination').value='${workflowCollection}'; document.getElementById('addWatchDestination').dispatchEvent(new Event('change'))`);
  assert(await evaluate("document.getElementById('addWatchHint').textContent.includes('Already in this collection') && document.getElementById('addWatchQuantity').disabled && document.getElementById('addWatchQuantity').value==='4'"), 'Existing collection membership was not clearly identified');
  await evaluate("document.getElementById('addWatchForm').requestSubmit()");
  await waitForBrowser("document.getElementById('collectionDialog').classList.contains('hidden') && !app.collectionBusy", 'Repeated Add did not complete');
  assert(await evaluate(`app.collections.find(item=>item.id==='${workflowCollection}').items[0].paidTotal===300`), 'Repeated Add erased the purchase record');
  await evaluate("activateTab('watchlist'); document.getElementById('groupCollectedWatches').checked=true; document.querySelector('[data-watch-overview=\"target\"]').click()");
  assert(await evaluate("app.watchQuickFilter==='target' && document.querySelector('[data-watch-overview=\"target\"]').getAttribute('aria-pressed')==='true' && document.querySelectorAll('#watchGrid .watch-card').length===app.watchOverview.targetMet.length && document.querySelectorAll('#collectionReadiness .collection-card').length===0"), 'Overview count did not open exactly its matching items through grouped mode');
  await reloadBrowserPage();
  await waitForBrowser("app.watchQuickFilter==='target' && app.watchOverview && document.querySelectorAll('#watchGrid .watch-card').length===app.watchOverview.targetMet.length", 'Overview filter did not survive reload');
  await evaluate("document.querySelector('[data-watch-overview=\"collections\"]').click()");
  assert(await evaluate("document.querySelectorAll('#collectionReadiness .collection-card').length===app.watchOverview.collectionsReady.length && document.querySelectorAll('#watchGrid .watch-card').length===0"), 'Collections-ready overview included individual cards or waiting collections');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:450,deviceScaleFactor:2,mobile:false});
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth+1"), 'Watchlist overview overflowed at 200% equivalent zoom');
  await assertAccessible('Actionable Watchlist overview');
  await evaluate(`document.querySelector('[data-collection-card="${workflowCollection}"] [data-collection-alerts]').click(); document.querySelector('[data-notify-collection]').click()`);
  await waitForBrowser(`app.collections.find(item=>item.id==='${workflowCollection}').notifyReady && !document.querySelector('[data-notify-collection]').disabled`, 'Workflow collection alerts did not enable');
  await evaluate("document.querySelector('[data-collection-alert-mode]').value='only'; document.querySelector('[data-collection-alert-mode]').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitForBrowser(`app.collections.find(item=>item.id==='${workflowCollection}').alertsOnly && !document.querySelector('[data-collection-alert-mode]').disabled`, 'Workflow override did not save');
  await evaluate(`document.getElementById('closeCollectionManager').click(); resetWatchFilters(); document.querySelector('[data-collection-card="${workflowCollection}"] [data-edit-collection]').click(); document.getElementById('archiveCollection').click()`);
  await waitForBrowser(`!app.collectionBusy && app.collections.find(item=>item.id==='${workflowCollection}').archived && document.getElementById('collectionDialog').classList.contains('hidden')`, 'Archive did not save or close the editor');
  assert(await evaluate(`!document.querySelector('[data-collection-card="${workflowCollection}"]') && !app.watchOverview.collectionsReady.includes('${workflowCollection}') && collectionAlertSources(app.products.find(item=>item.slug==='uvc-g5-ptz::mock-white')).length===0`), 'Archive remained in active cards, ready counts, or item-alert overrides');
  await evaluate("document.getElementById('openCollectionManager').click(); document.getElementById('collectionArchiveFilter').value='archived'; document.getElementById('collectionArchiveFilter').dispatchEvent(new Event('change'))");
  await assertAccessible('Archived collection manager');
  await evaluate(`document.querySelector('#collectionList [data-view-collection="${workflowCollection}"]').click()`);
  assert(await evaluate(`document.getElementById('watchCollection').value==='${workflowCollection}' && document.querySelector('[data-collection-card="${workflowCollection}"] .badge').textContent==='Archived'`), 'Archived collection could not be opened from the manager');
  await evaluate(`document.querySelector('[data-collection-card="${workflowCollection}"] [data-edit-collection]').click(); document.getElementById('archiveCollection').click()`);
  await waitForBrowser(`!app.collectionBusy && !app.collections.find(item=>item.id==='${workflowCollection}').archived`, 'Restore did not reactivate the archived collection');
  assert(await evaluate(`app.collections.find(item=>item.id==='${workflowCollection}').items[0].paidTotal===300 && collectionAlertSources(app.products.find(item=>item.slug==='uvc-g5-ptz::mock-white')).some(item=>item.id==='${workflowCollection}')`), 'Restore lost purchase records or saved alert mode');
  await evaluate("resetWatchFilters(); document.getElementById('groupCollectedWatches').checked=false; document.getElementById('collectionArchiveFilter').value='active'; renderProducts(true)");

  // Named views are persisted by the server; layout and dialogs remain accessible.
  await evaluate("resetWatchFilters(); document.getElementById('watchLayout').value='compact'; document.getElementById('watchLayout').dispatchEvent(new Event('change')); document.querySelector('[data-save-view=watchlist]').focus(); document.querySelector('[data-save-view=watchlist]').click()");
  assert(await evaluate("document.getElementById('ownerDialog').open && document.activeElement.id==='savedViewName'"), 'Saved view dialog did not open with name focus');
  await assertAccessible('Save named Watchlist view');
  await evaluate("document.getElementById('savedViewName').value='Daily <view>'; document.getElementById('savedViewForm').requestSubmit()");
  await waitForBrowser("app.savedViews.some(view=>view.name==='Daily <view>') && !document.getElementById('ownerDialog').open", 'View did not save');
  assert(await evaluate("document.activeElement.matches('#watchViewToggle')"), 'Saving did not restore focus');
  const savedView = await evaluate("app.savedViews.find(view=>view.name==='Daily <view>').id");
  await evaluate(`document.getElementById('watchLayout').value='cards'; document.getElementById('watchLayout').dispatchEvent(new Event('change')); document.getElementById('watchSavedView').value='${savedView}'; document.getElementById('watchSavedView').dispatchEvent(new Event('change'))`);
  assert(await evaluate("document.getElementById('watchLayout').value==='compact' && document.getElementById('watchlistCards').classList.contains('compact-list')"), 'Applying a saved view did not restore its layout');
  await evaluate("document.querySelector('[data-manage-views=watchlist]').click(); document.querySelector('[data-view-edit]').click(); document.getElementById('savedViewName').value='Daily compact'; document.getElementById('savedViewForm').requestSubmit()");
  await waitForBrowser("app.savedViews.some(view=>view.name==='Daily compact') && !document.getElementById('ownerDialog').open", 'Renaming a saved view failed');
  await evaluate("window.originalViewApi=api; api=async(path,options)=>{ const result=await window.originalViewApi(path,options); if(path==='/api/views' && options?.method==='POST') await new Promise(resolve=>window.finishViewSave=resolve); return result; }; document.querySelector('[data-save-view=watchlist]').click(); document.getElementById('savedViewName').value='Z delayed save'; document.getElementById('savedViewForm').requestSubmit()");
  await waitForBrowser("Boolean(window.finishViewSave)", 'Delayed save fixture did not reach the server');
  await evaluate("document.getElementById('closeOwnerDialog').click()");
  await waitForBrowser("app.viewDraft===null", 'Closing an in-progress view did not clear its draft');
  await evaluate("document.querySelector('[data-save-view=watchlist]').click(); document.getElementById('savedViewName').value='Unsaved next view'; window.finishViewSave()");
  await waitForBrowser("app.savedViews.some(view=>view.name==='Z delayed save')", 'Completed save was not reflected in the view list');
  assert(await evaluate("document.getElementById('ownerDialog').open && document.getElementById('savedViewName').value==='Unsaved next view'"), 'An earlier save closed or overwrote a newer dialog');
  await evaluate("api=window.originalViewApi; document.getElementById('closeOwnerDialog').click()");
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme('${theme}'); renderProducts(true)`); await delay(250);
    for (const width of [1280,390,640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:width===640?2:1,mobile:false});
      assert(await evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"), `Compact layout overflowed at ${width}px`);
      assert(await evaluate("[...document.querySelectorAll('.compact-list .watch-card')].every(card=>card.querySelector('.watch-image').getBoundingClientRect().width>=60 && card.querySelector('.price') && card.querySelectorAll('.card-actions button').length===3)"), 'Compact rows lost product previews, prices or actions');
      if (screenshotRoot) {
        await evaluate("document.getElementById('watchlistCards').scrollIntoView({block:'start'})");
        const capture=await cdp.send('Page.captureScreenshot',{format:'png'});
        await writeFile(join(screenshotRoot,`compact-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
      }
    }
    await assertAccessible(`Compact Watchlist ${theme}`);
    await evaluate("document.querySelector('[data-alert-explain=watch]').focus(); document.querySelector('[data-alert-explain=watch]').click()");
    await waitForBrowser("document.querySelector('.alert-explanation')", 'Alert explanation did not load');
    assert(await evaluate("document.getElementById('ownerDialogBody').textContent.includes('Actual notification jobs') && document.getElementById('ownerDialogBody').textContent.includes('Saving a rule does not create a notification job')"), 'Explanation confused enabled rules with deliveries');
    await assertAccessible(`Alert explanation ${theme}`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitForBrowser("!document.getElementById('ownerDialog').open", 'Escape did not dismiss alert explanation');
    assert(await evaluate("document.activeElement.matches('[data-alert-explain=watch]')"), 'Alert explanation did not restore focus');
  }
  await evaluate("document.querySelector('#watchGrid [data-product-detail]').click()");
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.querySelector('#productRuleForm [data-alert-explain]')", 'Product alert rules did not open');
  await evaluate("document.querySelector('#productRuleForm [data-alert-explain]').focus(); document.activeElement.click()");
  await waitForBrowser("document.querySelector('.alert-explanation')", 'Nested alert explanation did not load');
  await assertAccessible('Alert explanation over product rules');
  await evaluate("document.getElementById('closeOwnerDialog').click()");
  await waitForBrowser("!document.getElementById('ownerDialog').open && document.activeElement.matches('#productRuleForm [data-alert-explain]')", 'Nested explanation lost focus in product rules');
  await evaluate("document.getElementById('closeProductDialog').click(); document.querySelector('[data-manage-views=watchlist]').click(); document.querySelector('[data-view-delete]').click()");
  await waitForBrowser("!app.savedViews.some(view=>view.name==='Daily compact')", 'Deleting a saved view failed');
  await evaluate("document.getElementById('closeOwnerDialog').click(); document.getElementById('watchLayout').value='cards'; document.getElementById('watchLayout').dispatchEvent(new Event('change')); activateTab('browse'); document.getElementById('search').value='G5'; document.getElementById('search').dispatchEvent(new Event('input')); document.querySelector('[data-save-view=browse]').click(); document.getElementById('savedViewName').value='Browse cameras'; document.getElementById('savedViewForm').requestSubmit()");
  await waitForBrowser("app.savedViews.some(view=>view.scope==='browse') && !document.getElementById('ownerDialog').open", 'Browse view did not save');
  await evaluate("document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input')); document.getElementById('browseSavedView').value=app.savedViews.find(view=>view.scope==='browse').id; document.getElementById('browseSavedView').dispatchEvent(new Event('change'))");
  assert(await evaluate("document.getElementById('search').value==='G5'"), 'Browse view did not restore search');
  await evaluate("document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input')); activateTab('watchlist')");
  // Paginate more than 100 real API entries in the isolated browser fixture.
  await evaluate(`(async () => {
    const backup = await api('/api/data/export');
    backup.regions.us.events = Array.from({ length:115 }, (_, index) => ({
      id:'pagination-' + index, region:'us', type:'restock', alertKind:'restock',
      slug:'pagination-product-' + index, name:'Pagination fixture ' + index,
      detectedAt:new Date(Date.now() - index * 1000).toISOString(), status:'Available', watchedAtDetection:false
    }));
    await api('/api/data/import', { method:'POST', body:JSON.stringify({ backup }) });
    activateTab('activity'); resetActivityFilters();
  })()`);
  await waitForBrowser("app.activity.count === 115 && app.activity.limit === 20 && document.querySelectorAll('#activityList .event').length === 20", 'Default Activity page did not show only the first 20 entries');
  assert(await evaluate("app.activity.pages === 6 && document.getElementById('activityPrevious').disabled && !document.getElementById('activityNext').disabled"), 'Default Activity pagination controls are incorrect');
  const firstActivityIds = await evaluate("app.activity.events.map((event) => event.id)");
  await evaluate("document.getElementById('activityNext').click()");
  await waitForBrowser("app.activity.page === 2 && document.getElementById('activityResultCount').textContent === 'Showing 21–40 of 115 events'", 'Next did not show the second Activity page');
  const secondActivityIds = await evaluate('app.activity.events.map((event) => event.id)');
  assert(secondActivityIds.every((id) => !firstActivityIds.includes(id)), 'Activity repeated first-page entries on the next page');
  for (const size of [50,100]) {
    await evaluate(`(() => { const picker=document.getElementById('activityPageSize'); picker.focus(); picker.value='${size}'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitForBrowser(`app.activity.limit === ${size} && app.activity.page === 1 && document.querySelectorAll('#activityList .event').length === ${size}`, `Activity did not apply the ${size}-entry limit and reset to page 1`);
    assert(await evaluate("document.activeElement.id === 'activityPageSize'"), 'Changing Activity page size lost keyboard focus');
    await evaluate("document.getElementById('activityNext').click()");
    await waitForBrowser(`app.activity.page === 2 && document.querySelectorAll('#activityList .event').length === ${size === 50 ? 50 : 15}`, 'Activity last-page size was incorrect');
  }
  assert(await evaluate("document.getElementById('activityNext').disabled && !document.getElementById('activityPrevious').disabled"), 'Activity did not stop at its last page');
  await evaluate("document.getElementById('activityPrevious').click()");
  await waitForBrowser("app.activity.page === 1 && document.querySelectorAll('#activityList .event').length === 100", 'Previous did not restore the first Activity page');
  await reloadBrowserPage();
  await waitForBrowser("app.activity.loaded && app.activity.limit === 100 && document.getElementById('activityPageSize').value === '100'", 'Activity page size did not survive reload');
  await evaluate("document.getElementById('activityNext').click()");
  await waitForBrowser("app.activity.page === 2 && app.activity.events.length === 15", 'Saved Activity page size was not used for navigation');
  await evaluate("document.getElementById('activitySearch').value='Pagination fixture 114'; document.getElementById('activityFilters').requestSubmit()");
  await waitForBrowser("app.activity.count === 1 && app.activity.page === 1 && app.activity.limit === 100", 'Activity filters did not reset pagination while preserving the selected size');
  await evaluate("resetActivityFilters()");
  await waitForBrowser("app.activity.count === 115 && app.activity.limit === 100 && app.activity.page === 1", 'Resetting Activity filters changed the preferred page size');
  // A slow earlier request must not overwrite a newer page-size choice.
  await evaluate(`(() => {
    window.paginationOriginalFetch=window.fetch;
    window.paginationRelease=null;
    window.fetch=async (...args) => {
      const response=await window.paginationOriginalFetch(...args);
      if (String(args[0]).includes('/api/activity?') && new URL(String(args[0]),location.origin).searchParams.get('limit') === '50') await new Promise((resolve) => { window.paginationRelease=resolve; });
      return response;
    };
    const picker=document.getElementById('activityPageSize'); picker.value='50'; picker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitForBrowser("typeof window.paginationRelease === 'function'", 'Delayed Activity request did not start');
  await evaluate("(() => { const picker=document.getElementById('activityPageSize'); picker.value='20'; picker.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitForBrowser("app.activity.limit === 20 && app.activity.events.length === 20", 'Newer Activity size request did not finish');
  await evaluate("window.fetch=window.paginationOriginalFetch; window.paginationRelease()");
  await delay(100);
  assert(await evaluate("app.activity.limit === 20 && document.querySelectorAll('#activityList .event').length === 20"), 'An older request overwrote the selected Activity page size');
  for (const theme of ['dark','light']) {
    await evaluate(`applyTheme(${JSON.stringify(theme)})`); await delay(250);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,screenWidth:390,screenHeight:844,deviceScaleFactor:1,mobile:false });
    assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1 && Math.round(document.querySelector('#activityList .event').getBoundingClientRect().height) === 64"), 'Activity page-size controls overflowed mobile layout or changed row height');
    await assertAccessible(`Activity pagination ${theme}`);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:640,height:450,screenWidth:1280,screenHeight:900,deviceScaleFactor:2,mobile:false });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'Activity page-size controls overflowed at 200% equivalent zoom');
  console.log(`BROWSER SMOKE PASSED: ${process.platform} · setup/auth · WCAG axe scans · keyboard/focus/reduced-motion · persistent navigation/filters · resettable empty states · offline recovery · copy actions · unclipped navigation · dark/light · images · watch/rules/bulk/import · exact variants/combined preview/collections/purchased · stock insights/windows/collection readiness/alerts/deep-links · compact searchable activity/evidence · email settings/preview/deep-link · backup/import · diagnostics/operations · responsive`);
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
