#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls the Windows Background Service and System Tray shortcuts for omp-web.
.PARAMETER CleanConfig
    Also removes the web-service.json configuration file.
.PARAMETER Quiet
    Suppress non-error console output.
#>

param(
    [switch]$CleanConfig,
    [switch]$Quiet
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path

function Log-Message([string]$msg) {
    if (!$Quiet) {
        Write-Host $msg
    }
}

Log-Message "Uninstalling omp-web Windows System Tray & Background Service..."

# -----------------------------------------------------------------------------
# 1. Terminate Running Background Service & Tray Instances
# -----------------------------------------------------------------------------
try {
    $taskkillExe = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (!(Test-Path $taskkillExe)) { $taskkillExe = "taskkill.exe" }
    # Find any running powershell instance executing omp-web-tray.ps1
    $trayProcs = Get-CimInstance Win32_Process -Filter "Name LIKE '%powershell%' OR Name LIKE '%pwsh%'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*omp-web-tray.ps1*' }
    foreach ($p in $trayProcs) {
        Log-Message "  Stopping background tray process tree (PID $($p.ProcessId))..."
        Start-Process -FilePath $taskkillExe -ArgumentList "/PID $($p.ProcessId) /T /F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    }
} catch { }

# -----------------------------------------------------------------------------
# 2. Remove Windows Shortcuts
# -----------------------------------------------------------------------------
$desktopDirs = [System.Collections.Generic.List[string]]::new()
$desktopDirs.Add([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop))
$desktopDirs.Add((Join-Path $env:USERPROFILE "Desktop"))
if ($env:OneDrive) { $desktopDirs.Add((Join-Path $env:OneDrive "Desktop")) }
if ($env:OneDriveConsumer) { $desktopDirs.Add((Join-Path $env:OneDriveConsumer "Desktop")) }
$desktopDirs.Add((Join-Path $env:USERPROFILE "OneDrive\Desktop"))
$uniqueDesktopDirs = $desktopDirs | Where-Object { !([string]::IsNullOrEmpty($_)) } | Select-Object -Unique

foreach ($dir in $uniqueDesktopDirs) {
    $desktopLnk = Join-Path $dir "omp-web.lnk"
    if (Test-Path $desktopLnk) {
        Remove-Item -Path $desktopLnk -Force -ErrorAction SilentlyContinue
        Log-Message "  [OK] Removed Desktop shortcut: $desktopLnk"
    }
}
$programsDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs)
$startMenuLnk = Join-Path $programsDir "omp-web.lnk"
if (Test-Path $startMenuLnk) {
    Remove-Item -Path $startMenuLnk -Force -ErrorAction SilentlyContinue
    Log-Message "  [OK] Removed Start Menu shortcut: $startMenuLnk"
}

$startupDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
$startupLnk = Join-Path $startupDir "omp-web-tray.lnk"
if (Test-Path $startupLnk) {
    Remove-Item -Path $startupLnk -Force -ErrorAction SilentlyContinue
    Log-Message "  [OK] Removed Startup shortcut: $startupLnk"
}

# -----------------------------------------------------------------------------
# 3. Clean Configuration (Optional)
# -----------------------------------------------------------------------------
$AgentDir = Join-Path $env:USERPROFILE ".omp\agent"
$ConfigPath = Join-Path $AgentDir "web-service.json"

if ($CleanConfig -and (Test-Path $ConfigPath)) {
    Remove-Item -Path $ConfigPath -Force -ErrorAction SilentlyContinue
    Log-Message "  [OK] Removed configuration file: $ConfigPath"
}

Log-Message ""
Log-Message "Uninstallation complete. All shortcuts and background services removed."
