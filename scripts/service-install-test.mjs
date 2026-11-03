import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const project = resolve(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), "gearbeacon-service-install-space & quote'-"));
const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'sh';
const unix = value => value.replaceAll('\\', '/');
const sourceDir = join(root, 'package'), installDir = join(root, 'gearbeacon'), dataDir = join(root, 'data');
const runner = join(root, 'install-files.sh');
const metadata = { packageVersion:'1.4.1-rc.1', branch:'dev', commit:'a'.repeat(40) };
try {
  mkdirSync(join(sourceDir, 'web', 'assets'), { recursive:true });
  writeFileSync(join(sourceDir, 'web', 'index.html'), '<html>service fixture</html>');
  writeFileSync(join(sourceDir, 'web', 'assets', 'fixture.txt'), 'public asset');
  writeFileSync(join(sourceDir, 'gearbeacon'), 'executable fixture');
  writeFileSync(join(sourceDir, 'release-manifest.json'), '{"latestVersion":"1.4.1"}');
  for (const platform of ['linux', 'macos']) {
    const source = readFileSync(join(project, 'deploy', 'install-' + platform + '-service.sh'), 'utf8').replaceAll('\r\n', '\n');
    const start = source.indexOf('install -d -o root');
    const end = source.indexOf('\n', source.indexOf('chmod -R go-w', start));
    assert.ok(start >= 0 && end > start, 'Native application installation block not found');
    // Run the actual file-installation block in a temporary tree without account/service
    // management. Removing owner flags lets Unix CI run this fixture unprivileged.
    let block = source.slice(start, end)
      .replaceAll('/opt/gearbeacon', '"$INSTALL_DIR"').replaceAll('/var/lib/gearbeacon', '"$DATA_DIR"')
      .replace(/ -o (?:root|gearbeacon|"\$SERVICE_USER") -g (?:root|wheel|gearbeacon|"\$SERVICE_GROUP")/g, '')
      .replace(/^chown .*$/gm, '');
    assert.ok(!/\/(?:opt|var|Library|usr\/local)\//.test(block), 'Installer fixture escaped its temporary paths');
    // NTFS/Git Bash cannot model POSIX private directory modes. Unix CI verifies
    // the real mode flags; Windows still executes the copy/metadata branches.
    if (process.platform === 'win32') block = block.replace(/ -m 0[0-7]{3}/g, '');
    writeFileSync(runner, '#!/bin/sh\nset -eu\nexport PATH=/usr/bin:/bin:$PATH\numask ' + (process.platform === 'win32' ? '022' : '077') + '\nSOURCE_DIR=$1\nINSTALL_DIR=$2\nDATA_DIR=$3\n' + block + '\n');
    const run = () => {
      const result = spawnSync(shell, [unix(runner), unix(sourceDir), unix(installDir), unix(dataDir)], {
        cwd:root, encoding:'utf8', timeout:15000, windowsHide:true,
      });
      assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    };
    writeFileSync(join(sourceDir, 'build-info.json'), JSON.stringify(metadata));
    run();
    assert.deepEqual(JSON.parse(readFileSync(join(installDir, 'build-info.json'), 'utf8')), metadata, platform + ' lost package identity');
    assert.ok(readFileSync(join(installDir, 'web', 'index.html'), 'utf8').includes('service fixture'));
    if (process.platform !== 'win32') {
      for (const directory of ['web', 'web/assets']) assert.equal(statSync(join(installDir, directory)).mode & 0o777, 0o755, platform + ' web directory is not traversable by the service');
      for (const file of ['web/index.html', 'web/assets/fixture.txt', 'build-info.json']) assert.equal(statSync(join(installDir, file)).mode & 0o777, 0o644, platform + ' public application file is not readable by the service');
      if (platform === 'linux') assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'Public web permissions exposed private data');
    }
    unlinkSync(join(sourceDir, 'build-info.json')); run();
    assert.equal(existsSync(join(installDir, 'build-info.json')), false, platform + ' retained stale package identity');
  }
  console.log('SERVICE INSTALL TEST PASSED: Linux/macOS actual file-copy blocks, nested assets, private data permissions, prerelease metadata and stale metadata removal' + (process.platform === 'win32' ? '; POSIX mode assertions run on Unix CI.' : '; public file modes verified.'));
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('gearbeacon-service-install-'));
  rmSync(root, { recursive:true, force:true });
}
