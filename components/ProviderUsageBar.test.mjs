import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  ProviderUsageBar,
  nextUsageDisplayWindow,
  displayWindowForReport,
  displaySummary,
} = await jiti.import("./ProviderUsageBar.tsx");

const report = (overrides) => ({
  provider: "anthropic",
  accountLabel: "main",
  accountIndex: 1,
  ...overrides,
});

test("usage display window cycles Auto -> 5H -> 7D -> Auto (#285)", () => {
  assert.equal(nextUsageDisplayWindow("auto"), "5H");
  assert.equal(nextUsageDisplayWindow("5H"), "7D");
  assert.equal(nextUsageDisplayWindow("7D"), "auto");
});

test("pinned 5H shows the 5-hour window even when it is not the worst (#285)", () => {
  const r = report({
    fiveHour: { percent: 30, resetMinutes: 120 },
    sevenDay: { percent: 80, resetHours: 48 },
    monthly: { percent: 10, resetHours: 200 },
  });
  assert.equal(displayWindowForReport(r, "auto")?.short, "7D");
  assert.equal(displayWindowForReport(r, "5H")?.window.percent, 30);
  assert.equal(displayWindowForReport(r, "7D")?.window.percent, 80);
});

test("a report without the pinned window falls back to its worst window (#285)", () => {
  const r = report({ sevenDay: { percent: 55, resetHours: 24 } });
  assert.equal(displayWindowForReport(r, "5H")?.short, "7D");
  assert.equal(displayWindowForReport(r, "5H")?.window.percent, 55);
});

test("header summary uses the pinned window across reports, skipping reports without it (#285)", () => {
  const reports = [
    report({ fiveHour: { percent: 40 }, sevenDay: { percent: 90 } }),
    report({ sevenDay: { percent: 70 } }),
    report({ fiveHour: { percent: 65 }, sevenDay: { percent: 20 } }),
  ];
  assert.deepEqual(displaySummary(reports, "auto"), { percent: 90, window: "7D" });
  assert.deepEqual(displaySummary(reports, "5H"), { percent: 65, window: "5H" });
  assert.deepEqual(displaySummary(reports, "7D"), { percent: 90, window: "7D" });
});

test("header summary falls back to the worst window when no report has the pinned window (#285)", () => {
  const reports = [report({ sevenDay: { percent: 55 } })];
  assert.deepEqual(displaySummary(reports, "5H"), { percent: 55, window: "7D" });
  assert.deepEqual(displaySummary([], "5H"), null);
});

test("widget renders with a window toggle chip (#285)", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderUsageBar, {}),
  );
  assert.match(html, /Switch usage window \(currently Auto\)/);
  assert.match(html, />Auto</);
});
