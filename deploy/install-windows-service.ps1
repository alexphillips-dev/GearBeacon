[CmdletBinding()]
param([string]$InstallDir = "$env:ProgramFiles\GearBeacon", [string]$DataDir = "$env:ProgramData\GearBeacon")
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from an elevated PowerShell window.' }
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the GearBeacon data-directory ACL.' }
Copy-Item -LiteralPath "$source\GearBeacon.exe" -Destination "$InstallDir\GearBeacon.exe" -Force
Copy-Item -LiteralPath "$source\web" -Destination "$InstallDir\web" -Recurse -Force
Copy-Item -LiteralPath "$source\release-manifest.json" -Destination "$InstallDir\release-manifest.json" -Force
$launcher = @"
`$env:GEARBEACON_DATA_DIR = '$($DataDir.Replace("'", "''"))'
`$env:GEARBEACON_ACCESS_MODE = 'private'
`$env:GEARBEACON_BIND_HOST = '0.0.0.0'
& '$($InstallDir.Replace("'", "''"))\GearBeacon.exe' *>> '$($DataDir.Replace("'", "''"))\gearbeacon.log'
"@
Set-Content -LiteralPath "$InstallDir\service-launch.ps1" -Value $launcher -Encoding UTF8
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the GearBeacon installation-directory ACL.' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\service-launch.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'GearBeacon' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'GearBeacon'
Write-Host "GearBeacon service installed as LocalService. Data is stored in $DataDir. Open http://localhost:8787 and use the setup token in $DataDir\gearbeacon.log."
