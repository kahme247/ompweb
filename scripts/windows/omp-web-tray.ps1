#Requires -Version 5.1
<#
.SYNOPSIS
    Native Windows System Tray Manager and Background Service for omp-web.
.DESCRIPTION
    Runs omp-web in the background without a terminal window, monitors server health,
    provides a system tray context menu, auto-restarts on crash, and manages Windows startup.
.PARAMETER Port
    HTTP port to bind (default 30177 for start mode, 30178 for dev mode).
.PARAMETER Hostname
    Bind address (default 127.0.0.1).
.PARAMETER Mode
    Execution mode: "start" (production) or "dev" (development). Default "start".
.PARAMETER Startup
    Switch indicating invocation from Windows Startup (prevents opening browser).
.PARAMETER OpenBrowser
    Switch to open the default web browser once the server is responsive.
.PARAMETER ConfigPath
    Path to configuration JSON file (default ~/.omp/agent/web-service.json).
#>

param(
    [int]$Port = 0,
    [string]$Hostname = "",
    [string]$Mode = "",
    [switch]$Startup,
    [switch]$OpenBrowser,
    [string]$ConfigPath = "$env:USERPROFILE\.omp\agent\web-service.json"
)

# Load required .NET Windows Forms and Drawing assemblies
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# -----------------------------------------------------------------------------
# 1. Configuration & Resolution
# -----------------------------------------------------------------------------
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$PkgJsonPath = Join-Path $RepoRoot "package.json"
$PkgVersion = "0.0.0"
if (Test-Path $PkgJsonPath) {
    try {
        $pkg = Get-Content $PkgJsonPath -Raw | ConvertFrom-Json
        if ($pkg.version) { $PkgVersion = $pkg.version }
    } catch { }
}

# Defaults
$DefaultPort = 30177
$DefaultHostname = "127.0.0.1"
$DefaultMode = "start"
$DefaultAutostart = $true
$DefaultOpenBrowserOnLaunch = $false
$DefaultAutoRestart = $true

# Read existing config file if present
$Config = $null
if (Test-Path $ConfigPath) {
    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch { }
}

# Resolve effective settings (CLI parameters take precedence over config file)
$EffectivePort = if ($Port -gt 0) { $Port } elseif ($Config -and $Config.port) { [int]$Config.port } else { $DefaultPort }
$EffectiveHostname = if (![string]::IsNullOrWhiteSpace($Hostname)) { $Hostname } elseif ($Config -and $Config.hostname) { [string]$Config.hostname } else { $DefaultHostname }
$EffectiveMode = if (![string]::IsNullOrWhiteSpace($Mode)) { $Mode } elseif ($Config -and $Config.mode) { [string]$Config.mode } else { $DefaultMode }
$EffectiveAutoRestart = if ($Config -and ($null -ne $Config.autoRestart)) { [bool]$Config.autoRestart } else { $DefaultAutoRestart }

# Open browser determination
$ShouldOpenBrowser = $false
if ($OpenBrowser) {
    $ShouldOpenBrowser = $true
} elseif (!$Startup -and $Config -and $Config.openBrowserOnLaunch) {
    $ShouldOpenBrowser = $true
}

# Fallback: if in start mode but .next directory does not exist, fall back to dev mode
$NextDir = Join-Path $RepoRoot ".next"
if ($EffectiveMode -eq "start" -and !(Test-Path $NextDir)) {
    $EffectiveMode = "dev"
    if ($EffectivePort -eq 30177) {
        $EffectivePort = 30178
    }
}

$ServerUrl = if ($EffectiveHostname -eq "0.0.0.0" -or $EffectiveHostname -eq "::" -or [string]::IsNullOrWhiteSpace($EffectiveHostname)) {
    "http://localhost:$EffectivePort"
} else {
    "http://${EffectiveHostname}:${EffectivePort}"
}

# -----------------------------------------------------------------------------
# 2. Single-Instance Enforcement via Mutex
# -----------------------------------------------------------------------------
$MutexName = "Local\OmpWebTray_Instance_Mutex"
$createdNew = $false
try {
    $script:AppMutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew)
} catch {
    # If mutex creation fails, continue as single instance
    $createdNew = $true
}

if (!$createdNew) {
    # Another instance is already running
    if ($OpenBrowser) {
        try {
            [System.Diagnostics.Process]::Start($ServerUrl) | Out-Null
        } catch { }
    }
    Exit 0
}

# -----------------------------------------------------------------------------
# 3. Logging & Rotation
# -----------------------------------------------------------------------------
$LogDir = Join-Path $env:USERPROFILE ".omp\agent\logs"
if (!(Test-Path $LogDir)) {
    New-Item -Path $LogDir -ItemType Directory -Force | Out-Null
}
$LogFile = Join-Path $LogDir "omp-web-service.log"
$OldLogFile = Join-Path $LogDir "omp-web-service.old.log"

# Rotate log file if > 5MB
if (Test-Path $LogFile) {
    try {
        $logItem = Get-Item $LogFile
        if ($logItem.Length -gt 5 * 1024 * 1024) {
            Move-Item -Path $LogFile -Destination $OldLogFile -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

$script:LogLock = New-Object object
function Write-ServiceLog([string]$message) {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    $line = "[$timestamp] $message"
    [System.Threading.Monitor]::Enter($script:LogLock)
    try {
        [System.IO.File]::AppendAllText($LogFile, "$line`r`n")
    } catch { }
    finally {
        [System.Threading.Monitor]::Exit($script:LogLock)
    }
}

Write-ServiceLog "=========================================="
Write-ServiceLog "omp-web System Tray Manager v$PkgVersion starting"
Write-ServiceLog "Repository Root: $RepoRoot"
Write-ServiceLog "Target: $ServerUrl (Mode: $EffectiveMode, Port: $EffectivePort)"
Write-ServiceLog "=========================================="

# -----------------------------------------------------------------------------
# 4. Icon Loading & Rendering
# -----------------------------------------------------------------------------
$IcoPath = Join-Path $RepoRoot "public\omp-web.ico"
$PngPath = Join-Path $RepoRoot "public\icon.png"
$script:AppIcon = $null

if (Test-Path $IcoPath) {
    try {
        $script:AppIcon = New-Object System.Drawing.Icon $IcoPath
    } catch { }
}
if (!$script:AppIcon -and (Test-Path $PngPath)) {
    try {
        $bmp = [System.Drawing.Bitmap]::FromFile($PngPath)
        $hIcon = $bmp.GetHicon()
        $script:AppIcon = [System.Drawing.Icon]::FromHandle($hIcon)
        $bmp.Dispose()
    } catch { }
}
if (!$script:AppIcon) {
    $script:AppIcon = [System.Drawing.SystemIcons]::Application
}

# -----------------------------------------------------------------------------
# 5. Process Lifecycle & State Management
# -----------------------------------------------------------------------------
$script:ChildProcess = $null
$script:State = "Starting" # Starting, Running, Stopped, Error
$script:CrashTimestamps = [System.Collections.Generic.List[datetime]]::new()
$script:IsExiting = $false

function Find-NodeExecutable {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd -and (Test-Path $nodeCmd.Source)) {
        return $nodeCmd.Source
    }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\node\node.exe",
        "$env:USERPROFILE\.bun\bin\node.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return "node.exe"
}

$NodeExe = Find-NodeExecutable

function Start-WebServer {
    if ($script:ChildProcess -and !$script:ChildProcess.HasExited) {
        return
    }

    $script:State = "Starting"
    Update-TrayUI
    Write-ServiceLog "Starting web server in $EffectiveMode mode on $EffectiveHostname`:$EffectivePort..."

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.WorkingDirectory = $RepoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    if ($EffectiveMode -eq "start") {
        $launcherJs = Join-Path $RepoRoot "bin\omp-web.js"
        $psi.Arguments = "`"$launcherJs`" -p $EffectivePort -H $EffectiveHostname --no-open"
    } else {
        $nextBin = Join-Path $RepoRoot "node_modules\next\dist\bin\next"
        $psi.Arguments = "`"$nextBin`" dev -H $EffectiveHostname -p $EffectivePort"
    }

    # Environment variables
    $psi.EnvironmentVariables["OMP_WEB_PORT"] = [string]$EffectivePort
    $psi.EnvironmentVariables["OMP_WEB_HOSTNAME"] = [string]$EffectiveHostname
    $psi.EnvironmentVariables["OMP_WEB_SERVICE"] = "1"
    $psi.EnvironmentVariables["PORT"] = [string]$EffectivePort

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true

    # Asynchronous output logging
    $proc.add_OutputDataReceived({
        param($sender, $e)
        if (![string]::IsNullOrEmpty($e.Data)) {
            Write-ServiceLog "[STDOUT] $($e.Data)"
        }
    })
    $proc.add_ErrorDataReceived({
        param($sender, $e)
        if (![string]::IsNullOrEmpty($e.Data)) {
            Write-ServiceLog "[STDERR] $($e.Data)"
        }
    })

    try {
        $started = $proc.Start()
        if ($started) {
            $proc.BeginOutputReadLine()
            $proc.BeginErrorReadLine()
            $script:ChildProcess = $proc
            Write-ServiceLog "Child server process started with PID $($proc.Id)"
        } else {
            $script:State = "Error"
            Write-ServiceLog "Failed to start child server process."
            Update-TrayUI
        }
    } catch {
        $script:State = "Error"
        Write-ServiceLog "Exception starting child server: $($_.Exception.Message)"
        Update-TrayUI
    }
}

function Stop-WebServer {
    if ($script:ChildProcess -and !$script:ChildProcess.HasExited) {
        $pidToKill = $script:ChildProcess.Id
        Write-ServiceLog "Stopping child server process tree (PID $pidToKill)..."
        try {
            $taskkillExe = Join-Path $env:SystemRoot "System32\taskkill.exe"
            if (!(Test-Path $taskkillExe)) { $taskkillExe = "taskkill.exe" }
            # Use taskkill on Windows to terminate child tree cleanly
            Start-Process -FilePath $taskkillExe -ArgumentList "/PID $pidToKill /T /F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        } catch {
            try { $script:ChildProcess.Kill() } catch { }
        }
        $script:ChildProcess = $null
    }
    $script:State = "Stopped"
    Write-ServiceLog "Server stopped."
    Update-TrayUI
}

function Restart-WebServer {
    Write-ServiceLog "Restart requested."
    Stop-WebServer
    Start-Sleep -Milliseconds 500
    Start-WebServer
}

# -----------------------------------------------------------------------------
# 6. HTTP Health Probe & Timer
# -----------------------------------------------------------------------------
function Test-ServerHealth {
    if (!$script:ChildProcess -or $script:ChildProcess.HasExited) {
        return $false
    }
    try {
        $probeUrl = if ($EffectiveHostname -eq "0.0.0.0" -or $EffectiveHostname -eq "::" -or [string]::IsNullOrWhiteSpace($EffectiveHostname)) {
            "http://127.0.0.1:$EffectivePort/api/home"
        } else {
            "http://${EffectiveHostname}:${EffectivePort}/api/home"
        }
        $req = [System.Net.WebRequest]::Create($probeUrl)
        $req.Method = "GET"
        $req.Timeout = 2000
        $req.Headers.Add("User-Agent", "omp-web-tray-probe")
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        # Check if we got any HTTP response (e.g. 200, 302, 401, 404), which means server is up
        if ($_.Exception.Response) {
            $_.Exception.Response.Close()
            return $true
        }
        return $false
    }
}

function Check-AutostartShortcut {
    $startupDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
    $startupLnk = Join-Path $startupDir "omp-web-tray.lnk"
    return (Test-Path $startupLnk)
}

function Set-AutostartShortcut([bool]$enable) {
    $startupDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
    $startupLnk = Join-Path $startupDir "omp-web-tray.lnk"
    $launchVbs = Join-Path $RepoRoot "scripts\windows\launch-tray.vbs"

    if ($enable) {
        try {
            $wsh = New-Object -ComObject WScript.Shell
            $wscriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
            if (!(Test-Path $wscriptExe)) { $wscriptExe = "wscript.exe" }
            $shortcut = $wsh.CreateShortcut($startupLnk)
            $shortcut.TargetPath = $wscriptExe
            $shortcut.Arguments = "`"$launchVbs`" -Startup"
            $shortcut.WorkingDirectory = $RepoRoot
            if (Test-Path $IcoPath) {
                $shortcut.IconLocation = "$IcoPath,0"
            }
            $shortcut.Description = "omp-web Background Tray Service"
            $shortcut.Save()
            Write-ServiceLog "Enabled Windows startup shortcut: $startupLnk"
        } catch {
            Write-ServiceLog "Failed to create startup shortcut: $($_.Exception.Message)"
        }
    } else {
        if (Test-Path $startupLnk) {
            Remove-Item -Path $startupLnk -Force -ErrorAction SilentlyContinue
            Write-ServiceLog "Removed Windows startup shortcut: $startupLnk"
        }
    }

    # Update config file
    try {
        $agentDir = Join-Path $env:USERPROFILE ".omp\agent"
        if (!(Test-Path $agentDir)) { New-Item -Path $agentDir -ItemType Directory -Force | Out-Null }
        $currentCfg = @{
            port = $EffectivePort
            hostname = $EffectiveHostname
            mode = $EffectiveMode
            autostart = $enable
            openBrowserOnLaunch = $DefaultOpenBrowserOnLaunch
            autoRestart = $EffectiveAutoRestart
        }
        if (Test-Path $ConfigPath) {
            try {
                $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json
                if ($existing.port) { $currentCfg.port = $existing.port }
                if ($existing.hostname) { $currentCfg.hostname = $existing.hostname }
                if ($existing.mode) { $currentCfg.mode = $existing.mode }
                if ($null -ne $existing.openBrowserOnLaunch) { $currentCfg.openBrowserOnLaunch = $existing.openBrowserOnLaunch }
                if ($null -ne $existing.autoRestart) { $currentCfg.autoRestart = $existing.autoRestart }
            } catch { }
        }
        $currentCfg.autostart = $enable
        $currentCfg | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Force
    } catch { }
}

# -----------------------------------------------------------------------------
# 7. System Tray UI & Menu Construction
# -----------------------------------------------------------------------------
$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Icon = $script:AppIcon
$script:NotifyIcon.Text = "omp-web (Starting...)"
$script:NotifyIcon.Visible = $true

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# Item 1: App Header
$script:MenuItemHeader = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemHeader.Text = "● omp-web (v$PkgVersion)"
$script:MenuItemHeader.Font = New-Object System.Drawing.Font($script:MenuItemHeader.Font, [System.Drawing.FontStyle]::Bold)
$script:MenuItemHeader.Enabled = $false
$contextMenu.Items.Add($script:MenuItemHeader) | Out-Null

# Item 2: Status Indicator
$script:MenuItemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemStatus.Text = "  Status: Starting (Port $EffectivePort)"
$script:MenuItemStatus.Enabled = $false
$contextMenu.Items.Add($script:MenuItemStatus) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Item 3: Open in Browser
$script:MenuItemOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemOpen.Text = "🌐 Open in Browser"
$script:MenuItemOpen.Font = New-Object System.Drawing.Font($script:MenuItemOpen.Font, [System.Drawing.FontStyle]::Bold)
$script:MenuItemOpen.add_Click({
    try { [System.Diagnostics.Process]::Start($ServerUrl) | Out-Null } catch { }
})
$contextMenu.Items.Add($script:MenuItemOpen) | Out-Null

# Item 4: Copy URL
$script:MenuItemCopy = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemCopy.Text = "📋 Copy Web URL"
$script:MenuItemCopy.add_Click({
    try {
        [System.Windows.Forms.Clipboard]::SetText($ServerUrl)
        $script:NotifyIcon.ShowBalloonTip(1500, "omp-web", "URL copied: $ServerUrl", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch { }
})
$contextMenu.Items.Add($script:MenuItemCopy) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Item 5: Restart Server
$script:MenuItemRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemRestart.Text = "🔄 Restart Server"
$script:MenuItemRestart.add_Click({ Restart-WebServer })
$contextMenu.Items.Add($script:MenuItemRestart) | Out-Null

# Item 6: Toggle Start/Stop Server
$script:MenuItemToggle = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemToggle.Text = "⏹ Stop Server"
$script:MenuItemToggle.add_Click({
    if ($script:State -eq "Running" -or $script:State -eq "Starting") {
        Stop-WebServer
    } else {
        Start-WebServer
    }
})
$contextMenu.Items.Add($script:MenuItemToggle) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Item 7: View Logs
$script:MenuItemViewLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemViewLogs.Text = "📄 View Logs"
$script:MenuItemViewLogs.add_Click({
    try { Start-Process "notepad.exe" "`"$LogFile`"" } catch { }
})
$contextMenu.Items.Add($script:MenuItemViewLogs) | Out-Null

# Item 8: Edit Configuration
$script:MenuItemConfig = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemConfig.Text = "⚙ Edit Configuration"
$script:MenuItemConfig.add_Click({
    if (!(Test-Path $ConfigPath)) {
        Set-AutostartShortcut (Check-AutostartShortcut)
    }
    try { Start-Process "notepad.exe" "`"$ConfigPath`"" } catch { }
})
$contextMenu.Items.Add($script:MenuItemConfig) | Out-Null

# Item 9: Open Project Folder
$script:MenuItemOpenFolder = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemOpenFolder.Text = "📁 Open Project Folder"
$script:MenuItemOpenFolder.add_Click({
    try { Start-Process "explorer.exe" "`"$RepoRoot`"" } catch { }
})
$contextMenu.Items.Add($script:MenuItemOpenFolder) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Item 10: Autostart Toggle
$script:MenuItemAutostart = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemAutostart.Text = "☑ Start with Windows"
$script:MenuItemAutostart.CheckOnClick = $true
$script:MenuItemAutostart.Checked = Check-AutostartShortcut
$script:MenuItemAutostart.add_Click({
    Set-AutostartShortcut $script:MenuItemAutostart.Checked
})
$contextMenu.Items.Add($script:MenuItemAutostart) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Item 11: Exit
$script:MenuItemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MenuItemExit.Text = "🚪 Exit Tray & Server"
$script:MenuItemExit.add_Click({
    $script:IsExiting = $true
    Write-ServiceLog "Exit requested from system tray menu."
    Stop-WebServer
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
    $script:Timer.Stop()
    $script:Timer.Dispose()
    if ($script:AppMutex) {
        try { $script:AppMutex.ReleaseMutex() } catch { }
        $script:AppMutex.Dispose()
    }
    [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($script:MenuItemExit) | Out-Null

$script:NotifyIcon.ContextMenuStrip = $contextMenu

# Double-click action on notify icon
$script:NotifyIcon.add_DoubleClick({
    try { [System.Diagnostics.Process]::Start($ServerUrl) | Out-Null } catch { }
})

function Update-TrayUI {
    $statusText = switch ($script:State) {
        "Running"  { "Running ($EffectivePort)" }
        "Starting" { "Starting... ($EffectivePort)" }
        "Stopped"  { "Stopped" }
        "Error"    { "Error" }
        Default    { $script:State }
    }

    $script:MenuItemStatus.Text = "  Status: $statusText"

    # Limit tooltip text length (Windows NotifyIcon.Text max 63 characters)
    $tipText = "omp-web ($statusText)"
    if ($tipText.Length -gt 63) { $tipText = $tipText.Substring(0, 63) }
    $script:NotifyIcon.Text = $tipText

    if ($script:State -eq "Running" -or $script:State -eq "Starting") {
        $script:MenuItemToggle.Text = "⏹ Stop Server"
        $script:MenuItemRestart.Enabled = $true
    } else {
        $script:MenuItemToggle.Text = "▶ Start Server"
        $script:MenuItemRestart.Enabled = $false
    }
    $script:MenuItemAutostart.Checked = Check-AutostartShortcut
}

# -----------------------------------------------------------------------------
# 8. Health Monitoring Loop (Timer)
# -----------------------------------------------------------------------------
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 3000

$script:Timer.add_Tick({
    if ($script:IsExiting) { return }

    # Check child process state
    if ($script:ChildProcess -and $script:ChildProcess.HasExited) {
        $exitCode = $script:ChildProcess.ExitCode
        Write-ServiceLog "Child server process exited unexpectedly with code $exitCode."
        $script:ChildProcess = $null

        if ($EffectiveAutoRestart) {
            $now = Get-Date
            $script:CrashTimestamps.Add($now)
            # Retain only crashes within the last 60 seconds
            $cutoff = $now.AddSeconds(-60)
            for ($i = $script:CrashTimestamps.Count - 1; $i -ge 0; $i--) {
                if ($script:CrashTimestamps[$i] -lt $cutoff) {
                    $script:CrashTimestamps.RemoveAt($i)
                }
            }

            if ($script:CrashTimestamps.Count -ge 3) {
                $script:State = "Error"
                Write-ServiceLog "Server crashed repeatedly (3 times in 60s). Auto-restart suspended."
                $script:NotifyIcon.ShowBalloonTip(3000, "omp-web Service Error", "Server crashed repeatedly. Check logs for details.", [System.Windows.Forms.ToolTipIcon]::Error)
            } else {
                Write-ServiceLog "Auto-restarting server (crash attempt $($script:CrashTimestamps.Count) of 3)..."
                Start-WebServer
            }
        } else {
            $script:State = "Stopped"
        }
        Update-TrayUI
        return
    }

    # Health check probe
    if ($script:ChildProcess -and !$script:ChildProcess.HasExited) {
        $isHealthy = Test-ServerHealth
        if ($isHealthy) {
            if ($script:State -ne "Running") {
                $script:State = "Running"
                Write-ServiceLog "Server is healthy and responsive at $ServerUrl"
                Update-TrayUI

                if ($ShouldOpenBrowser) {
                    $ShouldOpenBrowser = $false
                    try {
                        [System.Diagnostics.Process]::Start($ServerUrl) | Out-Null
                    } catch { }
                }
            }
        } elseif ($script:State -eq "Running") {
            # Was running, but failed probe
            $script:State = "Starting"
            Update-TrayUI
        }
    }
})

# -----------------------------------------------------------------------------
# 9. Startup & Execution
# -----------------------------------------------------------------------------
Start-WebServer
$script:Timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if (!$script:IsExiting) {
        Stop-WebServer
        if ($script:NotifyIcon) {
            $script:NotifyIcon.Visible = $false
            $script:NotifyIcon.Dispose()
        }
        if ($script:Timer) {
            $script:Timer.Stop()
            $script:Timer.Dispose()
        }
        if ($script:AppMutex) {
            try { $script:AppMutex.ReleaseMutex() } catch { }
            $script:AppMutex.Dispose()
        }
    }
}
