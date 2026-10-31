import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ComposerModeStatus } = await jiti.import("./ChatInput-banners.tsx");

const goal = (overrides = {}) => ({
  id: "g1",
  objective: "ship the export",
  status: "active",
  tokensUsed: 1234,
  timeUsedSeconds: 90,
  createdAt: 1000,
  updatedAt: Date.now(),
  ...overrides,
});
const state = (value) => ({ enabled: value.status === "active", mode: "active", goal: value });
const flush = () => act(async () => { await Promise.resolve(); });

afterEach(async () => {
  cleanup();
  await flush();
});

test("an active goal shows its status, objective, tokens and pause/drop actions", async () => {
  const actions = [];
  render(React.createElement(ComposerModeStatus, {
    goal: state(goal()),
    onGoalAction: (op) => actions.push(op),
  }));

  assert.match(screen.getByText(/ship the export/).textContent, /ship the export/);
  assert.match(screen.getByText(/Goal active/).textContent, /1m/);
  fireEvent.click(screen.getByRole("button", { name: /ship the export/ }));

  assert.match(screen.getByText(/1,234 tokens/).textContent, /1,234 tokens/);
  fireEvent.click(screen.getByRole("button", { name: /^Pause$/ }));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Drop$/ }));
  await flush();
  assert.deepEqual(actions, ["pause", "drop"]);
});

test("goal controls stay disabled until a pending action settles", async () => {
  const actions = [];
  let release;
  render(React.createElement(ComposerModeStatus, {
    goal: state(goal()),
    onGoalAction: (op) => {
      actions.push(op);
      return new Promise((resolve) => { release = resolve; });
    },
  }));

  fireEvent.click(screen.getByRole("button", { name: /ship the export/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Pause$/ }));
  const pause = screen.getByRole("button", { name: /^Pause$/ });
  const drop = screen.getByRole("button", { name: /^Drop$/ });
  assert.equal(pause.disabled, true);
  assert.equal(drop.disabled, true);

  fireEvent.click(drop);
  assert.deepEqual(actions, ["pause"]);

  await act(async () => {
    release();
    await Promise.resolve();
  });
  assert.equal(pause.disabled, false);
  assert.equal(drop.disabled, false);
});

test("a paused goal offers resume, and a finished goal offers no actions", async () => {
  const actions = [];
  const view = render(React.createElement(ComposerModeStatus, {
    goal: state(goal({ status: "paused" })),
    onGoalAction: (op) => actions.push(op),
  }));
  assert.match(screen.getByText(/Goal paused/).textContent, /Goal paused/);
  fireEvent.click(screen.getByRole("button", { name: /ship the export/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Resume$/ }));
  await flush();
  assert.deepEqual(actions, ["resume"]);

  view.rerender(React.createElement(ComposerModeStatus, {
    goal: state(goal({ status: "completed" })),
    onGoalAction: (op) => actions.push(op),
  }));
  fireEvent.click(screen.getByRole("button", { name: /ship the export/ }));
  assert.match(screen.getByText(/Goal completed/).textContent, /Goal completed/);
  assert.equal(screen.queryByRole("button", { name: /^(Pause|Resume|Drop)$/ }), null);
});
