import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_WEB_SERVICE_CONFIG,
  sanitizePort,
  sanitizeHostname,
  sanitizeMode,
  getWebServiceConfigPath,
  getWebServiceLogPath,
  getWindowsShortcutPaths,
  getWebServiceStatus,
  getAppVersion,
} = await jiti.import("./windows-service.ts");

test("DEFAULT_WEB_SERVICE_CONFIG has correct production ports and settings", () => {
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.port, 30177);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.hostname, "127.0.0.1");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.mode, "start");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autostart, true);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.openBrowserOnLaunch, false);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autoRestart, true);
});

test("sanitizePort validates numeric and string port values", () => {
  assert.equal(sanitizePort(30177), 30177);
  assert.equal(sanitizePort("30178"), 30178);
  assert.equal(sanitizePort(80), 80);
  assert.equal(sanitizePort(65535), 65535);

  // Invalid values fallback to default or provided fallback
  assert.equal(sanitizePort(0), 30177);
  assert.equal(sanitizePort(-1), 30177);
  assert.equal(sanitizePort(70000), 30177);
  assert.equal(sanitizePort("invalid"), 30177);
  assert.equal(sanitizePort(null, 8080), 8080);
  assert.equal(sanitizePort(undefined, 8080), 8080);
});

test("sanitizeHostname validates and trims hostname strings", () => {
  assert.equal(sanitizeHostname("127.0.0.1"), "127.0.0.1");
  assert.equal(sanitizeHostname("  0.0.0.0  "), "0.0.0.0");
  assert.equal(sanitizeHostname("localhost"), "localhost");
  assert.equal(sanitizeHostname("192.168.1.100"), "192.168.1.100");

  // Invalid values fallback
  assert.equal(sanitizeHostname(""), "127.0.0.1");
  assert.equal(sanitizeHostname("   "), "127.0.0.1");
  assert.equal(sanitizeHostname(null, "fallback.host"), "fallback.host");
  assert.equal(sanitizeHostname(undefined, "fallback.host"), "fallback.host");
});

test("sanitizeMode restricts mode to 'start' or 'dev'", () => {
  assert.equal(sanitizeMode("start"), "start");
  assert.equal(sanitizeMode("dev"), "dev");
  assert.equal(sanitizeMode("other"), "start");
  assert.equal(sanitizeMode(null, "dev"), "dev");
  assert.equal(sanitizeMode(undefined), "start");
});

test("getWebServiceConfigPath returns expected web-service.json path", () => {
  const configPath = getWebServiceConfigPath();
  assert.ok(configPath.endsWith(path.join(".omp", "agent", "web-service.json")) || configPath.endsWith("web-service.json"));
});

test("getWebServiceLogPath returns expected log path", () => {
  const logPath = getWebServiceLogPath();
  assert.ok(logPath.endsWith(path.join("logs", "omp-web-service.log")));
});

test("getWindowsShortcutPaths returns expected .lnk shortcut locations", () => {
  const shortcuts = getWindowsShortcutPaths();
  assert.ok(shortcuts.desktop.endsWith(path.join("Desktop", "omp-web.lnk")));
  assert.ok(shortcuts.startMenu.endsWith(path.join("Programs", "omp-web.lnk")));
  assert.ok(shortcuts.startup.endsWith(path.join("Startup", "omp-web-tray.lnk")));
});

test("getAppVersion returns package version string", () => {
  const ver = getAppVersion();
  assert.match(ver, /^\d+\.\d+\.\d+/);
});

test("getWebServiceStatus returns a complete status object", async () => {
  const status = await getWebServiceStatus();
  assert.equal(typeof status.isWindows, "boolean");
  assert.equal(typeof status.isInstalled, "boolean");
  assert.equal(typeof status.autostart, "boolean");
  assert.equal(typeof status.isRunning, "boolean");
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.hostname, "string");
  assert.ok(status.mode === "start" || status.mode === "dev");
  assert.equal(typeof status.desktopShortcutExists, "boolean");
  assert.equal(typeof status.startMenuShortcutExists, "boolean");
  assert.equal(typeof status.startupShortcutExists, "boolean");
  assert.equal(typeof status.logFile, "string");
  assert.equal(typeof status.configFile, "string");
  assert.equal(typeof status.serviceUrl, "string");
  assert.equal(typeof status.version, "string");
  assert.ok(status.serviceUrl.startsWith("http://"));
});
