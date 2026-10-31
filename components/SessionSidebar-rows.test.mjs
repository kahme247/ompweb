import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { PinnedSessionsGroup } = await jiti.import("./SessionSidebar-rows.tsx");

const noop = () => {};
const session = (id) => ({
  path: `/tmp/${id}.jsonl`,
  id,
  cwd: "/tmp/project",
  name: id,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: id,
});

test("pinned rows show the recently-completed indicator like workspace rows", () => {
  const html = renderToStaticMarkup(React.createElement(PinnedSessionsGroup, {
    sessions: [session("done"), session("idle")],
    collapsed: false,
    onToggleCollapsed: noop,
    selectedSessionId: null,
    runningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    recentlyCompletedIds: new Set(["done"]),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-01-02T00:00:00.000Z"),
    onSelectSession: noop,
    pinnedSessionIds: new Set(["done", "idle"]),
    onToggleSessionPin: noop,
    parentSessionIds: new Set(),
  }));
  assert.equal(html.match(/aria-label="Recently completed"/g)?.length, 1, "only the recently completed pin carries the indicator");
});
