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

const gitStatus = { ok: true, json: async () => ({ isGitRepository: false, files: [] }) };
const listing = (entries) => ({ ok: true, json: async () => ({ entries }) });
const hasChevron = (row) => row.querySelector("svg.lucide-chevron-right") !== null;

test("a link out of the workspace shows its target and neither expands nor opens", async () => {
  const lists = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/git/")) return gitStatus;
    lists.push(href);
    return listing([
      { name: "escape", isDir: true, size: 0, modified: "", linkTarget: "../shared/build", outsideRoot: true },
      { name: "shared", isDir: true, size: 0, modified: "", linkTarget: "real" },
      { name: "gone.txt", isDir: false, size: 0, modified: "", linkTarget: "../missing", outsideRoot: true },
      { name: "notes.txt", isDir: false, size: 0, modified: "" },
    ]);
  };
  const opened = [];
  const { container } = render(React.createElement(FileExplorer, { cwd: "/ws", hostId: "local", onOpenFile: (file) => opened.push(file) }));
  const row = (path) => container.querySelector(`[data-file-path="${path}"]`);
  await waitFor(() => assert.ok(row("/ws/escape")));

  // The explorer states its root, so the server can hold the tree to it.
  const listParams = new URL(lists[0], "http://localhost").searchParams;
  assert.equal(listParams.get("type"), "list");
  assert.equal(listParams.get("root"), "/ws");
  assert.equal(listParams.get("hostId"), "local");

  const outsideLabel = translate("fileExplorer.outsideRoot");
  assert.notEqual(outsideLabel, "fileExplorer.outsideRoot", "the string exists in the locale files");
  const escape = row("/ws/escape");
  assert.equal(escape.getAttribute("aria-disabled"), "true");
  assert.equal(escape.getAttribute("title"), outsideLabel);
  assert.equal(escape.getAttribute("aria-expanded"), null);
  assert.equal(escape.style.opacity, "0.5", "dimmed");
  assert.equal(hasChevron(escape), false);
  assert.ok(escape.textContent.includes("→ ../shared/build"));
  // Every symlink shows where it leads, inside the root or not; plain entries do not.
  assert.equal(row("/ws/shared").style.opacity, "1");
  assert.equal(hasChevron(row("/ws/shared")), true, "an in-root link still expands");
  assert.ok(row("/ws/shared").textContent.includes("→ real"));
  assert.equal(row("/ws/notes.txt").textContent.includes("→"), false);

  // A flagged file link has no way to fetch the file either.
  const gone = row("/ws/gone.txt");
  assert.equal(gone.style.opacity, "0.5");
  assert.equal(gone.querySelector("a[download]"), null);
  assert.notEqual(row("/ws/notes.txt").querySelector("a[download]"), null);

  for (const target of [escape, gone]) {
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: " " });
    fireEvent.keyDown(target, { key: "ArrowRight" });
  }
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

test("a folder that becomes a link out of the workspace drops its stale children", async () => {
  let flagged = false;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/git/")) return gitStatus;
    if (href.startsWith("/api/files/ws/sub?")) {
      return flagged
        ? { ok: false, status: 403, json: async () => ({ error: "Outside the explorer root" }) }
        : listing([{ name: "child.txt", isDir: false, size: 0, modified: "" }]);
    }
    return listing([flagged
      ? { name: "sub", isDir: true, size: 0, modified: "", linkTarget: "/elsewhere", outsideRoot: true }
      : { name: "sub", isDir: true, size: 0, modified: "" }]);
  };
  const opened = [];
  const props = { cwd: "/ws", onOpenFile: (file) => opened.push(file) };
  const { container, rerender } = render(React.createElement(FileExplorer, props));
  const row = (path) => container.querySelector(`[data-file-path="${path}"]`);
  await waitFor(() => assert.ok(row("/ws/sub")));
  fireEvent.click(row("/ws/sub"));
  await waitFor(() => assert.ok(row("/ws/sub/child.txt")));

  // A refresh re-reads the root and every expanded folder; sub is a link out now.
  flagged = true;
  rerender(React.createElement(FileExplorer, { ...props, refreshKey: 1 }));
  await waitFor(() => assert.equal(row("/ws/sub").getAttribute("aria-disabled"), "true"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(row("/ws/sub/child.txt"), null, "the old listing is not shown");
  fireEvent.click(row("/ws/sub"));
  assert.equal(row("/ws/sub/child.txt"), null);
  assert.deepEqual(opened, []);
});
