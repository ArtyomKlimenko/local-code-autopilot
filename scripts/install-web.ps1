param(
  [string]$LocalAiRoot = "C:\LocalAI",
  [Parameter(Mandatory = $true)][string]$ProjectsRoot,
  [int]$Port = 8766
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $repo "src\web"
$destination = Join-Path $LocalAiRoot "webui"
if (-not (Test-Path -LiteralPath (Join-Path $source "dist\index.html"))) {
  throw "Build the UI first: cd src\web; npm ci; npm run build"
}
if (-not (Test-Path -LiteralPath (Join-Path $LocalAiRoot "launcher\local-code.ps1"))) {
  throw "Install the local GPU launcher first."
}
$resolvedProjects = (Resolve-Path -LiteralPath $ProjectsRoot).Path
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($name in @("server.mjs", "feed.mjs", "launcher-helper.mjs", "start-web.ps1", "start-hidden.vbs", "THIRD_PARTY.md")) {
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force
}
Copy-Item -LiteralPath (Join-Path $source "dist") -Destination $destination -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo "docs\WEB_UI.md") -Destination (Join-Path $destination "README.md") -Force
@{ projectsRoot = $resolvedProjects; port = $Port } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination "machine.json") -Encoding UTF8
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\wscript.exe") -Argument ('"' + (Join-Path $destination "start-hidden.vbs") + '"') -WorkingDirectory $destination
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "LocalCode-Web" -Action $action -Principal $principal -Settings $settings -Description "Local Code web interface, on demand, ordinary user token" -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Programs")) "Local Code.lnk"))
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $destination "start-web.ps1") + '"'
$shortcut.WorkingDirectory = $destination
$shortcut.WindowStyle = 7
$shortcut.Description = "Local Code - local coding agent workspace"
$shortcut.Save()
Write-Output "Installed. Open Local Code from the Start menu."
