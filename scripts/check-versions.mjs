import { readFile } from 'node:fs/promises';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const backend = await readJson('backend/package.json');
const mobile = await readJson('mobile/package.json');
const app = await readJson('mobile/app.json');
const manifest = await readJson('release-manifest.json');
const source = await readFile('backend/src/index.ts', 'utf8');
const sourceVersion = source.match(/const APP_VERSION = '([^']+)'/)?.[1];

const expected = backend.version;
const checks = {
  'backend/package.json': backend.version,
  'mobile/package.json': mobile.version,
  'mobile/app.json': app.expo?.version,
  'release-manifest.json': manifest.latestVersion,
  'backend/src/index.ts': sourceVersion,
};

for (const [file, version] of Object.entries(checks)) {
  if (version !== expected) throw new Error(`${file} version ${version ?? 'missing'} does not match ${expected}`);
}
console.log(`Version consistency OK: ${expected}`);
