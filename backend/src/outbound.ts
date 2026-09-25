// @ts-nocheck
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['169.254.0.0',16],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
blocked.addAddress('100.100.100.200','ipv4');
for (const [ip, bits] of [['::',128],['fe80::',10],['ff00::',8],['64:ff9b::',96],['64:ff9b:1::',48],['2002::',16],['2001::',32]]) blocked.addSubnet(ip,bits,'ipv6');
blocked.addAddress('fd00:ec2::254','ipv6');
const privateAddresses = new net.BlockList();
for (const [ip,bits] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['127.0.0.0',8],['100.64.0.0',10]]) privateAddresses.addSubnet(ip,bits,'ipv4');
privateAddresses.addSubnet('fc00::',7,'ipv6'); privateAddresses.addAddress('::1','ipv6');
function addressPolicy(address) {
  const family = net.isIP(address);
  if (!family) return 'blocked';
  // BlockList handles IPv4-mapped IPv6 addresses against IPv4 rules too.
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (blocked.check(address,type)) return 'blocked';
  return privateAddresses.check(address,type) ? 'private' : 'public';
}
function normalizePrivateHosts(value) {
  const hosts = Array.isArray(value) ? value : String(value || '').split(',');
  if (hosts.length > 32) throw new Error('Use at most 32 private notification hostnames.');
  return [...new Set(hosts.map(item => String(item).trim().toLowerCase()).filter(Boolean).map(host => {
    const bare = host.replace(/^\[|\]$/g,'');
    if (!net.isIP(bare) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(bare)) throw new Error('Enter notification hostnames or IP addresses without URLs, ports, or paths.');
    return bare;
  }))];
}
async function notificationFetch(url, options = {}, timeoutMs = 10000, { allowedUrls = [], privateHosts = [], lookup = dns.lookup } = {}) {
  const target = new URL(url);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password || !allowedUrls.some(value => value && new URL(value).origin === target.origin)) throw new Error('Notification destination is not configured.');
  const hostname = target.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const allowPrivate = Boolean(net.isIP(hostname)) || hostname === 'localhost' || normalizePrivateHosts(privateHosts).includes(hostname);
  const signal = AbortSignal.timeout(timeoutMs);
  const addresses = net.isIP(hostname) ? [{ address:hostname, family:net.isIP(hostname) }] : await Promise.race([
    lookup(hostname,{ all:true, verbatim:true }),
    new Promise((_,reject) => signal.addEventListener('abort',() => reject(new Error('Notification lookup timed out.')),{ once:true }))
  ]);
  if (!addresses.length || addresses.some(item => addressPolicy(item.address) === 'blocked' || (addressPolicy(item.address) === 'private' && !allowPrivate))) throw new Error('Notification destination is blocked. Approve private server hostnames in Settings > Security. Metadata and link-local addresses are never allowed.');
  // Pin the checked address for this connection, retaining Host and TLS hostname verification.
  const address = addresses[0];
  return new Promise((resolve,reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method:options.method || 'GET', headers:options.headers, signal, agent:false,
      lookup:(_name, settings, done) => settings.all ? done(null,[address]) : done(null,address.address,address.family),
    }, response => {
      const chunks = []; let size = 0;
      if (response.statusCode >= 300 && response.statusCode < 400) { reject(new Error('Notification redirects are blocked. Configure the final destination URL.')); response.destroy(); request.destroy(); return; }
      response.on('aborted',() => reject(new Error('Notification response was interrupted.')));
      response.on('data',chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error('Notification response exceeded the size limit.'));
        else chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end',() => resolve(new Response([204,205,304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status:response.statusCode, headers:response.headers })));
    });
    request.on('error',(err) => {
      const networkCodes = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','ABORT_ERR']);
      reject(new Error(networkCodes.has(err?.code) ? 'Notification network connection failed.' : 'Notification request failed or was blocked. Check the destination, TLS certificate, and private-host approval.'));
    });
    request.end(options.body);
  });
}
module.exports = { notificationFetch, normalizePrivateHosts, addressPolicy };
