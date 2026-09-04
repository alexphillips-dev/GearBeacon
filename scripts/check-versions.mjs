import { readFile } from 'node:fs/promises';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const root = await readJson('package.json');
const backend = await readJson('backend/package.json');
const manifest = await readJson('release-manifest.json');
const source = await readFile('backend/src/index.ts', 'utf8');
const compiled = await readFile('backend/dist/index.js', 'utf8');
const web = await readFile('web/index.html', 'utf8');
const sourceVersion = source.match(/const APP_VERSION = '([^']+)'/)?.[1];
const compiledVersion = compiled.match(/const APP_VERSION = '([^']+)'/)?.[1];
const webVersion = web.match(/id="settingsVersion">V([^<]+)</)?.[1];

const expected = backend.version;
const checks = {
  'package.json': root.version,
  'backend/package.json': backend.version,
  'release-manifest.json': manifest.latestVersion,
  'backend/src/index.ts': sourceVersion,
  'backend/dist/index.js': compiledVersion,
  'web/index.html': webVersion,
};

for (const [file, version] of Object.entries(checks)) {
  if (version !== expected) throw new Error(`${file} version ${version ?? 'missing'} does not match ${expected}`);
}
console.log(`Version consistency OK: ${expected}`);
