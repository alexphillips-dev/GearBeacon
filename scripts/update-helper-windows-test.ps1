$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gearbeacon-updater-test-' + [guid]::NewGuid())
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../deploy/update-windows.ps1'))
$name = 'GearBeacon-v1.2.1-windows-x64'
$install = Join-Path $fixture 'GearBeacon'
$archive = Join-Path $fixture 'package.zip'
$global:GearBeaconTestScenario = 'success'
$global:GearBeaconTestActions = @()
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-WebRequest {
  param($Uri, $OutFile)
  Assert ($Uri -like 'https://github.com/alexphillips-dev/GearBeacon/releases/download/v1.2.1/*') 'Unexpected download destination.'
  if ($Uri.EndsWith('.attestation.jsonl')) { if ($global:GearBeaconTestScenario -eq 'missing-bundle') { throw 'Missing attestation.' }; Set-Content -LiteralPath $OutFile 'mock signed bundle'; return }
  if ($Uri.EndsWith('.sha256')) {
    $hash = if ($global:GearBeaconTestScenario -eq 'checksum') { '0' * 64 } else { (Get-FileHash $archive -Algorithm SHA256).Hash }
    Set-Content -LiteralPath $OutFile -Value $hash
  } else { Copy-Item -LiteralPath $archive -Destination $OutFile }
}
function gh {
  Assert (($args -join ' ') -like '*--repo alexphillips-dev/GearBeacon*--signer-workflow alexphillips-dev/GearBeacon/.github/workflows/package.yml*--source-ref refs/tags/v1.2.1 --source-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --deny-self-hosted-runners') 'Missing attestation identity restrictions.'
  $global:LASTEXITCODE = if ($global:GearBeaconTestScenario -eq 'provenance') { 1 } else { 0 }
}
function Stop-ScheduledTask {
  param($TaskName, $ErrorAction)
  Assert ($TaskName -eq 'GearBeacon') 'Unexpected task name.'
  $global:GearBeaconTestActions += 'stop'
  if ($global:GearBeaconTestScenario -eq 'stop') { throw 'Mock stop failed.' }
}
function Start-ScheduledTask {
  param($TaskName)
  $global:GearBeaconTestActions += 'start'
  if ($global:GearBeaconTestScenario -eq 'restart') { throw 'Mock restart failed.' }
}
function Invoke-RestMethod {
  param($Uri, $TimeoutSec)
  if ($Uri -eq 'https://api.github.com/repos/alexphillips-dev/GearBeacon/commits/refs%2Ftags%2Fv1.2.1') { return @{sha=('a' * 40)} }
  Assert ($Uri -eq 'http://127.0.0.1:9876/healthz') 'Custom port or local health path was lost.'
  $global:GearBeaconTestActions += 'health'
  if ($global:GearBeaconTestScenario -eq 'unreachable') { throw 'Mock connection refused.' }
  if ($global:GearBeaconTestScenario -eq 'wrong-version') { return @{ok=$true; name='GearBeacon'; version='1.2.0'; packageVersion='1.2.1'} }
  if ($global:GearBeaconTestScenario -eq 'wrong-app') { return @{ok=$true; name='Another app'; version='1.2.1'} }
  return @{ok=$true; name='GearBeacon'; version='1.2.1'; packageVersion='1.2.1'}
}
try {
  New-Item -ItemType Directory -Path "$fixture/$name/web", "$install/web" -Force | Out-Null
  Set-Content "$fixture/$name/GearBeacon.exe" 'new executable fixture'
  Set-Content "$fixture/$name/web/index.html" '<html>new UI fixture</html>'
  Set-Content "$fixture/$name/release-manifest.json" '{"version":"1.2.1"}'
  Set-Content "$fixture/$name/build-info.json" '{"packageVersion":"1.2.1","commit":"fixture"}'
  Compress-Archive -LiteralPath "$fixture/$name" -DestinationPath $archive
  foreach ($case in @('checksum','provenance','missing-bundle','stop','restart','wrong-version','wrong-app','unreachable','success')) {
    $global:GearBeaconTestScenario = $case
    $global:GearBeaconTestActions = @()
    Set-Content "$install/GearBeacon.exe" 'old executable fixture'
    Set-Content "$install/web/obsolete.html" 'old UI fixture'
    $failed = $false
    $result = @()
    try { & $helper -Version '1.2.1' -InstallDir $install -BackupConfirmed -Port 9876 -TimeoutSeconds 1 -WarningVariable result } catch { $failed = $true }
    if ($case -eq 'success') {
      Assert (-not $failed) 'Healthy update failed.'
      Assert (($global:GearBeaconTestActions -join ',') -eq 'stop,start,health') 'Healthy update did not stop, restart and verify.'
      Assert (-not (Test-Path "$install/web/obsolete.html")) 'Old web assets remained.'
      Assert ((Get-Content "$install/build-info.json" -Raw).Contains('1.2.1')) 'Build metadata was not updated.'
    } else {
      Assert $failed "The $case failure was reported as success."
      if ($case -in @('checksum','provenance','missing-bundle')) { Assert ($global:GearBeaconTestActions.Count -eq 0) 'Checksum failure stopped the application.' }
      if ($case -in @('checksum','provenance','missing-bundle','stop')) { Assert ((Get-Content "$install/GearBeacon.exe" -Raw).Contains('old executable')) 'Pre-install failure changed application files.' }
      if ($case -notin @('checksum','provenance','missing-bundle')) { Assert (($result -join ' ').Contains('matching secrets.key')) 'Recovery instructions omitted the compatible database/key requirement.' }
    }
  }
  $installerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../deploy/install-windows-service.ps1'))
  $parseErrors = $null
  $tokens = $null
  $installerAst = [Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$parseErrors)
  Assert ($parseErrors.Count -eq 0) 'Windows installer has PowerShell syntax errors.'
  $webFunction = $installerAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-GearBeaconWeb' }, $true)
  Assert ($null -ne $webFunction) 'Windows installer web replacement function is missing.'
  . ([scriptblock]::Create($webFunction.Extent.Text))
  Set-Content -LiteralPath "$install/web/obsolete.html" -Value 'old UI fixture'
  Install-GearBeaconWeb -SourceDir "$fixture/$name" -DestinationDir $install
  Assert (-not (Test-Path -LiteralPath "$install/web/obsolete.html")) 'Windows reinstall kept an obsolete web file.'
  Assert (-not (Test-Path -LiteralPath "$install/web/web")) 'Windows reinstall nested the new web directory.'
  Assert ((Get-Content -LiteralPath "$install/web/index.html" -Raw).Contains('new UI fixture')) 'Windows reinstall did not serve the new web files.'
  Write-Host 'Windows updater tests passed: checksum, stop/restart failures, wrong app/version, unreachable health, metadata and successful startup.'
} finally {
  $resolved = [IO.Path]::GetFullPath($fixture)
  $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ((Split-Path $resolved -Parent) -eq $parent -and (Split-Path $resolved -Leaf) -like 'gearbeacon-updater-test-*' -and (Test-Path -LiteralPath $resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
