import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ClampedDescription, clampDescriptionStyle, resolveToastTimeout, toast, toastHistory, TOAST_HISTORY_LIMIT } = await jiti.import("./toast.tsx");

const TOOL_LIST = "xd://: mounted mcp__ida_reverse_engineering_ida_address_context, mcp__ida_decompile";

test("clamped description renders collapsed to 2 lines with an expand affordance", () => {
  const html = renderToStaticMarkup(React.createElement(ClampedDescription, null, TOOL_LIST));

  assert.match(html, new RegExp(TOOL_LIST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /-webkit-line-clamp:2/);
  assert.match(html, /-webkit-box/);
  assert.match(html, /overflow:hidden/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /cursor:pointer/);
  assert.match(html, /Click to expand/);
});

test("clamp style helper drops the clamp when expanded", () => {
  const collapsed = clampDescriptionStyle(false);
  const expanded = clampDescriptionStyle(true);

  assert.equal(collapsed.display, "-webkit-box");
  assert.equal(collapsed.WebkitLineClamp, 2);
  assert.equal(collapsed.overflow, "hidden");
  assert.equal(collapsed.cursor, "pointer");

  assert.equal(expanded.display, undefined);
  assert.equal(expanded.WebkitLineClamp, undefined);
  assert.equal(expanded.overflow, undefined);
  assert.equal(expanded.cursor, "default");
});

test("history keeps the newest notification toasts first, capped at the limit; other toasts stay out", () => {
  toastHistory.clear();
  toast.success("Saved");
  toast.error("Copy failed");
  assert.equal(toastHistory.get().length, 0);
  for (let i = 0; i < TOAST_HISTORY_LIMIT + 5; i++) toast.info(`n${i}`, undefined, { history: true });
  const entries = toastHistory.get();
  assert.equal(entries.length, TOAST_HISTORY_LIMIT);
  assert.equal(entries[0].title, `n${TOAST_HISTORY_LIMIT + 4}`);
  assert.equal(entries.at(-1).title, "n5");
});

test("a reused toast id replaces its history entry; remove and clear drop entries", () => {
  toastHistory.clear();
  toast.info("update v1", undefined, { id: "update", history: true });
  const other = toast.error("failed", undefined, { history: true });
  toast.info("update v2", undefined, { id: "update", history: true });
  assert.deepEqual(toastHistory.get().map((e) => [e.id, e.title, e.kind]), [["update", "update v2", "info"], [other, "failed", "error"]]);

  toastHistory.remove("update");
  assert.deepEqual(toastHistory.get().map((e) => e.id), [other]);
  toastHistory.clear();
  assert.equal(toastHistory.get().length, 0);
});

test("toasts default to 6s, errors to 10s, and an explicit timeout (including sticky 0) wins", () => {
  assert.equal(resolveToastTimeout("info"), 6000);
  assert.equal(resolveToastTimeout("success"), 6000);
  assert.equal(resolveToastTimeout("error"), 10000);
  assert.equal(resolveToastTimeout("error", { timeout: 12000 }), 12000);
  assert.equal(resolveToastTimeout("info", { duration: 2000 }), 2000);
  assert.equal(resolveToastTimeout("info", { timeout: 0 }), 0);
});

test("recorded OS notifications get distinct entries and notify subscribers", () => {
  toastHistory.clear();
  let notified = 0;
  const unsubscribe = toastHistory.subscribe(() => { notified++; });
  toastHistory.record("info", "Session A", "Task finished");
  toastHistory.record("info", "Session A", "Task finished", { clamp: true });
  const entries = toastHistory.get();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(entries[0].clamp, true);
  toastHistory.remove(entries[0].id);
  assert.equal(notified, 3);
  unsubscribe();
  toastHistory.clear();
  assert.equal(notified, 3);
});

test("new entries are unread until marked; a re-announced id is unread again", () => {
  toastHistory.clear();
  toast.info("Update available", undefined, { id: "update", history: true });
  toastHistory.record("info", "Task finished");
  assert.deepEqual(toastHistory.get().map((e) => e.read), [false, false]);

  toastHistory.markAllRead();
  assert.deepEqual(toastHistory.get().map((e) => e.read), [true, true]);

  // A session's next notification of the same type reuses its id; it is new.
  toast.info("Update available", undefined, { id: "update", history: true });
  toastHistory.record("info", "Another task finished");
  assert.deepEqual(toastHistory.get().map((e) => [e.title, e.read]), [
    ["Another task finished", false],
    ["Update available", false],
    ["Task finished", true],
  ]);

  // Leaving the Notifications tab calls markAllRead; with nothing unread it
  // must not wake every subscriber (AppShell, the right panel).
  toastHistory.markAllRead();
  let notified = 0;
  const unsubscribe = toastHistory.subscribe(() => { notified++; });
  toastHistory.markAllRead();
  assert.equal(notified, 0);
  unsubscribe();
  toastHistory.clear();
});
