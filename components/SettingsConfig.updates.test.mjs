import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};
const NO_OMP_UPDATE = { currentVersion: "1.0.0", availableVersion: null, updateAvailable: false, updateCommand: "omp update" };

/** Settings → System, with `ompCheck` as the answer to the omp update check. */
async function renderSystemTab(t, { ompCheck = NO_OMP_UPDATE, appUpdate = null }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => Response.json(String(url) === "/api/omp-update" ? ompCheck : {});
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
      appUpdate, onRefreshAppUpdate: async () => appUpdate, onOmpUpdateAvailabilityChange: noop,
      onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
    }));
  });
  // The omp update check answers after the first render.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return container;
}

const buttonLabels = (container) => [...container.querySelectorAll("button")].map((button) => button.textContent.trim());

test("OMP's Update now shows only when this server can run the update; the command stays", async (t) => {
  const update = { currentVersion: "1.0.0", availableVersion: "1.1.0", updateAvailable: true, updateCommand: "omp update" };
  const binary = await renderSystemTab(t, { ompCheck: { ...update, selfUpdateSupported: false } });
  assert.ok(!buttonLabels(binary).includes("Update now"), buttonLabels(binary).join(" | "));
  assert.ok([...binary.querySelectorAll("code")].some((code) => code.textContent === "omp update"), "the omp update command is gone");

  const npm = await renderSystemTab(t, { ompCheck: { ...update, selfUpdateSupported: true } });
  assert.ok(buttonLabels(npm).includes("Update now"), buttonLabels(npm).join(" | "));
});

test("a binary install's ompweb update links the release page instead of showing a command", async (t) => {
  const releases = "https://github.com/kahme247/ompweb/releases/latest";
  const appUpdate = { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, selfUpdateSupported: false };
  const binary = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "binary", updateCommand: releases } });
  const link = binary.querySelector(`a[href="${releases}"]`);
  assert.ok(link, "no link to the release page");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /\bnoopener\b/);
  assert.ok(![...binary.querySelectorAll("code")].some((code) => code.textContent === releases), "the release page is shown as a command");

  const npm = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "npm", updateCommand: "npm install -g @kahme247/ompweb" } });
  assert.ok([...npm.querySelectorAll("code")].some((code) => code.textContent === "npm install -g @kahme247/ompweb"), "the npm command is gone");
});
