import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

// The sidebar's green check means "finished in the background, not opened
// since": it follows the persisted unread set, never recency ranking.

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
const { SessionSidebar } = await jiti.import("@/components/SessionSidebar");

const UNREAD_KEY = "omp-web:unread-session-ids";
const CHECK = "Finished — not opened yet";
const PROJECT = "/work/alpha";

function session(id, firstMessage, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { path: `${PROJECT}/${id}.jsonl`, id, cwd: PROJECT, projectRoot: PROJECT, created: at, modified: at, messageCount: 2, firstMessage };
}
const SESSIONS = [
  session("s-bg", "Background task", 1),
  session("s-open", "Open task", 2),
  session("s-seen", "Seen task", 3),
];
/** What /api/sessions serves; a test may swap it before mounting. */
let sessions = SESSIONS;

/** The tab side of the shared event-stream worker (lib/event-stream.ts), so a
 * test can push `running` frames on the channel the sidebar opened. */
const eventStreams = new Map();
const eventWorker = {
  onmessage: null,
  onerror: null,
  postMessage(message) {
    if (message.op === "open") eventStreams.set(message.id, message.channel);
    else if (message.op === "close") eventStreams.delete(message.id);
  },
};
function deliverRunning(runningSessionIds) {
  const id = [...eventStreams].findLast(([, channel]) => channel.kind === "running")?.[0];
  assert.ok(id, "the sidebar must hold a running channel");
  act(() => {
    eventWorker.onmessage({ data: { id, type: "message", data: JSON.stringify({ type: "running", runningSessionIds, exitedSessions: [] }) } });
  });
}

/** Responses still being consumed; drained before each test ends so no state
 * update lands after the DOM globals are torn down. */
const inflight = new Set();
before(() => {
  globalThis.Worker = function Worker() { return eventWorker; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = (url) => {
    const path = String(url).split("?")[0];
    const body = path === "/api/sessions"
      ? { sessions, runningSessionIds: [] }
      : path === "/api/projects" ? { projects: [{ path: PROJECT }] } : {};
    const response = Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    inflight.add(response);
    void response.then(() => setTimeout(() => inflight.delete(response), 0));
    return response;
  };
});
afterEach(async () => {
  await act(async () => {
    while (inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  cleanup();
  localStorage.clear();
  sessions = SESSIONS;
});

function Harness({ initialSelected }) {
  const [selected, setSelected] = React.useState(initialSelected);
  return React.createElement(SessionSidebar, {
    selectedSessionId: selected,
    onSelectSession: (s) => setSelected(s.id),
    addProjectOpen: false,
    setAddProjectOpen: () => {},
    onOpenArchive: () => {},
    skipInitialProjectSelection: true,
  });
}

async function mount({ selected = null, unread } = {}) {
  localStorage.setItem("omp-web:expanded-projects", JSON.stringify([PROJECT]));
  if (unread) localStorage.setItem(UNREAD_KEY, JSON.stringify(unread));
  render(React.createElement(Harness, { initialSelected: selected }));
  await screen.findByText("Seen task");
}

const row = (title) => screen.getByText(title).closest(".session-item-row");
/** Any check mark in the row, whatever its label (main labelled it "Recently completed"). */
const hasCheck = (title) => row(title).querySelector("svg.lucide-check") !== null;

test("a session that finishes in the background shows the check until it is opened", async () => {
  await mount();
  deliverRunning(["s-bg"]);
  assert.equal(hasCheck("Background task"), false, "running sessions show the spinner, not the check");
  deliverRunning([]);
  await waitFor(() => assert.equal(hasCheck("Background task"), true));
  assert.ok(within(row("Background task")).getByLabelText(CHECK));
  assert.deepEqual(JSON.parse(localStorage.getItem(UNREAD_KEY)), ["s-bg"]);

  await userEvent.click(screen.getByText("Background task"));
  await waitFor(() => assert.equal(hasCheck("Background task"), false));
  assert.equal(localStorage.getItem(UNREAD_KEY), null, "opening it clears the persisted marker");
});

test("a session that finishes while it is open never shows the check", async () => {
  await mount({ selected: "s-open" });
  deliverRunning(["s-open"]);
  deliverRunning([]);
  await waitFor(() => assert.equal(localStorage.getItem(UNREAD_KEY), null));
  assert.equal(hasCheck("Open task"), false);
});

test("recent but already seen sessions show no check and stay in the running-only filter", async () => {
  await mount();
  for (const title of ["Background task", "Open task", "Seen task"]) assert.equal(hasCheck(title), false, title);

  await userEvent.click(screen.getByRole("button", { name: "Show running sessions only" }));
  // Nothing runs, yet the recent-runs retention keeps the finished sessions listed.
  assert.ok(screen.getByText("Seen task"));
  assert.equal(hasCheck("Seen task"), false);
});

test("opening the session in another tab clears the check here", async () => {
  await mount({ unread: ["s-bg"] });
  assert.equal(hasCheck("Background task"), true);

  localStorage.removeItem(UNREAD_KEY);
  act(() => { window.dispatchEvent(new window.StorageEvent("storage", { key: UNREAD_KEY, oldValue: '["s-bg"]', newValue: null })); });
  assert.equal(hasCheck("Background task"), false);
});

test("a check adopted from another tab skips the session open in this tab", async () => {
  await mount({ selected: "s-open" });
  localStorage.setItem(UNREAD_KEY, JSON.stringify(["s-bg", "s-open"]));
  act(() => { window.dispatchEvent(new window.StorageEvent("storage", { key: UNREAD_KEY, newValue: '["s-bg","s-open"]' })); });
  assert.equal(hasCheck("Background task"), true);
  assert.equal(hasCheck("Open task"), false);
  assert.deepEqual(JSON.parse(localStorage.getItem(UNREAD_KEY)), ["s-bg"], "the open session is written back as seen");
});

test("a nested child's check updates when only the child becomes unread", async () => {
  sessions = [...SESSIONS, { ...session("s-child", "Child task", 0), parentSessionId: "s-bg" }];
  await mount();
  assert.equal(hasCheck("Child task"), false);
  // Let every startup fetch land so only the unread set changes below.
  await act(async () => {
    while (inflight.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  });

  localStorage.setItem(UNREAD_KEY, JSON.stringify(["s-child"]));
  act(() => { window.dispatchEvent(new window.StorageEvent("storage", { key: UNREAD_KEY, newValue: '["s-child"]' })); });
  await waitFor(() => assert.equal(hasCheck("Child task"), true));
  assert.equal(hasCheck("Background task"), false, "the parent itself stays unmarked");
});
