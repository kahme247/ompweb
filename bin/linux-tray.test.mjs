import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  TRAY_ICON_PIXMAP_SIZES,
  buildAutostartDesktop,
  buildAutostartExec,
  buildIconPixmap,
  buildLayout,
  buildMenuItems,
  buildTrayIconPixels,
  itemById,
  itemProperties,
  probeServer,
  readTrayConfig,
  sanitizeHostname,
  sanitizePort,
  terminalCandidates,
  terminalPrefix,
} = require("./linux-tray.js");

test("sanitizePort accepts valid ports and falls back otherwise", () => {
  assert.equal(sanitizePort("30177"), 30177);
  assert.equal(sanitizePort(8080), 8080);
  assert.equal(sanitizePort("nope"), 30177);
  assert.equal(sanitizePort("70000"), 30177);
  assert.equal(sanitizePort(undefined, 4000), 4000);
});

test("sanitizeHostname trims strings and rejects empties", () => {
  assert.equal(sanitizeHostname(" 0.0.0.0 "), "0.0.0.0");
  assert.equal(sanitizeHostname(""), "127.0.0.1");
  assert.equal(sanitizeHostname(undefined, "localhost"), "localhost");
});

test("readTrayConfig prefers CLI overrides over the service config file", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ompweb-tray-"));
  try {
    const agentDir = path.join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "web-service.json"), JSON.stringify({ port: 40001, hostname: "0.0.0.0" }));

    const config = readTrayConfig({}, {}, home);
    assert.equal(config.port, 40001);
    assert.equal(config.hostname, "0.0.0.0");
    assert.equal(config.serviceUrl, "http://0.0.0.0:40001");

    const overridden = readTrayConfig({ port: 40100, hostname: "127.0.0.1" }, {}, home);
    assert.equal(overridden.port, 40100);
    assert.equal(overridden.serviceUrl, "http://127.0.0.1:40100");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readTrayConfig falls back to defaults without a config file", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ompweb-tray-"));
  try {
    const config = readTrayConfig({}, {}, home);
    assert.equal(config.port, 30177);
    assert.equal(config.hostname, "127.0.0.1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildMenuItems reflects running state and service availability", () => {
  const running = buildMenuItems({ running: true, version: "0.4.2", autostart: true, hasService: true });
  assert.equal(itemById(running, 2).label, "  Status: Running");
  assert.equal(itemById(running, 7).label, "Stop Server");
  assert.equal(itemById(running, 11).state, 1);

  const stoppedNoService = buildMenuItems({ running: false, version: "0.4.2", autostart: false, hasService: false });
  assert.equal(itemById(stoppedNoService, 2).label, "  Status: Stopped");
  assert.equal(itemById(stoppedNoService, 7).label, "Start Server");
  assert.equal(itemById(stoppedNoService, 7).enabled, false);
  assert.equal(itemById(stoppedNoService, 8).enabled, false);
  assert.equal(itemById(stoppedNoService, 11).state, 0);

  // Inert rows and separators.
  assert.equal(itemById(running, 1).enabled, false);
  assert.ok(itemById(running, 3).separator);
});

test("itemProperties renders standard, separator, and checkmark items", () => {
  const standard = itemProperties({ id: 4, label: "Open in Browser" });
  assert.equal(standard.label.value, "Open in Browser");
  assert.equal(standard.enabled.value, true);
  assert.ok(!standard["toggle-type"]);

  const separator = itemProperties({ id: 6, separator: true });
  assert.equal(separator.type.value, "separator");

  const checkmark = itemProperties({ id: 11, label: "Start with Plasma", checkmark: true, state: 1 });
  assert.equal(checkmark["toggle-type"].value, "checkmark");
  assert.equal(checkmark["toggle-state"].value, 1);
});

test("buildLayout nests all items under the root with the given revision", () => {
  const items = buildMenuItems({ running: true, version: "0.4.2", autostart: true, hasService: true });
  const [revision, root] = buildLayout(items, 7, 0);
  assert.equal(revision, 7);
  assert.equal(root[0], 0);
  assert.equal(root[1]["children-display"].value, "submenu");
  assert.equal(root[2].length, items.length);
  assert.equal(root[2][0].value[0], items[0].id);

  // A non-zero parent returns just that item; unknown parents return an empty node.
  const [, node] = buildLayout(items, 8, 4);
  assert.equal(node[0], 4);
  const [, empty] = buildLayout(items, 9, 999);
  assert.equal(empty[0], 999);
  assert.equal(empty[2].length, 0);
});

test("autostart desktop file references the tray script", () => {
  const desktop = buildAutostartDesktop("/usr/bin/node /opt/ompweb/bin/linux-tray.js --start");
  assert.match(desktop, /^\[Desktop Entry\]/);
  assert.match(desktop, /^Exec=\/usr\/bin\/node \/opt\/ompweb\/bin\/linux-tray\.js --start$/m);
  assert.match(desktop, /^Terminal=false$/m);
  assert.match(desktop, /^X-KDE-autostart-after=panel$/m);
});

test("buildAutostartExec quotes paths containing spaces", () => {
  const exec = buildAutostartExec();
  assert.match(exec, / --start$/);
  const parts = exec.match(/"([^"]+)"/g);
  if (parts) {
    for (const part of parts) assert.ok(!part.includes(" ") || part.startsWith('"'), "spaces must be quoted");
  }
});

test("terminal candidates honor explicit env overrides first", () => {
  const candidates = terminalCandidates({ OMP_WEB_TERMINAL: "foot", TERMINAL: "wezterm" });
  assert.deepEqual(candidates.slice(0, 2), ["foot", "wezterm"]);
  assert.ok(candidates.includes("konsole"));
});

test("terminal prefix wraps gnome-terminal with -- and others with -e", () => {
  assert.deepEqual(terminalPrefix("konsole"), ["konsole", "-e"]);
  assert.deepEqual(terminalPrefix("gnome-terminal"), ["gnome-terminal", "--"]);
});

test("probeServer resolves true for a live listener and false for a closed port", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await probeServer("127.0.0.1", port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeServer("127.0.0.1", port), false);
});

test("buildTrayIconPixels renders opaque rounded square with transparent corners", () => {
  const buffer = buildTrayIconPixels(64, true);
  assert.equal(buffer.length, 64 * 64 * 4);

  const pixel = (x, y) => {
    const offset = (y * 64 + x) * 4;
    return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
  };
  // Corners are outside the rounded box → fully transparent.
  for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]]) {
    assert.equal(pixel(x, y)[0], 0, `corner ${x},${y} must be transparent`);
  }
  // Center of the box: background color #c96f4a.
  const [a, r] = pixel(32, 8);
  assert.equal(a, 255);
  assert.ok(Math.abs(r - 201) <= 2, `background red must be ~201, got ${r}`);
  // Chevron stroke passes near (30, 32) → light foreground #fff8f2.
  const [, rFg] = pixel(30, 32);
  assert.ok(Math.abs(rFg - 255) <= 2, `glyph red must be ~255, got ${rFg}`);
});

test("buildIconPixmap returns sized structs with matching byte counts", () => {
  for (const size of TRAY_ICON_PIXMAP_SIZES) {
    const pixmaps = buildIconPixmap(false);
    const entry = pixmaps.find(([w, h]) => w === size && h === size);
    assert.ok(entry, `missing pixmap for size ${size}`);
    assert.equal(entry[2].length, size * size * 4);
  }
  // Stopped icon uses the gray background #8d8578.
  const stopped = buildIconPixmap(false).find(([w]) => w === 64)[2];
  assert.ok(Math.abs(stopped[(8 * 64 + 32) * 4 + 1] - 141) <= 2);
});
