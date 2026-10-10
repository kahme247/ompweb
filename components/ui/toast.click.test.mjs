import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
// Same specifiers as useNotifications' own imports: on Windows a relative path
// can load a second toast module, whose manager the rendered provider never sees.
const { ClampedDescription, ToastProvider, toast } = await jiti.import("@/components/ui/toast");
const { useNotifications } = await jiti.import("@/hooks/useNotifications");
const { NOTIFICATION_MESSAGE_EVENT } = await jiti.import("@/lib/notification-client");

before(() => {
  globalThis.AbortController = window.AbortController;
  window.Element.prototype.setPointerCapture = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => { act(() => toast.close()); cleanup(); window.getSelection()?.removeAllRanges(); });

function pointer(target, type, x, y, { detail = 1 } = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  act(() => { target.dispatchEvent(event); });
}
function show(description, options = {}) {
  const opened = [];
  render(React.createElement(ToastProvider, null));
  act(() => { toast.info("Agent finished", description, { onClick: () => opened.push(1), ...options }); });
  return { opened, card: () => document.querySelector(".toast-card") };
}

test("clicking anywhere on a toast card runs its action and closes it", () => {
  const { opened, card } = show("Body");
  assert.equal(card().style.cursor, "pointer");
  const title = card().querySelector(".display-serif");
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 102, 51);
  assert.equal(opened.length, 1);
  assert.equal(card()?.hasAttribute("data-ending-style") ?? true, true);
});

test("Enter on the focused card runs its action; Enter inside it does not", () => {
  const { opened, card } = show(React.createElement("button", { type: "button" }, "inner"));
  const press = (target) => act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  press(card().querySelector("button:not(.toast-close-button)"));
  assert.equal(opened.length, 0);
  press(card());
  assert.equal(opened.length, 1);
});

test("buttons, links, expandable text, drags and text selection do not trigger the card action", () => {
  let pressed = 0;
  const { opened, card } = show(React.createElement("span", null,
    React.createElement("button", { type: "button", onClick: () => { pressed += 1; } }, "Open"),
    React.createElement("a", { href: "#x" }, "link"),
    React.createElement(ClampedDescription, null, "long text")));
  act(() => card().querySelector("button:not(.toast-close-button)").click());
  assert.equal(pressed, 1);
  act(() => card().querySelector("a").click());
  // A press on the clamped text whose click is retargeted to the card, as pointer capture does.
  pointer(card().querySelector("[aria-expanded]"), "pointerdown", 100, 50);
  pointer(card(), "click", 100, 50);
  // A drag that fell short of a swipe.
  const title = card().querySelector(".display-serif");
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 130, 50);
  // A drag pulled back to where it started.
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "pointermove", 160, 50);
  pointer(title, "click", 101, 50);
  window.getSelection().selectAllChildren(title);
  act(() => title.click());
  assert.equal(opened.length, 0);
});

test("a toast without an action keeps the default cursor", () => {
  render(React.createElement(ToastProvider, null));
  act(() => { toast.info("Saved"); });
  assert.equal(document.querySelector(".toast-card").style.cursor, "");
});

test("a session notification toast opens its session from a card click; one without a session does not", () => {
  const sessions = [];
  render(React.createElement(ToastProvider, null));
  renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: (id) => sessions.push(id) }));
  // Toasts closed by earlier tests can still be leaving the shared manager, so
  // each card is found by its own title (the session name).
  const deliver = (sessionId, sessionName) => {
    act(() => {
      window.dispatchEvent(new window.CustomEvent(NOTIFICATION_MESSAGE_EVENT, { detail: { kind: "toast", event: { type: "completed", sessionId, sessionName } } }));
    });
    return Array.from(document.querySelectorAll(".toast-card")).find((card) => card.querySelector(".display-serif")?.textContent === sessionName);
  };
  const withSession = deliver("s1", "Fix bug");
  // The card is the only way in: no separate Open link.
  assert.equal(withSession.querySelectorAll("button:not(.toast-close-button), a").length, 0);
  act(() => withSession.querySelector(".display-serif").click());
  assert.deepEqual(sessions, ["s1"]);
  const withoutSession = deliver("", "No session");
  assert.equal(withoutSession.style.cursor, "");
  act(() => withoutSession.querySelector(".display-serif").click());
  assert.deepEqual(sessions, ["s1"]);
});

test("a notification the OS showed is listed in history and opens its session from there", async () => {
  const sessions = [];
  const { toastHistory } = await jiti.import("@/components/ui/toast");
  const created = [];
  // Bare `Notification` in the code under test resolves to the global, not window.
  globalThis.Notification = window.Notification = class { static permission = "granted"; constructor(title) { created.push(title); } };
  try {
    renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: (id) => sessions.push(id) }));
    await act(async () => {
      window.dispatchEvent(new window.CustomEvent(NOTIFICATION_MESSAGE_EVENT, { detail: { kind: "os", event: { type: "error", sessionId: "s9", sessionName: "Shown by OS", detail: "boom" } } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(created, ["Shown by OS"]);
    const entry = toastHistory.get().find((e) => e.title === "Shown by OS");
    assert.ok(entry, "listed in the Notifications tab");
    assert.equal(entry.kind, "error");
    entry.onClick();
    assert.deepEqual(sessions, ["s9"]);
  } finally {
    delete window.Notification;
    delete globalThis.Notification;
    toastHistory.clear();
  }
});

test("a push the service worker showed is listed in history and opens its session; other messages are ignored", async () => {
  const sessions = [];
  const { toastHistory } = await jiti.import("@/components/ui/toast");
  const worker = new window.EventTarget();
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
  try {
    renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: (id) => sessions.push(id) }));
    const post = (data) => act(() => { worker.dispatchEvent(new window.MessageEvent("message", { data })); });
    post({ type: "omp-notification-shown", notification: { type: "error", title: "Pushed", body: "Run failed", tag: "s7:error", sessionId: "s7" } });
    post({ type: "omp-notification-shown", notification: { title: 42 } });
    post("junk");
    const entries = toastHistory.get();
    assert.deepEqual(entries.map((e) => [e.id, e.kind, e.title]), [["s7:error", "error", "Pushed"]]);
    entries[0].onClick();
    assert.deepEqual(sessions, ["s7"]);
  } finally {
    delete window.navigator.serviceWorker;
    toastHistory.clear();
  }
});
