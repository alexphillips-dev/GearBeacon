import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const packageDir = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/standalone-smoke.mjs <standalone-package-directory>');
const executable = join(packageDir, process.platform === 'win32' ? 'GearBeacon.exe' : 'gearbeacon');
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-standalone-smoke-'));
const port = 8921 + (process.pid % 500);
let exit = null;
let spawnError = null;
const child = spawn(executable, [], { cwd:packageDir, env:{ ...process.env, MOCK_MODE:'1', PORT:String(port), GEARBEACON_DATA_DIR:dataDir, GEARBEACON_ACCESS_MODE:'local', GEARBEACON_BIND_HOST:'127.0.0.1', GEARBEACON_GITHUB_RELEASE_API:'', GEARBEACON_BACKUP_INTERVAL_HOURS:'0' }, stdio:['ignore','inherit','inherit'] });
child.once('exit', (code, signal) => { exit = { code, signal }; });
child.once('error', (error) => { spawnError = error; });
try {
  let status = null;
  for (let i = 0; i < 300; i += 1) {
    if (spawnError || exit) break;
    try { const response = await fetch(`http://127.0.0.1:${port}/api/status`); if (response.ok) { status = await response.json(); break; } } catch {}
    await delay(100);
  }
  if (status?.version !== '1.9.0' || status?.storage?.schemaVersion !== 7) {
    const detail = spawnError ? `spawn error: ${spawnError.message}` : exit ? `process exited: ${JSON.stringify(exit)}` : 'startup timed out after 30 seconds';
    throw new Error(`Standalone did not start correctly (${detail}): ${JSON.stringify(status)}`);
  }
  const dashboard = await fetch(`http://127.0.0.1:${port}/`);
  if (!dashboard.ok || !(await dashboard.text()).includes('Guided first run')) throw new Error('Standalone dashboard assets were not served.');
  const operations = await (await fetch(`http://127.0.0.1:${port}/api/operations`)).json();
  if (!operations.runtime?.standalone) throw new Error('Runtime did not identify the single-executable package.');
  if (process.env.EXPECTED_BUILD_COMMIT && operations.runtime.commit !== process.env.EXPECTED_BUILD_COMMIT) throw new Error('Standalone build provenance is missing or incorrect.');
  console.log(`STANDALONE SMOKE PASSED: ${process.platform}/${process.arch}`);
} finally {
  if (!exit) child.kill('SIGINT');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(dataDir, { recursive:true, force:true });
}
