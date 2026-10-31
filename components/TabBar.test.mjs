import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

const { TabBar } = await import("./TabBar.tsx");

beforeEach(() => {
  globalThis.CSS ??= { escape: (value) => value };
});

afterEach(cleanup);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

test("right-panel tabs support roving arrows, Home/End, and keyboard close", async () => {
  const selected = [];
  const closed = [];
  const tabs = [
    { id: "alpha", label: "alpha.ts", filePath: "/workspace/alpha.ts" },
    { id: "beta", label: "beta.ts", filePath: "/workspace/beta.ts" },
  ];

  render(React.createElement(TabBar, {
    tabs,
    activeTabId: "alpha",
    onSelectTab: (id) => selected.push(id),
    onCloseTab: (id) => closed.push(id),
    explorerSelected: true,
    onSelectExplorer: () => selected.push("explorer"),
    gitSelected: false,
    onSelectGit: () => selected.push("git"),
    onSelectNotifications: () => selected.push("notifications"),
    worktreesSelected: false,
    onSelectWorktrees: () => selected.push("worktrees"),
  }));

  // Notifications is the first pinned tab, so Home lands there.
  const notifications = screen.getByRole("tab", { name: "Notifications" });

  const explorer = screen.getByRole("tab", { name: "Explorer" });
  const alpha = screen.getByRole("tab", { name: "/workspace/alpha.ts" });
  const beta = screen.getByRole("tab", { name: "/workspace/beta.ts" });
  assert.equal(alpha.tabIndex, 0);
  assert.equal(screen.getByRole("button", { name: "Close alpha.ts" }).tabIndex, 0);

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta"]);

  fireEvent.keyDown(beta, { key: "Home" });
  await nextFrame();
  assert.equal(document.activeElement, notifications);
  assert.deepEqual(selected, ["beta", "notifications"]);

  fireEvent.keyDown(notifications, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, explorer);
  assert.deepEqual(selected, ["beta", "notifications", "explorer"]);

  fireEvent.keyDown(explorer, { key: "End" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta", "notifications", "explorer", "beta"]);

  fireEvent.keyDown(beta, { key: "Delete" });
  assert.deepEqual(closed, ["beta"]);

  fireEvent.keyDown(alpha, { key: "ArrowLeft" });
  await nextFrame();
  assert.equal(document.activeElement, screen.getByRole("tab", { name: "Worktrees" }));
  assert.deepEqual(selected, ["beta", "notifications", "explorer", "beta", "worktrees"]);
});
