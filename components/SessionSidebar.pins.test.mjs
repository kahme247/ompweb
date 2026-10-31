import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

// The live-event stream needs a worker; this test drives the list by fetches only.
globalThis.Worker ??= class { onmessage = null; onerror = null; postMessage() {} };
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
const { SessionSidebar } = await jiti.import("@/components/SessionSidebar");
const { ToastProvider } = await jiti.import("@/components/ui/toast");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

const noop = () => {};
const session = {
  path: "/work/proj/s-x.jsonl",
  id: "s-x",
  cwd: "/work/proj",
  name: "Pinned elsewhere",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hello",
};

test("a failed pin write refetches the list without its ETag so the server's pins win", async () => {
  // The server's pin list; the session list ETag follows it like the real route.
  let serverPins = ["s-x"];
  const etag = () => `"pins-${serverPins.join(",")}"`;
  const listRequests = [];
  let failPatch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "/api/sessions") {
      const ifNoneMatch = init.headers?.["If-None-Match"] ?? null;
      listRequests.push(ifNoneMatch);
      if (ifNoneMatch === etag()) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ sessions: [session], runningSessionIds: [], runningSessions: [], pinnedSessionIds: serverPins }), { status: 200, headers: { ETag: etag() } });
    }
    if (url === "/api/sessions/s-x" && init.method === "PATCH") {
      return new Promise((resolve) => { failPatch = () => resolve(new Response("{}", { status: 500 })); });
    }
    if (url === "/api/projects") return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };

  render(React.createElement(SessionSidebar, { selectedSessionId: null, onSelectSession: noop, addProjectOpen: false, setAddProjectOpen: noop, onOpenArchive: noop }));
  await waitFor(() => assert.ok(document.querySelector(".sidebar-pinned-sessions")?.textContent.includes("Pinned elsewhere")));

  // Unpin here; the write is still in flight when another device unpins the
  // same session and a refresh commits that list (and its new ETag).
  const user = userEvent.setup();
  const group = document.querySelector(".sidebar-pinned-sessions");
  await user.click(within(group).getByRole("button", { name: "Project actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Unpin" }));
  assert.equal(document.querySelector(".sidebar-pinned-sessions"), null, "the unpin shows at once");
  serverPins = [];
  // The browser reporting the network is back triggers the sidebar's refresh.
  await act(async () => { window.dispatchEvent(new window.Event("online")); });
  await waitFor(() => assert.equal(listRequests.length, 2));

  // This device's write fails: the local rollback re-pins the session, but the
  // server no longer pins it, so the refetch must not be answered with a 304.
  await act(async () => { failPatch(); });
  await waitFor(() => assert.equal(listRequests.length, 3));
  assert.equal(listRequests[2], null, "the refetch after a failed pin write is unconditional");
  await waitFor(() => assert.equal(document.querySelector(".sidebar-pinned-sessions"), null, "the server's pins win over the rollback"));
});

const parent = { ...session, path: "/work/proj/s-parent.jsonl", id: "s-parent", name: "Parent session" };
const pinnedFork = { ...session, path: "/work/proj/s-fork.jsonl", id: "s-fork", name: "Pinned fork", parentSessionId: "s-parent" };

function serveList(sessions, pinnedSessionIds, onArchive) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "/api/sessions") {
      return new Response(JSON.stringify({ sessions, runningSessionIds: [], runningSessions: [], pinnedSessionIds }), { status: 200 });
    }
    if (url === "/api/projects") return new Response(JSON.stringify({ projects: [{ path: "/work/proj" }] }), { status: 200 });
    if (url === "/api/sessions/s-parent/archive" && init.method === "POST") return onArchive(init);
    return new Response("{}", { status: 404 });
  };
}

async function openWorkspaceRowMenu(name) {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll(".sidebar-project-sessions .session-item-row")].find((element) => element.textContent.includes(name));
    assert.ok(found, `${name} is listed in its workspace`);
    return found;
  });
  const user = userEvent.setup();
  await user.click(within(row).getByRole("button", { name: "Project actions" }));
  return { row, user, archive: await screen.findByRole("menuitem", { name: "Archive" }) };
}

test("a session whose only fork is pinned cannot be archived from its workspace", async () => {
  let archiveRequests = 0;
  serveList([parent, pinnedFork], ["s-fork"], () => { archiveRequests += 1; return new Response("{}", { status: 200 }); });
  render(React.createElement(SessionSidebar, { selectedSessionId: null, onSelectSession: noop, addProjectOpen: false, setAddProjectOpen: noop, onOpenArchive: noop }));
  await waitFor(() => assert.ok(document.querySelector(".sidebar-pinned-sessions")?.textContent.includes("Pinned fork")));

  const { archive } = await openWorkspaceRowMenu("Parent session");
  assert.equal(archive.disabled, true, "the server only archives leaf sessions");
  assert.equal(archive.title, "Archive child sessions first");
  assert.equal(archiveRequests, 0);
});

test("a server refusal to archive a session with forks explains the leaf-only rule", async () => {
  // A stale list still shows the parent as a leaf; the server knows better.
  serveList([parent], [], () => new Response(JSON.stringify({ error: "has children", code: "session_has_children" }), { status: 409 }));
  render(React.createElement(ToastProvider, null, React.createElement(SessionSidebar, { selectedSessionId: null, onSelectSession: noop, addProjectOpen: false, setAddProjectOpen: noop, onOpenArchive: noop })));

  const { user, archive } = await openWorkspaceRowMenu("Parent session");
  assert.equal(archive.disabled, false);
  await user.click(archive);
  await waitFor(() => assert.ok(document.body.textContent.includes("Archive child sessions first"), "the toast names the leaf-only rule"));
  assert.ok(!document.body.textContent.includes("Failed to archive the session"));
});

test("a stalled archive error body times out into the generic failure toast", async (t) => {
  // Headers arrive, the body never does; aborting the request's signal errors
  // the body stream as real fetch does.
  serveList([parent], [], ({ signal }) => new Response(new ReadableStream({
    start(controller) { signal?.addEventListener("abort", () => controller.error(signal.reason)); },
  }), { status: 500 }));
  render(React.createElement(ToastProvider, null, React.createElement(SessionSidebar, { selectedSessionId: null, onSelectSession: noop, addProjectOpen: false, setAddProjectOpen: noop, onOpenArchive: noop })));

  const { row, user, archive } = await openWorkspaceRowMenu("Parent session");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Testing Library settles each action on a zero-delay timer, which a mocked clock runs only on a tick.
    let clicked = false;
    const click = user.click(archive).finally(() => { clicked = true; });
    while (!clicked) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(0);
    }
    await click;
    assert.equal(row.style.opacity, "0.5", "the row is busy while the error body stalls");

    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(document.body.textContent.includes("Failed to archive the session"), "the timeout surfaces the generic failure");
    assert.equal(row.style.opacity, "1", "the row leaves its busy state");
  } finally {
    // Unmounting in afterEach must clear its timers on the real clock.
    t.mock.timers.reset();
  }
});
