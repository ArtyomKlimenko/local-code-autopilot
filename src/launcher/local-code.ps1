param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LocalCodeArgs
)

$ErrorActionPreference = "Stop"

try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
}

$BaseDir = if ($env:LOCAL_AI_ROOT) { $env:LOCAL_AI_ROOT } else { "C:\LocalAI" }
$RuntimeDir = Join-Path $BaseDir "runtime"
$ToolsDir = Join-Path $RuntimeDir "bin"
$LlamaDir = Join-Path $RuntimeDir "llama-b10621"
$NodeDir = Join-Path $RuntimeDir "node-v22.23.2-win-x64"
$PiDir = Join-Path $BaseDir "pi"
$ModelPath = if ($env:LOCAL_CODE_MODEL_PATH) { $env:LOCAL_CODE_MODEL_PATH } else { Join-Path $BaseDir "models\Ornith-1.5-9B-Abliterated-Q4_K_M.gguf" }
$ExpectedModelSha256 = $env:LOCAL_CODE_MODEL_SHA256
$ExpectedModelBytes = if ($env:LOCAL_CODE_MODEL_BYTES) { [long]$env:LOCAL_CODE_MODEL_BYTES } else { [long]0 }
$LlamaServer = Join-Path $LlamaDir "llama-server.exe"
$NodeExe = Join-Path $NodeDir "node.exe"
$PiCli = Join-Path $PiDir "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
$AutopilotDir = Join-Path $BaseDir "autopilot"
$AutopilotSupervisor = Join-Path $AutopilotDir "supervisor.mjs"
$DefaultAutopilotConfig = $env:LOCAL_CODE_AUTOPILOT_CONFIG
$LogDir = Join-Path $BaseDir "logs"
$StateDir = Join-Path $BaseDir "state"
$PidFile = Join-Path $StateDir "llama-server.pid"
$OkHashFile = Join-Path $StateDir "Ornith-1.5-9B-Abliterated-Q4_K_M.gguf.sha256.ok"
$AlyaRoot = if ($env:LOCAL_CODE_ALYA_ROOT) { $env:LOCAL_CODE_ALYA_ROOT } else { Join-Path $BaseDir "alya-disabled" }
$AlyaScripts = Join-Path $AlyaRoot "scripts"
$AlyaStop = Join-Path $AlyaScripts "stop_windows_brain.ps1"
$AlyaStart = Join-Path $AlyaScripts "start_windows_brain.ps1"
$AlyaSupervisor = Join-Path $AlyaScripts "supervise_windows_brain.ps1"
$AlyaStateFile = Join-Path $StateDir "alya-paused.json"
$AlyaDisabledFile = Join-Path $StateDir "alya-disabled.json"
$ProviderId = "local-code"
$ModelId = "ornith-1.5-9b-abliterated"
$HealthUrl = "http://127.0.0.1:8080/health"
$ModelsUrl = "http://127.0.0.1:8080/v1/models"
$GpuNamePattern = if ($env:LOCAL_CODE_GPU_NAME) { $env:LOCAL_CODE_GPU_NAME } else { "AMD Radeon RX 5700 XT" }
$SelectedGpuDevice = $null
$DefaultContextSize = 16384
$PreferredVulkanDriverJson = $env:LOCAL_CODE_VULKAN_ICD

function Write-Info([string]$Message) { Write-Host "[local-code] $Message" }
function Write-Ok([string]$Message) { Write-Host "[ok] $Message" }
function Write-WarnLine([string]$Message) { Write-Warning $Message }

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-File([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Name not found: $Path"
  }
}

function Assert-Dir([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Name not found: $Path"
  }
}

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hashBytes = $sha.ComputeHash($stream)
    return -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Get-PortOwners([int]$Port) {
  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($conn in $connections) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
      Port = $Port
      Pid = [int]$conn.OwningProcess
      Name = [string]$proc.Name
      Path = [string]$proc.ExecutablePath
      CommandLine = [string]$proc.CommandLine
    }
  }
}

function Test-LocalServerProcess([psobject]$Owner) {
  if (-not $Owner) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$Owner.Path)) { return $false }
  return ([string]$Owner.Path).Equals($LlamaServer, [StringComparison]::OrdinalIgnoreCase)
}

function Stop-LocalServer {
  $owners = @(Get-PortOwners -Port 8080)
  foreach ($owner in $owners) {
    if (Test-LocalServerProcess $owner) {
      Write-Info "stopping local llama-server pid=$($owner.Pid)"
      Stop-Process -Id $owner.Pid -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $PidFile) {
    try {
      $pid = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      if ($proc -and ($proc.Path -eq $LlamaServer)) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
      }
    } catch {
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-FreeSpace {
  $free = (Get-PSDrive C).Free
  if ($free -lt 20GB) {
    throw ("C: free space is {0:N2} GB; need at least 20 GB" -f ($free / 1GB))
  }
  Write-Ok ("C: free space {0:N2} GB" -f ($free / 1GB))
}

function Assert-ModelHash([switch]$Fast) {
  Assert-File $ModelPath "model"
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $item = Get-Item -LiteralPath $ModelPath
  if ($ExpectedModelBytes -gt 0 -and $item.Length -ne $ExpectedModelBytes) {
    throw "model size mismatch: expected $ExpectedModelBytes bytes, got $($item.Length)"
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedModelSha256)) {
    Write-WarnLine "LOCAL_CODE_MODEL_SHA256 is not configured; model hash verification is skipped."
    return
  }
  if ($Fast -and (Test-Path -LiteralPath $OkHashFile)) {
    $marker = (Get-Content -LiteralPath $OkHashFile -Raw).Trim().ToLowerInvariant()
    if ($marker -eq $ExpectedModelSha256) {
      Write-Ok "model hash marker exists"
      return
    }
  }
  Write-Info "checking model SHA256; this reads 5.24 GiB once"
  $actual = Get-Sha256Hex -Path $ModelPath
  if ($actual -ne $ExpectedModelSha256) {
    throw "model SHA256 mismatch: expected $ExpectedModelSha256, got $actual"
  }
  Set-Content -LiteralPath $OkHashFile -Value $actual -Encoding ascii
  Write-Ok "model SHA256 matches"
}

function Get-AlyaSupervisorProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(?i:powershell|pwsh)(?:\.exe)?$' -and
    ([string]$_.CommandLine).IndexOf($AlyaSupervisor, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

function Test-AlyaBrainRunning {
  $patterns = @("run_windows_brain.ps1", "windows_brain_entry.py", "-m tg_parrot.brain.service_runner")
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Name -notmatch '^(?i:pythonw?|powershell|pwsh)(?:\.exe)?$') { return $false }
    $cmd = [string]$_.CommandLine
    foreach ($pattern in $patterns) {
      if ($cmd.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
  })
  if ($processes.Count -gt 0) { return $true }
  $port = @(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue)
  return ($port.Count -gt 0)
}

function Get-AlyaModelName {
  $configPath = Join-Path $AlyaRoot "config\windows_brain.toml"
  $default = "alya-qwen3-4b-sft-burst:q4"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $default }
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $section = [regex]::Match($raw, '(?ms)^\[brain\]\s*(.*?)(?=^\[|\z)')
    if (-not $section.Success) { return $default }
    $match = [regex]::Match($section.Groups[1].Value, '(?m)^model\s*=\s*"([^"]+)"\s*$')
    if ($match.Success) { return $match.Groups[1].Value }
  } catch {
  }
  return $default
}

function Get-OllamaLoadedModels {
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/ps" -TimeoutSec 5
    return @($state.models | ForEach-Object {
      if ($_.name) { [string]$_.name } else { [string]$_.model }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  } catch {
    return @()
  }
}

function Stop-OllamaModel([string]$ModelName) {
  if ([string]::IsNullOrWhiteSpace($ModelName)) { return }
  try {
    $payload = @{ model = $ModelName; prompt = ""; keep_alive = 0; stream = $false } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/generate" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 30 | Out-Null
    return
  } catch {
  }

  $ollama = Get-Command "ollama.exe" -ErrorAction SilentlyContinue
  if (-not $ollama -and (Test-Path "F:\Ollama\App\ollama.exe")) {
    $ollama = [pscustomobject]@{ Source = "F:\Ollama\App\ollama.exe" }
  }
  if ($ollama) {
    $oldErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & $ollama.Source stop $ModelName *>$null
    } finally {
      $ErrorActionPreference = $oldErrorActionPreference
    }
  }
}

function Get-SavedAlyaState {
  if (-not (Test-Path -LiteralPath $AlyaStateFile -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $AlyaStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-WarnLine ("failed to read saved Alya state: " + $_.Exception.Message)
    return $null
  }
}

function Wait-AlyaRuntimePaused([string]$ModelName) {
  $deadline = (Get-Date).AddSeconds(90)
  $lastStatus = ""
  while ((Get-Date) -lt $deadline) {
    $supervisors = @(Get-AlyaSupervisorProcesses)
    $brainRunning = Test-AlyaBrainRunning
    $loaded = @(Get-OllamaLoadedModels)
    $unknownLoaded = @($loaded | Where-Object { $_ -and $_ -ne $ModelName })
    if ($unknownLoaded.Count -gt 0) {
      throw "Ollama has loaded model(s) not owned by Alya: $($unknownLoaded -join ', '). Stop them first; local-code will not guess-kill unknown GPU users."
    }

    if ($loaded -contains $ModelName) {
      Stop-OllamaModel -ModelName $ModelName
    }

    if ($supervisors.Count -eq 0 -and -not $brainRunning -and -not ($loaded -contains $ModelName)) {
      Start-Sleep -Seconds 3
      Write-Ok "Alya local AI runtime paused"
      return
    }

    $status = "supervisors=$($supervisors.Count) brain=$brainRunning loaded=$($loaded -join ',')"
    if ($status -ne $lastStatus) {
      Write-Info "waiting for Alya runtime to pause ($status)"
      $lastStatus = $status
    }
    Start-Sleep -Seconds 2
  }
  throw "Alya runtime did not fully pause within 90 seconds"
}

function Suspend-AlyaRuntime {
  if (-not (Test-Path -LiteralPath $AlyaRoot -PathType Container)) {
    return [pscustomobject]@{ AlyaPresent = $false; SupervisorWasRunning = $false; BrainWasRunning = $false; StoppedAlyaModel = $false }
  }

  $supervisors = @(Get-AlyaSupervisorProcesses)
  $brainWasRunning = Test-AlyaBrainRunning
  $alyaModel = Get-AlyaModelName
  $loaded = @(Get-OllamaLoadedModels)
  $unknownLoaded = @($loaded | Where-Object { $_ -and $_ -ne $alyaModel })
  if ($unknownLoaded.Count -gt 0) {
    throw "Ollama has loaded model(s) not owned by Alya: $($unknownLoaded -join ', '). Stop them first; local-code will not guess-kill unknown GPU users."
  }

  $state = [pscustomobject]@{
    AlyaPresent = $true
    SupervisorWasRunning = ($supervisors.Count -gt 0)
    SupervisorPids = @($supervisors | ForEach-Object { [int]$_.ProcessId })
    BrainWasRunning = [bool]$brainWasRunning
    AlyaModel = $alyaModel
    StoppedAlyaModel = ($loaded -contains $alyaModel)
    PausedAt = [DateTimeOffset]::Now.ToString("o")
  }
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $AlyaStateFile -Encoding utf8

  foreach ($supervisor in $supervisors) {
    Write-Info "pausing Alya supervisor pid=$($supervisor.ProcessId)"
    Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
  }

  if ($brainWasRunning -and (Test-Path -LiteralPath $AlyaStop -PathType Leaf)) {
    Write-Info "pausing Alya Windows brain"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AlyaStop | Out-Null
  }

  if ($loaded -contains $alyaModel) {
    Write-Info "unloading Alya Ollama model $alyaModel"
    Stop-OllamaModel -ModelName $alyaModel
  }

  Wait-AlyaRuntimePaused -ModelName $alyaModel

  return $state
}

function Restore-AlyaRuntime([psobject]$State) {
  if (-not $State -or -not $State.AlyaPresent) { return }
  if (Test-Path -LiteralPath $AlyaDisabledFile -PathType Leaf) {
    Write-Info "Alya is disabled; not restoring Alya runtime"
    Remove-Item -LiteralPath $AlyaStateFile -Force -ErrorAction SilentlyContinue
    return
  }
  try {
    if ($State.SupervisorWasRunning -and (Test-Path -LiteralPath $AlyaSupervisor -PathType Leaf)) {
      Write-Info "restoring Alya supervisor"
      Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $AlyaSupervisor) `
        -WorkingDirectory $AlyaRoot `
        -WindowStyle Hidden | Out-Null
    } elseif ($State.BrainWasRunning -and (Test-Path -LiteralPath $AlyaStart -PathType Leaf)) {
      Write-Info "restoring Alya Windows brain"
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AlyaStart | Out-Null
    }
  } catch {
    Write-WarnLine ("failed to restore Alya runtime: " + $_.Exception.Message)
  } finally {
    Remove-Item -LiteralPath $AlyaStateFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-InstallReady([switch]$FastHash) {
  Assert-Dir $BaseDir "base dir"
  Assert-File $LlamaServer "llama-server"
  Assert-File $NodeExe "portable node"
  Assert-File $PiCli "Pi CLI"
  Assert-FreeSpace
  Assert-ModelHash -Fast:$FastHash
}

function Set-VulkanEnvironment {
  $env:VK_LOADER_LAYERS_DISABLE = "~implicit~"
  if (Test-Path -LiteralPath $PreferredVulkanDriverJson -PathType Leaf) {
    $env:VK_DRIVER_FILES = $PreferredVulkanDriverJson
    $env:VK_ICD_FILENAMES = $PreferredVulkanDriverJson
  } else {
    Remove-Item Env:\VK_DRIVER_FILES -ErrorAction SilentlyContinue
    Remove-Item Env:\VK_ICD_FILENAMES -ErrorAction SilentlyContinue
  }
}

function Assert-GpuDevice {
  Set-VulkanEnvironment
  if ((Test-IsAdmin) -and (Test-Path -LiteralPath $PreferredVulkanDriverJson -PathType Leaf)) {
    Write-WarnLine "running elevated; Vulkan may ignore VK_DRIVER_FILES/VK_ICD_FILENAMES. Use a normal terminal for real launches."
  }
  $devices = & $LlamaServer --list-devices 2>&1
  $text = ($devices -join "`n")
  if ($LASTEXITCODE -ne 0) { throw "llama-server --list-devices failed: $text" }
  $devicePattern = '^\s*(Vulkan\d+):\s+.*' + [regex]::Escape($GpuNamePattern)
  $match = [regex]::Match($text, $devicePattern, 'Multiline')
  if (-not $match.Success) {
    throw "$GpuNamePattern Vulkan device not found. Devices:`n$text"
  }
  $script:SelectedGpuDevice = $match.Groups[1].Value
  $line = (($text -split "`n" | Where-Object { $_ -match ('^\s*' + [regex]::Escape($script:SelectedGpuDevice) + ':') } | Select-Object -First 1).Trim())
  Write-Ok "selected GPU: $line"
}

function Assert-SearchTools {
  $rg = Join-Path $ToolsDir "rg.exe"
  $fd = Join-Path $ToolsDir "fd.exe"
  Assert-File $rg "ripgrep"
  Assert-File $fd "fd"
  $rgVersion = (& $rg --version 2>&1 | Select-Object -First 1)
  $fdVersion = (& $fd --version 2>&1 | Select-Object -First 1)
  Write-Ok "ripgrep available: $rgVersion"
  Write-Ok "fd available: $fdVersion"
}

function Test-ServerHealth {
  try {
    $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Get-ServerContextSize {
  try {
    $models = Invoke-RestMethod -Uri $ModelsUrl -TimeoutSec 5
    $ctx = $models.data[0].meta.n_ctx
    if ($ctx) { return [int]$ctx }
  } catch {
  }
  return $null
}

function Set-PiModelContext([int]$ContextSize) {
  $modelsPath = Join-Path $env:USERPROFILE ".pi\agent\models.json"
  Assert-File $modelsPath "Pi models.json"
  $config = Get-Content -LiteralPath $modelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $providerProp = $config.providers.PSObject.Properties[$ProviderId]
  $provider = if ($providerProp) { $providerProp.Value } else { $null }
  if (-not $provider) { throw "Pi provider not found in models.json: $ProviderId" }
  $model = $provider.models | Where-Object { $_.id -eq $ModelId } | Select-Object -First 1
  if (-not $model) { throw "Pi model not found in models.json: $ModelId" }
  $ctxProp = $model.PSObject.Properties["contextWindow"]
  if (-not $ctxProp) {
    $model | Add-Member -MemberType NoteProperty -Name "contextWindow" -Value $ContextSize
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $modelsPath -Encoding utf8
  } elseif ([int]$ctxProp.Value -ne $ContextSize) {
    $ctxProp.Value = $ContextSize
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $modelsPath -Encoding utf8
  }
  Write-Ok "Pi contextWindow: $ContextSize"
}

function Start-LlamaServer([int]$ContextSize) {
  if ([string]::IsNullOrWhiteSpace($script:SelectedGpuDevice)) {
    [void](Assert-GpuDevice)
  }
  $gpuDevice = $script:SelectedGpuDevice

  $owners = @(Get-PortOwners -Port 8080)
  if ($owners.Count -gt 0) {
    $nonLocal = @($owners | Where-Object { -not (Test-LocalServerProcess $_) })
    if ($nonLocal.Count -gt 0) {
      $ownerText = $nonLocal | ForEach-Object { "pid=$($_.Pid) name=$($_.Name) path=$($_.Path)" }
      throw "port 8080 is occupied by unknown process: $($ownerText -join '; ')"
    }
    if (Test-ServerHealth) {
      $serverCtx = Get-ServerContextSize
      if ($serverCtx -eq $ContextSize) {
        Write-Ok "local llama-server already healthy on 127.0.0.1:8080 with ctx=$ContextSize"
        return $false
      }
      Write-Info "restarting local llama-server to switch ctx=$serverCtx -> ctx=$ContextSize"
      Stop-LocalServer
    } else {
      Stop-LocalServer
    }
  }

  New-Item -ItemType Directory -Force -Path $LogDir, $StateDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $LogDir "llama-server-$stamp.out.log"
  $errLog = Join-Path $LogDir "llama-server-$stamp.err.log"
  $args = @(
    "--model", $ModelPath,
    "--alias", $ModelId,
    "--device", $gpuDevice,
    "--n-gpu-layers", "all",
    "--fit", "off",
    "--split-mode", "none",
    "--main-gpu", "0",
    "--ctx-size", ([string]$ContextSize),
    "--parallel", "1",
    "--kv-offload",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    "--flash-attn", "on",
    "--jinja",
    "--reasoning", "auto",
    "--reasoning-format", "deepseek",
    "--no-context-shift",
    "--log-verbosity", "4",
    "--host", "127.0.0.1",
    "--port", "8080",
    "--offline"
  )

  Set-VulkanEnvironment
  Write-Info "starting llama-server on $gpuDevice ($GpuNamePattern), ctx=$ContextSize; logs: $outLog / $errLog"
  $proc = Start-Process -FilePath $LlamaServer `
    -ArgumentList $args `
    -WorkingDirectory $LlamaDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii

  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if ($proc.HasExited) {
      $tail = ""
      if (Test-Path -LiteralPath $errLog) {
        $tail = (Get-Content -LiteralPath $errLog -Tail 80 -ErrorAction SilentlyContinue) -join "`n"
      }
      throw "llama-server exited early code=$($proc.ExitCode). Last stderr:`n$tail"
    }
    if (Test-ServerHealth) {
      Write-Ok "llama-server health OK"
      Assert-GpuOnlyLog -OutLog $outLog -ErrLog $errLog
      return $true
    }
  }
  throw "llama-server did not become healthy within 180 seconds"
}

function Assert-GpuOnlyLog([string]$OutLog, [string]$ErrLog) {
  $combined = ""
  foreach ($path in @($OutLog, $ErrLog)) {
    if (Test-Path -LiteralPath $path) {
      $combined += "`n" + (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue)
    }
  }
  if ($combined -notmatch [regex]::Escape($GpuNamePattern)) {
    throw "GPU log marker missing; refusing possible CPU fallback"
  }
  $offload = [regex]::Match($combined, 'offloaded\s+(\d+)\s*/\s*(\d+)\s+layers\s+to\s+GPU', 'IgnoreCase')
  if (-not $offload.Success) {
    throw "could not find full layer offload marker in llama-server logs"
  }
  if ($offload.Groups[1].Value -ne $offload.Groups[2].Value) {
    throw "partial GPU offload detected: $($offload.Groups[1].Value)/$($offload.Groups[2].Value) layers"
  }
  if ($combined -notmatch '(?is)(KV|cache).*Vulkan|Vulkan.*(KV|cache)') {
    throw "KV/cache Vulkan marker missing; refusing possible CPU KV fallback"
  }
  Write-Ok "GPU-only log verified: offloaded $($offload.Groups[1].Value)/$($offload.Groups[2].Value) layers and KV/cache uses Vulkan"
}

function Invoke-SmokeGeneration {
  $payload = @{
    model = $ModelId
    messages = @(
      @{ role = "system"; content = "Answer in the final response exactly with OK." },
      @{ role = "user"; content = "Return final answer OK and nothing else." }
    )
    max_tokens = 64
    temperature = 0
    stream = $false
  } | ConvertTo-Json -Depth 6
  $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 180
  $rawPath = Join-Path $LogDir "last-smoke-response.json"
  $resp | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $rawPath -Encoding utf8
  $text = [string]$resp.choices[0].message.content
  if ([string]::IsNullOrWhiteSpace($text) -and $resp.choices[0].message.reasoning_content) {
    $text = [string]$resp.choices[0].message.reasoning_content
  }
  if ([string]::IsNullOrWhiteSpace($text)) { throw "smoke generation returned empty response; raw response: $rawPath" }
  Write-Ok "smoke generation returned: $($text.Trim())"
}

function Invoke-Doctor {
  Write-Info "doctor"
  if (Test-IsAdmin) {
    Write-WarnLine "running as Administrator; use a normal terminal for local-code sessions"
  } else {
    Write-Ok "not running as Administrator"
  }
  Assert-InstallReady
  Assert-GpuDevice
  Assert-SearchTools
  $owners = @(Get-PortOwners -Port 8080)
  if ($owners.Count -eq 0) {
    Write-Ok "port 8080 is free"
  } else {
    foreach ($owner in $owners) {
      if (Test-LocalServerProcess $owner) {
        Write-Ok "port 8080 owned by local llama-server pid=$($owner.Pid)"
      } else {
        throw "port 8080 occupied by unknown process pid=$($owner.Pid) name=$($owner.Name) path=$($owner.Path)"
      }
    }
  }
  if (Test-Path -LiteralPath "$env:USERPROFILE\.pi\agent\models.json") {
    Write-Ok "Pi models.json exists"
  } else {
    throw "Pi models.json missing"
  }
  if (Test-Path -LiteralPath "$env:USERPROFILE\.pi\agent\settings.json") {
    Write-Ok "Pi settings.json exists"
  } else {
    throw "Pi settings.json missing"
  }
}

function Invoke-Smoke([int]$ContextSize) {
  Write-Info "smoke"
  if (Test-IsAdmin) {
    Write-WarnLine "running as Administrator; use a normal terminal for local-code sessions"
  }
  Assert-InstallReady -FastHash
  Assert-GpuDevice
  $alyaState = $null
  try {
    $alyaState = Suspend-AlyaRuntime
    Stop-LocalServer
    [void](Start-LlamaServer -ContextSize $ContextSize)
    Invoke-SmokeGeneration
  } finally {
    Stop-LocalServer
    if (-not $alyaState) { $alyaState = Get-SavedAlyaState }
    Restore-AlyaRuntime -State $alyaState
  }
}

function Set-PiEnvironment {
  $env:PI_CODING_AGENT_DIR = "$env:USERPROFILE\.pi\agent"
  $env:PI_CODING_AGENT_SESSION_DIR = Join-Path $BaseDir "sessions"
  $env:PI_OFFLINE = "1"
  $env:PI_SKIP_VERSION_CHECK = "1"
  $env:PI_TELEMETRY = "0"
  $env:LLAMA_BASE_URL = "http://127.0.0.1:8080"
  $env:LOCAL_CODE = "1"
  $env:Path = "$ToolsDir;$NodeDir;$PiDir\node_modules\.bin;$env:Path"
}

function Invoke-PiSmoke([string]$Thinking, [int]$ContextSize) {
  Write-Info "pi-smoke"
  if (Test-IsAdmin) {
    Write-WarnLine "running as Administrator; this smoke uses no tools and no session, but use a normal terminal for real local-code sessions"
  }
  Assert-InstallReady -FastHash
  Assert-GpuDevice
  $alyaState = $null
  try {
    $alyaState = Suspend-AlyaRuntime
    Stop-LocalServer
    Set-PiModelContext -ContextSize $ContextSize
    [void](Start-LlamaServer -ContextSize $ContextSize)
    Set-PiEnvironment
    $piArgs = @(
      "--offline",
      "--provider", $ProviderId,
      "--model", $ModelId,
      "--thinking", $Thinking,
      "--no-tools",
      "--no-session",
      "--print",
      "Answer exactly OK and nothing else."
    )
    $output = @(& $NodeExe $PiCli @piArgs 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0) {
      throw "Pi smoke failed with exit code $exitCode`n$text"
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
      throw "Pi smoke returned empty output"
    }
    Write-Ok "Pi smoke returned: $($text.Trim())"
  } finally {
    Stop-LocalServer
    if (-not $alyaState) { $alyaState = Get-SavedAlyaState }
    Restore-AlyaRuntime -State $alyaState
  }
}

function Invoke-Pi([string]$Folder, [string]$Thinking, [int]$ContextSize, [string]$Session, [string]$SessionId, [string]$PromptFile, [switch]$Resume, [switch]$Continue) {
  if (Test-IsAdmin) {
    throw "Refusing to run coding agent as Administrator. Open a normal CMD/PowerShell and run local-code again."
  }
  $resolved = (Resolve-Path -LiteralPath $Folder).Path
  Set-PiModelContext -ContextSize $ContextSize
  Set-PiEnvironment

  Push-Location -LiteralPath $resolved
  try {
    $piArgs = @(
      "--offline",
      "--provider", $ProviderId,
      "--model", $ModelId,
      "--thinking", $Thinking,
      "--append-system-prompt", "Private SSH key safety rule: never read, print, copy, encode, summarize, or inspect private key file contents. When SSH access is needed, use only the key path supplied by the user with ssh -i and keep IdentityAgent=none and IdentitiesOnly=yes when those options are supplied.",
      "--tools", "read,bash,powershell,edit,write,grep,find,ls",
      "--session-dir", (Join-Path $BaseDir "sessions")
    )
    if ($Resume) { $piArgs += "--resume" }
    if ($Continue) { $piArgs += "--continue" }
    if (-not [string]::IsNullOrWhiteSpace($Session)) { $piArgs += @("--session", $Session) }
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $piArgs += @("--session-id", $SessionId) }
    if (-not [string]::IsNullOrWhiteSpace($PromptFile)) {
      $promptPath = (Resolve-Path -LiteralPath $PromptFile).Path
      $promptText = Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8
      $piArgs += $promptText
    }
    & $NodeExe $PiCli @piArgs
  } finally {
    Pop-Location
  }
}

function Assert-NoOtherPiAgents {
  $agents = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(?i:node)(?:\.exe)?$' -and
    ([string]$_.CommandLine).IndexOf($PiCli, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($agents.Count -gt 0) {
    $details = $agents | ForEach-Object { "pid=$($_.ProcessId)" }
    throw "Another Pi coding-agent session is running ($($details -join ', ')). Stop it with Ctrl+C before starting autopilot; concurrent project edits are refused."
  }
}

function Invoke-Autopilot([string]$ConfigPath, [int]$ContextSize) {
  if (Test-IsAdmin) {
    throw "Refusing to run autopilot as Administrator. Open a normal CMD/PowerShell."
  }
  Assert-File $AutopilotSupervisor "autopilot supervisor"
  Assert-File $ConfigPath "autopilot config"
  Assert-NoOtherPiAgents
  Assert-InstallReady -FastHash
  Assert-GpuDevice

  $alyaState = $null
  $serverStarted = $false
  try {
    $alyaState = Suspend-AlyaRuntime
    Set-PiModelContext -ContextSize $ContextSize
    $serverStarted = Start-LlamaServer -ContextSize $ContextSize
    Invoke-SmokeGeneration
    Set-PiEnvironment
    & $NodeExe $AutopilotSupervisor start $ConfigPath
    return $LASTEXITCODE
  } finally {
    if ($serverStarted -or (Test-Path -LiteralPath $PidFile)) { Stop-LocalServer }
    if (-not $alyaState) { $alyaState = Get-SavedAlyaState }
    Restore-AlyaRuntime -State $alyaState
  }
}

function Show-Usage {
  @"
local-code [folder]
local-code --resume [folder]
local-code --continue [folder]
local-code --session <id> [folder]
local-code --prompt-file <file> [folder]
local-code --thinking low|medium|high [folder]
local-code --ctx 32768 --thinking high [folder]
local-code autopilot --config <file> --ctx 24576
local-code doctor
local-code smoke
local-code pi-smoke
local-code stop-server
"@ | Write-Host
}

$command = ""
$resume = $false
$continue = $false
$thinking = "medium"
$contextSize = $DefaultContextSize
$session = ""
$promptFile = ""
$autopilotConfig = $DefaultAutopilotConfig
$folder = (Get-Location).Path

if ($LocalCodeArgs.Count -gt 0) {
  if ($LocalCodeArgs[0] -in @("doctor", "--doctor")) {
    $command = "doctor"
  } elseif ($LocalCodeArgs[0] -in @("smoke", "--smoke")) {
    $command = "smoke"
  } elseif ($LocalCodeArgs[0] -in @("pi-smoke", "--pi-smoke")) {
    $command = "pi-smoke"
  } elseif ($LocalCodeArgs[0] -in @("stop-server", "--stop-server")) {
    $command = "stop-server"
  } elseif ($LocalCodeArgs[0] -in @("autopilot", "--autopilot")) {
    $command = "autopilot"
  } elseif ($LocalCodeArgs[0] -in @("-h", "--help", "help")) {
    Show-Usage
    exit 0
  } else {
    $command = "run"
    $i = 0
    while ($i -lt $LocalCodeArgs.Count) {
      $arg = $LocalCodeArgs[$i]
      if ($arg -eq "--resume" -or $arg -eq "-r") {
        $resume = $true
      } elseif ($arg -eq "--continue" -or $arg -eq "-c") {
        $continue = $true
      } elseif ($arg -eq "--session") {
        if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--session requires a session file or ID" }
        $session = $LocalCodeArgs[$i + 1]
        $i++
      } elseif ($arg -eq "--prompt-file") {
        if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--prompt-file requires a UTF-8 text file" }
        $promptFile = $LocalCodeArgs[$i + 1]
        if (-not (Test-Path -LiteralPath $promptFile -PathType Leaf)) { throw "--prompt-file not found: $promptFile" }
        $i++
      } elseif ($arg -eq "--thinking" -or $arg -eq "-t") {
        if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--thinking requires: low, medium, or high" }
        $thinking = $LocalCodeArgs[$i + 1]
        if ($thinking -notin @("low", "medium", "high")) { throw "--thinking must be one of: low, medium, high" }
        $i++
      } elseif ($arg -eq "--ctx" -or $arg -eq "--context") {
        if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--ctx requires a token count, for example 32768" }
        if (-not [int]::TryParse($LocalCodeArgs[$i + 1], [ref]$contextSize)) { throw "--ctx must be an integer token count" }
        if ($contextSize -lt 8192 -or $contextSize -gt 65536 -or ($contextSize % 1024) -ne 0) {
          throw "--ctx must be a multiple of 1024 between 8192 and 65536"
        }
        $i++
      } elseif ($arg.StartsWith("-")) {
        throw "unknown argument: $arg"
      } else {
        $folder = $arg
      }
      $i++
    }
    if (($resume -and $continue) -or ($resume -and $session) -or ($continue -and $session)) {
      throw "use only one of: --resume, --continue, or --session"
    }
  }
} else {
  $command = "run"
}

if ($command -eq "autopilot") {
  $i = 1
  while ($i -lt $LocalCodeArgs.Count) {
    $arg = $LocalCodeArgs[$i]
    if ($arg -eq "--config") {
      if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--config requires an autopilot JSON file" }
      $autopilotConfig = $LocalCodeArgs[$i + 1]
      if (-not (Test-Path -LiteralPath $autopilotConfig -PathType Leaf)) { throw "--config not found: $autopilotConfig" }
      $i++
    } elseif ($arg -eq "--ctx" -or $arg -eq "--context") {
      if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--ctx requires a token count, for example 24576" }
      if (-not [int]::TryParse($LocalCodeArgs[$i + 1], [ref]$contextSize)) { throw "--ctx must be an integer token count" }
      if ($contextSize -lt 8192 -or $contextSize -gt 65536 -or ($contextSize % 1024) -ne 0) {
        throw "--ctx must be a multiple of 1024 between 8192 and 65536"
      }
      $i++
    } else {
      throw "unknown autopilot argument: $arg"
    }
    $i++
  }
}

if ($command -in @("doctor", "smoke", "pi-smoke")) {
  $i = 1
  while ($i -lt $LocalCodeArgs.Count) {
    $arg = $LocalCodeArgs[$i]
    if ($arg -eq "--thinking" -or $arg -eq "-t") {
      if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--thinking requires: low, medium, or high" }
      $thinking = $LocalCodeArgs[$i + 1]
      if ($thinking -notin @("low", "medium", "high")) { throw "--thinking must be one of: low, medium, high" }
      $i++
    } elseif ($arg -eq "--ctx" -or $arg -eq "--context") {
      if ($i + 1 -ge $LocalCodeArgs.Count) { throw "--ctx requires a token count, for example 32768" }
      if (-not [int]::TryParse($LocalCodeArgs[$i + 1], [ref]$contextSize)) { throw "--ctx must be an integer token count" }
      if ($contextSize -lt 8192 -or $contextSize -gt 65536 -or ($contextSize % 1024) -ne 0) {
        throw "--ctx must be a multiple of 1024 between 8192 and 65536"
      }
      $i++
    } elseif ($arg.StartsWith("-")) {
      throw "unknown argument: $arg"
    } else {
      throw "unexpected argument for ${command}: $arg"
    }
    $i++
  }
}

switch ($command) {
  "doctor" {
    Invoke-Doctor
    exit 0
  }
  "stop-server" {
    Stop-LocalServer
    exit 0
  }
  "smoke" {
    Invoke-Smoke -ContextSize $contextSize
    exit 0
  }
  "pi-smoke" {
    Invoke-PiSmoke -Thinking $thinking -ContextSize $contextSize
    exit 0
  }
  "autopilot" {
    $exitCode = Invoke-Autopilot -ConfigPath $autopilotConfig -ContextSize $contextSize
    exit $exitCode
  }
  "run" {
    Assert-InstallReady -FastHash
    Assert-GpuDevice
    $alyaState = $null
    $serverStarted = $false
    try {
      $alyaState = Suspend-AlyaRuntime
      $serverStarted = Start-LlamaServer -ContextSize $contextSize
      Invoke-SmokeGeneration
      Invoke-Pi -Folder $folder -Thinking $thinking -ContextSize $contextSize -Session $session -PromptFile $promptFile -Resume:$resume -Continue:$continue
      exit $LASTEXITCODE
    } finally {
      if ($serverStarted -or (Test-Path -LiteralPath $PidFile)) { Stop-LocalServer }
      if (-not $alyaState) { $alyaState = Get-SavedAlyaState }
      Restore-AlyaRuntime -State $alyaState
    }
  }
  default {
    Show-Usage
    exit 1
  }
}
