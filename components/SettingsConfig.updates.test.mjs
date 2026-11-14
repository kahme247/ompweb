import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};

/** Render the real System panel and record its HTTP boundary. */
async function renderSystemTab(t, { appUpdate = null, onRequestAppUpdate = noop }) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({}); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(SettingsConfig, {
      activeTab: "system",
      toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
      hideToolActivity: false, onHideToolActivityChange: noop,
      expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
      providerUsageVisible: false, onProviderUsageVisibleChange: noop,
      scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
      openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
      cwd: null, remoteHost: false, sessionId: null,
      onModelsSaved: noop, onPluginsReloaded: noop,
      appUpdate, onRefreshAppUpdate: async () => appUpdate,
      onRequestAppUpdate, onSelectTab: noop, onClose: noop,
    }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, requests };
}

const buttonLabels = (container) => [...container.querySelectorAll("button")].map((button) => button.textContent.trim());

test("System keeps web-server updates but never checks or updates the host runtime", async (t) => {
  let requested = false;
  const { container, requests } = await renderSystemTab(t, {
    appUpdate: { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, selfUpdateSupported: true },
    onRequestAppUpdate: () => { requested = true; },
  });
  assert.ok(container.querySelector("h2")?.textContent === "System");
  const updateButton = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Update and restart");
  assert.ok(updateButton);
  act(() => updateButton.click());
  assert.equal(requested, true);
  assert.ok(!buttonLabels(container).includes("Restart OMP sessions"));
  assert.ok(!container.textContent.includes("OMP runtime"));
  assert.ok(container.textContent.includes("Resume running sessions after a restart"));
  assert.ok(!requests.includes("/api/omp-update"), requests.join(", "));
});

test("a binary install's ompweb update links the release page instead of showing a command", async (t) => {
  const releases = "https://github.com/ompweb-dev/ompweb/releases/latest";
  const appUpdate = { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, selfUpdateSupported: false };
  const { container: binary } = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "binary", updateCommand: releases } });
  const link = binary.querySelector(`a[href="${releases}"]`);
  assert.ok(link, "no link to the release page");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /\bnoopener\b/);
  assert.ok(![...binary.querySelectorAll("code")].some((code) => code.textContent === releases), "the release page is shown as a command");

  const { container: npm } = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "npm", updateCommand: "npm install -g @kahme247/ompweb" } });
  assert.ok([...npm.querySelectorAll("code")].some((code) => code.textContent === "npm install -g @kahme247/ompweb"), "the npm command is gone");
});

test("a supported binary install gets the in-app Update action, not a download link, and clicking it only opens the review", async (t) => {
  const releases = "https://github.com/ompweb-dev/ompweb/releases/latest";
  let requested = 0;
  const { container, requests } = await renderSystemTab(t, {
    appUpdate: { currentVersion: "0.7.0", availableVersion: "0.8.0", updateAvailable: true, selfUpdateSupported: true, installMethod: "binary", updateCommand: releases },
    onRequestAppUpdate: () => { requested += 1; },
  });
  assert.equal(container.querySelector(`a[href="${releases}"]`), null, "a supported binary must not be sent to the download page");
  const updateButton = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Update and restart");
  assert.ok(updateButton, "no Update action for a supported binary install");
  act(() => updateButton.click());
  assert.equal(requested, 1);
  assert.ok(!requests.some((url) => url.includes("app-update")), "the Settings click must not prepare or commit anything itself");
});

test("a host's omp row shows the omp its ompweb shipped and offers no update of its own", async (t) => {
  const { HostUpdates } = await import("./HostUpdates");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ompweb: { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "npm install -g @kahme247/ompweb", installMethod: "npm", protocolVersion: 10 },
    omp: { currentVersion: "18.20.0-int.202611130355.gd2c2eff" },
    operation: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(HostUpdates, { host: { id: "box", label: "Box", status: "online", ompVersion: "omp/18.20.0-int.202611130355.gd2c2eff", ompwebVersion: "0.6.0" } }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(container.textContent.includes("18.20.0-int.202611130355.gd2c2eff"), container.textContent);
  assert.ok(container.textContent.includes("Updated with ompweb"), container.textContent);
  assert.deepEqual(buttonLabels(container).filter((label) => label === "Update"), ["Update"], "only ompweb has an update button");
});
