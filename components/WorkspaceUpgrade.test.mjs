import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { GitChangesPanel } = await import("./GitChangesPanel.tsx");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { WorktreesPanel } = await import("./WorktreesPanel.tsx");
const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker };
afterEach(() => { cleanup(); Object.assign(globalThis, original); delete window.matchMedia; });
const advice = "Upgrade the linked Beta host daemon before using this workspace feature";
function setup() {
  globalThis.Worker = class { postMessage() {} }; globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.startsWith("/api/git/") || url.pathname === "/api/worktrees") return Response.json({ error: advice, code: "workspace_unsupported" }, { status: 501 });
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ path: "/same", hostId: "remote" }] });
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({});
  };
}

test("Git preserves an older daemon's actionable upgrade explanation", async () => {
  setup();
  const view = render(React.createElement(GitChangesPanel, { cwd: "/same", hostId: "remote", onOpenFile() {} }));
  await waitFor(() => assert.ok(view.container.textContent.includes(advice)));
});

test("sidebar worktree failure reaches the panel as an upgrade error, not a non-repository result", async () => {
  setup();
  function Surface() {
    const [ctx, setCtx] = React.useState(null);
    return React.createElement(React.Fragment, null,
      React.createElement(SessionSidebar, { selectedSessionId: null, selectedCwd: "/same", selectedHostId: "remote", skipInitialProjectSelection: true,
        onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false, onWorktreeContextChange: setCtx }),
      React.createElement(WorktreesPanel, { ctx }));
  }
  const view = render(React.createElement(Surface));
  await waitFor(() => assert.ok(view.container.textContent.includes(advice)));
  assert.equal(view.queryByRole("button", { name: "New worktree…" }), null);
});
