$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $project 'logs'
$logFile = Join-Path $logDir 'dashboard.log'
$url = 'http://127.0.0.1:3077/'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-Dashboard {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Dashboard)) {
  $command = 'cd /d "' + $project + '" && set "OPEN_BROWSER=false" && node src/index.js web >> "' + $logFile + '" 2>&1'
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $command) -WorkingDirectory $project -WindowStyle Hidden
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Dashboard) {
    $ready = $true
    break
  }
}

if ($ready) {
  Start-Process $url
} else {
  Start-Process notepad.exe $logFile
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Opportunity Monitor did not start. I opened the log file.", "Opportunity Monitor")
}
