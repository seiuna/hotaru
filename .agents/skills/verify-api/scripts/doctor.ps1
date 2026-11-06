#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only health check: is this instance worth driving?
.DESCRIPTION
  Confirms the recorded instance is alive, that the port is owned by that exact
  PID (ours, not another process), and that /health reports a sane payload with
  non-decreasing uptime. Starts nothing, changes nothing.
  Runs on Windows PowerShell 5.1 and PowerShell 7+.
.EXAMPLE
  powershell -NoProfile -File .agents\skills\verify-api\scripts\doctor.ps1 -Port 3100
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
$problems = New-Object System.Collections.Generic.List[string]
$pidFile = Join-Path $Root ".verify\run\server-$Port.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "[doctor] no PID file for port $Port -> run the launch block in SKILL.md first" -ForegroundColor Red
  exit 1
}
$record = Get-Content $pidFile -Raw | ConvertFrom-Json
$expectedPid = [int]$record.pid

$proc = Get-Process -Id $expectedPid -ErrorAction SilentlyContinue
if (-not $proc) {
  $problems.Add("recorded pid $expectedPid is not running (stale PID file)")
} elseif ($proc.ProcessName -ne 'node') {
  $problems.Add("pid $expectedPid is '$($proc.ProcessName)', expected node")
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  $problems.Add("nothing is listening on port $Port")
} else {
  $owners = @($listeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
  if ($owners -notcontains $expectedPid) {
    $problems.Add("port $Port is owned by pid $($owners -join ', '), not ours ($expectedPid)")
  }
}

$base = "http://localhost:$Port"
$first = $null
try {
  $first = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 3 -UseBasicParsing
} catch {
  $problems.Add("/health unreachable: $($_.Exception.Message)")
}

if ($first) {
  if ($first.status -ne 'ok') { $problems.Add("/health status is '$($first.status)', expected ok") }
  if ($first.service -ne 'skymatrix-api') { $problems.Add("/health service is '$($first.service)', expected skymatrix-api") }
  if ($null -eq $first.uptimeSeconds) { $problems.Add('/health has no uptimeSeconds') }
  try {
    [void][datetime]::Parse($first.timestamp)
  } catch {
    $problems.Add("/health timestamp '$($first.timestamp)' is not a date")
  }

  Start-Sleep -Seconds 1
  try {
    $second = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 3 -UseBasicParsing
    if ($null -ne $first.uptimeSeconds -and $second.uptimeSeconds -lt $first.uptimeSeconds) {
      $problems.Add("uptime went backwards ($($first.uptimeSeconds) -> $($second.uptimeSeconds))")
    }
  } catch {
    $problems.Add("/health second call failed: $($_.Exception.Message)")
  }
}

if ($problems.Count -gt 0) {
  Write-Host "[doctor] NOT healthy on port ${Port}:" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

Write-Host "[doctor] OK port=$Port pid=$expectedPid service=$($first.service) uptime=$($first.uptimeSeconds)s"
exit 0
