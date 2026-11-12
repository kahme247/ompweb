import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { act, render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");

test("URL session changes restore repeated visits without reselecting sidebar-only changes", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  const sessions = ["first", "second"].map((id) => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/workspace", projectRoot: "/workspace", firstMessage: id, created: "2026-11-01", modified: "2026-11-01", messageCount: 1 }));
  globalThis.Worker = class { postMessage() {} };
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://omp.test");
    if (url.pathname === "/api/sessions") return Response.json({ sessions });
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ path: "/workspace" }] });
    return Response.json({});
  };
  const selected = [];
  const onSelectSession = (session, restoring) => { selected.push([session.id, restoring]); };
  const props = { selectedSessionId: null, onSelectSession, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false };
  try {
    const view = render(React.createElement(SessionSidebar, { ...props, initialSessionId: "first" }));
    await waitFor(() => assert.deepEqual(selected, [["first", true]]));
    view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: "first", initialSessionId: "second" }));
    await waitFor(() => assert.deepEqual(selected, [["first", true], ["second", true]]));
    view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: "second", initialSessionId: "second", settingsOpen: true }));
    assert.equal(selected.length, 2);
    view.rerender(React.createElement(SessionSidebar, { ...props, initialSessionId: null }));
    view.rerender(React.createElement(SessionSidebar, { ...props, initialSessionId: "first" }));
    await waitFor(() => assert.deepEqual(selected, [["first", true], ["second", true], ["first", true]]));
  } finally {
    cleanup();
    Object.assign(globalThis, { fetch: original.fetch, Worker: original.Worker, SharedWorker: original.SharedWorker });
    window.matchMedia = original.matchMedia;
  }
});

function stubSidebarEnvironment(sessions) {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = class { postMessage() {} };
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://omp.test");
    if (url.pathname === "/api/sessions") return Response.json({ sessions });
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ path: "/workspace" }, { path: "/other" }] });
    return Response.json({});
  };
  return () => {
    cleanup();
    Object.assign(globalThis, { fetch: original.fetch, Worker: original.Worker, SharedWorker: original.SharedWorker });
    window.matchMedia = original.matchMedia;
  };
}

test("the automatic top-project pick is marked, a user pick is not, and options wait for the project fetch", async () => {
  const restore = stubSidebarEnvironment([]);
  const changes = [];
  const loaded = [];
  const props = {
    selectedSessionId: null, onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    onCwdChange: (cwd, _root, _host, _project, automatic) => changes.push([cwd, automatic]),
    onWorkspaceOptionsChange: (projects, _selected, _cwd, _host, isLoaded) => loaded.push([projects.length, isLoaded]),
  };
  try {
    const view = render(React.createElement(SessionSidebar, props));
    assert.deepEqual(loaded[0], [0, false]);
    await waitFor(() => assert.equal(changes.length, 1));
    assert.equal(changes[0][1], true);
    assert.equal(loaded.at(-1)[1], true);
    assert.equal(loaded.some(([count, isLoaded]) => count === 0 && isLoaded), false);
    const next = changes[0][0] === "/other" ? "/workspace" : "/other";
    const row = await view.findByText(next.slice(1));
    act(() => row.click());
    await waitFor(() => assert.equal(changes.length, 2));
    assert.deepEqual(changes[1], [next, false]);
  } finally {
    restore();
  }
});

test("a URL session the list lacks clears the previous selection once; the app's own selection is no restore", async () => {
  const sessions = [{ id: "first", path: "/sessions/first.jsonl", cwd: "/workspace", projectRoot: "/workspace", firstMessage: "first", created: "2026-11-01", modified: "2026-11-01", messageCount: 1 }];
  const restore = stubSidebarEnvironment(sessions);
  const selected = [];
  let pending = 0;
  const props = { onSelectSession: (session) => selected.push(session.id), onRestorePending: () => { pending += 1; }, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false };
  try {
    const view = render(React.createElement(SessionSidebar, { ...props, selectedSessionId: null, initialSessionId: "first" }));
    await waitFor(() => assert.deepEqual(selected, ["first"]));
    view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: "created", initialSessionId: "created" }));
    view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: "first", initialSessionId: "missing" }));
    await waitFor(() => assert.equal(pending, 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pending, 1);
    assert.deepEqual(selected, ["first"]);
  } finally {
    restore();
  }
});
