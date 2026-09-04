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
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const packageName = `GearBeacon-v${pkg.version}-${platform}-${arch}`;
const outputDir = join(root, 'dist', 'standalone', packageName);
const executableName = process.platform === 'win32' ? 'GearBeacon.exe' : 'gearbeacon';
const executable = join(outputDir, executableName);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const seaConfigFile = join(tmpdir(), `gearbeacon-sea-${process.pid}.json`);
writeFileSync(seaConfigFile, JSON.stringify({
  main: join(root, 'backend', 'dist', 'index.js'),
  mainFormat: 'commonjs',
  executable: process.execPath,
  output: executable,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgv: ['--no-warnings'],
  execArgvExtension: 'none',
}, null, 2));

const build = spawnSync(process.execPath, ['--build-sea', seaConfigFile], { cwd: root, stdio: 'inherit' });
rmSync(seaConfigFile, { force: true });
if (build.status !== 0 || !existsSync(executable)) throw new Error(`Node SEA build failed with exit code ${build.status}.`);
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
  name: 'GearBeacon', version: pkg.version, platform, arch,
  commit: process.env.GEARBEACON_BUILD_COMMIT || process.env.GITHUB_SHA || null,
  builtAt: new Date().toISOString(), unsigned: true,
}, null, 2));
console.log(outputDir);
