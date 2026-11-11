import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");

const { ComposerPanels } = await import("./ComposerPanels.tsx");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // Collapsible headers scroll their active row into view.
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.matchMedia;
  delete window.HTMLElement.prototype.scrollIntoView;
});

function makeSubagent(index, status) {
  return { id: `s${index}`, agent: "explore", index, status, task: `task ${index}`, source: "live" };
}

function renderPanels(subagents) {
  render(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents,
    onSelectSubagent() {},
    defaultExpanded: true,
  }));
}

test("subagents header shows the completed count once nothing is running (#352)", () => {
  renderPanels(Array.from({ length: 6 }, (_, i) => makeSubagent(i, "completed")));
  const counter = screen.getByLabelText("6/6 complete");
  assert.equal(counter.textContent, "6/6 complete");
});

test("subagents header counts only truly completed runs, not failed ones (#352)", () => {
  renderPanels([
    ...Array.from({ length: 4 }, (_, i) => makeSubagent(i, "completed")),
    ...Array.from({ length: 2 }, (_, i) => makeSubagent(i + 4, "failed")),
  ]);
  const counter = screen.getByLabelText("4/6 complete");
  assert.equal(counter.textContent, "4/6 complete");
});

test("subagents header still shows the running count while any subagent runs", () => {
  renderPanels([
    ...Array.from({ length: 2 }, (_, i) => makeSubagent(i, "started")),
    ...Array.from({ length: 4 }, (_, i) => makeSubagent(i + 2, "completed")),
  ]);
  const counter = screen.getByLabelText("2 running · 6 total");
  assert.equal(counter.textContent, "2/6");
});
