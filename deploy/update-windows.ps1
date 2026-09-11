[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Version, [string]$InstallDir = "$env:ProgramFiles\GearBeacon", [switch]$BackupConfirmed, [ValidateRange(1,65535)][int]$Port = 8787, [ValidateRange(1,300)][int]$TimeoutSeconds = 60)
$ErrorActionPreference = 'Stop'
if (-not $BackupConfirmed) { throw 'Use Prepare safe update in GearBeacon first, then rerun with -BackupConfirmed.' }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Version must be a release version such as 1.0.0.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ((Split-Path $InstallDir -Leaf) -ne 'GearBeacon') { throw 'InstallDir must resolve to a GearBeacon directory.' }
if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) { throw 'InstallDir must already exist.' }
foreach ($target in @($InstallDir, "$InstallDir/web", "$InstallDir/GearBeacon.exe")) {
  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Application paths must not be links or junctions.' }
}
$arch = 'x64'
$name = "GearBeacon-v$Version-windows-$arch"
$base = "https://github.com/alexphillips-dev/GearBeacon/releases/download/v$Version"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("gearbeacon-update-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
$changed = $false
try {
  Invoke-WebRequest "$base/$name.zip" -OutFile "$temp/$name.zip"
  Invoke-WebRequest "$base/$name.zip.sha256" -OutFile "$temp/$name.zip.sha256"
  $expected = ((Get-Content "$temp/$name.zip.sha256" -Raw) -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash "$temp/$name.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -notmatch '^[a-f0-9]{64}$' -or $expected -ne $actual) { throw 'Downloaded package checksum does not match release metadata.' }
  Expand-Archive "$temp/$name.zip" -DestinationPath $temp
  foreach ($entry in @('GearBeacon.exe', 'web/index.html', 'release-manifest.json')) {
    if (-not (Test-Path -LiteralPath "$temp/$name/$entry" -PathType Leaf)) { throw 'Downloaded package is incomplete.' }
  }
  $changed = $true
  Stop-ScheduledTask -TaskName 'GearBeacon' -ErrorAction Stop
  Copy-Item -LiteralPath "$temp/$name/GearBeacon.exe" -Destination "$InstallDir/GearBeacon.exe" -Force
  $webDir = [IO.Path]::GetFullPath((Join-Path $InstallDir 'web'))
  if ((Split-Path $webDir -Parent) -ne $InstallDir) { throw 'Web directory must remain inside InstallDir.' }
  if (Test-Path -LiteralPath $webDir) { Remove-Item -LiteralPath $webDir -Recurse -Force }
  Copy-Item -LiteralPath "$temp/$name/web" -Destination "$InstallDir/web" -Recurse -Force
  Copy-Item -LiteralPath "$temp/$name/release-manifest.json" -Destination "$InstallDir/release-manifest.json" -Force
  if (Test-Path -LiteralPath "$temp/$name/build-info.json") { Copy-Item -LiteralPath "$temp/$name/build-info.json" -Destination "$InstallDir/build-info.json" -Force }
  elseif (Test-Path -LiteralPath "$InstallDir/build-info.json") { Remove-Item -LiteralPath "$InstallDir/build-info.json" -Force }
  Start-ScheduledTask -TaskName 'GearBeacon'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
      $observed = if ($health.packageVersion) { $health.packageVersion } else { $health.version }
      if ($health.ok -is [bool] -and $health.ok -eq $true -and $health.name -ceq 'GearBeacon' -and $health.version -ceq ($Version -split '[-+]')[0] -and $observed -ceq $Version) {
        Write-Host "GearBeacon V$Version verified: local startup health and expected version. Data was preserved."
        return
      }
    } catch { Write-Verbose 'Waiting for GearBeacon startup.' }
    Start-Sleep -Milliseconds 500
  } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
  throw 'Startup/version verification timed out.'
} catch {
  if ($changed) {
    Write-Warning 'Update was not verified. Inspect the GearBeacon scheduled task and confirm its configured port.'
    Write-Warning 'To roll back: Stop-ScheduledTask -TaskName GearBeacon; restore a compatible pre-update database and matching secrets.key while stopped; reinstall the previous exact version, then start and verify it. Never run an older application against a migrated database. Keep the backup.'
  }
  throw
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath($temp)
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ((Split-Path $resolvedTemp -Parent) -eq $tempParent -and (Split-Path $resolvedTemp -Leaf) -like 'gearbeacon-update-*' -and (Test-Path -LiteralPath $resolvedTemp)) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
}
