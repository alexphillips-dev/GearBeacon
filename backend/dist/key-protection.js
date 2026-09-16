// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
// The script is constant. Paths and key material use stdin, never command arguments.
const windowsScript = String.raw `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$item = Get-Item -LiteralPath $request.path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links are not supported.' }
$acl = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
foreach ($value in $allowed) {
  $principal = [Security.Principal.SecurityIdentifier]::new($value)
  $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow'))
}
if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($request.path,$acl) } else { [IO.File]::SetAccessControl($request.path,$acl) }
$verified = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
if (-not $verified.AreAccessRulesProtected) { throw 'Permissions were not protected.' }
foreach ($rule in $verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Unexpected file access.' }
}
if ($request.operation -eq 'acl') { [Console]::Out.Write('ok'); exit }
$bytes = [Convert]::FromBase64String($request.value)
$entropy = [Text.Encoding]::UTF8.GetBytes('GearBeacon:notification-key:v1')
if ($request.operation -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
else { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
[Console]::Out.Write([Convert]::ToBase64String($result))
`;
function windowsOperation(file, operation, value = '') {
    try {
        return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')], { input: JSON.stringify({ path: file, operation, value }), encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    catch {
        throw new Error('Unable to secure local data for this Windows account. Check data-directory permissions and run under the original service or user account.');
    }
}
function secureDataDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('The data directory must be a real directory.');
    if (process.platform === 'win32')
        windowsOperation(directory, 'acl');
    else {
        fs.chmodSync(directory, 0o700);
        if ((fs.statSync(directory).mode & 0o777) !== 0o700)
            throw new Error('Unable to restrict the data directory to its owner.');
    }
}
let cachedWindowsKey;
function loadProtectedKey(file) {
    if (process.platform === 'win32' && cachedWindowsKey?.file === file)
        return cachedWindowsKey.key;
    if (!fs.existsSync(file)) {
        const generated = crypto.randomBytes(32).toString('base64');
        const stored = process.platform === 'win32' ? `dpapi-v1:${windowsOperation(path.dirname(file), 'protect', generated)}` : generated;
        fs.writeFileSync(file, stored, { flag: 'wx', mode: 0o600 });
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Secret key path is not a regular file.');
    if (process.platform !== 'win32') {
        fs.chmodSync(file, 0o600);
        if ((fs.lstatSync(file).mode & 0o777) !== 0o600)
            throw new Error('Unable to restrict the secret key to its owner.');
    }
    else
        windowsOperation(file, 'acl');
    const stored = fs.readFileSync(file, 'utf8').trim();
    const protectedKey = stored.startsWith('dpapi-v1:');
    if (protectedKey && process.platform !== 'win32')
        throw new Error('This key belongs to its original Windows account. Use an encrypted transfer export to move installations.');
    const key = Buffer.from(protectedKey ? windowsOperation(file, 'unprotect', stored.slice(9)) : stored, 'base64');
    if (key.length !== 32)
        throw new Error('Secret key file is invalid.');
    if (process.platform === 'win32') {
        if (!protectedKey) {
            const wrapped = windowsOperation(file, 'protect', key.toString('base64'));
            const temporary = `${file}.${crypto.randomUUID()}.key.pending`;
            try {
                fs.writeFileSync(temporary, `dpapi-v1:${wrapped}`, { flag: 'wx', mode: 0o600 });
                windowsOperation(temporary, 'acl');
                // Verify before replacing the legacy key; encryption does not change key bytes.
                if (!key.equals(Buffer.from(windowsOperation(temporary, 'unprotect', wrapped), 'base64')))
                    throw new Error('Key protection verification failed.');
                fs.renameSync(temporary, file);
            }
            finally {
                if (fs.existsSync(temporary))
                    fs.unlinkSync(temporary);
            }
        }
        cachedWindowsKey = { file, key };
    }
    return key;
}
module.exports = { secureDataDirectory, loadProtectedKey };
