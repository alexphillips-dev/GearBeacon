import { cpSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error('Standalone builds require Node.js 25.5 or newer because GearBeacon uses Node single-executable application builds.');
}

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'backend', 'package.json'), 'utf8'));
const packageVersion = String(process.env.GEARBEACON_PACKAGE_VERSION || pkg.version).replace(/^v/, '');
const versionPattern = new RegExp(`^${pkg.version.replaceAll('.', '\\.')}([+-][0-9A-Za-z][0-9A-Za-z.-]*)?$`);
if (!versionPattern.test(packageVersion)) throw new Error(`Standalone package version ${packageVersion} must match application version ${pkg.version} or add a prerelease suffix.`);
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const packageName = `GearBeacon-v${packageVersion}-${platform}-${arch}`;
const outputDir = join(root, 'dist', 'standalone', packageName);
const executableName = process.platform === 'win32' ? 'GearBeacon.exe' : 'gearbeacon';
const executable = join(outputDir, executableName);
const bundledMainFile = join(tmpdir(), `gearbeacon-standalone-main-${process.pid}.cjs`);

const indexSource = readFileSync(join(root, 'backend', 'dist', 'index.js'), 'utf8');
const emailSource = readFileSync(join(root, 'backend', 'dist', 'email.js'), 'utf8');
const emailRequire = "const { renderEmail, buildMimeEmail } = require('./email');";
if (!indexSource.includes(emailRequire)) throw new Error('Standalone bundling could not find the GearBeacon email module import.');
const bundledEmailModule = [
  'const { renderEmail, buildMimeEmail } = (() => {',
  '  const module = { exports: {} };',
  '  const exports = module.exports;',
  emailSource,
  '  return module.exports;',
  '})();',
].join('\n');
const bundledSource = indexSource.replace(emailRequire, () => bundledEmailModule);
writeFileSync(bundledMainFile, bundledSource);

const syntaxCheck = spawnSync(process.execPath, ['--check', bundledMainFile], { cwd: root, stdio: 'inherit' });
if (syntaxCheck.status !== 0) {
  rmSync(bundledMainFile, { force: true });
  throw new Error(`Standalone bundled source failed its syntax check with exit code ${syntaxCheck.status}.`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const seaConfigFile = join(tmpdir(), `gearbeacon-sea-${process.pid}.json`);
const seaBlobFile = join(tmpdir(), `gearbeacon-sea-${process.pid}.blob`);
// Node's built-in Mach-O injector currently produces crashing Intel macOS binaries.
// Keep the official preparation-blob path until https://github.com/nodejs/node/issues/65479 is resolved.
const usePostject = process.platform === 'darwin' && process.arch === 'x64';
const seaConfig = {
  main: bundledMainFile,
  mainFormat: 'commonjs',
  output: usePostject ? seaBlobFile : executable,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgv: ['--no-warnings'],
  execArgvExtension: 'none',
};
if (!usePostject) seaConfig.executable = process.execPath;
writeFileSync(seaConfigFile, JSON.stringify(seaConfig, null, 2));

const buildFlag = usePostject ? '--experimental-sea-config' : '--build-sea';
const build = spawnSync(process.execPath, [buildFlag, seaConfigFile], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  rmSync(seaBlobFile, { force: true });
  rmSync(seaConfigFile, { force: true });
  rmSync(bundledMainFile, { force: true });
  throw new Error(`Node SEA build failed with exit code ${build.status}.`);
}

if (usePostject) {
  cpSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  const unsigned = spawnSync('codesign', ['--remove-signature', executable], { stdio: 'inherit' });
  if (unsigned.status !== 0) throw new Error('Could not remove the Node signature before macOS x64 SEA injection.');
  const injection = spawnSync('npx', [
    '--no-install', 'postject', executable, 'NODE_SEA_BLOB', seaBlobFile,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name', 'NODE_SEA', '--overwrite',
  ], { cwd: root, stdio: 'inherit' });
  if (injection.status !== 0) throw new Error(`macOS x64 SEA injection failed with exit code ${injection.status}.`);
}

rmSync(seaBlobFile, { force: true });
rmSync(seaConfigFile, { force: true });
rmSync(bundledMainFile, { force: true });
if (!existsSync(executable)) throw new Error('Node SEA build did not create an executable.');
if (process.platform === 'darwin') {
  const signing = spawnSync('codesign', ['--sign', '-', '--force', executable], { stdio:'inherit' });
  if (signing.status !== 0) throw new Error('macOS ad-hoc signing failed.');
}

cpSync(join(root, 'web'), join(outputDir, 'web'), { recursive: true });
for (const file of ['release-manifest.json', 'LICENSE', 'NOTICE', 'START_HERE.txt']) cpSync(join(root, file), join(outputDir, file));
const platformFiles = process.platform === 'win32'
  ? ['install-windows-service.ps1', 'uninstall-windows-service.ps1', 'update-windows.ps1']
  : process.platform === 'darwin'
    ? ['install-macos-service.sh', 'uninstall-macos-service.sh', 'update-mac-linux.sh']
    : ['install-linux-service.sh', 'uninstall-linux-service.sh', 'update-mac-linux.sh'];
for (const file of platformFiles) {
  cpSync(join(root, 'deploy', file), join(outputDir, file));
  if (process.platform !== 'win32') chmodSync(join(outputDir, file), 0o755);
}
if (process.platform !== 'win32') chmodSync(executable, 0o755);
writeFileSync(join(outputDir, 'build-info.json'), JSON.stringify({
  name: 'GearBeacon', version: pkg.version, packageVersion, platform, arch,
  commit: process.env.GEARBEACON_BUILD_COMMIT || process.env.GITHUB_SHA || null,
  builtAt: new Date().toISOString(), unsigned: true,
}, null, 2));
console.log(outputDir);
