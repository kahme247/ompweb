import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TabBar } = await jiti.import("./TabBar.tsx");

beforeEach(() => {
  globalThis.CSS ??= { escape: (value) => value };
});

afterEach(cleanup);

test("right-panel tabs support roving arrows, Home/End, and keyboard close", async () => {
  const user = userEvent.setup();
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
  }));

  const explorer = screen.getByRole("tab", { name: "Explorer" });
  const alpha = screen.getByRole("tab", { name: "/workspace/alpha.ts" });
  const beta = screen.getByRole("tab", { name: "/workspace/beta.ts" });
  assert.equal(alpha.tabIndex, 0);
  assert.equal(screen.getByRole("button", { name: "Close alpha.ts" }).tabIndex, 0);

  await act(async () => alpha.focus());
  await user.keyboard("{ArrowRight}");
  await waitFor(() => assert.equal(document.activeElement, beta));
  assert.deepEqual(selected, ["beta"]);

  await user.keyboard("{Home}");
  await waitFor(() => assert.equal(document.activeElement, explorer));
  assert.deepEqual(selected, ["beta", "explorer"]);

  await user.keyboard("{End}");
  await waitFor(() => assert.equal(document.activeElement, beta));
  assert.deepEqual(selected, ["beta", "explorer", "beta"]);

  await user.keyboard("{Delete}");
  assert.deepEqual(closed, ["beta"]);
});
