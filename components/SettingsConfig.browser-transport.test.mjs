import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

test("the browser transport control shows the saved mode, saves changes and shows pool numbers only for ws-pool", async (t) => {
  const puts = [];
  let putStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      puts.push(init.body);
      return Response.json({}, { status: putStatus });
    }
    return Response.json({ browserTransport: "sse", browserTransportPerSocket: 4, browserTransportMaxSockets: 16 });
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  const { container } = render(createElement(SettingsConfig, {
    activeTab: "general",
    toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
    hideToolActivity: false, onHideToolActivityChange: noop,
    expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
    providerUsageVisible: false, onProviderUsageVisibleChange: noop,
    scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
    openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
    cwd: null, remoteHost: false, sessionId: null,
    onModelsSaved: noop, onPluginsReloaded: noop,
    appUpdate: null, onRefreshAppUpdate: async () => null, onOmpUpdateAvailabilityChange: noop,
    onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
  }));
  await settle();
  const page = within(container);
  const select = page.getByRole("combobox", { name: "Browser connection (experiment)" });
  const perSocket = () => page.queryByRole("spinbutton", { name: "Sessions per connection" });
  const maxSockets = () => page.queryByRole("spinbutton", { name: "Most connections" });

  assert.equal(select.value, "sse");
  assert.equal(select.disabled, false);
  assert.equal(perSocket(), null);
  assert.equal(maxSockets(), null);

  fireEvent.change(select, { target: { value: "ws-pool" } });
  await settle();
  assert.deepEqual(puts, ['{"browserTransport":"ws-pool"}']);
  assert.equal(perSocket()?.value, "4");
  assert.equal(maxSockets()?.value, "16");

  fireEvent.change(perSocket(), { target: { value: "8" } });
  await settle();
  assert.deepEqual(puts.slice(1), ['{"browserTransportPerSocket":8}']);
  assert.equal(perSocket()?.value, "8");

  fireEvent.change(perSocket(), { target: { value: "0" } });
  await settle();
  assert.equal(puts.length, 2, "an out-of-range number is not saved");

  putStatus = 500;
  fireEvent.change(select, { target: { value: "ws-client" } });
  await settle();
  assert.equal(puts.at(-1), '{"browserTransport":"ws-client"}');
  assert.equal(select.value, "ws-pool", "a failed save restores the previous mode");
  assert.equal(perSocket()?.value, "8");
});
