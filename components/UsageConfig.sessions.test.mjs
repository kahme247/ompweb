import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, render, waitFor, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { UsageConfig, SESSION_PREVIEW_LIMIT } = await jiti.import("./UsageConfig.tsx");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.getSelection()?.removeAllRanges();
});

const SESSION_COUNT = SESSION_PREVIEW_LIMIT + 5;

/** Conversations as the server sends them: most expensive first. `s1` is deleted, `s2` is too large to open. */
function sessionBreakdown() {
  return Array.from({ length: SESSION_COUNT }, (_, i) => ({
    sessionId: `s${i}`,
    title: `Session ${i}`,
    project: `/home/user/project-${i % 3}`,
    projectName: `project-${i % 3}`,
    models: i === 0
      ? [
          { model: "claude-opus-5-5", provider: "anthropic", cost: 80, tokens: 1000 },
          { model: "claude-haiku-5", provider: "anthropic", cost: 20, tokens: 500 },
        ]
      : [{ model: "claude-opus-5-5", provider: "anthropic", cost: SESSION_COUNT - i, tokens: 100 }],
    cost: i === 0 ? 100 : SESSION_COUNT - i,
    tokens: i === 0 ? 1500 : 100,
    share: 1,
    requestsCount: 3,
    lastActiveAt: Date.UTC(2026, 9, 27, 12, 0),
    deleted: i === 1,
    tooLarge: i === 2,
  }));
}

function report() {
  return {
    timeRange: "30d",
    granularity: "daily",
    summary: {
      totalCost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, cacheSavings: 0, activeDays: 0, tokensPerActiveDay: 0, cachePercentage: 0,
      costQuality: { providerReported: 100, modelPriced: 0, unpriced: 0 },
    },
    providers: [],
    timeSeries: [],
    modelBreakdown: [],
    dayBreakdown: [],
    projectBreakdown: [],
    sessionBreakdown: sessionBreakdown(),
    scanInfo: { transcriptsScanned: 1, transcriptsOutsideWindow: 0, usageRecordsCount: 1, durationSeconds: 0.1, scannedAt: 0 },
  };
}

async function renderSessionsTab(opened) {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => report() };
  };
  const user = userEvent.setup();
  const view = render(React.createElement(UsageConfig, { onOpenSession: (id) => opened.push(id) }));
  const tab = await waitFor(() => view.getByRole("button", { name: "CONVERSATION" }));
  await user.click(tab);
  assert.equal(tab.getAttribute("aria-pressed"), "true");
  return { view, requests, user };
}

const rowIds = (container) => [...container.querySelectorAll("tr[data-session-id]")].map((tr) => tr.getAttribute("data-session-id"));

test("the conversation tab lists the most expensive conversations first and opens one on click", async () => {
  const opened = [];
  const { view, requests, user } = await renderSessionsTab(opened);
  assert.match(requests[0], /^\/api\/usage\?range=30d&/);

  // Server order (cost descending) is kept, capped at the preview limit.
  const ids = rowIds(view.container);
  assert.equal(ids.length, SESSION_PREVIEW_LIMIT);
  assert.deepEqual(ids.slice(0, 3), ["s0", "s1", "s2"]);
  const costs = [...view.container.querySelectorAll("tr[data-session-id] td:nth-child(2)")].map((td) => td.textContent);
  assert.deepEqual(costs.slice(0, 3), ["$100.00", "$54.00", "$53.00"]);

  // The row shows its project, main model (+ the others), last activity with its year, and request count.
  const first = view.container.querySelector('tr[data-session-id="s0"]');
  assert.match(first.textContent, /project-0 · claude-opus-5-5 \+1 · /);
  assert.match(first.querySelector("td:nth-child(1)").textContent, /2026/);
  assert.equal(first.querySelector("td:nth-child(5)").textContent, "3");

  await user.click(view.getByRole("button", { name: "Session 0" }));
  assert.deepEqual(opened, ["s0"], "the title button opens it once");

  // Any cell of the row opens it too.
  await user.click(view.container.querySelector('tr[data-session-id="s3"] td:nth-child(2)'));
  assert.deepEqual(opened, ["s0", "s3"]);
});

test("releasing a text selection in a row does not open it; a selection elsewhere does not block it", async () => {
  const opened = [];
  const { view, user } = await renderSessionsTab(opened);
  const row = view.container.querySelector('tr[data-session-id="s3"]');
  const title = within(row).getByRole("button", { name: "Session 3" });
  const dragSelect = (target) => user.pointer([{ keys: "[MouseLeft>]", target, offset: 0 }, { offset: 3 }, { keys: "[/MouseLeft]" }]);

  // Drag-selecting text in the row to copy it ends with a click on the row.
  await dragSelect(row.querySelector("td:nth-child(2)"));
  assert.equal(String(window.getSelection()), "$52");
  assert.deepEqual(opened, []);

  // Text selected in another row does not keep this one from opening.
  await dragSelect(view.container.querySelector('tr[data-session-id="s4"] td:nth-child(2)'));
  assert.equal(String(window.getSelection()), "$51");
  await user.click(title);
  assert.deepEqual(opened, ["s3"], "the title button still opens it");
});

test("a deleted conversation is labelled and cannot be opened", async () => {
  const opened = [];
  const { view, user } = await renderSessionsTab(opened);

  const deleted = view.container.querySelector('tr[data-session-id="s1"]');
  assert.equal(deleted.querySelector("button"), null);
  assert.match(deleted.textContent, /Deleted/);
  await user.click(view.getByText("Session 1"));
  await user.click(deleted.querySelector("td:nth-child(2)"));
  assert.deepEqual(opened, []);
});

test("a conversation too large to load is labelled and cannot be opened", async () => {
  const opened = [];
  const { view, user } = await renderSessionsTab(opened);

  const tooLarge = view.container.querySelector('tr[data-session-id="s2"]');
  assert.equal(tooLarge.querySelector("button"), null);
  assert.match(tooLarge.textContent, /Too large/);
  assert.match(view.getByText("Session 2").getAttribute("title"), /too large to open/);
  await user.click(view.getByText("Session 2"));
  await user.click(tooLarge.querySelector("td:nth-child(2)"));
  assert.deepEqual(opened, []);
});

test("show all lists every conversation and can collapse back to the top ones", async () => {
  const { view, user } = await renderSessionsTab([]);

  await user.click(view.getByRole("button", { name: `Show all ${SESSION_COUNT} conversations` }));
  assert.equal(rowIds(view.container).length, SESSION_COUNT);
  assert.equal(rowIds(view.container).at(-1), `s${SESSION_COUNT - 1}`);

  await user.click(view.getByRole("button", { name: `Show top ${SESSION_PREVIEW_LIMIT} only` }));
  assert.equal(rowIds(view.container).length, SESSION_PREVIEW_LIMIT);
});
