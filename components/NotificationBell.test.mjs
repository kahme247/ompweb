import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
// Same specifiers as the component's own imports, so both see one history store.
const { NotificationBell } = await jiti.import("@/components/NotificationBell");
const { notificationHistory } = await jiti.import("@/lib/notification-history");

before(() => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
});
afterEach(() => { cleanup(); notificationHistory.clear(); });

function renderBell() {
  const opens = [];
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(NotificationBell, { open, onOpenChange: (next) => { opens.push(next); setOpen(next); } });
  }
  render(React.createElement(Harness));
  return opens;
}
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

test("the bell shows the unread count and opens the list with its actions", async () => {
  act(() => {
    notificationHistory.add({ type: "input", sessionId: "a", sessionName: "Alpha" });
    notificationHistory.add({ type: "error", sessionId: "b", sessionName: "Beta" });
  });
  renderBell();
  const bell = screen.getByRole("button", { name: "2 unread" });
  assert.equal(bell.textContent, "2");
  fireEvent.click(bell);
  await flush();
  const popup = screen.getByRole("dialog", { name: "Notifications" });
  assert.equal(popup.querySelectorAll("li").length, 2);
  assert.ok(screen.getByRole("button", { name: "Mark all as read" }));
  assert.ok(screen.getByRole("button", { name: "Clear all" }));
});

test("opening a notification's session closes the popover", async () => {
  act(() => { notificationHistory.add({ type: "completed", sessionId: "a", sessionName: "Alpha" }); });
  const opens = renderBell();
  fireEvent.click(screen.getByRole("button", { name: "1 unread" }));
  await flush();
  fireEvent.click(screen.getByRole("dialog").querySelector("li"));
  await flush();
  assert.deepEqual(opens, [true, false]);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("dismissing a row keeps keyboard focus in the popover", async () => {
  act(() => {
    notificationHistory.add({ type: "input", sessionId: "a", sessionName: "Alpha" });
    notificationHistory.add({ type: "error", sessionId: "b", sessionName: "Beta" });
  });
  renderBell();
  fireEvent.click(screen.getByRole("button", { name: "2 unread" }));
  await flush();
  const popup = screen.getByRole("dialog");
  const dismiss = screen.getAllByRole("button", { name: "Dismiss notification" })[0];
  act(() => { dismiss.focus(); });
  fireEvent.click(dismiss);
  await flush();
  assert.ok(popup.contains(document.activeElement), `focus moved to ${document.activeElement?.tagName}`);
});
