[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Version, [string]$InstallDir = "$env:ProgramFiles\GearBeacon", [switch]$BackupConfirmed)
$ErrorActionPreference = 'Stop'
if (-not $BackupConfirmed) { throw 'Use Prepare safe update in GearBeacon first, then rerun with -BackupConfirmed.' }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Version must be a release version such as 1.0.0.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ((Split-Path $InstallDir -Leaf) -ne 'GearBeacon') { throw 'InstallDir must resolve to a GearBeacon directory.' }
$arch = 'x64'
$name = "GearBeacon-v$Version-windows-$arch"
$base = "https://github.com/alexphillips-dev/GearBeacon/releases/download/v$Version"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("gearbeacon-update-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Invoke-WebRequest "$base/$name.zip" -OutFile "$temp/$name.zip"
  Invoke-WebRequest "$base/$name.zip.sha256" -OutFile "$temp/$name.zip.sha256"
  $expected = ((Get-Content "$temp/$name.zip.sha256" -Raw) -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash "$temp/$name.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw 'Downloaded package checksum does not match the signed release metadata.' }
  Expand-Archive "$temp/$name.zip" -DestinationPath $temp
  Stop-ScheduledTask -TaskName 'GearBeacon' -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath "$temp/$name/GearBeacon.exe" -Destination "$InstallDir/GearBeacon.exe" -Force
  if (Test-Path "$InstallDir/web") { Remove-Item -LiteralPath "$InstallDir/web" -Recurse -Force }
  Copy-Item -LiteralPath "$temp/$name/web" -Destination "$InstallDir/web" -Recurse -Force
  Copy-Item -LiteralPath "$temp/$name/release-manifest.json" -Destination "$InstallDir/release-manifest.json" -Force
  Start-ScheduledTask -TaskName 'GearBeacon'
  Write-Host "GearBeacon updated to V$Version. Data was preserved."
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force } }
