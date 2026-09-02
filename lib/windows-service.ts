import packageJson from "../package.json";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getAgentDir } from "./omp/paths";

const execFileAsync = promisify(execFile);

export interface WebServiceConfig {
  port: number;
  hostname: string;
  mode: "start" | "dev";
  autostart: boolean;
  openBrowserOnLaunch: boolean;
  autoRestart: boolean;
}

export interface WebServiceStatus {
  isWindows: boolean;
  isInstalled: boolean;
  autostart: boolean;
  isRunning: boolean;
  port: number;
  hostname: string;
  mode: "start" | "dev";
  desktopShortcutExists: boolean;
  startMenuShortcutExists: boolean;
  startupShortcutExists: boolean;
  logFile: string;
  configFile: string;
  serviceUrl: string;
  version: string;
}

export const DEFAULT_WEB_SERVICE_CONFIG: WebServiceConfig = {
  port: 30177,
  hostname: "127.0.0.1",
  mode: "start",
  autostart: true,
  openBrowserOnLaunch: false,
  autoRestart: true,
};

export function getRepoRoot(): string {
  if (process.env.OMP_WEB_PACKAGE_DIR && existsSync(process.env.OMP_WEB_PACKAGE_DIR)) {
    return process.env.OMP_WEB_PACKAGE_DIR;
  }
  const fromDirname = path.resolve(__dirname, "..");
  if (existsSync(path.join(fromDirname, "package.json"))) {
    return fromDirname;
  }
  const fromCwd = process.cwd();
  if (existsSync(path.join(fromCwd, "package.json"))) {
    return fromCwd;
  }
  return fromDirname;
}

export function getSystemRoot(): string {
  if (process.platform !== "win32") {
    return "C:\\Windows";
  }
  return (
    process.env.SystemRoot ||
    process.env.systemroot ||
    process.env.windir ||
    process.env.WINDIR ||
    "C:\\Windows"
  );
}

export function resolvePowerShellBin(): string {
  if (process.platform !== "win32") {
    return "powershell";
  }
  const sysRoot = getSystemRoot();
  const candidates = [
    path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(sysRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")] : []),
    ...(process.env["ProgramFiles(x86)"] ? [path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe")] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

export function resolveWscriptBin(): string {
  if (process.platform !== "win32") {
    return "wscript";
  }
  const sysRoot = getSystemRoot();
  const candidates = [
    path.join(sysRoot, "System32", "wscript.exe"),
    path.join(sysRoot, "SysWOW64", "wscript.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "wscript.exe";
}

export function resolveTaskkillBin(): string {
  if (process.platform !== "win32") {
    return "taskkill";
  }
  const sysRoot = getSystemRoot();
  const candidate = path.join(sysRoot, "System32", "taskkill.exe");
  if (existsSync(candidate)) {
    return candidate;
  }
  return "taskkill.exe";
}

export function getWindowsExecutionEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return process.env;
  }
  const sysRoot = getSystemRoot();
  const system32 = path.join(sysRoot, "System32");
  const psDir = path.join(system32, "WindowsPowerShell", "v1.0");
  const wbem = path.join(system32, "Wbem");
  const currentPath = process.env.PATH || process.env.Path || "";
  const extraPaths = [system32, psDir, wbem, sysRoot].filter(
    (p) => !currentPath.toLowerCase().includes(p.toLowerCase())
  );
  const mergedPath = extraPaths.length > 0
    ? `${currentPath}${path.delimiter}${extraPaths.join(path.delimiter)}`
    : currentPath;
  return {
    ...process.env,
    SystemRoot: sysRoot,
    windir: sysRoot,
    PATH: mergedPath,
    Path: mergedPath,
  };
}

export function getWebServiceConfigPath(): string {
  return path.join(getAgentDir(), "web-service.json");
}

export function getWebServiceLogPath(): string {
  return path.join(getAgentDir(), "logs", "omp-web-service.log");
}

export function getWindowsShortcutPaths(): { desktop: string; startMenu: string; startup: string } {
  const home = homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  let desktopDir = path.join(home, "Desktop");
  if (process.env.OneDrive && existsSync(path.join(process.env.OneDrive, "Desktop", "omp-web.lnk"))) {
    desktopDir = path.join(process.env.OneDrive, "Desktop");
  } else if (process.env.OneDriveConsumer && existsSync(path.join(process.env.OneDriveConsumer, "Desktop", "omp-web.lnk"))) {
    desktopDir = path.join(process.env.OneDriveConsumer, "Desktop");
  } else if (existsSync(path.join(home, "OneDrive", "Desktop", "omp-web.lnk"))) {
    desktopDir = path.join(home, "OneDrive", "Desktop");
  }

  return {
    desktop: path.join(desktopDir, "omp-web.lnk"),
    startMenu: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "omp-web.lnk"),
    startup: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "omp-web-tray.lnk"),
  };
}

export function sanitizePort(val: unknown, fallback = DEFAULT_WEB_SERVICE_CONFIG.port): number {
  if (typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= 65535) {
    return val;
  }
  if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return fallback;
}

export function sanitizeHostname(val: unknown, fallback = DEFAULT_WEB_SERVICE_CONFIG.hostname): string {
  if (typeof val === "string" && val.trim().length > 0) {
    return val.trim();
  }
  return fallback;
}

export function sanitizeMode(val: unknown, fallback: "start" | "dev" = DEFAULT_WEB_SERVICE_CONFIG.mode): "start" | "dev" {
  if (val === "start" || val === "dev") {
    return val;
  }
  return fallback;
}

export async function loadWebServiceConfig(): Promise<WebServiceConfig> {
  const configPath = getWebServiceConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const data = JSON.parse(raw);
    return {
      port: sanitizePort(data.port, DEFAULT_WEB_SERVICE_CONFIG.port),
      hostname: sanitizeHostname(data.hostname, DEFAULT_WEB_SERVICE_CONFIG.hostname),
      mode: sanitizeMode(data.mode, DEFAULT_WEB_SERVICE_CONFIG.mode),
      autostart: typeof data.autostart === "boolean" ? data.autostart : DEFAULT_WEB_SERVICE_CONFIG.autostart,
      openBrowserOnLaunch: typeof data.openBrowserOnLaunch === "boolean" ? data.openBrowserOnLaunch : DEFAULT_WEB_SERVICE_CONFIG.openBrowserOnLaunch,
      autoRestart: typeof data.autoRestart === "boolean" ? data.autoRestart : DEFAULT_WEB_SERVICE_CONFIG.autoRestart,
    };
  } catch {
    return { ...DEFAULT_WEB_SERVICE_CONFIG };
  }
}

export async function saveWebServiceConfig(updates: Partial<WebServiceConfig>): Promise<WebServiceConfig> {
  const current = await loadWebServiceConfig();
  const merged: WebServiceConfig = {
    port: updates.port !== undefined ? sanitizePort(updates.port, current.port) : current.port,
    hostname: updates.hostname !== undefined ? sanitizeHostname(updates.hostname, current.hostname) : current.hostname,
    mode: updates.mode !== undefined ? sanitizeMode(updates.mode, current.mode) : current.mode,
    autostart: typeof updates.autostart === "boolean" ? updates.autostart : current.autostart,
    openBrowserOnLaunch: typeof updates.openBrowserOnLaunch === "boolean" ? updates.openBrowserOnLaunch : current.openBrowserOnLaunch,
    autoRestart: typeof updates.autoRestart === "boolean" ? updates.autoRestart : current.autoRestart,
  };

  const configPath = getWebServiceConfigPath();
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${configPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), "utf-8");
  await fs.rename(tempPath, configPath);

  return merged;
}

let trayRunningCache: { running: boolean; expiresAt: number } | null = null;
const TRAY_RUNNING_TTL_MS = 3000;

export function invalidateTrayRunningCache(): void {
  trayRunningCache = null;
}

export async function isTrayProcessRunning(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }
  if (trayRunningCache && trayRunningCache.expiresAt > Date.now()) {
    return trayRunningCache.running;
  }
  try {
    const psExe = resolvePowerShellBin();
    const { stdout } = await execFileAsync(
      psExe,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        '$procs = Get-CimInstance Win32_Process -Filter "Name LIKE \'%powershell%\' OR Name LIKE \'%pwsh%\'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like \'*omp-web-tray.ps1*\' }; ($procs | Measure-Object).Count',
      ],
      { timeout: 4000, env: getWindowsExecutionEnv(), windowsHide: true }
    );
    const count = parseInt(stdout.trim(), 10);
    const isRunning = !isNaN(count) && count > 0;
    trayRunningCache = { running: isRunning, expiresAt: Date.now() + TRAY_RUNNING_TTL_MS };
    return isRunning;
  } catch {
    trayRunningCache = { running: false, expiresAt: Date.now() + TRAY_RUNNING_TTL_MS };
    return false;
  }
}

export function getAppVersion(): string {
  return packageJson.version || "0.0.0";
}

export async function getWebServiceStatus(): Promise<WebServiceStatus> {
  const isWindows = process.platform === "win32";
  const config = await loadWebServiceConfig();
  const shortcuts = getWindowsShortcutPaths();

  const desktopExists = isWindows && existsSync(shortcuts.desktop);
  const startMenuExists = isWindows && existsSync(shortcuts.startMenu);
  const startupExists = isWindows && existsSync(shortcuts.startup);

  const isInstalled = desktopExists || startMenuExists || startupExists || existsSync(getWebServiceConfigPath());
  const isRunning = await isTrayProcessRunning();

  const host = config.hostname;
  const port = config.port;
  const serviceUrl = (host === "0.0.0.0" || host === "::" || !host)
    ? `http://localhost:${port}`
    : `http://${host}:${port}`;

  return {
    isWindows,
    isInstalled,
    autostart: startupExists || config.autostart,
    isRunning,
    port: config.port,
    hostname: config.hostname,
    mode: config.mode,
    desktopShortcutExists: desktopExists,
    startMenuShortcutExists: startMenuExists,
    startupShortcutExists: startupExists,
    logFile: getWebServiceLogPath(),
    configFile: getWebServiceConfigPath(),
    serviceUrl,
    version: getAppVersion(),
  };
}

export async function installTrayShortcuts(
  options: Partial<WebServiceConfig> & { startImmediately?: boolean } = {}
): Promise<{ success: boolean; message?: string }> {
  if (process.platform !== "win32") {
    return { success: false, message: "Windows service installation is only supported on Windows platforms." };
  }

  const savedConfig = await saveWebServiceConfig(options);
  const repoRoot = getRepoRoot();
  const installScript = path.join(repoRoot, "scripts", "windows", "install-tray.ps1");

  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installScript,
    "-Port",
    String(savedConfig.port),
    "-Hostname",
    savedConfig.hostname,
    "-Mode",
    savedConfig.mode,
  ];

  if (!savedConfig.autostart) {
    psArgs.push("-NoAutostart");
  }
  if (options.startImmediately) {
    psArgs.push("-StartImmediately");
  }

  try {
    const psExe = resolvePowerShellBin();
    const { stdout, stderr } = await execFileAsync(psExe, psArgs, {
      cwd: repoRoot,
      timeout: 15000,
      env: getWindowsExecutionEnv(),
      windowsHide: true,
    });
    invalidateTrayRunningCache();
    return { success: true, message: stdout || stderr };
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      success: false,
      message: err.stderr || err.stdout || err.message || "Failed to execute installer script.",
    };
  }
}

export async function uninstallTrayShortcuts(
  options: { cleanConfig?: boolean } = {}
): Promise<{ success: boolean; message?: string }> {
  if (process.platform !== "win32") {
    return { success: false, message: "Windows service uninstallation is only supported on Windows platforms." };
  }

  const repoRoot = getRepoRoot();
  const uninstallScript = path.join(repoRoot, "scripts", "windows", "uninstall-tray.ps1");

  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    uninstallScript,
  ];

  if (options.cleanConfig) {
    psArgs.push("-CleanConfig");
  }

  try {
    const psExe = resolvePowerShellBin();
    const { stdout, stderr } = await execFileAsync(psExe, psArgs, {
      cwd: repoRoot,
      timeout: 15000,
      env: getWindowsExecutionEnv(),
      windowsHide: true,
    });
    invalidateTrayRunningCache();
    return { success: true, message: stdout || stderr };
  } catch (error: unknown) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      success: false,
      message: err.stderr || err.stdout || err.message || "Failed to execute uninstaller script.",
    };
  }
}

export async function toggleAutostart(enable: boolean): Promise<{ success: boolean; autostart: boolean; message?: string }> {
  if (process.platform !== "win32") {
    return { success: false, autostart: false, message: "Autostart is only supported on Windows." };
  }

  await saveWebServiceConfig({ autostart: enable });
  const repoRoot = getRepoRoot();
  const launchVbs = path.join(repoRoot, "scripts", "windows", "launch-tray.vbs");
  const icoPath = path.join(repoRoot, "public", "omp-web.ico");
  const { startup: startupLnk } = getWindowsShortcutPaths();

  try {
    if (enable) {
      const wscriptExe = resolveWscriptBin();
      const psCommand = `
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut('${startupLnk.replace(/'/g, "''")}')
        $sc.TargetPath = '${wscriptExe.replace(/'/g, "''")}'
        $sc.Arguments = '"${launchVbs.replace(/"/g, '`"')}" -Startup'
        $sc.WorkingDirectory = '${repoRoot.replace(/'/g, "''")}'
        if (Test-Path '${icoPath.replace(/'/g, "''")}') { $sc.IconLocation = '${icoPath.replace(/'/g, "''")},0' }
        $sc.Description = 'omp-web Background Tray Service'
        $sc.Save()
      `;
      const psExe = resolvePowerShellBin();
      await execFileAsync(
        psExe,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
        { timeout: 5000, env: getWindowsExecutionEnv(), windowsHide: true }
      );
    } else {
      if (existsSync(startupLnk)) {
        await fs.unlink(startupLnk);
      }
    }
    return { success: true, autostart: enable };
  } catch (error: unknown) {
    const err = error as Error;
    return { success: false, autostart: !enable, message: err.message };
  }
}

export async function startTrayService(options: { openBrowser?: boolean } = {}): Promise<{ success: boolean; message?: string }> {
  if (process.platform !== "win32") {
    return { success: false, message: "Tray service can only be started on Windows." };
  }

  const repoRoot = getRepoRoot();
  const launchVbs = path.join(repoRoot, "scripts", "windows", "launch-tray.vbs");

  if (!existsSync(launchVbs)) {
    return { success: false, message: `Launch script not found at ${launchVbs}` };
  }

  const wscriptExe = resolveWscriptBin();
  const vbsArgs = [launchVbs];
  if (options.openBrowser) {
    vbsArgs.push("-OpenBrowser");
  }

  return new Promise<{ success: boolean; message?: string }>((resolve) => {
    try {
      const child = spawn(wscriptExe, vbsArgs, {
        cwd: repoRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: getWindowsExecutionEnv(),
      });

      let settled = false;

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          resolve({ success: false, message: `Failed to launch tray process: ${err.message}` });
        }
      });

      child.unref();

      // Allow child spawn to tick to capture immediate spawn errors (ENOENT, etc.)
      setTimeout(() => {
        if (!settled) {
          settled = true;
          invalidateTrayRunningCache();
          resolve({ success: true });
        }
      }, 200);
    } catch (error: unknown) {
      const err = error as Error;
      resolve({ success: false, message: err.message });
    }
  });
}

export async function stopTrayService(): Promise<{ success: boolean; message?: string }> {
  if (process.platform !== "win32") {
    return { success: false, message: "Only supported on Windows." };
  }
  try {
    const taskkillExe = resolveTaskkillBin();
    const psCommand = `
      $trayProcs = Get-CimInstance Win32_Process -Filter "Name LIKE '%powershell%' OR Name LIKE '%pwsh%'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*omp-web-tray.ps1*' }
      foreach ($p in $trayProcs) {
          Start-Process -FilePath '${taskkillExe.replace(/'/g, "''")}' -ArgumentList "/PID $($p.ProcessId) /T /F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
      }
    `;
    const psExe = resolvePowerShellBin();
    await execFileAsync(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { timeout: 8000, env: getWindowsExecutionEnv(), windowsHide: true }
    );
    invalidateTrayRunningCache();
    return { success: true };
  } catch (error: unknown) {
    const err = error as Error;
    return { success: false, message: err.message };
  }
}
export async function restartTrayService(): Promise<{ success: boolean; message?: string }> {
  await stopTrayService();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 800);
  await promise;
  return startTrayService({ openBrowser: false });
}
