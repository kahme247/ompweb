import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, createElement, createRef } from "react";
import { mock } from "bun:test";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
globalThis.CSS ??= { escape: (value) => value }; // TabBar's active-tab scroll uses CSS.escape; jsdom has none (as in TabBar.test.mjs)

// Real exports first, then the one function the panel polls: the contract function is stubbed per test.
const realEventStream = await import("@/lib/event-stream");
let diagnostics = null;
mock.module("@/lib/event-stream", () => ({
  ...realEventStream,
  requestConnectionDiagnostics: async () => diagnostics,
}));

const { RightPanel } = await import("./RightPanel");
const { setConnectionDiagnosticsEnabled, useConnectionDiagnosticsEnabled } = await import("@/lib/connection-diagnostics-prefs");

afterEach(() => {
  cleanup();
  localStorage.clear();
  diagnostics = null;
});

const wsDiagnostics = {
  setting: "ws",
  mode: "ws",
  fallback: false,
  status: "connected",
  since: null,
  lastReconnect: null,
  reconnects: 0,
  resumes: 0,
  resyncs: 0,
  clockRttMs: 12,
  effectiveType: "4g",
  pendingCommands: 0,
  uploads: 0,
  windowMs: 900000,
  stats: [{ transport: "ws", metric: "transportMs", count: 10, mean: 20.4, p50: 18, p95: 30, p999: null, max: 41 }],
};

function rightPanelProps(overrides) {
  return {
    fileTabs: [],
    activeFileTabId: null,
    rightView: "connection",
    onSelectView: () => {},
    rightPanelOpen: true,
    onClose: () => {},
    rightPanelWidth: null,
    rightPanelResizing: false,
    rightPanelRef: createRef(),
    fileExplorerRef: createRef(),
    revealPath: null,
    onRevealDone: () => {},
    explorerCwd: null,
    remoteHost: false,
    worktrees: null,
    explorerRefreshKey: 0,
    fileSearchOpen: false,
    onToggleFileSearch: () => {},
    onFileSearchOpenChange: () => {},
    showHiddenFiles: false,
    onToggleShowHiddenFiles: () => {},
    explorerUploadBusy: false,
    onUploadBusyChange: () => {},
    explorerGitCount: 0,
    explorerIsRepo: false,
    explorerRefreshing: false,
    isMobile: false,
    isCompactOverlay: false,
    onOpenFile: () => {},
    onSelectFileTab: () => {},
    onCloseFileTab: () => {},
    onCloseOtherFileTabs: () => {},
    onCloseAllFileTabs: () => {},
    onMentionActiveFile: () => {},
    onCopyActiveFilePath: () => {},
    onDownloadActiveFile: () => {},
    onRevealActiveFile: () => {},
    onExplorerRefresh: () => {},
    onExplorerRefreshDone: () => {},
    onAtMention: () => {},
    onAtMentions: () => {},
    onMentionLines: () => {},
    onExplorerGitStatus: () => {},
    onResetRightPanelWidth: () => {},
    onRightPanelResizeStart: () => {},
    onRightPanelResizeKey: () => {},
    ...overrides,
  };
}

/** Mirrors AppShell: the setting drives `connectionDiagnosticsOn`. */
function Harness() {
  const on = useConnectionDiagnosticsEnabled();
  return createElement(RightPanel, rightPanelProps({ connectionDiagnosticsOn: on }));
}

/** The value cell paired with a state row's label. */
function valueOf(label) {
  return screen.getByText(label).nextElementSibling;
}

test("with the setting off, the right panel has no Connection tab", () => {
  render(createElement(Harness));
  assert.ok(screen.getByRole("tab", { name: "Worktrees" }));
  assert.equal(screen.queryByRole("tab", { name: "Connection" }), null);
});

test("with the setting on, the Connection tab shows the WebSocket state and a dash for an empty p99.9", async () => {
  setConnectionDiagnosticsEnabled(true);
  diagnostics = wsDiagnostics;
  render(createElement(Harness));
  assert.ok(screen.getByRole("tab", { name: "Connection" }));

  await screen.findByText("Transport in use");
  assert.equal(valueOf("Transport in use").textContent, "WebSocket");
  assert.equal(valueOf("Status").textContent, "connected");

  const row = screen.getByText("Browser ↔ app round trip").closest("tr");
  const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
  // n, mean, p50, p95, p99.9, max
  assert.deepEqual(cells, ["10", "20", "18", "30", "—", "41"]);
});

test("the panel says so when the connection worker gives no diagnostics", async () => {
  setConnectionDiagnosticsEnabled(true);
  diagnostics = null;
  render(createElement(Harness));
  assert.ok(await screen.findByText("No diagnostics from the connection worker yet."));
});

test("turning the setting on while the panel is mounted adds the Connection tab", async () => {
  render(createElement(Harness));
  assert.equal(screen.queryByRole("tab", { name: "Connection" }), null);
  act(() => setConnectionDiagnosticsEnabled(true));
  assert.ok(await screen.findByRole("tab", { name: "Connection" }));
});
