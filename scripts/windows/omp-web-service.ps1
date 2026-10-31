#Requires -Version 5.1
<#
.SYNOPSIS
    Headless omp-web background service (no System Tray UI).
    Used by Task Scheduler for reliable autostart without desktop-heap issues.
#>
param(
    [int]$Port = 0,
    [string]$Hostname = "",
    [string]$Mode = "",
    [string]$ConfigPath = "$env:USERPROFILE\.omp\agent\web-service.json"
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$PkgJsonPath = Join-Path $RepoRoot "package.json"
$PkgVersion = "0.0.0"
if (Test-Path $PkgJsonPath) {
    try { $pkg = Get-Content $PkgJsonPath -Raw | ConvertFrom-Json; if ($pkg.version) { $PkgVersion = $pkg.version } } catch { }
}
$DefaultPort = 30177
$DefaultHostname = "127.0.0.1"
$DefaultMode = "start"
$DefaultAutoRestart = $true

$Config = $null
if (Test-Path $ConfigPath) { try { $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { } }

$EffectivePort = if ($Port -gt 0) { $Port } elseif ($Config -and $Config.port) { [int]$Config.port } else { $DefaultPort }
$EffectiveHostname = if (![string]::IsNullOrWhiteSpace($Hostname)) { $Hostname } elseif ($Config -and $Config.hostname) { [string]$Config.hostname } else { $DefaultHostname }
$EffectiveMode = if (![string]::IsNullOrWhiteSpace($Mode)) { $Mode } elseif ($Config -and $Config.mode) { [string]$Config.mode } else { $DefaultMode }
$EffectiveAutoRestart = if ($Config -and ($null -ne $Config.autoRestart)) { [bool]$Config.autoRestart } else { $DefaultAutoRestart }

$BuildIndex = Join-Path $RepoRoot "dist\index.html"
if ($EffectiveMode -eq "start" -and !(Test-Path $BuildIndex)) {
    $EffectiveMode = "dev"
    if ($EffectivePort -eq 30177) { $EffectivePort = 30178 }
}
$ServerUrl = if ($EffectiveHostname -eq "0.0.0.0" -or $EffectiveHostname -eq "::" -or [string]::IsNullOrWhiteSpace($EffectiveHostname)) { "http://localhost:$EffectivePort" } else { "http://${EffectiveHostname}:$EffectivePort" }

# Mutex to prevent duplicate service instances
$MutexName = "Local\OmpWebService_Instance_Mutex"
$createdNew = $false
try { $script:AppMutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew) } catch { $createdNew = $true }
if (!$createdNew) { Exit 0 }

# Logging
$LogDir = Join-Path $env:USERPROFILE ".omp\agent\logs"
if (!(Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
$LogFile = Join-Path $LogDir "omp-web-service.log"
$OldLogFile = Join-Path $LogDir "omp-web-service.old.log"
if (Test-Path $LogFile) {
    try {
        $logItem = Get-Item $LogFile
        if ($logItem.Length -gt 5 * 1024 * 1024) { Move-Item -Path $LogFile -Destination $OldLogFile -Force -ErrorAction SilentlyContinue }
    } catch { }
}
$script:LogLock = New-Object object
function Write-ServiceLog([string]$message) {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    $line = "[$timestamp] $message"
    [System.Threading.Monitor]::Enter($script:LogLock)
    try { [System.IO.File]::AppendAllText($LogFile, "$line`r`n") } catch { }
    finally { [System.Threading.Monitor]::Exit($script:LogLock) }
}
Write-ServiceLog "=========================================="
Write-ServiceLog "omp-web Service v$PkgVersion starting (headless)"
Write-ServiceLog "Repository Root: $RepoRoot"
Write-ServiceLog "Target: $ServerUrl (Mode: $EffectiveMode, Port: $EffectivePort)"
Write-ServiceLog "=========================================="

$script:ChildProcess = $null
$script:IsExiting = $false
$script:CrashTimestamps = [System.Collections.Generic.List[datetime]]::new()

function Find-NodeExecutable {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd -and (Test-Path $nodeCmd.Source)) { return $nodeCmd.Source }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\node\node.exe",
        "$env:USERPROFILE\.bun\bin\node.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return "node.exe"
}
$NodeExe = Find-NodeExecutable

function Test-ServerHealth {
    try {
        $req = [System.Net.WebRequest]::Create($ServerUrl)
        $req.Timeout = 2000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch { return $false }
}

# Copy an omp-web credential from the user (then system) environment into the
# child, or remove it there. This launcher's own environment was captured at
# logon, so a value changed or removed with `setx` since then must not survive
# a server restart: the old password would keep working after rotation.
function Set-ChildCredential($psi, [string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if ([string]::IsNullOrEmpty($value)) { $value = [Environment]::GetEnvironmentVariable($name, "Machine") }
    if ([string]::IsNullOrEmpty($value)) { $psi.EnvironmentVariables.Remove($name) } else { $psi.EnvironmentVariables[$name] = $value }
    return $value
}

function Start-WebServer {
    if ($script:ChildProcess -and !$script:ChildProcess.HasExited) { return }
    Write-ServiceLog "Starting web server in $EffectiveMode mode on ${EffectiveHostname}:$EffectivePort..."
    # Child output goes to a file through cmd; the async OutputDataReceived
    # callbacks run on a thread-pool thread with no runspace and terminate this
    # supervisor the moment the child prints anything (see the tray script).
    $childOutLog = Join-Path $LogDir "omp-web-server.log"
    if ((Test-Path $childOutLog) -and ((Get-Item $childOutLog).Length -gt 5MB)) {
        Move-Item -Path $childOutLog -Destination "$childOutLog.old" -Force -ErrorAction SilentlyContinue
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.WorkingDirectory = $RepoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    if ($EffectiveMode -eq "start") {
        $launcherJs = Join-Path $RepoRoot "bin\omp-web.js"
        $inner = "`"$NodeExe`" `"$launcherJs`" -p $EffectivePort -H $EffectiveHostname --no-open"
    } else {
        $inner = "`"$NodeExe`" `"$(Join-Path $RepoRoot 'bin\bun-runtime.js')`" --hot server\dev.ts -H $EffectiveHostname -p $EffectivePort"
    }
    $psi.FileName = $env:ComSpec
    $psi.Arguments = "/d /s /c `"$inner >> `"$childOutLog`" 2>&1`""
    $psi.EnvironmentVariables["OMP_WEB_PORT"] = [string]$EffectivePort
    $psi.EnvironmentVariables["OMP_WEB_HOSTNAME"] = [string]$EffectiveHostname
    $psi.EnvironmentVariables["OMP_WEB_SERVICE"] = "1"
    $psi.EnvironmentVariables["PORT"] = [string]$EffectivePort
    # bin/omp-web.js refuses a non-loopback bind without a password hash. A
    # plaintext OMP_WEB_PASSWORD is passed through only so the server can refuse
    # it with instructions; generate a hash with `ompweb hash-password`.
    $childHash = Set-ChildCredential $psi "OMP_WEB_PASSWORD_HASH"
    $null = Set-ChildCredential $psi "OMP_WEB_PASSWORD"
    $null = Set-ChildCredential $psi "OMP_WEB_TRUSTED_HEADER_SHA256"
    if ([string]::IsNullOrEmpty($childHash)) {
        Write-ServiceLog "WARN: OMP_WEB_PASSWORD_HASH not found in the user or system environment; a non-loopback bind will be refused by bin/omp-web.js (generate one with: ompweb hash-password)"
    }
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true
    try {
        $started = $proc.Start()
        if ($started) {
            $script:ChildProcess = $proc
            Write-ServiceLog "Child server process started with PID $($proc.Id) (output -> $childOutLog)"
        } else {
            Write-ServiceLog "Failed to start child server process."
        }
    } catch {
        Write-ServiceLog "Exception starting child server: $($_.Exception.Message)"
    }
}

function Stop-WebServer {
    if ($script:ChildProcess -and !$script:ChildProcess.HasExited) {
        $pidToKill = $script:ChildProcess.Id
        Write-ServiceLog "Stopping child server process tree (PID $pidToKill)..."
        try {
            $taskkillExe = Join-Path $env:SystemRoot "System32\taskkill.exe"
            if (!(Test-Path $taskkillExe)) { $taskkillExe = "taskkill.exe" }
            Start-Process -FilePath $taskkillExe -ArgumentList "/PID $pidToKill /T /F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        } catch { try { $script:ChildProcess.Kill() } catch { } }
        $script:ChildProcess = $null
    }
    Write-ServiceLog "Server stopped."
}

# Handle Ctrl-C / termination. Guarded: launched from a hidden window or Task
# Scheduler there is no console, and touching it throws, which would kill the
# supervisor before the health-monitor loop ever starts.
try { [Console]::TreatControlCAsInput = $false } catch { }
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { $script:IsExiting = $true; Stop-WebServer } -ErrorAction SilentlyContinue

# Trap termination signals
try { [System.Console]::CancelKeyPress += { $script:IsExiting = $true; Stop-WebServer; [Environment]::Exit(0) } } catch { }

Start-WebServer

# Main health monitor loop (no Forms, just sleep)
try {
    while (-not $script:IsExiting) {
        Start-Sleep -Seconds 3
        if ($script:ChildProcess -and $script:ChildProcess.HasExited) {
            $exitCode = $script:ChildProcess.ExitCode
            Write-ServiceLog "Child server process exited with code $exitCode."
            $script:ChildProcess = $null
            if ($EffectiveAutoRestart) {
                $now = Get-Date
                $script:CrashTimestamps.Add($now)
                $cutoff = $now.AddSeconds(-60)
                for ($i = $script:CrashTimestamps.Count - 1; $i -ge 0; $i--) {
                    if ($script:CrashTimestamps[$i] -lt $cutoff) { $script:CrashTimestamps.RemoveAt($i) }
                }
                if ($script:CrashTimestamps.Count -ge 3) {
                    Write-ServiceLog "Server crashed repeatedly (3 times in 60s). Auto-restart suspended."
                    Start-Sleep -Seconds 30
                    $script:CrashTimestamps.Clear()
                } else {
                    Write-ServiceLog "Auto-restarting server (crash $($script:CrashTimestamps.Count) of 3)..."
                    Start-WebServer
                }
            }
            continue
        }
        if ($script:ChildProcess -and !$script:ChildProcess.HasExited) {
            $isHealthy = Test-ServerHealth
            if (-not $isHealthy) {
                # Not yet healthy, keep waiting (no log spam)
            }
        }
    }
} finally {
    Stop-WebServer
    if ($script:AppMutex) { try { $script:AppMutex.ReleaseMutex() } catch { }; $script:AppMutex.Dispose() }
}
