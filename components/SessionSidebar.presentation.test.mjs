import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { render, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { ProjectRow } = await import("./SessionSidebar-rows.tsx");
const { toast } = await import("./ui/toast.tsx");
const { translate } = await import("../lib/i18n/index.tsx");

test("failed workspace rename is reported without an unhandled rejection; failed launch save stays open", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia, error: toast.error };
  const errors = [];
  const writes = [];
  globalThis.Worker = class { postMessage() {} };
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  toast.error = (message) => { errors.push(message); };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/projects") {
      if (init.method === "PATCH") {
        writes.push(JSON.parse(init.body));
        return Response.json({ error: "Workspace update refused", code: "workspace_write_refused" }, { status: 400 });
      }
      return Response.json({ projects: [{ path: "/workspace", launchConfig: { profile: "work" } }] });
    }
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({});
  };
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: null, selectedCwd: "/workspace", skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.ok(screen.getByTitle("/workspace")));
    fireEvent.click(screen.getByRole("button", { name: translate("commandPalette.actions") }));
    fireEvent.click(screen.getByRole("menuitem", { name: translate("projects.nameAlias") }));
    const alias = screen.getByRole("textbox", { name: translate("projects.aliasPrompt") });
    fireEvent.change(alias, { target: { value: "New name" } });
    fireEvent.keyDown(alias, { key: "Enter" });
    await waitFor(() => assert.deepEqual(errors, ["Workspace update refused"]));
    assert.equal(writes[0].alias, "New name");
    assert.ok(screen.getByTitle("/workspace"), "the failed rename does not replace the displayed workspace");

    fireEvent.click(screen.getByRole("button", { name: translate("commandPalette.actions") }));
    fireEvent.click(screen.getByRole("menuitem", { name: translate("sessionSidebar.editLaunchConfig") }));
    fireEvent.click(screen.getByRole("button", { name: translate("projectLaunchConfig.save") }));
    await waitFor(() => assert.equal(errors.length, 2));
    assert.equal(writes[1].launchConfig.profile, "work");
    await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "Workspace update refused"));
    assert.ok(screen.getByRole("button", { name: translate("projectLaunchConfig.save") }), "the dialog remains open for correction or retry");
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
    toast.error = original.error;
  }
});

test("a pinned project row names its node; other rows carry no node label", () => {
  const noop = () => {};
  const row = (extra) => React.createElement(ProjectRow, {
    project: { path: "/srv/app", hostId: "h1" }, isActive: false, isExpanded: false, activity: undefined, tree: [], hiddenCount: 0,
    selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), exitedSessions: new Map(), relativeTimeNow: 0,
    onActivate: noop, onToggleExpand: noop, onRemoveProject: noop, onEditLaunchConfig: noop, onUpdatePresentation: noop,
    onDragProjectChange: noop, onDropProject: noop, onMoveProject: noop, pinnable: false, onTogglePin: noop, isDragTarget: false,
    removeBusy: false, onSelectSession: noop, ...extra,
  });
  try {
    render(row({ nodeLabel: "Build box" }));
    const label = screen.getByText("Build box");
    assert.equal(label.getAttribute("title"), translate("hosts.onNode", { node: "Build box" }));
    assert.equal(label.getAttribute("aria-label"), translate("hosts.onNode", { node: "Build box" }));
    cleanup();
    render(row({}));
    assert.equal(screen.queryByText("Build box"), null);
  } finally {
    cleanup();
  }
});
