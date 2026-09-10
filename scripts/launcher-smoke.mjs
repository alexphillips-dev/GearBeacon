import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const testRoot = await mkdtemp(join(tmpdir(), 'gearbeacon-launchers-'));
const checkout = join(testRoot, 'source checkout & test');
const shimDir = join(testRoot, 'node shim');
const unrelatedCwd = join(testRoot, 'unrelated working directory');
const probeFile = join(testRoot, 'probe.mjs');
const resultFile = join(testRoot, 'result.json');
const windows = process.platform === 'win32';
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  await Promise.all([
    mkdir(join(checkout, 'launchers'), { recursive: true }),
    mkdir(join(checkout, 'backend', 'dist'), { recursive: true }),
    mkdir(shimDir),
    mkdir(unrelatedCwd),
  ]);
  // Even if a launcher bypasses the shim, it cannot start an actual GearBeacon server.
  await writeFile(join(checkout, 'backend', 'dist', 'index.js'), "throw new Error('Launcher bypassed the test node shim');\n");
  await writeFile(probeFile, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.GEARBEACON_LAUNCHER_PROBE, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2),
  mode: process.env.GEARBEACON_ACCESS_MODE, bind: process.env.GEARBEACON_BIND_HOST,
  mock: process.env.MOCK_MODE || ''
}));
`);
  await writeFile(join(shimDir, windows ? 'node.cmd' : 'node'), windows
    ? `@echo off\r\n"${process.execPath}" "${probeFile}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probeFile)} "$@"\n`, { mode: 0o755 });

  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const originalPath = env[pathKey] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  Object.assign(env, {
    PATH: `${shimDir}${delimiter}${originalPath}`,
    GEARBEACON_LAUNCHER_PROBE: resultFile,
    GEARBEACON_ACCESS_MODE: 'invalid-test-default',
    GEARBEACON_BIND_HOST: 'invalid-test-default',
    MOCK_MODE: '',
  });
  for (const variant of ['', 'private-', 'mock-']) {
    const name = `run-${variant}${windows ? 'windows.bat' : 'mac-linux.sh'}`;
    const launcher = join(checkout, 'launchers', name);
    await copyFile(join(root, 'launchers', name), launcher);
    await rm(resultFile, { force: true });
    const result = windows
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" <nul"`], {
        cwd: unrelatedCwd, env, encoding: 'utf8', input: '', timeout: 15_000, windowsVerbatimArguments: true,
      })
      : spawnSync('sh', [launcher], { cwd: unrelatedCwd, env, encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message || result.stderr || result.stdout}`);
    const observed = JSON.parse(await readFile(resultFile, 'utf8'));
    const expectedMode = variant === 'private-' ? 'private' : 'local';
    const expectedBind = variant === 'private-' ? '0.0.0.0' : '127.0.0.1';
    const expectedMock = variant === 'mock-' ? '1' : '';
    const expectedArgs = ['--no-warnings', windows ? 'backend\\dist\\index.js' : 'backend/dist/index.js'];
    if (await realpath(observed.cwd) !== await realpath(checkout) || JSON.stringify(observed.args) !== JSON.stringify(expectedArgs)
      || observed.mode !== expectedMode || observed.bind !== expectedBind || observed.mock !== expectedMock) {
      throw new Error(`${name} did not preserve its source directory, server entrypoint, or access-mode settings.`);
    }
  }
  console.log(`Launcher smoke passed: ${process.platform}, all three modes, unrelated working directory, spaces and ampersands in the checkout path.`);
} finally {
  const cleanupRoot = resolve(testRoot);
  if (dirname(cleanupRoot) !== resolve(tmpdir()) || !basename(cleanupRoot).startsWith('gearbeacon-launchers-')) {
    throw new Error('Refusing to clean up an unexpected launcher test directory.');
  }
  await rm(cleanupRoot, { recursive: true, force: true });
}
