param(
  [ValidateSet('start', 'stop', 'status')][string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $env:LOCALAPPDATA 'CodexConnector/data'
$recordFile = Join-Path $runtimeDir 'service.json'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$serviceProcess = $null
if (Test-Path -LiteralPath $recordFile) {
  $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
  $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt) {
    $serviceProcess = $candidate
  }
}
if ($Action -eq 'status') {
  if ($serviceProcess) { Write-Output "Running: PID $($serviceProcess.Id). Logs: $runtimeDir" }
  else { Write-Output 'Stopped' }
  exit 0
}
if ($Action -eq 'stop') {
  if (-not $serviceProcess) { Write-Output 'Already stopped'; exit 0 }
  New-Item -ItemType File -Force -Path (Join-Path $runtimeDir 'stop-request') | Out-Null
  if (-not $serviceProcess.WaitForExit(60000)) { throw 'Graceful shutdown is still pending. Inspect logs; no forced termination was performed.' }
  Write-Output 'Stopped'; exit 0
}
if ($serviceProcess) { Write-Output "Already running: PID $($serviceProcess.Id)"; exit 0 }
$entry = Join-Path $projectRoot 'dist/src/main.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm run build first.' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$started = Start-Process -FilePath $nodePath -ArgumentList @('--disable-warning=ExperimentalWarning', ('"' + $entry + '"'), 'run') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'service.log') -RedirectStandardError (Join-Path $runtimeDir 'service-error.log')
@{ pid = $started.Id; startedAt = $started.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $recordFile
Start-Sleep -Seconds 3
$started.Refresh()
if ($started.HasExited) { throw "Startup failed; inspect $runtimeDir/service.log and service-error.log" }
Write-Output "Started: PID $($started.Id). Check service.log for Feishu WebSocket ready and CodexConnector running."
