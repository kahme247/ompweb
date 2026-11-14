import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const LABEL = "Allow agent GitHub writes without asking";

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

/** `get` answers the settings load; each PUT waits until the test releases it. */
function fakeSettings(t, get) {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      const { promise, resolve, reject } = Promise.withResolvers();
      puts.push({ body: init.body, release: () => resolve(Response.json({})), fail: () => reject(new TypeError("Failed to fetch")) });
      return promise;
    }
    return get();
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return puts;
}

test("a failed settings load leaves the GitHub writes switch unknown and disabled", async (t) => {
  fakeSettings(t, () => Response.json({}, { status: 500 }));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  assert.equal(within(container).getByRole("switch", { name: LABEL }).disabled, true);
});

test("a lost GitHub writes save reloads the persisted permission before re-enabling", async (t) => {
  let persisted = false;
  let loads = 0;
  const puts = fakeSettings(t, () => {
    loads++;
    return Response.json({ githubWritesUnasked: persisted });
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const toggle = within(container).getByRole("switch", { name: LABEL });

  fireEvent.click(toggle);
  await settle();
  assert.deepEqual(puts.map((put) => put.body), ['{"githubWritesUnasked":true}']);
  const previousLoads = loads;
  persisted = true;
  puts[0].fail();
  await settle();
  assert.ok(loads > previousLoads, "the saved permission is reloaded after the uncertain PUT");
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
});

test("a failed GitHub writes reconciliation GET leaves the permission unknown and disabled", async (t) => {
  let failReload = false;
  let loads = 0;
  const puts = fakeSettings(t, () => {
    loads++;
    return failReload ? Response.json({}, { status: 500 }) : Response.json({ githubWritesUnasked: false });
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const toggle = within(container).getByRole("switch", { name: LABEL });

  fireEvent.click(toggle);
  await settle();
  const previousLoads = loads;
  failReload = true;
  puts[0].fail();
  await settle();
  assert.ok(loads > previousLoads, "the switch attempts to reload saved settings after the uncertain PUT");
  assert.equal(toggle.disabled, true);
});


test("the GitHub writes switch takes no second change until its save lands", async (t) => {
  const puts = fakeSettings(t, () => Response.json({ githubWritesUnasked: false }));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const toggle = within(container).getByRole("switch", { name: LABEL });
  assert.equal(toggle.disabled, false);

  fireEvent.click(toggle);
  await settle();
  assert.deepEqual(puts.map((p) => p.body), ['{"githubWritesUnasked":true}']);
  assert.equal(toggle.disabled, true, "an off click now could reach the server before the on");
  fireEvent.click(toggle);
  await settle();
  assert.equal(puts.length, 1);

  puts[0].release();
  await settle();
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
});
