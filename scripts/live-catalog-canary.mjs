import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const root = resolve(import.meta.dirname, '..');
const regions = String(process.env.GEARBEACON_CANARY_REGIONS || 'us,ca,eu,uk')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const minimumProducts = Number(process.env.GEARBEACON_CANARY_MIN_PRODUCTS || 20);
const timeoutMs = Number(process.env.GEARBEACON_CANARY_TIMEOUT_MS || 180_000);
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-live-canary-'));

const port = await new Promise((resolvePort, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const selected = socket.address().port;
    socket.close((error) => error ? reject(error) : resolvePort(selected));
  });
});
const base = `http://127.0.0.1:${port}`;
let output = '';
const child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    MOCK_MODE: '0',
    PORT: String(port),
    POLL_SECONDS: '86400',
    REGIONS: regions.join(','),
    GEARBEACON_DATA_DIR: dataDir,
    GEARBEACON_SKIP_LEGACY_IMPORT: '1',
    GEARBEACON_GITHUB_RELEASE_API: '',
    GEARBEACON_BACKUP_INTERVAL_HOURS: '0',
    GEARBEACON_ACCESS_MODE: 'local',
    GEARBEACON_BIND_HOST: '127.0.0.1',
    NTFY_TOPIC: '', DISCORD_WEBHOOK_URL: '', GENERIC_WEBHOOK_URL: '', GOTIFY_BASE_URL: '',
    SMTP_HOST: '', SMTP_FROM: '', SMTP_TO: '', SMTP_USER: '', SMTP_PASSWORD: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { output += chunk.toString(); process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(chunk); });

async function json(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body.error || 'unknown error'}`);
  return body;
}

async function waitForCatalogs() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const statuses = await Promise.all(regions.map((region) => json(`/api/status?region=${encodeURIComponent(region)}`)));
      if (statuses.every((status) => !status.checking)) {
        const failures = statuses.filter((status) => !status.lastSuccessAt || status.lastError);
        if (failures.length) throw new Error(failures.map((status) => `${status.region}: ${status.lastError || 'no successful catalog'}`).join('\n'));
        return statuses;
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Canary server exited with code ${child.exitCode}.\n${output}`);
    await delay(1_000);
  }
  throw new Error(`Live catalog checks did not finish within ${Math.round(timeoutMs / 1000)} seconds.\n${output}`);
}

function validateProduct(product, region) {
  if (!product || typeof product.slug !== 'string' || !product.slug || typeof product.name !== 'string' || !product.name) {
    throw new Error(`${region} returned a product without a stable slug and name.`);
  }
  if (product.region !== region || typeof product.inStock !== 'boolean' || typeof product.status !== 'string') {
    throw new Error(`${region}/${product.slug} returned invalid region or availability data.`);
  }
  const store = new URL(product.url);
  const expectedStoreHost = region === 'us' ? 'store.ui.com' : `${region}.store.ui.com`;
  if (store.protocol !== 'https:' || store.hostname !== expectedStoreHost) throw new Error(`${region}/${product.slug} returned an unexpected store URL.`);
  if (product.imageUrl) {
    const image = new URL(product.imageUrl);
    if (image.protocol !== 'https:' || !['images.svc.ui.com', 'cdn.ecomm.ui.com', 'assets.ecomm.ui.com'].includes(image.hostname)) {
      throw new Error(`${region}/${product.slug} returned an image from an unexpected host.`);
    }
  }
}

try {
  const statuses = await waitForCatalogs();
  for (const status of statuses) {
    const region = status.region;
    if (status.version !== '1.10.0' || status.mockMode || status.catalogHealth !== 'healthy' || status.lastError) {
      throw new Error(`${region} catalog is not healthy: ${status.lastError || status.catalogHealth}`);
    }
    const result = await json(`/api/products?region=${encodeURIComponent(region)}`);
    if (!Array.isArray(result.products) || result.count !== result.products.length || result.count < minimumProducts) {
      throw new Error(`${region} returned ${result.count ?? 'an unknown number of'} products; expected at least ${minimumProducts}.`);
    }
    result.products.forEach((product) => validateProduct(product, region));
    const withImages = result.products.filter((product) => product.imageUrl).length;
    const withPrices = result.products.filter((product) => product.price).length;
    if (withImages < Math.ceil(result.count * 0.75)) throw new Error(`${region} image coverage fell below 75% (${withImages}/${result.count}).`);
    if (withPrices < Math.ceil(result.count * 0.5)) throw new Error(`${region} price coverage fell below 50% (${withPrices}/${result.count}).`);
    console.log(`${region.toUpperCase()}: ${result.count} products, ${withImages} images, ${withPrices} prices, healthy.`);
  }
  console.log(`Live catalog canary passed for ${regions.length} regions without creating watchlist items or notification deliveries.`);
} finally {
  child.kill('SIGINT');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
}
