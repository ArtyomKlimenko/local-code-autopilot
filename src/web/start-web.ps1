param([switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$webRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$aiRoot = Split-Path -Parent $webRoot
$node = Join-Path $aiRoot "runtime\node-v22.23.2-win-x64\node.exe"
$settings = Get-Content -LiteralPath (Join-Path $webRoot "machine.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$env:LOCAL_AI_ROOT = $aiRoot
$env:LOCAL_CODE_PROJECTS_ROOT = $settings.projectsRoot
$env:LOCAL_CODE_WEB_PORT = [string]$settings.port
$url = "http://127.0.0.1:$($settings.port)"
$ready = $false
try {
  $response = Invoke-RestMethod -Uri "$url/api/bootstrap" -TimeoutSec 2
  $ready = [bool]$response.token
} catch {}
if (-not $ready) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    & schtasks.exe /Run /TN "LocalCode-Web" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not start LocalCode-Web scheduled task." }
  } else {
    $logDir = Join-Path $aiRoot "state\web"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $webRoot "server.mjs") + '"') -WorkingDirectory $webRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "server.out.log") -RedirectStandardError (Join-Path $logDir "server.err.log") | Out-Null
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-RestMethod -Uri "$url/api/bootstrap" -TimeoutSec 1
      if ($response.token) { $ready = $true; break }
    } catch {}
  }
}
if (-not $ready) { throw "Local Code web did not become ready. See C:\LocalAI\state\web\server.err.log" }
if (-not $NoBrowser) { Start-Process $url }
Write-Output $url
