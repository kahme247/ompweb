import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { act, render, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { ProjectRow } = await import("./SessionSidebar-rows.tsx");
const { toast } = await import("./ui/toast.tsx");
const { translate } = await import("../lib/i18n/index.tsx");

// The event-stream transport keeps the first worker it was given for the whole file.
const workers = [];
class FakeWorker {
  posted = [];
  constructor() { workers.push(this); }
  postMessage(message) { this.posted.push(message); }
}

test("failed workspace rename is reported without an unhandled rejection; failed launch save stays open", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia, error: toast.error };
  const errors = [];
  const writes = [];
  globalThis.Worker = FakeWorker;
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
    render(row({ node: { label: "Build box" } }));
    const button = screen.getByRole("button", { name: new RegExp(translate("hosts.onNode", { node: "Build box" })) });
    assert.equal(button.getAttribute("aria-describedby"), null, "an online node adds no description");
    assert.equal(screen.getByText("Build box").getAttribute("title"), translate("hosts.onNode", { node: "Build box" }));
    cleanup();
    const { container } = render(row({ node: { label: "Build box", statusText: "offline", unavailableReason: "Build box is offline." } }));
    const offline = screen.getByRole("button", { name: /On Build box/ });
    assert.equal(container.querySelector(`[id="${offline.getAttribute("aria-describedby")}"]`)?.textContent, "Build box is offline.");
    assert.ok(offline.getAttribute("title").endsWith("Build box is offline."));
    assert.equal(container.querySelector("section").style.opacity, "0.55");
    assert.ok(container.textContent.includes("Build box · offline"));
    cleanup();
    render(row({}));
    assert.equal(screen.queryByText("Build box"), null);
  } finally {
    cleanup();
  }
});

test("the sidebar lists a cluster's pool projects before its members' pinned projects, and marks an offline node", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const hostRows = [
    { id: "local", label: "", status: "online" },
    { id: "h1", label: "Build box", status: "offline", hostVersion: null, serverVersion: 9 },
  ];
  const pools = [{ id: "cluster", label: "Cluster", enabled: true, members: [{ hostId: "local" }, { hostId: "h1" }], projects: [] }];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts: hostRows, pools });
    if (url.pathname === "/api/projects") {
      return Response.json({ projects: [
        { path: "/a", hostId: "h1" },
        { path: "/l", hostId: "local" },
        { path: "pool:cluster:x", poolId: "cluster", projectId: "x", name: "shared", origin: "git@example.com:o/shared.git" },
      ] });
    }
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({});
  };
  try {
    const { container } = render(React.createElement(SessionSidebar, {
      selectedSessionId: null, skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.equal(container.querySelectorAll(".sidebar-project-identity").length, 3));
    const names = [...container.querySelectorAll(".sidebar-project-identity")].map((button) => button.textContent);
    assert.ok(names[0].startsWith("shared"), `the cluster's own project comes first: ${names.join(" | ")}`);
    assert.ok(names[1].startsWith("a") && names[2].startsWith("l"), names.join(" | "));
    const pinned = screen.getByRole("button", { name: /On Build box/ });
    assert.ok(pinned.textContent.includes(translate("hostsConfig.statusOffline")), "an offline node shows its status");
    const reason = container.querySelector(`[id="${pinned.getAttribute("aria-describedby")}"]`);
    assert.ok(reason?.textContent.includes("Build box"), "the button is described by the unavailable reason");
    assert.ok(screen.queryByRole("button", { name: /On This machine/ }), "this machine's pinned project names its node");
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
  }
});

test("the sidebar refetches its projects and sessions when the loaded pools change, not on their first load or an unchanged frame", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The remote host stays offline: nothing comes online, which refetches on its own.
  const hosts = [{ id: "local", label: "", status: "online" }, { id: "h1", label: "Build box", status: "offline", hostVersion: null, serverVersion: 9 }];
  const cluster = (...hostIds) => [{ id: "cluster", label: "Cluster", enabled: true, members: hostIds.map((hostId) => ({ hostId })), projects: [] }];
  let projectLoads = 0;
  let sessionLoads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts, pools: cluster("local") });
    if (url.pathname === "/api/projects") {
      projectLoads++;
      return Response.json({ projects: [] });
    }
    if (url.pathname === "/api/sessions") {
      sessionLoads++;
      return Response.json({ sessions: [] });
    }
    return Response.json({});
  };
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: null, skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await screen.findByRole("region", { name: "Cluster" });
    assert.equal(projectLoads, 1, "loading the pools does not fetch the projects again");
    const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
    const frame = (pools) => act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts, pools }) } }));
    const sessionsBefore = sessionLoads;
    frame(cluster("local"));
    assert.equal(projectLoads, 1, "a frame with the same pools");
    assert.equal(sessionLoads, sessionsBefore, "a frame with the same pools");
    // The server tags sessions with the cluster's bindings: they move to the new projects only when fetched again.
    frame(cluster("local", "h1"));
    assert.equal(projectLoads, 2, "a host joined");
    assert.equal(sessionLoads, sessionsBefore + 1, "a host joined");
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
  }
});
