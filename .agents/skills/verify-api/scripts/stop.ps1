#Requires -Version 5.1
<#
.SYNOPSIS
  Tear down exactly the instance this skill started. Never kills by process name.
.DESCRIPTION
  Reads the PID file written by the launch block in SKILL.md, stops that one process, waits for the
  port to free, and removes the PID file. Leaves .verify/evidence untouched.
  Runs on Windows PowerShell 5.1 and PowerShell 7+.
.EXAMPLE
  powershell -NoProfile -File .agents\skills\verify-api\scripts\stop.ps1 -Port 3100
#>
[CmdletBinding()]
param(
  [int]$Port = 3100,
  [string]$Root
)

# $PSScriptRoot is not populated yet while param defaults are bound under
# `powershell -File`, so resolve the repo root here instead.
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path }

$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $Root ".verify\run\server-$Port.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "[stop] no PID file for port $Port - nothing started by this skill"
  exit 0
}

$record = Get-Content $pidFile -Raw | ConvertFrom-Json
$targetPid = [int]$record.pid

$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($proc) {
  # Windows cannot deliver SIGINT/SIGTERM to another console process, so this is a
  # hard stop; graceful-shutdown behavior is exercised on Linux/macOS only.
  Stop-Process -Id $targetPid -Force
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  Write-Host "[stop] stopped pid $targetPid (port $Port)"
} else {
  Write-Host "[stop] pid $targetPid already gone"
}

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  $stillListening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  if (-not $stillListening) { break }
  Start-Sleep -Milliseconds 200
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
  Write-Host "[stop] WARNING: something still listens on port $Port (not ours)" -ForegroundColor Yellow
}
Write-Host "[stop] evidence kept at: $($record.evidenceDir)"
