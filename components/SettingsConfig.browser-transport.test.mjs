import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

test("the browser transport control offers SSE and the WebSocket link, saves a change and restores a failed one", async (t) => {
  const puts = [];
  let putStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      puts.push(init.body);
      return Response.json({}, { status: putStatus });
    }
    return Response.json({ browserTransport: "sse" });
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
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["sse", "Server-sent events + HTTP (default)"], ["ws", "WebSocket link"]]);
  assert.equal(select.value, "sse");
  assert.equal(select.disabled, false);

  fireEvent.change(select, { target: { value: "ws" } });
  await settle();
  assert.deepEqual(puts, ['{"browserTransport":"ws"}']);
  assert.equal(select.value, "ws");

  putStatus = 500;
  fireEvent.change(select, { target: { value: "sse" } });
  await settle();
  assert.equal(puts.at(-1), '{"browserTransport":"sse"}');
  assert.equal(select.value, "ws", "a failed save restores the previous mode");
});
