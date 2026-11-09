import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { createElement } = await import("react");

const { UsageConfig, STALE_POLL_MS } = await import("./UsageConfig.tsx");

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * One report shaped like the API's. `records` is what the footer prints, so a
 * test can tell two answers apart without depending on the chart's layout.
 */
function report(records, stale) {
  return {
    timeRange: "30d",
    granularity: "daily",
    summary: {
      totalCost: 1,
      totalTokens: 1000,
      inputTokens: 1000,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheSavings: 0,
      activeDays: 1,
      tokensPerActiveDay: 1000,
      cachePercentage: 0,
      costQuality: { providerReported: 100, modelPriced: 0, unpriced: 0 },
    },
    providers: [],
    timeSeries: [],
    modelBreakdown: [],
    dayBreakdown: [],
    projectBreakdown: [],
    scanInfo: { transcriptsScanned: 1, transcriptsOutsideWindow: 0, usageRecordsCount: records, durationSeconds: 0.1, scannedAt: Date.now() },
    stale,
    scannedAt: Date.now(),
  };
}

/** The footer's "Scanned … · N usage records · …" line, which names the served report. */
function recordsShown() {
  // Testing Library matches every ancestor too; the innermost one is the footer.
  const footer = screen.getAllByText(/^Scanned .* usage records/).reduce((a, b) => (a.textContent.length <= b.textContent.length ? a : b));
  return Number(/· (\d+) usage records ·/.exec(footer.textContent ?? "")?.[1]);
}

/** Answers with `answers` in order, repeating the last one; records each URL. */
function serve(answers) {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const answer = answers[Math.min(requested.length - 1, answers.length - 1)];
    return { ok: true, json: async () => answer };
  };
  return requested;
}

test("a stale report is re-fetched until the background scan lands, so the page never keeps old numbers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requested = serve([
    report(11, true), // the server served its cache while it rescans
    report(22, false), // the rescan landed
  ]);

  render(createElement(UsageConfig));
  await act(async () => {});
  assert.equal(requested.length, 1, "the first load asks once");
  assert.equal(recordsShown(), 11, "the cached numbers show while the rescan runs");

  await act(async () => t.mock.timers.tick(STALE_POLL_MS));
  await act(async () => {});
  assert.equal(requested.length, 2, "the stale answer triggers a second request");
  assert.equal(recordsShown(), 22, "the page shows the rescanned numbers");

  // The fresh answer ends the polling: no third request without a new reason.
  await act(async () => t.mock.timers.tick(STALE_POLL_MS * 10));
  await act(async () => {});
  assert.equal(requested.length, 2, "a fresh report stops the re-fetch loop");
});

test("a fresh report is not re-fetched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requested = serve([report(11, false)]);

  render(createElement(UsageConfig));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(STALE_POLL_MS * 10));
  await act(async () => {});
  assert.equal(requested.length, 1);
  assert.equal(recordsShown(), 11);
});

test("the refresh button asks for a rescan instead of reusing the cached report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requested = serve([report(11, false), report(33, false)]);

  render(createElement(UsageConfig));
  await act(async () => {});
  assert.equal(requested.length, 1);

  const refresh = screen.getByRole("button", { name: "Refresh usage data" });
  await act(async () => refresh.click());
  await act(async () => {});

  assert.equal(requested.length, 2);
  assert.match(requested[1], /refresh=true/);
  assert.equal(recordsShown(), 33, "the refreshed numbers replace the old ones");
});

test("a slow earlier answer cannot overwrite a newer report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requested = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    // The second request (the refresh) is the slow one.
    if (requested.length === 2) return { ok: true, json: () => slow };
    return { ok: true, json: async () => report(requested.length === 1 ? 11 : 44, false) };
  };

  render(createElement(UsageConfig));
  await act(async () => {});
  assert.equal(recordsShown(), 11);

  const refresh = screen.getByRole("button", { name: "Refresh usage data" });
  await act(async () => refresh.click());
  await act(async () => {});
  // The slow refresh is still pending; a different query answers meanwhile.
  await act(async () => fireEvent.change(screen.getByLabelText("Time range"), { target: { value: "7d" } }));
  await act(async () => {});
  assert.equal(recordsShown(), 44, "the newer query's report is on screen");

  // The refresh answers last with numbers for the old query; they must not win.
  await act(async () => releaseSlow(report(99, false)));
  await act(async () => {});
  assert.equal(recordsShown(), 44, "the newer report stays on screen");
});
