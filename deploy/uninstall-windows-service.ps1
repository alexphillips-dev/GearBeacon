[CmdletBinding(SupportsShouldProcess)]
param([string]$InstallDir = "$env:ProgramFiles\GearBeacon", [string]$DataDir = "$env:ProgramData\GearBeacon", [switch]$RemoveData)
$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$DataDir = [IO.Path]::GetFullPath($DataDir)
if ((Split-Path $InstallDir -Leaf) -ne 'GearBeacon' -or (Split-Path $DataDir -Leaf) -ne 'GearBeacon') { throw 'InstallDir and DataDir must each resolve to a GearBeacon directory.' }
if (Get-ScheduledTask -TaskName 'GearBeacon' -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName 'GearBeacon' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'GearBeacon' -Confirm:$false }
if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
if ($RemoveData -and (Test-Path -LiteralPath $DataDir)) { Remove-Item -LiteralPath $DataDir -Recurse -Force; Write-Host "Removed GearBeacon data from $DataDir." } else { Write-Host "GearBeacon was removed; data was preserved in $DataDir." }
