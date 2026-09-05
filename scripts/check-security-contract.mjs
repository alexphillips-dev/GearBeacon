import { readFile, readdir } from 'node:fs/promises';

const read = (file) => readFile(file, 'utf8');
const requireMatch = (text, pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};

const [backend, dockerfile, compose, windowsInstaller, macInstaller, linuxInstaller, dependabot, securityWorkflow] = await Promise.all([
  read('backend/src/index.ts'),
  read('Dockerfile'),
  read('docker-compose.yml'),
  read('deploy/install-windows-service.ps1'),
  read('deploy/install-macos-service.sh'),
  read('deploy/install-linux-service.sh'),
  read('.github/dependabot.yml'),
  read('.github/workflows/security.yml'),
]);

requireMatch(backend, /const PASSWORD_HASH_VERSION = 'scrypt-v2';/, 'Current owner-password hashes must use the versioned scrypt-v2 profile.');
requireMatch(backend, /'scrypt-v1':.*p: 1[\s\S]*'scrypt-v2':.*p: 5/, 'Owner-password verification must retain legacy scrypt-v1 support and use the stronger scrypt-v2 profile.');
requireMatch(backend, /function validatedRequestHost\([\s\S]*Request host is not allowed\./, 'HTTP requests must pass strict Host validation before routing.');
for (const setting of ['server.headersTimeout = 15_000;', 'server.requestTimeout = 30_000;', 'server.timeout = 120_000;', 'server.keepAliveTimeout = 5_000;', 'server.maxHeadersCount = 64;', 'server.maxRequestsPerSocket = 100;']) {
  if (!backend.includes(setting)) throw new Error(`Missing bounded HTTP server setting: ${setting}`);
}

if (/COPY --chown=node:node/.test(dockerfile) || !/COPY --chown=root:root backend\/dist/.test(dockerfile) || !/^USER node$/m.test(dockerfile)) {
  throw new Error('Container application files must be root-owned while the process remains unprivileged.');
}
for (const pattern of [/read_only:\s*true/, /cap_drop:\s*\r?\n\s*- ALL/, /no-new-privileges:true/, /pids_limit:\s*256/, /\/tmp:rw,nosuid,nodev,noexec/]) {
  requireMatch(compose, pattern, 'Compose must keep the read-only, capability-free, no-new-privileges runtime contract.');
}

requireMatch(windowsInstaller, /NT AUTHORITY\\LOCAL SERVICE[\s\S]*-RunLevel Limited/, 'Windows service installation must use limited LocalService rather than SYSTEM.');
requireMatch(windowsInstaller, /\*S-1-5-19:\(OI\)\(CI\)F/, 'Windows LocalService must have access only to the protected data directory.');
requireMatch(macInstaller, /<key>UserName<\/key><string>\$SERVICE_USER<\/string>/, 'macOS LaunchDaemon must use the dedicated GearBeacon service account.');
requireMatch(macInstaller, /chown -R root:wheel "\$INSTALL_DIR"/, 'macOS application files must remain root-owned.');
requireMatch(linuxInstaller, /User=gearbeacon[\s\S]*CapabilityBoundingSet=[\s\S]*ProtectSystem=strict/, 'Linux service must use the unprivileged account with an empty capability set and read-only system paths.');
requireMatch(linuxInstaller, /chown -R root:root \/opt\/gearbeacon/, 'Linux application files must remain root-owned.');

const devTargets = dependabot.match(/target-branch:\s*dev/g) || [];
if (devTargets.length !== 3) throw new Error('Every Dependabot ecosystem must target the development branch.');
requireMatch(securityWorkflow, /repository-secret-scan:[\s\S]*scan-type:\s*fs[\s\S]*scanners:\s*secret[\s\S]*exit-code:\s*'1'/, 'Security CI must fail closed on repository filesystem secret findings.');

const workflowFiles = (await readdir('.github/workflows')).filter((file) => /\.ya?ml$/i.test(file));
for (const file of workflowFiles) {
  const workflow = await read(`.github/workflows/${file}`);
  for (const match of workflow.matchAll(/\buses:\s*([^\s#]+)/g)) {
    const reference = match[1];
    if (reference.startsWith('./')) continue;
    const revision = reference.split('@')[1] || '';
    if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error(`${file} contains an action that is not pinned to a full commit SHA: ${reference}`);
  }
}

console.log('Security hardening contract OK.');
