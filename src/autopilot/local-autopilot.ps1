param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LocalAutopilotArgs
)

$ErrorActionPreference = "Stop"

$BaseDir = if ($env:LOCAL_AI_ROOT) { $env:LOCAL_AI_ROOT } else { "C:\LocalAI" }
$NodeExe = Join-Path $BaseDir "runtime\node-v22.23.2-win-x64\node.exe"
$Supervisor = Join-Path $BaseDir "autopilot\supervisor.mjs"
$LocalCode = Join-Path $BaseDir "launcher\local-code.ps1"
$DefaultSshKey = if ($env:LOCAL_AUTOPILOT_SSH_KEY) { $env:LOCAL_AUTOPILOT_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
$DefaultRemoteHost = $env:LOCAL_AUTOPILOT_DEFAULT_REMOTE_HOST
$DefaultContext = 24576

function Fail([string]$Message) {
  Write-Error "[local-autopilot] $Message"
  exit 1
}

function Show-Usage {
@"
local-autopilot new <project-folder> <prompt-file> [--remote user@ip:/abs/path] [--name name] [--ctx 24576] [--force]
local-autopilot start <project-folder|autopilot.json> [--ctx 24576]
local-autopilot status <project-folder|autopilot.json>
local-autopilot watch <project-folder|autopilot.json>
local-autopilot stop <project-folder|autopilot.json>

Recommended flow:
  local-autopilot new C:\work\my-project C:\work\prompt.md --remote user@vm-host:/home/user/my-project
  local-autopilot start C:\work\my-project
  local-autopilot watch C:\work\my-project
"@ | Write-Host
}

function Resolve-FullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { Fail "missing path" }
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Resolve-ConfigPath([string]$Target) {
  $path = Resolve-FullPath $Target
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    return $path
  }
  $config = Join-Path $path ".agent\autopilot.json"
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    Fail "autopilot config not found: $config"
  }
  return $config
}

function Safe-Name([string]$Value) {
  $name = ($Value -replace '[^A-Za-z0-9_.-]+', '-').Trim('-')
  if ([string]::IsNullOrWhiteSpace($name)) { return "project" }
  return $name.ToLowerInvariant()
}

function Parse-Remote([string]$Remote, [string]$ProjectName) {
  if ([string]::IsNullOrWhiteSpace($Remote)) {
    if ([string]::IsNullOrWhiteSpace($DefaultRemoteHost)) { Fail "--remote is required unless LOCAL_AUTOPILOT_DEFAULT_REMOTE_HOST is configured" }
    return @{
      Host = $DefaultRemoteHost
      Cwd = "/home/user/$ProjectName"
    }
  }
  $idx = $Remote.IndexOf(":")
  if ($idx -lt 1) { Fail "--remote must look like user@ip:/absolute/path" }
  $remoteHostValue = $Remote.Substring(0, $idx)
  $cwd = $Remote.Substring($idx + 1)
  if (-not $cwd.StartsWith("/")) { Fail "--remote path must be absolute on Linux" }
  return @{ Host = $remoteHostValue; Cwd = $cwd.TrimEnd("/") }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-Autopilot([string[]]$Rest) {
  if ($Rest.Count -lt 2) { Fail "usage: local-autopilot new <project-folder> <prompt-file> ..." }
  $projectRoot = Resolve-FullPath $Rest[0]
  $promptFile = Resolve-FullPath $Rest[1]
  if (-not (Test-Path -LiteralPath $promptFile -PathType Leaf)) { Fail "prompt file not found: $promptFile" }

  $ctx = $DefaultContext
  $name = Safe-Name ([System.IO.Path]::GetFileName($projectRoot))
  $remote = ""
  $force = $false

  $i = 2
  while ($i -lt $Rest.Count) {
    $arg = $Rest[$i]
    if ($arg -eq "--remote") {
      if ($i + 1 -ge $Rest.Count) { Fail "--remote requires user@ip:/abs/path" }
      $remote = $Rest[$i + 1]
      $i += 1
    } elseif ($arg -eq "--name") {
      if ($i + 1 -ge $Rest.Count) { Fail "--name requires a value" }
      $name = Safe-Name $Rest[$i + 1]
      $i += 1
    } elseif ($arg -eq "--ctx" -or $arg -eq "--context") {
      if ($i + 1 -ge $Rest.Count) { Fail "--ctx requires a token count" }
      if (-not [int]::TryParse($Rest[$i + 1], [ref]$ctx)) { Fail "--ctx must be an integer" }
      $i += 1
    } elseif ($arg -eq "--force") {
      $force = $true
    } else {
      Fail "unknown new argument: $arg"
    }
    $i += 1
  }

  if ($ctx -lt 8192 -or $ctx -gt 65536 -or ($ctx % 1024) -ne 0) {
    Fail "--ctx must be a multiple of 1024 between 8192 and 65536"
  }

  New-Item -ItemType Directory -Force -Path $projectRoot | Out-Null
  $agentDir = Join-Path $projectRoot ".agent"
  New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

  $goalPath = Join-Path $agentDir "GOAL.md"
  $tasksPath = Join-Path $agentDir "tasks.json"
  $configPath = Join-Path $agentDir "autopilot.json"
  $planPath = Join-Path $projectRoot "PLAN.md"
  foreach ($path in @($goalPath, $tasksPath, $configPath, $planPath)) {
    if ((Test-Path -LiteralPath $path) -and -not $force) {
      Fail "$path already exists; use --force only when you intentionally want to replace the autopilot scaffold"
    }
  }

  $prompt = Get-Content -LiteralPath $promptFile -Raw -Encoding UTF8
  $remoteInfo = Parse-Remote $remote $name
  $runDir = Join-Path $BaseDir "autopilot\runs\$name"
  $sessionDir = Join-Path $BaseDir "sessions\autopilot-$name"

  $goal = @"
# Goal

$prompt

## Autopilot Operating Rules

- Work only in the configured project/sandbox unless a task explicitly requires otherwise.
- First split this goal into small independently reviewable tasks.
- Keep each task narrow: inspect, implement, test, deploy, and document as separate steps when the work is broad.
- Do not read or print private keys, credentials, real browser-login profile contents, or unrelated files.
- Long-running servers/watchers must be started with timeout/background execution plus explicit health checks.
- Finish each task with concrete verification evidence.
"@

  $plan = @"
# Autopilot Plan

- [ ] 0.1 Bootstrap planning from GOAL.md
"@

  $tasks = [ordered]@{
    version = 1
    projectName = $name
    goalFile = ".agent/GOAL.md"
    planFile = "PLAN.md"
    tasks = @(
      [ordered]@{
        id = "0.1"
        title = "Bootstrap planning from GOAL.md"
        status = "pending"
        kind = "planner"
        canManagePlan = $true
        scope = "Inspect the project and GOAL.md, then replace PLAN.md and .agent/tasks.json with a small ordered implementation plan. Do not implement the project changes in this bootstrap task."
        acceptance = @(
          "PLAN.md contains a concise ordered checklist of implementation tasks.",
          ".agent/tasks.json contains the same task ids, each with title, status pending, scope, acceptance, and requiresUserApproval.",
          "Tasks are small enough for worker/reviewer passes and do not include this bootstrap task."
        )
        requiresUserApproval = $false
      }
    )
  }

  $config = [ordered]@{
    version = 1
    projectRoot = $projectRoot
    tasksFile = ".agent/tasks.json"
    goalFile = ".agent/GOAL.md"
    planFile = "PLAN.md"
    stateFile = ".agent/state.json"
    journalFile = ".agent/journal.md"
    runDirectory = $runDir
    piSessionDirectory = $sessionDir
    nodeExecutable = $NodeExe
    piCli = Join-Path $BaseDir "pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
    extension = Join-Path $BaseDir "autopilot\pi-autopilot-extension.ts"
    provider = "local-code"
    model = "ornith-1.5-9b-abliterated"
    thinking = "high"
    contextWindow = $ctx
    executionPolicy = "bootstrap-planned-progress-checkpointed-unbounded"
    attemptTimeoutMinutes = $null
    remoteHost = $remoteInfo.Host
    remoteCwd = $remoteInfo.Cwd
    sshKeyPath = $DefaultSshKey
  }

  Write-Utf8NoBom $goalPath $goal
  Write-Utf8NoBom $planPath $plan
  Write-Utf8NoBom $tasksPath (($tasks | ConvertTo-Json -Depth 20) + "`n")
  Write-Utf8NoBom $configPath (($config | ConvertTo-Json -Depth 20) + "`n")

  Write-Host "[local-autopilot] created $configPath"
  Write-Host "[local-autopilot] remote target: $($remoteInfo.Host):$($remoteInfo.Cwd)"
  Write-Host "[local-autopilot] start with: local-autopilot start `"$projectRoot`""
}

function Start-Autopilot([string[]]$Rest) {
  if ($Rest.Count -lt 1) { Fail "usage: local-autopilot start <project-folder|autopilot.json> [--ctx 24576]" }
  $config = Resolve-ConfigPath $Rest[0]
  $ctx = $DefaultContext
  $i = 1
  while ($i -lt $Rest.Count) {
    $arg = $Rest[$i]
    if ($arg -eq "--ctx" -or $arg -eq "--context") {
      if ($i + 1 -ge $Rest.Count) { Fail "--ctx requires a token count" }
      if (-not [int]::TryParse($Rest[$i + 1], [ref]$ctx)) { Fail "--ctx must be an integer" }
      $i += 1
    } else {
      Fail "unknown start argument: $arg"
    }
    $i += 1
  }
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $LocalCode autopilot --config $config --ctx $ctx
  exit $LASTEXITCODE
}

function Invoke-SupervisorCommand([string]$Command, [string[]]$Rest) {
  if ($Rest.Count -lt 1) { Fail "usage: local-autopilot $Command <project-folder|autopilot.json>" }
  $config = Resolve-ConfigPath $Rest[0]
  & $NodeExe $Supervisor $Command $config
  exit $LASTEXITCODE
}

if ($LocalAutopilotArgs.Count -lt 1 -or $LocalAutopilotArgs[0] -in @("help", "-h", "--help")) {
  Show-Usage
  exit 0
}

$cmd = $LocalAutopilotArgs[0].ToLowerInvariant()
$rest = @()
if ($LocalAutopilotArgs.Count -gt 1) { $rest = $LocalAutopilotArgs[1..($LocalAutopilotArgs.Count - 1)] }

switch ($cmd) {
  "new" { New-Autopilot $rest }
  "start" { Start-Autopilot $rest }
  "status" { Invoke-SupervisorCommand "status" $rest }
  "watch" { Invoke-SupervisorCommand "watch" $rest }
  "stop" { Invoke-SupervisorCommand "stop" $rest }
  default {
    Show-Usage
    Fail "unknown command: $cmd"
  }
}
