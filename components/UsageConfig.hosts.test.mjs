import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { UsageConfig } = await import("./UsageConfig");

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const host = (hostId, label, state, syncedAt, cost) => ({ hostId, label, state, syncedAt, cost, tokens: cost * 1000, share: 0, sessionsCount: 1 });
const project = (hostId, hostLabel, name) => ({
  hostId, hostLabel, project: `/work/${name}`, projectName: name, cost: 1, tokens: 1000, share: 50, sessionsCount: 1,
});

function fakeUsage(t, report) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("/api/usage")) return Response.json({});
    return Response.json(report);
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
}

function report(extra) {
  return {
    summary: {
      totalCost: 3, totalTokens: 3000, inputTokens: 2000, outputTokens: 1000, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, cachePercentage: 0, cacheSavings: 0, tokensPerActiveDay: 3000,
      costQuality: { providerReported: 100, modelPriced: 0, unpriced: 0 },
    },
    scanInfo: { transcriptsScanned: 2, transcriptsOutsideWindow: 0, usageRecordsCount: 2, durationSeconds: 0.1 },
    providers: [], modelBreakdown: [], dayBreakdown: [], timeSeries: [],
    projectBreakdown: [project("local", "", "web"), project("h1", "laptop", "api")],
    ...extra,
  };
}

test("the HOST breakdown lists every machine with its sync state", async (t) => {
  const syncedAt = Date.UTC(2026, 10, 10, 12, 0);
  fakeUsage(t, report({
    hostBreakdown: [
      host("local", "", "current", null, 2),
      host("h1", "laptop", "offline", syncedAt, 1),
      host("h2", "build", "unsupported", null, 0),
      host("h3", "tablet", "stale", null, 0),
      host("h4", "nas", "syncing", null, 0),
    ],
  }));
  const { container } = render(createElement(UsageConfig));
  await settle();
  fireEvent.click(within(container).getByRole("button", { name: "HOST" }));
  const rows = [...container.querySelectorAll("tbody tr")].map((row) => row.cells[0].textContent);
  assert.deepEqual(rows, [
    "This machine",
    `laptopOffline · last synced ${new Date(syncedAt).toLocaleString()}`,
    "buildUpdate ompweb on this host to include its usage",
    "tabletNot synced yet",
    "nasSyncing…",
  ]);
});

test("project rows of a linked host name it", async (t) => {
  fakeUsage(t, report({ hostBreakdown: [host("local", "", "current", null, 2), host("h1", "laptop", "current", 1, 1)] }));
  const { container } = render(createElement(UsageConfig));
  await settle();
  fireEvent.click(within(container).getByRole("button", { name: "PROJECT" }));
  const rows = [...container.querySelectorAll("tbody tr")].map((row) => row.cells[0].textContent);
  assert.deepEqual(rows, ["web", "api · laptop"]);
});

test("a single machine shows no HOST toggle", async (t) => {
  fakeUsage(t, report({ hostBreakdown: [host("local", "", "current", null, 3)] }));
  const { container } = render(createElement(UsageConfig));
  await settle();
  assert.ok(within(container).getByRole("button", { name: "PROJECT" }));
  assert.equal(within(container).queryByRole("button", { name: "HOST" }), null);
});

test("a report without hostBreakdown shows no HOST toggle", async (t) => {
  fakeUsage(t, report({}));
  const { container } = render(createElement(UsageConfig));
  await settle();
  assert.ok(within(container).getByRole("button", { name: "PROJECT" }));
  assert.equal(within(container).queryByRole("button", { name: "HOST" }), null);
});
