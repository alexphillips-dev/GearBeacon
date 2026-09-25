import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The script is constant. File paths and key bytes travel through stdin, never command arguments.
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$item = Get-Item -LiteralPath $request.path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links are not supported.' }
$acl = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
if ($request.operation -ne 'verify') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  foreach ($value in $allowed) {
    $principal = [Security.Principal.SecurityIdentifier]::new($value)
    $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow'))
  }
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($request.path,$acl) } else { [IO.File]::SetAccessControl($request.path,$acl) }
}
$verified = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($request.path) } else { [IO.File]::GetAccessControl($request.path) }
if (-not $verified.AreAccessRulesProtected) { throw 'Permissions were not protected.' }
foreach ($rule in $verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Unexpected file access.' }
}
if ($request.operation -eq 'acl' -or $request.operation -eq 'verify') { [Console]::Out.Write('ok'); exit }
$bytes = [Convert]::FromBase64String($request.value)
$entropy = [Text.Encoding]::UTF8.GetBytes('GearBeacon:checkout-key:v1')
if ($request.operation -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
elseif ($request.operation -eq 'unprotect') { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
else { throw 'Unknown operation.' }
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

export function windowsOperation(file, operation, value = '') {
  try {
    return execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input:JSON.stringify({ path:file, operation, value }), encoding:'utf8', windowsHide:true, timeout:15000, stdio:['pipe','pipe','pipe'] }).trim();
  } catch { throw new Error('Unable to secure the private checkout vault for this Windows account. Check its permissions and use the original account.'); }
}
