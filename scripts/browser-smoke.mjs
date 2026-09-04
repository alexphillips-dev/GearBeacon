import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-browser-smoke-'));
const chromeProfile = await mkdtemp(join(tmpdir(), 'gearbeacon-chrome-'));
const port = 9200 + (process.pid % 500);
const baseUrl = `http://127.0.0.1:${port}`;
const setupToken = 'v17-browser-setup-token';
const password = 'V1.7 browser owner password';
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
  await waitFor(() => existsSync(activePortFile), 'Chrome did not expose a DevTools port');
  const debugPort = Number((await readFile(activePortFile, 'utf8')).split(/\r?\n/)[0]);
  let pageTarget = null;
  await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    pageTarget = targets.find((target) => target.type === 'page' && target.url.startsWith(baseUrl));
    return Boolean(pageTarget?.webSocketDebuggerUrl);
  }, 'GearBeacon browser page was not available');
  cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')", 'Owner setup screen did not appear');
  await evaluate(`(() => {
    document.getElementById('setupToken').value = ${JSON.stringify(setupToken)};
    document.getElementById('authPassword').value = ${JSON.stringify(password)};
    document.getElementById('authPasswordConfirm').value = ${JSON.stringify(password)};
    document.getElementById('authForm').requestSubmit();
  })()`);
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.products.length >= 5", 'Authenticated dashboard did not load');
  await waitForBrowser("!document.getElementById('setupWizard').classList.contains('hidden') && app.wizardStep === 2", 'Guided setup did not start');
  for (const step of [3, 4, 5]) {
    await evaluate("document.getElementById('wizardNext').click()");
    await waitForBrowser(`app.wizardStep === ${step}`, `Guided setup did not advance to step ${step}`);
  }
  await evaluate("document.getElementById('wizardNext').click()");
  await waitForBrowser("document.getElementById('setupWizard').classList.contains('hidden') && app.auth.onboardingComplete", 'Guided setup did not complete');

  await evaluate("document.querySelector('[data-tab=\"browse\"]').click()");
  await waitForBrowser("document.getElementById('browse').classList.contains('active') && document.querySelectorAll('#browseGrid .store-card:not(.skeleton-card)').length >= 5", 'Browse catalog did not render');
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
  await evaluate("document.querySelector('#browseGrid [data-watch=\"u7-pro-xgs\"]').click()");
  await waitForBrowser("app.products.find((product) => product.slug === 'u7-pro-xgs')?.watched === true", 'Browser watch action failed');
  await evaluate(`(() => { const input=document.getElementById('search'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitForBrowser("document.querySelectorAll('#browseGrid .store-card').length >= 5", 'Browse search did not clear');
  await evaluate("document.querySelector('[data-category=\"WiFi\"]').click()");
  await waitForBrowser("app.browseCategory === 'WiFi' && app.products.filter((product) => product.category === 'WiFi').length === document.querySelectorAll('#browseGrid .store-card').length", 'Browse category filtering failed');
  await evaluate("document.querySelector('[data-category=\"All\"]').click(); app.browseVisibleCount=2; renderProducts(true)");
  await waitForBrowser("!document.getElementById('browseLoadMore').classList.contains('hidden') && document.querySelectorAll('#browseGrid .store-card').length === 2", 'Incremental catalog loading did not activate');
  await evaluate("document.getElementById('browseLoadMore').click()");
  await waitForBrowser("document.querySelectorAll('#browseGrid .store-card').length > 2", 'Load-more control did not expand the catalog');

  await evaluate("openProductDialog('u7-pro-xgs')");
  await waitForBrowser("!document.getElementById('productDialog').classList.contains('hidden') && document.getElementById('productRuleForm')", 'Product details or rule editor did not open');
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
  await evaluate(`document.querySelectorAll('#watchGrid [data-watch-select]').forEach((input) => { input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); })`);
  await waitForBrowser("!document.getElementById('bulkActions').classList.contains('hidden') && app.selectedWatch.size === 2", 'Bulk watchlist selection failed');
  await evaluate("document.getElementById('bulkPause').click()");
  await waitForBrowser("app.products.filter((product) => product.watched).every((product) => product.watchRule?.pausedUntil)", 'Bulk pause failed');
  await evaluate(`document.querySelectorAll('#watchGrid [data-watch-select]').forEach((input) => { input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true})); })`);
  await evaluate("document.getElementById('bulkResume').click()");
  await waitForBrowser("app.products.filter((product) => product.watched).every((product) => !product.watchRule?.pausedUntil)", 'Bulk resume failed');

  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabNotifications').click()");
  await waitForBrowser("!document.getElementById('settingsPanelNotifications').hidden && document.getElementById('settingsPanelData').hidden", 'Notification settings tab failed');
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
  const browserBackup = await evaluate(`(async () => {
    const backup = await api('/api/data/export/encrypted', { method:'POST', body:JSON.stringify({ passphrase:'browser backup passphrase' }) });
    const preview = await api('/api/data/preview', { method:'POST', body:JSON.stringify({ backup, passphrase:'browser backup passphrase' }) });
    const restored = await api('/api/data/import', { method:'POST', body:JSON.stringify({ backup, passphrase:'browser backup passphrase' }) });
    return { format:backup.format, historyCount:preview.regions[0].historyCount, watchCount:restored.watchCount };
  })()`);
  assert(browserBackup?.format === 'GearBeaconEncryptedBackup' && browserBackup.watchCount === 2 && browserBackup.historyCount >= 1, 'Browser backup preview/import flow failed.');

  await evaluate("document.querySelector('[data-tab=\"operations\"]').click()");
  await waitForBrowser("app.operations?.summary?.state && document.getElementById('operationsSummary').textContent.trim().length > 0", 'Operations summary did not render');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, screenWidth:390, screenHeight:844, deviceScaleFactor:1, mobile:false });
  const responsive = await evaluate("({ overflow:document.documentElement.scrollWidth <= window.innerWidth + 1, width:window.innerWidth, scrollWidth:document.documentElement.scrollWidth, widest:[...document.querySelectorAll('body *')].map((element) => ({ tag:element.tagName, id:element.id, cls:element.className, right:element.getBoundingClientRect().right, width:element.getBoundingClientRect().width })).filter((item) => item.right > window.innerWidth + 1).sort((a,b) => b.right-a.right).slice(0,5) })");
  assert(responsive?.overflow && responsive.width === 390, `Responsive layout overflows a 390px viewport: ${JSON.stringify(responsive)}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await evaluate("document.getElementById('logoutBtn').click()");
  await waitForBrowser("!document.getElementById('authGate').classList.contains('hidden')", 'Browser logout did not return to the owner gate');
  await evaluate(`(() => { document.getElementById('authPassword').value=${JSON.stringify(password)}; document.getElementById('authForm').requestSubmit(); })()`);
  await waitForBrowser("!document.getElementById('appShell').classList.contains('hidden') && app.auth.authenticated", 'Browser login after logout failed');
  await evaluate("document.querySelector('[data-tab=\"settings\"]').click(); document.getElementById('settingsTabSecurity').click()");
  await waitForBrowser("document.querySelectorAll('#sessionList [data-revoke-session]').length >= 1", 'Authenticated session management did not render');

  console.log(`BROWSER SMOKE PASSED: ${process.platform} · setup/auth · dark/light · images · search/category/load-more · stable dialog hover · watch/rules/bulk · email settings/preview/deep-link · backup/import · operations · responsive`);
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
