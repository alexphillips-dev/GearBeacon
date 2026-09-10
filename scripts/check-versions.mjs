import { readFile } from 'node:fs/promises';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const root = await readJson('package.json');
const backend = await readJson('backend/package.json');
const manifest = await readJson('release-manifest.json');
const source = await readFile('backend/src/index.ts', 'utf8');
const compiled = await readFile('backend/dist/index.js', 'utf8');
const web = await readFile('web/index.html', 'utf8');
const releaseWorkflow = await readFile('.github/workflows/release.yml', 'utf8');
const releaseNotes = await readFile('docs/RELEASE_NOTES.md', 'utf8');
const changelog = await readFile('docs/CHANGELOG.md', 'utf8');
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
const sourceSchema = Number(source.match(/const DATABASE_SCHEMA_VERSION = (\d+);/)?.[1]);
const compiledSchema = Number(compiled.match(/const DATABASE_SCHEMA_VERSION = (\d+);/)?.[1]);
if (!Number.isInteger(sourceSchema) || compiledSchema !== sourceSchema || manifest.maximumSchemaVersion !== sourceSchema) {
  throw new Error('Release manifest and compiled server must declare the current source database schema.');
}
if (!releaseNotes.startsWith(`# GearBeacon ${expected} `) || !releaseWorkflow.includes('--notes-file docs/RELEASE_NOTES.md') || releaseWorkflow.includes('--generate-notes')) {
  throw new Error('Release publication must use the curated notes for the current application version.');
}
if (!changelog.includes(`## V${expected} `) || !releaseWorkflow.includes('docs/CHANGELOG.md')) {
  throw new Error('Release publication must use the current changelog from docs.');
}
if (!releaseWorkflow.includes('test "$GITHUB_SHA" = "$TARGET_SHA"') || releaseWorkflow.includes('merge-base --is-ancestor "$GITHUB_SHA"')) {
  throw new Error('Release workflow must require a tag to equal the selected branch tip.');
}
console.log(`Version consistency OK: ${expected}`);
