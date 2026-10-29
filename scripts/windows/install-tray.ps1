#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the Windows Background Service, System Tray shortcuts, and autostart registration for omp-web.
.PARAMETER Port
    Default port to configure (default 30177).
.PARAMETER Hostname
    Default hostname to configure (default 127.0.0.1).
.PARAMETER Mode
    Execution mode: "start" or "dev" (default "start").
.PARAMETER NoAutostart
    Disable automatic Windows startup on logon.
.PARAMETER StartImmediately
    Launch the system tray service and open web UI immediately after installation.
.PARAMETER Quiet
    Suppress non-error console output.
#>

param(
    [int]$Port = 30177,
    [string]$Hostname = "127.0.0.1",
    [string]$Mode = "start",
    [switch]$NoAutostart,
    [switch]$StartImmediately,
    [switch]$Quiet
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$IcoPath = Join-Path $RepoRoot "public\omp-web.ico"
$PngPath = Join-Path $RepoRoot "public\icon.png"
$LaunchVbs = Join-Path $RepoRoot "scripts\windows\launch-tray.vbs"

function Log-Message([string]$msg) {
    if (!$Quiet) {
        Write-Host $msg
    }
}

# -----------------------------------------------------------------------------
# 1. Generate Multi-Size ICO if missing or requested
# -----------------------------------------------------------------------------
function Ensure-IconFile {
    if (Test-Path $IcoPath) {
        return
    }
    if (!(Test-Path $PngPath)) {
        Log-Message "Warning: Source icon '$PngPath' not found. Using system default icon."
        return
    }

    try {
        Add-Type -AssemblyName System.Drawing
        $srcBmp = [System.Drawing.Bitmap]::FromFile($PngPath)
        $sizes = @(16, 32, 48, 64, 128, 256)
        $images = @()

        foreach ($size in $sizes) {
            $resized = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $g = [System.Drawing.Graphics]::FromImage($resized)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.DrawImage($srcBmp, 0, 0, $size, $size)
            $g.Dispose()

            $ms = New-Object System.IO.MemoryStream
            $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $resized.Dispose()
            $bytes = $ms.ToArray()
            $ms.Dispose()

            $images += [PSCustomObject]@{
                Width = if ($size -ge 256) { [byte]0 } else { [byte]$size }
                Height = if ($size -ge 256) { [byte]0 } else { [byte]$size }
                Size = $size
                Data = $bytes
            }
        }
        $srcBmp.Dispose()

        $fs = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create)
        $bw = New-Object System.IO.BinaryWriter $fs

        # Header: Reserved (0), Type (1 = ICO), Count
        $bw.Write([uint16]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]$images.Count)

        # Offset calculation
        $offset = 6 + (16 * $images.Count)

        foreach ($img in $images) {
            $bw.Write([byte]$img.Width)
            $bw.Write([byte]$img.Height)
            $bw.Write([byte]0) # Color count
            $bw.Write([byte]0) # Reserved
            $bw.Write([uint16]1) # Planes
            $bw.Write([uint16]32) # Bit count
            $bw.Write([uint32]$img.Data.Length)
            $bw.Write([uint32]$offset)
            $offset += $img.Data.Length
        }

        foreach ($img in $images) {
            $bw.Write($img.Data)
        }

        $bw.Flush()
        $bw.Dispose()
        $fs.Dispose()

        Log-Message "  [OK] Generated multi-size icon at: $IcoPath"
    } catch {
        Log-Message "  [WARN] Failed to generate .ico from PNG: $($_.Exception.Message)"
    }
}

Log-Message "Installing omp-web Windows System Tray & Background Service..."
Ensure-IconFile

# -----------------------------------------------------------------------------
# 2. Initialize Service Configuration
# -----------------------------------------------------------------------------
$AgentDir = Join-Path $env:USERPROFILE ".omp\agent"
if (!(Test-Path $AgentDir)) {
    New-Item -Path $AgentDir -ItemType Directory -Force | Out-Null
}
$ConfigPath = Join-Path $AgentDir "web-service.json"

$configData = @{
    port = $Port
    hostname = $Hostname
    mode = $Mode
    autostart = (!$NoAutostart)
    openBrowserOnLaunch = $false
    autoRestart = $true
}

# Preserve existing custom values if already present
if (Test-Path $ConfigPath) {
    try {
        $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($existing.openBrowserOnLaunch -ne $null) { $configData.openBrowserOnLaunch = [bool]$existing.openBrowserOnLaunch }
        if ($existing.autoRestart -ne $null) { $configData.autoRestart = [bool]$existing.autoRestart }
    } catch { }
}

$configData | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Force
Log-Message "  [OK] Configuration written to: $ConfigPath"

# -----------------------------------------------------------------------------
# 3. Create Windows Shortcuts
# -----------------------------------------------------------------------------
$wsh = New-Object -ComObject WScript.Shell
$wscriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
if (!(Test-Path $wscriptExe)) {
    $wscriptExe = "wscript.exe"
}
$nativeExe = Join-Path $RepoRoot "bin\omp-web-tray.exe"
$useNative = Test-Path $nativeExe
# Desktop Shortcut
$desktopDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$desktopLnk = Join-Path $desktopDir "omp-web.lnk"
try {
    $sc = $wsh.CreateShortcut($desktopLnk)
    if ($useNative) {
        $sc.TargetPath = $nativeExe
        $sc.Arguments = "-OpenBrowser"
    } else {
        $sc.TargetPath = $wscriptExe
        $sc.Arguments = "`"$LaunchVbs`" -OpenBrowser"
    }
    $sc.WorkingDirectory = $RepoRoot
    if (Test-Path $IcoPath) { $sc.IconLocation = "$IcoPath,0" }
    $sc.Description = "Open omp-web AI Coding Agent Web Interface"
    $sc.Save()
    Log-Message "  [OK] Desktop shortcut created: $desktopLnk $(if ($useNative) { '(native tray)' } else { '' })"
} catch {
    Log-Message "  [FAIL] Failed to create desktop shortcut: $($_.Exception.Message)"
}

# Start Menu Shortcut
$programsDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs)
$startMenuLnk = Join-Path $programsDir "omp-web.lnk"
try {
    $sc = $wsh.CreateShortcut($startMenuLnk)
    if ($useNative) {
        $sc.TargetPath = $nativeExe
        $sc.Arguments = "-OpenBrowser"
    } else {
        $sc.TargetPath = $wscriptExe
        $sc.Arguments = "`"$LaunchVbs`" -OpenBrowser"
    }
    $sc.WorkingDirectory = $RepoRoot
    if (Test-Path $IcoPath) { $sc.IconLocation = "$IcoPath,0" }
    $sc.Description = "omp-web System Tray & Web Interface"
    $sc.Save()
    Log-Message "  [OK] Start Menu shortcut created: $startMenuLnk $(if ($useNative) { '(native tray)' } else { '' })"
} catch {
    Log-Message "  [FAIL] Failed to create Start Menu shortcut: $($_.Exception.Message)"
}

# Startup Shortcut (if autostart enabled)
$startupDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
$startupLnk = Join-Path $startupDir "omp-web-tray.lnk"
if (!$NoAutostart) {
    try {
        $sc = $wsh.CreateShortcut($startupLnk)
        if ($useNative) {
            $sc.TargetPath = $nativeExe
            $sc.Arguments = "-Startup"
        } else {
            $sc.TargetPath = $wscriptExe
            $sc.Arguments = "`"$LaunchVbs`" -Startup"
        }
        $sc.WorkingDirectory = $RepoRoot
        if (Test-Path $IcoPath) { $sc.IconLocation = "$IcoPath,0" }
        $sc.Description = "omp-web Background Tray Service"
        $sc.Save()
        Log-Message "  [OK] Windows Startup shortcut created: $startupLnk $(if ($useNative) { '(native tray)' } else { '' })"
    } catch {
        Log-Message "  [FAIL] Failed to create Startup shortcut: $($_.Exception.Message)"
    }
} else {
    if (Test-Path $startupLnk) {
        Remove-Item -Path $startupLnk -Force -ErrorAction SilentlyContinue
    }
}
Log-Message ""
Log-Message "Installation complete!"
Log-Message "Live server URL : http://${Hostname}:${Port}"
Log-Message "Tray Launcher   : $LaunchVbs"

# -----------------------------------------------------------------------------
# 3b. Register Scheduled Task for headless service (robust, no desktop heap)
# -----------------------------------------------------------------------------
$ServicePs1 = Join-Path $RepoRoot "scripts\windows\omp-web-service.ps1"
if (!$NoAutostart -and (Test-Path $ServicePs1)) {
    try {
        $taskName = "omp-web"
        $actionArg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ServicePs1`""
        # Use schtasks for compatibility (no admin required for current user ONLOGON)
        $createArgs = "/create /tn `"$taskName`" /tr `"powershell $actionArg`" /sc onlogon /f"
        # schtasks may require quoted task name
        $proc = Start-Process -FilePath "schtasks.exe" -ArgumentList $createArgs -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue
        if ($proc.ExitCode -eq 0) {
            Log-Message "  [OK] Scheduled Task created: $taskName (ONLOGON)"
        } else {
            # Fallback: try PowerShell Register-ScheduledTask
            try {
                $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArg
                $trigger = New-ScheduledTaskTrigger -AtLogOn
                $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
                Log-Message "  [OK] Scheduled Task created via PowerShell: $taskName"
            } catch {
                Log-Message "  [WARN] Failed to create Scheduled Task: $($_.Exception.Message)"
            }
        }
    } catch {
        Log-Message "  [WARN] Scheduled Task creation failed: $($_.Exception.Message)"
    }
} elseif ($NoAutostart) {
    try { schtasks /delete /tn "omp-web" /f 2>$null | Out-Null } catch { }
}

# The host daemon (`ompweb host`) runs next to the web service. It starts at logon like the web
# service; with -NoAutostart it is still registered and started, but not at logon.
$HostPs1 = Join-Path $RepoRoot "scripts\windows\omp-web-host.ps1"
if (Test-Path $HostPs1) {
    try {
        $hostArg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$HostPs1`""
        $hostAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $hostArg
        $hostTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $hostPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        # omp-web-host.ps1 restarts the daemon itself; the scheduler only has to survive battery and a missed logon.
        $hostSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        $hostTask = @{ TaskName = "omp-web-host"; Action = $hostAction; Principal = $hostPrincipal; Settings = $hostSettings; Force = $true; ErrorAction = "Stop" }
        if (!$NoAutostart) { $hostTask.Trigger = $hostTrigger }
        Register-ScheduledTask @hostTask | Out-Null
        Log-Message "  [OK] Scheduled Task created: omp-web-host"
        schtasks.exe /run /tn "omp-web-host" 2>$null | Out-Null
    } catch {
        Log-Message "  [WARN] Failed to create the omp-web-host Scheduled Task: $($_.Exception.Message)"
    }
}

# -----------------------------------------------------------------------------
# 4. Optional Immediate Launch
# -----------------------------------------------------------------------------
if ($StartImmediately) {
    Log-Message "Starting background service and opening browser..."
    $wsh.Run("`"$wscriptExe`" `"$LaunchVbs`" -OpenBrowser", 0, $false)
}
