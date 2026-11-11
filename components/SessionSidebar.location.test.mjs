import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
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
