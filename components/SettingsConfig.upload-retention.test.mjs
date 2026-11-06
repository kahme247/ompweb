import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const settingsProps = {
  activeTab: "system",
  toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false, onHideToolActivityChange: noop,
  expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
  providerUsageVisible: false, onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
  cwd: null, remoteHost: false, sessionId: null,
  onModelsSaved: noop, onPluginsReloaded: noop,
  appUpdate: null, onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
};

function fakeSettings(t, stored) {
  const puts = [];
  let putStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      puts.push(init.body);
      return Response.json({}, { status: putStatus });
    }
    return Response.json(stored);
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return { puts, failPuts: () => { putStatus = 500; } };
}

test("the upload retention control offers Never, 7, 30 and 90 days, saves a change and restores a failed one", async (t) => {
  const { puts, failPuts } = fakeSettings(t, { uploadRetentionDays: 30 });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", { name: "Delete sent uploads after" });
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["null", "Never"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]);
  assert.equal(select.value, "30");

  fireEvent.change(select, { target: { value: "null" } });
  await settle();
  assert.deepEqual(puts, ['{"uploadRetentionDays":null}']);
  assert.equal(select.value, "null");

  failPuts();
  fireEvent.change(select, { target: { value: "90" } });
  await settle();
  assert.equal(puts.at(-1), '{"uploadRetentionDays":90}');
  assert.equal(select.value, "null", "a failed save restores the previous choice");
});

test("a retention set through the API stays visible as its own choice", async (t) => {
  fakeSettings(t, { uploadRetentionDays: 14 });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", { name: "Delete sent uploads after" });
  assert.equal(select.value, "14");
  assert.equal([...select.options].at(-1).textContent, "14 days");
});
