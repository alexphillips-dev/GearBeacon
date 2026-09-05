import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const run = (command, args, expectedText) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0) throw new Error(`${args.at(-1)} accepted an update without backup confirmation.`);
  if (!output.toLowerCase().includes(expectedText.toLowerCase())) {
    throw new Error(`${args.at(-1)} failed for an unexpected reason:\n${output}`);
  }
};

if (process.platform === 'win32') {
  run('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'deploy/update-windows.ps1', '-Version', '1.0.1'], 'BackupConfirmed');
} else {
  run('sh', ['deploy/update-mac-linux.sh', '1.0.1'], '--backup-confirmed');
  run('sh', ['deploy/update-docker.sh', '1.0.1'], '--backup-confirmed');
}

console.log('Update helper safety checks passed.');
