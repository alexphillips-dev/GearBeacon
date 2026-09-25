import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { windowsOperation } from './windows-protection.mjs';

export function checkoutDataDir() {
  if (process.env.GEARBEACON_CHECKOUT_DATA_DIR) return path.resolve(process.env.GEARBEACON_CHECKOUT_DATA_DIR);
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local')
    : process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support') : process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share');
  return path.join(base,'GearBeaconCheckout');
}

// Storage state, profiles, the API token, and the submission journal are encrypted together.
// The key remains private to the companion host, outside GearBeacon backups and support exports.
export class VaultError extends Error {
  constructor(code) { super('The private checkout vault needs attention.'); this.code = code; }
}

export function openVault(directory = checkoutDataDir(), { readOnly = false } = {}) {
  const denyWrite = () => { throw new VaultError('read-only'); };
  const empty = { read:()=>({ profiles:{}, journal:{} }), write:denyWrite, lock:denyWrite };
  if (readOnly && !fs.existsSync(directory)) return empty;
  if (!readOnly) fs.mkdirSync(directory,{ recursive:true, mode:0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Checkout data must be a private directory, not a symbolic link.');
  if (process.platform === 'win32') windowsOperation(directory, readOnly ? 'verify' : 'acl');
  else {
    if (readOnly && (fs.statSync(directory).mode & 0o077)) throw new VaultError('permissions');
    if (!readOnly) fs.chmodSync(directory,0o700);
  }
  const keyFile = path.join(directory,'checkout.key'), stateFile = path.join(directory,'vault.checkout-state');
  if (!fs.existsSync(keyFile)) {
    if (fs.existsSync(stateFile)) throw new VaultError('missing-key');
    if (readOnly) return empty;
    const generated = crypto.randomBytes(32);
    const stored = process.platform === 'win32' ? `dpapi-v1:${windowsOperation(directory, 'protect', generated.toString('base64'))}` : generated;
    fs.writeFileSync(keyFile,stored,{ flag:'wx', mode:0o600 });
  }
  for (const file of [keyFile,stateFile]) if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Checkout state must use regular private files.');
    if (process.platform === 'win32') windowsOperation(file, readOnly ? 'verify' : 'acl');
    else {
      if (readOnly && (fs.statSync(file).mode & 0o077)) throw new VaultError('permissions');
      if (!readOnly) fs.chmodSync(file,0o600);
    }
  }
  const storedKey = fs.readFileSync(keyFile);
  const wrapped = storedKey.toString('utf8').startsWith('dpapi-v1:');
  if (wrapped && process.platform !== 'win32') throw new Error('This checkout key belongs to its original Windows account.');
  const key = wrapped ? Buffer.from(windowsOperation(keyFile, 'unprotect', storedKey.toString('utf8').slice(9)), 'base64') : storedKey;
  if (key.length !== 32) throw new Error('Checkout encryption key is invalid.');
  if (process.platform === 'win32' && !wrapped && !readOnly) {
    const protectedKey = windowsOperation(keyFile, 'protect', key.toString('base64'));
    const temporary = `${keyFile}.${crypto.randomUUID()}.pending`;
    try {
      fs.writeFileSync(temporary, `dpapi-v1:${protectedKey}`, { flag:'wx', mode:0o600 });
      windowsOperation(temporary, 'acl');
      if (!key.equals(Buffer.from(windowsOperation(temporary, 'unprotect', protectedKey), 'base64'))) throw new Error('Checkout key protection verification failed.');
      fs.renameSync(temporary, keyFile);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function read() {
    if (!fs.existsSync(stateFile)) return { profiles:{}, journal:{} };
    try {
      const data = fs.readFileSync(stateFile), iv = data.subarray(0,12), tag = data.subarray(12,28);
      const decipher = crypto.createDecipheriv('aes-256-gcm',key,iv);
      decipher.setAAD(Buffer.from('GearBeaconCheckout:v1')); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));
    } catch { throw new Error('The checkout vault could not be decrypted. Restore its matching key; do not discard an unresolved submission journal.'); }
  }
  function write(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('GearBeaconCheckout:v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    const temp = path.join(directory,`${crypto.randomUUID()}.checkout-state`);
    const fd = fs.openSync(temp,'wx',0o600);
    try {
      try { fs.writeFileSync(fd,Buffer.concat([iv,cipher.getAuthTag(),encrypted])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (process.platform === 'win32') windowsOperation(temp, 'acl');
      fs.renameSync(temp,stateFile);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    if (process.platform !== 'win32') { const dir = fs.openSync(directory,'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  }
  function lock() {
    const file = path.join(directory,'worker.checkout-lock');
    // OS process identity is checked before removing a stale lock. An ambiguous lock fails closed.
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Checkout lock must be a regular private file.');
      if (process.platform === 'win32') windowsOperation(file, 'acl');
      else fs.chmodSync(file,0o600);
      let pid; try { pid = Number(fs.readFileSync(file,'utf8')); } catch {}
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Checkout lock needs manual inspection.');
      let running = true;
      try { process.kill(pid,0); } catch (err) { if (err.code === 'ESRCH') running = false; }
      if (running) throw new VaultError('locked');
      fs.unlinkSync(file);
    }
    fs.writeFileSync(file,String(process.pid),{ flag:'wx', mode:0o600 });
    try { if (process.platform === 'win32') windowsOperation(file, 'acl'); }
    catch (err) { fs.unlinkSync(file); throw err; }
    return () => { if (fs.existsSync(file) && fs.readFileSync(file,'utf8') === String(process.pid)) fs.unlinkSync(file); };
  }
  return { read, write:readOnly ? denyWrite : write, lock:readOnly ? denyWrite : lock };
}
