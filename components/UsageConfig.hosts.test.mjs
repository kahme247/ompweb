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

/** Answer `/api/usage` with `reports` in turn, the last one from then on; `null` answers 503. Returns the URLs asked for. */
function fakeUsage(t, ...reports) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("/api/usage")) return Response.json({});
    requests.push(String(url));
    const next = reports[Math.min(requests.length, reports.length) - 1];
    return next ? Response.json(next) : new Response("", { status: 503, statusText: "Service Unavailable" });
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return requests;
}

/** Fake `setTimeout`. The returned function advances it by `ms`, then lets pending fetches answer and React render. */
function mockTimers(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  return (ms = 0) => act(async () => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
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

test("while a host is syncing the report is fetched again, until the host is done", async (t) => {
  const laptop = (state) => report({ hostBreakdown: [host("local", "", "current", null, 2), host("h1", "laptop", state, null, 1)] });
  const requests = fakeUsage(t, laptop("syncing"), laptop("syncing"), laptop("current"));
  const advance = mockTimers(t);
  const { container } = render(createElement(UsageConfig));
  await advance();
  fireEvent.click(within(container).getByRole("button", { name: "HOST" }));
  const laptopRow = () => container.querySelectorAll("tbody tr")[1].cells[0].textContent;
  assert.deepEqual([requests.length, laptopRow()], [1, "laptopSyncing…"]);

  await advance(1999);
  assert.equal(requests.length, 1);
  await advance(1);
  assert.deepEqual([requests.length, laptopRow()], [2, "laptopSyncing…"]);
  await advance(2000);
  assert.deepEqual([requests.length, laptopRow()], [3, "laptop"]);
  assert.ok(requests.every((url) => !url.includes("refresh")), "polling never forces a refresh");

  await advance(60_000);
  assert.equal(requests.length, 3, "nothing is syncing any more");
});

test("leaving the page stops fetching for a host that is still syncing", async (t) => {
  const requests = fakeUsage(t, report({ hostBreakdown: [host("local", "", "current", null, 2), host("h1", "laptop", "syncing", null, 1)] }));
  const advance = mockTimers(t);
  const { unmount } = render(createElement(UsageConfig));
  await advance();
  unmount();
  await advance(60_000);
  assert.equal(requests.length, 1);
});

test("a background update that fails is shown above the report it could not replace, until one arrives", async (t) => {
  const laptop = (state) => report({ hostBreakdown: [host("local", "", "current", null, 2), host("h1", "laptop", state, null, 1)] });
  const requests = fakeUsage(t, laptop("syncing"), null, laptop("current"));
  const advance = mockTimers(t);
  const { container } = render(createElement(UsageConfig));
  await advance();
  assert.equal(within(container).queryByRole("alert"), null);

  await advance(2000);
  assert.equal(within(container).getByRole("alert").textContent, "Could not load usage data: Failed to fetch usage: Service Unavailable");
  assert.ok(within(container).getByRole("button", { name: "HOST" }), "the report stays on screen");

  await advance(2000);
  assert.deepEqual([requests.length, within(container).queryByRole("alert")], [3, null]);
});
