"use strict";

// Linux system tray for ompweb (KDE Plasma and any StatusNotifierItem host).
//
// Registers a StatusNotifierItem on the session bus with a DBusMenu context
// menu mirroring the Windows tray: open, copy URL, start/stop/restart the
// systemd user service, view logs, autostart toggle, quit.
//
// CLI:
//   ompweb-tray --install [--no-autostart]   install icons/autostart, start tray
//   ompweb-tray --uninstall                  remove autostart and stop the tray
//   ompweb-tray --start                      run the tray (foreground)
//   ompweb-tray --stop | --restart           stop/restart a running tray
//   ompweb-tray --status [--json]            tray + service status
//   ompweb-tray --open                       open the web UI in the browser
//   -p, --port / -H, --hostname              override status endpoint

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbus = require("dbus-next");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync, execFile } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { promisify } = require("node:util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readServiceEnv, writeServiceEnv } = require("./service-env");// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAccessibleAddresses, isLoopbackHost } = require("./network-addresses");

const { Interface } = dbus.interface;
const { Variant } = dbus;

const execFileAsync = promisify(execFile);

const BUS_NAME = "org.kde.ompweb.tray";
const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/MenuBar";
const TRAY_PATH = "/ompweb/tray";
const SERVICE_UNIT = "ompweb.service";
const AUTOSTART_FILE = path.join(os.homedir(), ".config", "autostart", "ompweb-tray.desktop");
const ICON_DIR = path.join(os.homedir(), ".local", "share", "icons", "hicolor", "scalable", "apps");
const POLL_INTERVAL_MS = 5000;

// Warm-palette tray icons; installed into the user hicolor icon dir.
const ICON_RUNNING = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="#c96f4a"/>
  <path d="M18 22 L30 32 L18 42" fill="none" stroke="#fff8f2" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="34" y="38" width="14" height="6" rx="3" fill="#fff8f2"/>
</svg>
`;
const ICON_STOPPED = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="#8d8578"/>
  <rect x="20" y="28" width="24" height="8" rx="4" fill="#f5f1ea"/>
</svg>
`;

// ---------------------------------------------------------------------------
// Pure-JS tray icon rasterizer (SNI IconPixmap, ARGB32 big-endian = [A,R,G,B])
//
// Matches the SVG design: rounded square + prompt chevron + underscore
// (running) / gray square + flat bar (stopped). Rasterized at process start so
// the panel icon renders even when the theme cannot resolve IconName.
// ---------------------------------------------------------------------------

const TRAY_COLORS = {
  running: { bg: [201, 111, 74], fg: [255, 248, 242] }, // #c96f4a / #fff8f2
  stopped: { bg: [141, 133, 120], fg: [245, 241, 234] }, // #8d8578 / #f5f1ea
};

const TRAY_ICON_PIXMAP_SIZES = [24, 32, 64];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Signed distance to a rounded box centered at (cx, cy) with half extents.
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a segment (round caps) — used for the chevron strokes.
function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = clamp01((apx * abx + apy * aby) / (abx * abx + aby * aby));
  return Math.hypot(apx - abx * t, apy - aby * t);
}

// Signed distance for the foreground glyph at design coordinates (0..64).
function foregroundDistance(px, py, running) {
  if (!running) {
    // Flat horizontal bar: rounded rect centered (32, 32), half (12, 4), r 4.
    return sdRoundRect(px, py, 32, 32, 12, 4, 4);
  }
  const chevron = Math.min(
    sdSegment(px, py, 18, 22, 30, 32),
    sdSegment(px, py, 30, 32, 18, 42),
  ) - 3; // 6px stroke → half-width 3
  const underscore = sdRoundRect(px, py, 41, 41, 7, 3, 3);
  return Math.min(chevron, underscore);
}

// Convert one design pixel (SDF coverage) into straight-alpha ARGB floats.
function shadePixel(designX, designY, running, colors) {
  // 2×2 supersampling against the background rounded box and the glyph.
  let bgCover = 0;
  let fgCover = 0;
  for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const x = designX + ox;
    const y = designY + oy;
    bgCover += clamp01(0.5 - sdRoundRect(x, y, 32, 32, 28, 28, 14));
    fgCover += clamp01(0.5 - foregroundDistance(x, y, running));
  }
  const bgA = bgCover / 4;
  const fgA = fgCover / 4;
  // Composite foreground over background over transparent.
  const outA = fgA + bgA * (1 - fgA);
  if (outA <= 0) return [0, 0, 0, 0];
  const mix = (f, b) => (f * fgA + b * bgA * (1 - fgA)) / outA;
  return [outA, mix(colors.fg[0], colors.bg[0]), mix(colors.fg[1], colors.bg[1]), mix(colors.fg[2], colors.bg[2])];
}

// Rasterize the tray icon; returns an ARGB32 byte buffer ([A,R,G,B] per pixel).
function buildTrayIconPixels(size, running) {
  const colors = TRAY_COLORS[running ? "running" : "stopped"];
  const scale = size / 64;
  const buffer = Buffer.alloc(size * size * 4);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [a, r, g, b] = shadePixel((x + 0.5) / scale, (y + 0.5) / scale, running, colors);
      buffer[offset] = Math.round(a * 255);
      buffer[offset + 1] = Math.round(r);
      buffer[offset + 2] = Math.round(g);
      buffer[offset + 3] = Math.round(b);
      offset += 4;
    }
  }
  return buffer;
}

// SNI IconPixmap value: array of (width, height, ARGB32 bytes) structs.
function buildIconPixmap(running) {
  return TRAY_ICON_PIXMAP_SIZES.map((size) => [size, size, buildTrayIconPixels(size, running)]);
}

function printHelp() {
  console.log(`Usage: ompweb-tray [command] [options]

Linux system tray icon (StatusNotifierItem) for the ompweb web service.

Commands:
  --install, install     Install icons + autostart entry, then start the tray
  --uninstall, uninstall Remove autostart entry and stop the tray
  --start, start         Run the tray (foreground)
  --stop, stop           Stop a running tray
  --restart, restart     Restart the tray
  --status, status       Show tray and service status (default)
  --open, open           Open the web service in the default browser

Options:
  -p, --port <port>       Service port used for status (default from config)
  -H, --hostname <host>   Service hostname used for status (default from config)
      --no-autostart      Install without the desktop autostart entry
      --json              Output status as JSON
  -h, --help              Show this help
  -v, --version           Show version
`);
}

function readPackageVersion() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function sanitizePort(val, fallback = 30177) {
  const port = parseInt(val, 10);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

function sanitizeHostname(val, fallback = "127.0.0.1") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim();
}

// Tray configuration precedence: CLI overrides, then the service env file
// (the source the tray edits), then the Windows-style JSON config, then
// defaults.
function readTrayConfig(overrides = {}, env = process.env, home = os.homedir()) {
  const agentDir = (env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent")).replace(/^~(?=\/|$)/, home);
  const configFile = path.join(agentDir, "web-service.json");
  const serviceEnv = readServiceEnv(path.join(agentDir, "web-service.env"));
  let jsonConfig = {};
  try {
    jsonConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    jsonConfig = {};
  }
  const port = overrides.port ?? sanitizePort(serviceEnv.PORT ?? jsonConfig.port);
  const hostname = overrides.hostname ?? sanitizeHostname(serviceEnv.OMP_WEB_HOSTNAME ?? jsonConfig.hostname);
  return { port, hostname, configFile, serviceUrl: `http://${hostname}:${port}` };
}

// Menu item table. `separator` items render as dividers; `checkmark` items
// carry a toggle state; `disabled` items are inert status rows.
function buildMenuItems({ running, version, autostart, hasService, exposed, hasDialogTool }) {
  return [
    { id: 1, label: `ompweb (v${version})`, enabled: false },
    { id: 2, label: running ? "  Status: Running" : "  Status: Stopped", enabled: false },
    { id: 3, separator: true },
    { id: 4, label: "Open in Browser", action: "open" },
    { id: 5, label: "Copy Web URL", action: "copy" },
    { id: 6, separator: true },
    { id: 7, label: running ? "Stop Server" : "Start Server", action: "toggle", enabled: hasService },
    { id: 8, label: "Restart Server", action: "restart", enabled: hasService },
    { id: 9, separator: true },
    { id: 10, label: "View Logs", action: "logs" },
    { id: 11, separator: true },
    {
      id: 12,
      label: "Expose to Network",
      action: "expose",
      checkmark: true,
      state: exposed ? 1 : 0,
      enabled: hasService && hasDialogTool,
    },
    { id: 13, label: "Change Port…", action: "port", enabled: hasService && hasDialogTool },
    { id: 14, label: "Set Web Password…", action: "password", enabled: hasService && hasDialogTool },
    { id: 15, separator: true },
    { id: 16, label: "Start with Plasma", action: "autostart", checkmark: true, state: autostart ? 1 : 0 },
    { id: 17, separator: true },
    { id: 18, label: "Quit Tray", action: "quit" },
  ];
}

// DBus {sv} dictionary for one menu item.
function itemProperties(item) {
  if (item.separator) {
    return {
      type: new Variant("s", "separator"),
      visible: new Variant("b", true),
    };
  }
  const props = {
    label: new Variant("s", item.label),
    enabled: new Variant("b", item.enabled !== false),
    visible: new Variant("b", true),
  };
  if (item.checkmark) {
    props["toggle-type"] = new Variant("s", "checkmark");
    props["toggle-state"] = new Variant("i", item.state ?? 0);
  }
  return props;
}

// (ia{sv}av) struct for one menu node; children wrapped in variants.
function layoutNode(id, props, children = []) {
  return [id, props, children.map((child) => new Variant("(ia{sv}av)", child))];
}

// Full GetLayout response for the flat tray menu.
function buildLayout(items, revision, parentId = 0) {
  if (parentId === 0) {
    const children = items.map((item) => layoutNode(item.id, itemProperties(item), []));
    return [revision, layoutNode(0, { "children-display": new Variant("s", "submenu") }, children)];
  }
  const item = items.find((entry) => entry.id === parentId);
  if (!item) return [revision, layoutNode(parentId, {}, [])];
  return [revision, layoutNode(item.id, itemProperties(item), [])];
}

// [revision, layout] is cached; tests assert structure without dbus objects.
function itemById(items, id) {
  return items.find((entry) => entry.id === id) ?? null;
}

function buildAutostartDesktop(execLine) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ompweb Tray",
    "GenericName=ompweb tray icon",
    "Comment=ompweb web service tray icon and controls",
    `Exec=${execLine}`,
    "Icon=ompweb",
    "Terminal=false",
    "Categories=Network;",
    "X-GNOME-Autostart-enabled=true",
    "X-KDE-autostart-after=panel",
    "",
  ].join("\n");
}

function buildAutostartExec() {
  const nodeBin = process.execPath;
  const script = path.resolve(__filename);
  const needsQuoting = [nodeBin, script].some((part) => /\s/.test(part));
  if (!needsQuoting) return `${nodeBin} ${script} --start`;
  return `"${nodeBin.replace(/"/g, '\\"')}" "${script.replace(/"/g, '\\"')}" --start`;
}

// Terminal used to open logs; ordered candidates, first hit wins.
function terminalCandidates(env = process.env) {
  return [
    ...(env.OMP_WEB_TERMINAL ? [env.OMP_WEB_TERMINAL] : []),
    ...(env.TERMINAL ? [env.TERMINAL] : []),
    "konsole",
    "alacritty",
    "kitty",
    "gnome-terminal",
    "xterm",
  ];
}

// Prefix args for running a command inside the given terminal.
function terminalPrefix(terminal) {
  if (terminal === "gnome-terminal") return [terminal, "--"];
  return [terminal, "-e"];
}

function isExecutable(candidate) {
  try {
    return fs.statSync(candidate).isFile() && fs.accessSync(candidate, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function which(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function resolveTerminal(env = process.env) {
  for (const candidate of terminalCandidates(env)) {
    const base = path.basename(candidate);
    if (candidate.includes(path.sep) && isExecutable(candidate)) return candidate;
    if (!candidate.includes(path.sep) && which(base)) return base;
  }
  return null;
}

function resolveClipboardBin() {
  return which("wl-copy") ?? which("xclip") ?? null;
}

// Graphical prompt tools for tray settings (KDE kdialog first, zenity second).
function dialogCandidates() {
  return ["kdialog", "zenity"];
}

function resolveDialogTool(env = process.env) {
  const override = env.OMP_WEB_DIALOG;
  if (override) {
    return override.includes(path.sep) ? (isExecutable(override) ? override : null) : which(override);
  }
  for (const candidate of dialogCandidates()) {
    const found = which(candidate);
    if (found) return found;
  }
  return null;
}

// Show an input dialog; returns the entered string ("" allowed) or null on
// cancel / missing tool. Async so the tray's DBus loop stays responsive while
// the dialog is open.
async function dialogPrompt({ tool, title, text, value = "", password = false }, run = execFileAsync) {
  if (!tool) return null;
  let args;
  if (path.basename(tool) === "kdialog") {
    args = password
      ? ["--password", text, "--title", title]
      : ["--inputbox", text, value, "--title", title];
  } else {
    args = password
      ? ["--password", `--title=${title}`]
      : ["--entry", `--title=${title}`, `--text=${text}`, ...(value ? [`--entry-text=${value}`] : [])];
  }
  try {
    const { stdout } = await run(tool, args, { encoding: "utf8", maxBuffer: 1024 * 64 });
    return String(stdout ?? "").replace(/\n+$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

// Resolve via TCP connect; server presence is what "running" means for the tray.
function probeServer(hostname, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, hostname);
  });
}

function systemctlUser(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function serviceInstalled() {
  const dir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return fs.existsSync(path.join(dir, "systemd", "user", SERVICE_UNIT));
}

function openUrl(url) {
  const openBin = which("xdg-open") ?? "xdg-open";
  const child = spawn(openBin, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function copyToClipboard(text) {
  const bin = resolveClipboardBin();
  if (!bin) return false;
  const args = path.basename(bin) === "xclip" ? ["-selection", "clipboard"] : [];
  const result = spawnSync(bin, args, { input: text, encoding: "utf8" });
  return !result.error && result.status === 0;
}

function viewLogs() {
  const terminal = resolveTerminal();
  if (!terminal) return false;
  const resolved = candidateBinPath(terminal);
  if (!resolved) return false;
  const prefix = terminalPrefix(terminal).slice(1);
  const child = spawn(resolved, [...prefix, `journalctl --user -u ompweb -f`], {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  return true;
}

function candidateBinPath(terminal) {
  if (terminal.includes(path.sep)) return terminal;
  return which(path.basename(terminal)) ?? terminal;
}

// ---------------------------------------------------------------------------
// DBus interfaces
// ---------------------------------------------------------------------------

class StatusNotifierItem extends Interface {
  constructor(state) {
    super("org.kde.StatusNotifierItem");
    this.state = state;
  }

  get Status() {
    return "Active";
  }

  // IconName stays empty on purpose: Plasma prefers the theme name when
  // non-empty and renders an unresolvable name as nothing. Shipping real
  // ARGB pixels (IconPixmap) renders deterministically on every host.
  get IconName() {
    return "";
  }

  get IconPixmap() {
    return buildIconPixmap(this.state.running);
  }

  get ToolTip() {
    return [
      "",
      this.state.running ? buildIconPixmap(true) : buildIconPixmap(false),
      "ompweb",
      this.state.running ? `Running — ${this.state.serviceUrl}` : "Service stopped",
    ];
  }

  Activate() {
    openUrl(this.state.serviceUrl);
  }

  SecondaryActivate() {
    openUrl(this.state.serviceUrl);
  }

  Scroll() {}

  // Signal emitters — dbus-next emits the returned value as the signal body.
  NewTitle(...args) { return args; }
  NewIcon(...args) { return args; }
  NewAttentionIcon(...args) { return args; }
  NewOverlayIcon(...args) { return args; }
  NewToolTip(...args) { return args; }
  NewStatus(...args) { return args; }
}

StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: "s", access: "read" },
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    WindowId: { signature: "i", access: "read" },
    IconName: { signature: "s", access: "read" },
    // KDE marshals tray pixmaps as (width, height, ARGB32 byte array).
    IconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionIconName: { signature: "s", access: "read" },
    AttentionIconPixmap: { signature: "a(iiay)", access: "read" },
    OverlayIconName: { signature: "s", access: "read" },
    OverlayIconPixmap: { signature: "a(iiay)", access: "read" },
    ToolTip: { signature: "(sa(iiay)ss)", access: "read" },
    Menu: { signature: "o", access: "read" },
    ItemIsMenu: { signature: "b", access: "read" },
  },
  methods: {
    Activate: { inSignature: "ii", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
  signals: {
    NewTitle: { signature: "" },
    NewIcon: { signature: "" },
    NewAttentionIcon: { signature: "" },
    NewOverlayIcon: { signature: "" },
    NewToolTip: { signature: "" },
    NewStatus: { signature: "s" },
  },
});

StatusNotifierItem.prototype.Category = "ApplicationStatus";
StatusNotifierItem.prototype.Id = "ompweb";
StatusNotifierItem.prototype.Title = "ompweb";
// Status, IconName, IconPixmap, and ToolTip stay as class getters (dynamic).
StatusNotifierItem.prototype.WindowId = 0;
StatusNotifierItem.prototype.AttentionIconName = "";
StatusNotifierItem.prototype.AttentionIconPixmap = [];
StatusNotifierItem.prototype.OverlayIconName = "";
StatusNotifierItem.prototype.OverlayIconPixmap = [];
StatusNotifierItem.prototype.ItemIsMenu = true;
StatusNotifierItem.prototype.Menu = MENU_PATH;

class DbusMenu extends Interface {
  constructor(state) {
    super("com.canonical.dbusmenu");
    this.state = state;
  }

  GetLayout(parentId) {
    return buildLayout(this.state.menuItems(), this.state.menuRevision, Number(parentId) || 0);
  }

  GetGroupProperties(ids) {
    const items = this.state.menuItems();
    const found = ids
      .map((id) => itemById(items, Number(id)))
      .filter(Boolean)
      .map((item) => [item.id, itemProperties(item)]);
    return [found, []];
  }

  AboutToShow() {
    return false;
  }

  async Event(id, event) {
    await this.state.handleEvent(Number(id), String(event));
  }

  EventGroup(events) {
    for (const entry of events ?? []) {
      const [id, event] = entry;
      this.state.handleEvent(Number(id), String(event));
    }
    return [[]];
  }

  // Signal emitters — dbus-next emits the returned value as the signal body.
  LayoutUpdated(...args) { return args; }
  ItemsPropertiesUpdated(...args) { return args; }
}

DbusMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: "read" },
    TextDirection: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    IconThemePath: { signature: "s", access: "read" },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})as" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    Event: { inSignature: "isvu", outSignature: "" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ab" },
  },
  signals: {
    LayoutUpdated: { signature: "ui" },
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ia{sv})" },
  },
});

DbusMenu.prototype.Version = 3;
DbusMenu.prototype.TextDirection = "ltr";
DbusMenu.prototype.Status = "normal";
DbusMenu.prototype.IconThemePath = "";

class TrayControl extends Interface {
  constructor(state) {
    super("org.kde.ompweb.Tray");
    this.state = state;
  }

  Quit() {
    this.state.quit();
  }
}

TrayControl.configureMembers({
  methods: {
    Quit: { inSignature: "", outSignature: "" },
  },
});

// ---------------------------------------------------------------------------
// Tray state machine
// ---------------------------------------------------------------------------

function createTrayState(config, { log = console.log } = {}) {
  const state = {
    running: false,
    autostart: fs.existsSync(AUTOSTART_FILE),
    hasService: serviceInstalled(),
    exposed: !isLoopbackHost(config.hostname),
    dialogTool: resolveDialogTool(),
    menuRevision: 1,
    bus: null,
    sni: null,
    menu: null,
    pollTimer: null,
    registerTimer: null,
    registered: false,
    quitting: false,
    serviceUrl: config.serviceUrl,
    port: config.port,
    hostname: config.hostname,
    version: readPackageVersion(),
  };

  state.menuItems = () =>
    buildMenuItems({
      running: state.running,
      version: state.version,
      autostart: state.autostart,
      hasService: state.hasService,
      exposed: state.exposed,
      hasDialogTool: state.dialogTool !== null,
    });

  // Re-read the env file after config changes and refresh icon + menu.
  state.reloadConfig = () => {
    const config = readTrayConfig();
    state.port = config.port;
    state.hostname = config.hostname;
    state.serviceUrl = config.serviceUrl;
    state.exposed = !isLoopbackHost(config.hostname);
    state.refreshIcon();
    state.refreshMenu();
  };

  // Merge updates into the service env file and restart the unit to apply.
  // A `null` value removes the key.
  state.applyServiceEnv = (updates) => {
    const merged = readServiceEnv();
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    try {
      writeServiceEnv(merged);
    } catch (err) {
      state.notify("ompweb", `Config write failed: ${err.message}`);
      return false;
    }
    const result = systemctlUser(["restart", SERVICE_UNIT]);
    if (!result.ok) {
      state.notify("ompweb", `Service restart failed: ${result.stderr || result.stdout || "unknown error"}`);
      return false;
    }
    state.reloadConfig();
    return true;
  };

  state.refreshMenu = () => {
    state.menuRevision += 1;
    if (state.menu) state.menu.LayoutUpdated(state.menuRevision, 0);
  };

  state.refreshIcon = () => {
    if (!state.sni) return;
    Interface.emitPropertiesChanged(state.sni, {
      IconName: "",
      IconPixmap: buildIconPixmap(state.running),
      ToolTip: ["", buildIconPixmap(state.running), "ompweb", state.running ? `Running — ${state.serviceUrl}` : "Service stopped"],
    });
    state.sni.NewIcon();
    state.sni.NewToolTip();
  };

  state.handleEvent = async (id, event) => {
    if (event !== "clicked") return;
    const item = itemById(state.menuItems(), id);
    if (!item || item.enabled === false) return;
    switch (item.action) {
      case "open":
        openUrl(state.serviceUrl);
        break;
      case "copy":
        if (!copyToClipboard(state.serviceUrl)) state.notify("ompweb", "No clipboard tool found (install wl-clipboard)");
        break;
      case "toggle":
        systemctlUser([state.running ? "stop" : "start", SERVICE_UNIT]);
        break;
      case "restart":
        systemctlUser(["restart", SERVICE_UNIT]);
        break;
      case "logs":
        if (!viewLogs()) state.notify("ompweb", "No terminal emulator found for logs");
        break;
      case "autostart":
        state.setAutostart(!state.autostart);
        break;
      case "expose": {
        const exposing = !state.exposed;
        const updates = { OMP_WEB_HOSTNAME: exposing ? "0.0.0.0" : "127.0.0.1" };
        if (exposing && !readServiceEnv().OMP_WEB_PASSWORD) {
          const password = await dialogPrompt({
            tool: state.dialogTool,
            title: "ompweb",
            text: "A password is required to expose the web UI.\nWeb sign-in password:",
            password: true,
          });
          if (!password) {
            state.notify("ompweb", "Expose cancelled: a password is required to leave loopback");
            break;
          }
          updates.OMP_WEB_PASSWORD = password;
        }
        if (state.applyServiceEnv(updates)) {
          const urls = getAccessibleAddresses({ hostname: state.hostname, port: state.port }).entries
            .filter((entry) => entry.label !== "Local")
            .map((entry) => entry.url);
          state.notify(
            "ompweb",
            exposing
              ? `Exposed to the network: ${urls[0] ?? `http://0.0.0.0:${state.port}`}`
              : `Restricted to loopback (${state.serviceUrl})`,
          );
        }
        break;
      }
      case "port": {
        const input = await dialogPrompt({
          tool: state.dialogTool,
          title: "ompweb",
          text: `Server port (current: ${state.port}):`,
          value: String(state.port),
        });
        if (input === null) break;
        const port = parseInt(input.trim(), 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          state.notify("ompweb", `Invalid port: ${input.trim()}`);
          break;
        }
        if (state.applyServiceEnv({ PORT: String(port) })) {
          state.notify("ompweb", `Port updated: ${state.serviceUrl}`);
        }
        break;
      }
      case "password": {
        const password = await dialogPrompt({
          tool: state.dialogTool,
          title: "ompweb",
          text: "Web sign-in password (empty disables auth):",
          password: true,
        });
        if (password === null) break;
        const updates = {};
        if (password) {
          updates.OMP_WEB_PASSWORD = password;
        } else {
          updates.OMP_WEB_PASSWORD = null;
          if (!isLoopbackHost(state.hostname)) updates.OMP_WEB_HOSTNAME = "127.0.0.1";
        }
        if (state.applyServiceEnv(updates)) {
          state.notify("ompweb", password ? "Password updated" : "Password disabled (loopback only)");
        }
        break;
      }
      case "quit":
        state.quit();
        break;
      default:
        break;
    }
  };

  state.setAutostart = (enable) => {
    try {
      if (enable) {
        fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
        fs.writeFileSync(AUTOSTART_FILE, buildAutostartDesktop(buildAutostartExec()), { mode: 0o644 });
      } else {
        fs.rmSync(AUTOSTART_FILE, { force: true });
      }
      state.autostart = enable;
      state.refreshMenu();
    } catch (err) {
      state.notify("ompweb", `Autostart update failed: ${err.message}`);
    }
  };

  state.notify = async (summary, body) => {
    if (!state.bus) return;
    try {
      const obj = await state.bus.getProxyObject("org.freedesktop.Notifications", "/org/freedesktop/Notifications");
      const iface = obj.getInterface("org.freedesktop.Notifications");
      await iface.Notify("ompweb", 0, "ompweb", summary, body, [], {}, 5000);
    } catch {
      // Notifications are best-effort.
    }
  };

  state.poll = async () => {
    const wasRunning = state.running;
    let running = false;
    try {
      running = await probeServer(state.hostname, state.port);
    } catch {
      running = false;
    }
    const hadService = state.hasService;
    state.hasService = serviceInstalled();
    if (running !== wasRunning) {
      state.running = running;
      state.refreshIcon();
      state.refreshMenu();
    } else if (state.hasService !== hadService) {
      state.refreshMenu();
    }
  };

  state.registerWithWatcher = async () => {
    if (!state.bus) return;
    try {
      const obj = await state.bus.getProxyObject("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher");
      const watcher = obj.getInterface("org.kde.StatusNotifierWatcher");
      // KDE's watcher expects the bare bus name; /StatusNotifierItem is assumed.
      // Re-registration is idempotent (the watcher dedupes), so this also
      // self-heals after a plasmashell/kded6 restart.
      await watcher.RegisterStatusNotifierItem(BUS_NAME);
      if (!state.registered) log("tray registered with StatusNotifierWatcher");
      state.registered = true;
    } catch {
      // Watcher (plasmashell) may not be up yet; retry via timer.
    }
  };

  state.quit = () => {
    if (state.quitting) return;
    state.quitting = true;
    clearInterval(state.pollTimer);
    clearInterval(state.registerTimer);
    try {
      if (state.bus) state.bus.disconnect();
    } catch {
      // Ignore disconnect errors on shutdown.
    }
    process.exit(0);
  };

  return state;
}

async function startTray(config, { log = console.log, error = console.error } = {}) {
  const state = createTrayState(config, { log });

  installIcons({ log });
  ensureIconThemeCache();

  const bus = dbus.sessionBus();
  state.bus = bus;

  let nameReply;
  try {
    nameReply = await bus.requestName(BUS_NAME, 0);
  } catch (err) {
    error(`failed to request bus name: ${err.message}`);
    process.exit(1);
  }
  // 1 = primary owner, 4 = already ours; anything else means another tray runs.
  if (nameReply !== 1 && nameReply !== 4) {
    log("ompweb tray is already running");
    return state;
  }

  const sni = new StatusNotifierItem(state);
  const menu = new DbusMenu(state);
  const control = new TrayControl(state);
  state.sni = sni;
  state.menu = menu;

  bus.export(ITEM_PATH, sni);
  bus.export(MENU_PATH, menu);
  bus.export(TRAY_PATH, control);

  bus.on("error", (err) => error(`session bus error: ${err.message}`));

  await state.poll();
  await state.registerWithWatcher();
  state.registerTimer = setInterval(() => state.registerWithWatcher(), 60000);
  state.pollTimer = setInterval(() => state.poll(), POLL_INTERVAL_MS);
  log(`ompweb tray started (${state.serviceUrl})`);
  return state;
}

function installIcons({ log = console.log } = {}) {
  try {
    fs.mkdirSync(ICON_DIR, { recursive: true });
    fs.writeFileSync(path.join(ICON_DIR, "ompweb.svg"), ICON_RUNNING, { mode: 0o644 });
    fs.writeFileSync(path.join(ICON_DIR, "ompweb-off.svg"), ICON_STOPPED, { mode: 0o644 });
  } catch (err) {
    log(`warning: could not install tray icons: ${err.message}`);
  }
}

// Best-effort cache refresh so plasmashell picks up freshly written icons.
function ensureIconThemeCache() {
  for (const tool of ["kbuildsycoca6", "kbuildsycoca5", "gtk-update-icon-cache"]) {
    const bin = which(tool);
    if (!bin) continue;
    const args = tool.startsWith("gtk-update-icon-cache") ? ["-f", "-t", path.join(ICON_DIR, "..", "..", "..") ] : [];
    try {
      spawnSync(bin, args, { stdio: "ignore", timeout: 10000 });
    } catch {
      // Ignore cache refresh failures.
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function getTrayRunning(bus) {
  try {
    const dbusObj = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    const dbusIface = dbusObj.getInterface("org.freedesktop.DBus");
    await dbusIface.GetNameOwner(BUS_NAME);
    return true;
  } catch {
    return false;
  }
}

async function quitRunningTray() {
  const bus = dbus.sessionBus();
  try {
    const obj = await bus.getProxyObject(BUS_NAME, TRAY_PATH);
    const iface = obj.getInterface("org.kde.ompweb.Tray");
    await iface.Quit();
    return true;
  } catch {
    return false;
  } finally {
    bus.disconnect();
  }
}

async function readStatus(overrides) {
  const config = readTrayConfig(overrides);
  let trayRunning = false;
  try {
    const bus = dbus.sessionBus();
    try {
      trayRunning = await getTrayRunning(bus);
    } finally {
      bus.disconnect();
    }
  } catch {
    // No session bus (CI, SSH without a GUI session): report not running.
    trayRunning = false;
  }
  const active = systemctlUser(["is-active", SERVICE_UNIT.replace(/\.service$/, "")]);
  const serviceRunning = active.ok && active.stdout === "active";
  const autostart = fs.existsSync(AUTOSTART_FILE);
  return {
    isLinux: process.platform === "linux",
    trayRunning,
    serviceInstalled: serviceInstalled(),
    serviceRunning,
    autostart,
    port: config.port,
    hostname: config.hostname,
    serviceUrl: config.serviceUrl,
    configFile: config.configFile,
    autostartFile: AUTOSTART_FILE,
    version: readPackageVersion(),
  };
}

function spawnDetachedTray() {
  const child = spawn(process.execPath, [path.resolve(__filename), "--start"], {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.on("error", (err) => console.error(`failed to start tray: ${err.message}`));
  child.unref();
}

async function runCli(argv = process.argv.slice(2)) {
  const { values: cliArgs, positionals } = parseArgs({
    args: argv,
    options: {
      install:        { type: "boolean" },
      uninstall:      { type: "boolean" },
      start:          { type: "boolean" },
      stop:           { type: "boolean" },
      restart:        { type: "boolean" },
      status:         { type: "boolean" },
      open:           { type: "boolean" },
      port:           { type: "string", short: "p" },
      hostname:       { type: "string", short: "H" },
      "no-autostart": { type: "boolean" },
      json:           { type: "boolean" },
      help:           { type: "boolean", short: "h" },
      version:        { type: "boolean", short: "v" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (process.platform !== "linux") {
    console.error("error: the Linux tray is only supported on Linux (see omp-web-tray for Windows)");
    return { exitCode: 1 };
  }

  if (cliArgs.version || positionals.includes("version")) {
    console.log(readPackageVersion());
    return { exitCode: 0 };
  }
  if (cliArgs.help || positionals.includes("help")) {
    printHelp();
    return { exitCode: 0 };
  }

  const has = (flag) => cliArgs[flag] || positionals.includes(flag);
  const overrides = {
    ...(cliArgs.port ? { port: sanitizePort(cliArgs.port) } : {}),
    ...(cliArgs.hostname ? { hostname: sanitizeHostname(cliArgs.hostname) } : {}),
  };

  if (has("install")) {
    installIcons();
    ensureIconThemeCache();
    if (!cliArgs["no-autostart"]) {
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, buildAutostartDesktop(buildAutostartExec()), { mode: 0o644 });
      console.log(`autostart installed: ${AUTOSTART_FILE}`);
    }
    spawnDetachedTray();
    console.log("tray started in background.");
    return { exitCode: 0 };
  }

  if (has("uninstall")) {
    fs.rmSync(AUTOSTART_FILE, { force: true });
    const stopped = await quitRunningTray();
    console.log(`autostart removed: ${AUTOSTART_FILE}`);
    console.log(stopped ? "tray stopped." : "tray was not running.");
    return { exitCode: 0 };
  }

  if (has("start")) {
    const config = readTrayConfig(overrides);
    await startTray(config);
    return { exitCode: 0 };
  }

  if (has("stop")) {
    const stopped = await quitRunningTray();
    console.log(stopped ? "tray stopped." : "tray was not running.");
    return { exitCode: 0 };
  }

  if (has("restart")) {
    await quitRunningTray();
    installIcons();
    spawnDetachedTray();
    console.log("tray restarted in background.");
    return { exitCode: 0 };
  }

  if (has("open")) {
    const config = readTrayConfig(overrides);
    openUrl(config.serviceUrl);
    return { exitCode: 0 };
  }

  // Default: status.
  const status = await readStatus(overrides);
  if (cliArgs.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`=== ompweb Linux tray status ===`);
    console.log(`  Tray running    : ${status.trayRunning ? "Yes" : "No"}`);
    console.log(`  Service unit    : ${status.serviceInstalled ? "installed" : "not installed"} (${status.serviceRunning ? "active" : "inactive"})`);
    console.log(`  Autostart       : ${status.autostart ? `enabled (${status.autostartFile})` : "disabled"}`);
    console.log(`  Live URL        : ${status.serviceUrl}`);
  }
  return { exitCode: 0, status };
}

if (require.main === module) {
  runCli().then(({ exitCode }) => {
    if (exitCode !== undefined && exitCode !== 0) process.exit(exitCode);
  }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  AUTOSTART_FILE,
  BUS_NAME,
  ICON_RUNNING,
  ICON_STOPPED,
  TRAY_ICON_PIXMAP_SIZES,
  buildAutostartDesktop,
  buildAutostartExec,
  buildIconPixmap,
  buildLayout,
  buildMenuItems,
  buildTrayIconPixels,
  dialogCandidates,
  dialogPrompt,
  itemById,
  itemProperties,
  layoutNode,
  pollIntervalMs: POLL_INTERVAL_MS,
  probeServer,
  readTrayConfig,
  resolveDialogTool,
  resolveTerminal,
  runCli,
  sanitizeHostname,
  sanitizePort,
  serviceInstalled,
  terminalCandidates,
  terminalPrefix,
};
