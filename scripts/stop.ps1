# Stop ONLY the project API started by scripts/start.ps1 (pid stored in data/server.pid).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data/server.pid"
if (-not (Test-Path $pidFile)) {
  Write-Host "no server.pid found; nothing to stop"
  exit 0
}
$serverPid = [int](Get-Content $pidFile -Raw).Trim()
$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($null -eq $proc) {
  Write-Host "process $serverPid not running; removing stale pid file"
} else {
  Stop-Process -Id $serverPid -Force
  Write-Host "stopped project server pid $serverPid"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
