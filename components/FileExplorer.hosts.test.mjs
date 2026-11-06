import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import React from "react";
import test, { afterEach } from "node:test";
// The component is mounted against this file's isolated DOM/fetch environment.
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { FileExplorer } = await import("./FileExplorer.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; delete window.matchMedia; });

test("switching hosts with the same cwd replaces the Explorer listing", async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ isGitRepository: false, repositoryRoot: null, files: [] });
    const host = new URL(String(url), "http://localhost").searchParams.get("hostId");
    return Response.json({ path: "/same", entries: [{ name: host === "host-a" ? "alpha.txt" : "beta.txt", isDir: false, size: 0, modified: "" }] });
  };
  const view = render(React.createElement(FileExplorer, { hostId: "host-a", cwd: "/same", onOpenFile() {} }));
  await waitFor(() => assert.ok(view.container.textContent.includes("alpha.txt")));
  view.rerender(React.createElement(FileExplorer, { hostId: "host-b", cwd: "/same", onOpenFile() {} }));
  await waitFor(() => assert.ok(view.container.textContent.includes("beta.txt")));
  assert.ok(!view.container.textContent.includes("alpha.txt"));
});
