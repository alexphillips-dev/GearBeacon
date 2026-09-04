import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

const keyFile = process.env.TEST_TLS_KEY;
const certFile = process.env.TEST_TLS_CERT;
if (!keyFile || !certFile) throw new Error('TEST_TLS_KEY and TEST_TLS_CERT are required. Generate a test-only localhost certificate first.');
const secureContext = tls.createSecureContext({ key: readFileSync(keyFile), cert: readFileSync(certFile) });
let delivered = 0;

function smtpConversation(socket, encrypted = false, greeting = true) {
  let buffer = '';
  let inData = false;
  if (greeting) socket.write('220 starttls.test ESMTP\r\n');
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, ''); buffer = buffer.slice(index + 1);
      if (inData) {
        if (line === '.') { inData = false; delivered += 1; socket.write('250 queued\r\n'); }
      } else if (/^EHLO /i.test(line)) socket.write(encrypted ? '250-starttls.test\r\n250 8BITMIME\r\n' : '250-starttls.test\r\n250 STARTTLS\r\n');
      else if (line === 'STARTTLS' && !encrypted) {
        socket.write('220 Ready to start TLS\r\n'); socket.off('data', onData);
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
        secure.once('secure', () => smtpConversation(secure, true, false));
        secure.on('error', () => {});
      } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n');
      else if (line === 'DATA') { inData = true; socket.write('354 End with .\r\n'); }
      else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('500 unsupported\r\n');
    }
  };
  socket.on('data', onData); socket.on('error', () => {});
}

const smtp = net.createServer((socket) => smtpConversation(socket));
await new Promise((resolve, reject) => { smtp.listen(0, '127.0.0.1', resolve); smtp.once('error', reject); });
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), 'gearbeacon-starttls-'));
const port = 8911;
const child = spawn(process.execPath, ['--no-warnings', 'backend/dist/index.js'], { cwd: root, env: {
  ...process.env, MOCK_MODE:'1', PORT:String(port), GEARBEACON_DATA_DIR:dataDir, GEARBEACON_SKIP_LEGACY_IMPORT:'1',
  GEARBEACON_ACCESS_MODE:'local', GEARBEACON_BIND_HOST:'127.0.0.1', GEARBEACON_BACKUP_INTERVAL_HOURS:'0', GEARBEACON_GITHUB_RELEASE_API:'',
  SMTP_HOST:'127.0.0.1', SMTP_PORT:String(smtp.address().port), SMTP_FROM:'gearbeacon@test.local', SMTP_TO:'owner@test.local',
  SMTP_STARTTLS:'1', SMTP_REJECT_UNAUTHORIZED:'0', NTFY_TOPIC:'', DISCORD_WEBHOOK_URL:'', GOTIFY_BASE_URL:'', GEARBEACON_WEBHOOK_URL:'',
}, stdio:['ignore','inherit','inherit'] });

try {
  let ready = false;
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready = true; break; } } catch {} await delay(100); }
  if (!ready) throw new Error('GearBeacon did not start for STARTTLS test.');
  const response = await fetch(`http://127.0.0.1:${port}/api/notifications/test`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ channel:'email' }) });
  const body = await response.json();
  if (!response.ok || !body.outcomes?.some((item) => item.channel === 'email' && item.ok) || delivered !== 1) throw new Error(`STARTTLS delivery failed: ${JSON.stringify(body)}`);
  console.log('STARTTLS INTEGRATION TEST PASSED');
} finally {
  child.kill('SIGINT');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)]);
  await new Promise((resolve) => smtp.close(resolve));
  await rm(dataDir, { recursive:true, force:true });
}
