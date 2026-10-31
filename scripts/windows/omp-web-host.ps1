#Requires -Version 5.1
<#
.SYNOPSIS
    Headless omp-web host daemon supervisor (`ompweb host`).
    Registered next to the omp-web service by install-tray.ps1 as the "omp-web-host" scheduled task.
.NOTES
    `ompweb host` exits when host.json does not exist yet (first install: the web server writes it
    at startup) and when the server revokes or outdates its token. This loop restarts it after a
    pause, so the daemon follows the web server instead of staying down.
#>
param(
    [int]$RestartDelaySeconds = 10
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$LauncherJs = Join-Path $RepoRoot "bin\omp-web.js"

# One daemon supervisor per logon session.
$createdNew = $false
try { $script:AppMutex = New-Object System.Threading.Mutex($true, "Local\OmpWebHostDaemon_Instance_Mutex", [ref]$createdNew) } catch { $createdNew = $true }
if (!$createdNew) { Exit 0 }

$LogDir = Join-Path $env:USERPROFILE ".omp\agent\logs"
if (!(Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
$LogFile = Join-Path $LogDir "omp-web-host.log"
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
    Move-Item -Path $LogFile -Destination "$LogFile.old" -Force -ErrorAction SilentlyContinue
}

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

try {
    while ($true) {
        # Output goes to a file through cmd, as in omp-web-service.ps1.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = "/d /s /c `"`"$NodeExe`" `"$LauncherJs`" host >> `"$LogFile`" 2>&1`""
        $psi.WorkingDirectory = $RepoRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    if ($script:AppMutex) { try { $script:AppMutex.ReleaseMutex() } catch { }; $script:AppMutex.Dispose() }
}
