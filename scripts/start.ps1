# Start the project API bound to 127.0.0.1 on an automatic free port.
# Manages only this project's server process; data stays under .\data.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force $dataDir | Out-Null
$pidFile = Join-Path $dataDir "server.pid"
$portFile = Join-Path $dataDir "server.port"
foreach ($f in @($pidFile, $portFile)) {
  if (Test-Path $f) {
    $oldPid = [int](Get-Content $f -Raw).Trim()
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
      Write-Error "server already running (pid $oldPid)"
      exit 1
    }
    Remove-Item $f -Force
  }
}
$db = Join-Path $dataDir "ctm.sqlite"
$out = Join-Path $dataDir "server.out.log"
$err = Join-Path $dataDir "server.err.log"
$proc = Start-Process -FilePath "node" `
  -ArgumentList "--experimental-sqlite", (Join-Path $root "src/serve.ts") `
  -WorkingDirectory $root `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
for ($i = 0; $i -lt 50; $i++) {
  if (Test-Path $portFile) {
    $port = (Get-Content $portFile -Raw).Trim()
    Write-Host "CTM API started: pid $($proc.Id), http://127.0.0.1:$port"
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Write-Error "server did not write a port in time; see $err"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
exit 1
