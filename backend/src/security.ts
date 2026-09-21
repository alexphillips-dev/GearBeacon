// @ts-nocheck
// Local owner authentication; no external identity service or runtime dependencies.
const crypto = require('node:crypto');

function base32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', Buffer.from(secret, 'base64')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function codeHash(value) { return crypto.createHash('sha256').update(String(value).trim()).digest('hex'); }
function createOwnerSecurity({ db, getSetting, setSetting, encrypt, decrypt, sessionHours, idleMinutes }) {
  function policy() {
    const saved = JSON.parse(getSetting('owner_security_policy', '{}'));
    return validatePolicy({ sessionHours, idleMinutes, ...saved });
  }
  function validatePolicy(input) {
    const value = { sessionHours:Number(input.sessionHours), idleMinutes:Number(input.idleMinutes) };
    if (!Number.isInteger(value.sessionHours) || value.sessionHours < 1 || value.sessionHours > 168 || !Number.isInteger(value.idleMinutes) || value.idleMinutes < 1 || value.idleMinutes > 120) throw new Error('Session lifetime must be 1–168 hours; idle lock must be 1–120 minutes.');
    return value;
  }
  function mfa() { return decrypt(getSetting('owner_totp', '')); }
  function saveMfa(value) { setSetting('owner_totp', encrypt(value)); }
  function enabled() { return Boolean(mfa().secret); }
  function verify(code) {
    const value = mfa();
    if (!value.secret) return true;
    const text = String(code || '').trim();
    const step = Math.floor(Date.now() / 30000);
    if (/^\d{6}$/.test(text)) {
      for (const offset of [-1, 0, 1]) {
        const candidate = step + offset;
        if (candidate > (value.lastStep ?? -1) && crypto.timingSafeEqual(Buffer.from(text), Buffer.from(totp(value.secret, candidate)))) {
          saveMfa({ ...value, lastStep:candidate }); return true;
        }
      }
    }
    const hash = codeHash(text);
    const index = (value.recovery || []).indexOf(hash);
    if (index < 0) return false;
    value.recovery.splice(index, 1); saveMfa(value); return true;
  }
  function begin(session) {
    const secret = crypto.randomBytes(20).toString('base64');
    setSetting('owner_totp_pending', encrypt({ secret, session:session.token_hash, expires:Date.now() + 300000 }));
    return { secret:base32(Buffer.from(secret, 'base64')), expiresInSeconds:300 };
  }
  function finish(session, code) {
    const pending = decrypt(getSetting('owner_totp_pending', ''));
    if (!pending.secret || pending.session !== session.token_hash || pending.expires < Date.now()) throw new Error('Authenticator setup expired. Start setup again.');
    const step = Math.floor(Date.now() / 30000);
    const matched = [-1, 0, 1].map(offset => step + offset).find(candidate => /^\d{6}$/.test(String(code)) && crypto.timingSafeEqual(Buffer.from(String(code)), Buffer.from(totp(pending.secret, candidate))));
    if (matched === undefined) throw new Error('The authenticator code is incorrect.');
    const recovery = Array.from({ length:10 }, () => crypto.randomBytes(12).toString('hex'));
    saveMfa({ secret:pending.secret, lastStep:matched, recovery:recovery.map(codeHash) });
    setSetting('owner_totp_pending', '');
    db.prepare('DELETE FROM sessions WHERE token_hash<>?').run(session.token_hash);
    return { recoveryCodes:recovery };
  }
  function disable() { setSetting('owner_totp', ''); setSetting('owner_totp_pending', ''); }
  function savePolicy(input) {
    const value = validatePolicy(input); setSetting('owner_security_policy', JSON.stringify(value)); return value;
  }
  return { policy, savePolicy, enabled, verify, begin, finish, disable };
}
module.exports = { createOwnerSecurity, totp, base32 };
