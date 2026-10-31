import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// A running session paused on a dialog only the user can answer shows the
// amber "waiting for your answer" indicator instead of the running spinner,
// and its project row counts it as waiting rather than running.

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProjectRow } = await jiti.import("./SessionSidebar-rows.tsx");
const { projectActivityCounts } = await jiti.import("../lib/project-ordering.ts");
const { comparableProjectPath } = await jiti.import("../lib/comparable-path.ts");

const noop = () => {};
const project = { path: "/repo", addedAt: "2026-01-01T00:00:00.000Z" };
const session = (id, name) => ({
  id,
  name,
  firstMessage: name,
  path: `/sessions/${id}.jsonl`,
  cwd: "/repo",
  projectRoot: "/repo",
  created: "2026-10-28T00:00:00.000Z",
  modified: "2026-10-28T00:00:00.000Z",
  messageCount: 2,
});
const sessions = [session("working", "Working session"), session("waiting", "Waiting session"), session("idle", "Idle session")];
const tree = sessions.map((s) => ({ session: s, children: [] }));

function renderProject({ running, awaiting }) {
  const runningIds = new Set(running);
  const awaitingIds = new Set(awaiting);
  const activity = projectActivityCounts(sessions, runningIds, [], [], awaitingIds).get(comparableProjectPath("/repo"));
  return renderToStaticMarkup(React.createElement(ProjectRow, {
    project,
    isActive: true,
    isExpanded: true,
    activity,
    tree,
    hiddenCount: 0,
    selectedSessionId: null,
    runningSessionIds: runningIds,
    awaitingInputSessionIds: awaitingIds,
    unreadSessionIds: new Set(),
    recentlyCompletedIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-10-28T00:05:00.000Z"),
    onActivate: noop,
    onToggleExpand: noop,
    onRemoveProject: noop,
    onEditLaunchConfig: noop,
    onUpdatePresentation: noop,
    onDragPathChange: noop,
    onDropProject: noop,
    onMoveProject: noop,
    pinnable: false,
    onTogglePin: async () => {},
    isDragTarget: false,
    removeBusy: false,
    onSelectSession: noop,
  }));
}

/** Markup of the session row whose title is `name`. */
function rowFor(html, name) {
  const start = html.indexOf(`title="${name}"`);
  assert.ok(start >= 0, `row ${name} renders`);
  const rowStart = html.lastIndexOf('class="session-item-row"', start);
  const rowEnd = html.indexOf('class="session-item-row"', start);
  return html.slice(rowStart, rowEnd === -1 ? undefined : rowEnd);
}

const WAITING_LABEL = 'aria-label="Waiting for your answer"';
const SPINNER = 'class="sidebar-running-spinner"';

test("a session waiting for an answer shows the waiting indicator, not the spinner", () => {
  const html = renderProject({ running: ["working", "waiting"], awaiting: ["waiting"] });
  const waiting = rowFor(html, "Waiting session");
  assert.ok(waiting.includes(WAITING_LABEL), "waiting row is labelled for assistive tech");
  assert.ok(waiting.includes('title="Waiting for your answer"'), "waiting row has a tooltip");
  assert.ok(waiting.includes('data-awaiting-input="true"'));
  assert.ok(waiting.includes("var(--status-warning)"), "amber, distinct from the accent spinner");
  assert.ok(!waiting.includes(SPINNER), "no spinner while waiting");

  const working = rowFor(html, "Working session");
  assert.ok(working.includes(SPINNER), "a working session keeps the spinner");
  assert.ok(!working.includes(WAITING_LABEL));

  const idle = rowFor(html, "Idle session");
  assert.ok(!idle.includes(SPINNER) && !idle.includes(WAITING_LABEL));
});

test("the project summary counts waiting sessions separately from running ones", () => {
  const html = renderProject({ running: ["working", "waiting"], awaiting: ["waiting"] });
  assert.match(html, /aria-label="1 running, 1 waiting for your answer, 0 unread, 0 exited unexpectedly"/);
  assert.match(html, /class="sidebar-project-activity"[^>]*data-waiting="true"/);
  assert.match(html, /title="1 waiting for your answer"/, "the project badge shows the waiting icon");
});

test("once answered the row returns to the spinner and the summary to running only", () => {
  const html = renderProject({ running: ["working", "waiting"], awaiting: [] });
  assert.ok(rowFor(html, "Waiting session").includes(SPINNER));
  assert.ok(!html.includes(WAITING_LABEL));
  assert.match(html, /aria-label="2 running, 0 waiting for your answer, 0 unread, 0 exited unexpectedly"/);
  assert.match(html, /class="sidebar-project-activity"[^>]*data-waiting="false"/);
});

test("an awaiting id without a running session never shows the waiting indicator", () => {
  const html = renderProject({ running: [], awaiting: ["waiting"] });
  assert.ok(!html.includes(WAITING_LABEL));
  assert.ok(!html.includes('class="sidebar-project-activity"'), "no activity badge for an idle project");
});
