import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react/pure.js");

const { FileExplorer } = await import("./FileExplorer.tsx");
const { translate } = await import("../lib/i18n/index.tsx");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("a link out of the workspace shows its target and neither expands nor opens", async () => {
  const lists = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/git/")) return { ok: true, json: async () => ({ isGitRepository: false, files: [] }) };
    lists.push(href);
    return {
      ok: true,
      json: async () => ({
        entries: [
          { name: "escape", isDir: true, size: 0, modified: "", linkTarget: "../shared/build", outsideRoot: true },
          { name: "shared", isDir: true, size: 0, modified: "", linkTarget: "real" },
          { name: "notes.txt", isDir: false, size: 0, modified: "" },
        ],
      }),
    };
  };
  const opened = [];
  const { container } = render(React.createElement(FileExplorer, { cwd: "/ws", onOpenFile: (file) => opened.push(file) }));
  const row = (path) => container.querySelector(`[data-file-path="${path}"]`);
  await waitFor(() => assert.ok(row("/ws/escape")));

  // The explorer states its root, so the server can hold the tree to it.
  assert.ok(lists[0].includes("type=list&root=%2Fws"), lists[0]);

  const outsideLabel = translate("fileExplorer.outsideRoot");
  assert.notEqual(outsideLabel, "fileExplorer.outsideRoot", "the string exists in the locale files");
  const escape = row("/ws/escape");
  assert.equal(escape.getAttribute("aria-disabled"), "true");
  assert.equal(escape.getAttribute("title"), outsideLabel);
  assert.equal(escape.getAttribute("aria-expanded"), null);
  assert.ok(escape.textContent.includes("→ ../shared/build"));
  // Every symlink shows where it leads, inside the root or not; plain entries do not.
  assert.ok(row("/ws/shared").textContent.includes("→ real"));
  assert.equal(row("/ws/notes.txt").textContent.includes("→"), false);

  fireEvent.click(escape);
  fireEvent.keyDown(escape, { key: "Enter" });
  fireEvent.keyDown(escape, { key: "ArrowRight" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lists.length, 1, "no directory is fetched for it");
  assert.equal(escape.getAttribute("aria-expanded"), null);
  assert.deepEqual(opened, []);

  // A link that stays inside the root expands like any folder, and files still open.
  fireEvent.click(row("/ws/shared"));
  await waitFor(() => assert.equal(lists.length, 2));
  fireEvent.click(row("/ws/notes.txt"));
  assert.deepEqual(opened, ["/ws/notes.txt"]);
});
