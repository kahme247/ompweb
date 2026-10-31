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
const { notificationHistory } = await jiti.import("@/lib/notification-history");

/** The tab side of the shared event-stream worker (lib/event-stream.ts), so a
 * test can deliver frames on the notifications channel the hook opened. */
const eventStreams = new Map();
const eventWorker = {
  onmessage: null,
  onerror: null,
  postMessage(message) {
    if (message.op === "open") eventStreams.set(message.id, message.channel);
    else if (message.op === "close") eventStreams.delete(message.id);
  },
};
function deliverFrame(frame) {
  const id = [...eventStreams].findLast(([, channel]) => channel.kind === "notifications")?.[0];
  assert.ok(id, "useNotifications must hold a notifications channel");
  eventWorker.onmessage({ data: { id, type: "message", data: JSON.stringify(frame) } });
}
function deliverNotification(message) {
  deliverFrame({ type: "notification", ...message });
}

before(() => {
  globalThis.AbortController = window.AbortController;
  window.Element.prototype.setPointerCapture = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  // `new Worker()` yields the one shared fake (a constructor may return an object).
  globalThis.Worker = function Worker() { return eventWorker; };
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
  assert.equal(card()?.hasAttribute("data-ending-style") ?? false, false);
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
      deliverNotification({ kind: "toast", event: { type: "completed", sessionId, sessionName } });
    });
    return Array.from(document.querySelectorAll(".toast-card")).find((card) => card.querySelector(".display-serif")?.textContent === sessionName);
  };
  const withSession = deliver("s1", "Fix bug");
  // The card is the only way in: no separate Open link.
  assert.equal(withSession.querySelectorAll("button:not(.toast-close-button), a").length, 0);
  act(() => withSession.querySelector(".display-serif").click());
  assert.deepEqual(sessions, ["s1"]);
  // Session notifications are listed; opening one from its toast reads it.
  assert.deepEqual(notificationHistory.get().filter((e) => e.id === "s1:completed").map((e) => e.read), [true]);
  const withoutSession = deliver("", "No session");
  assert.equal(withoutSession.style.cursor, "");
  act(() => withoutSession.querySelector(".display-serif").click());
  assert.deepEqual(sessions, ["s1"]);
});

test("a notification the OS showed is listed in history", async () => {
  const created = [];
  // Bare `Notification` in the code under test resolves to the global, not window.
  globalThis.Notification = window.Notification = class { static permission = "granted"; constructor(title) { created.push(title); } };
  try {
    renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: () => {} }));
    await act(async () => {
      deliverNotification({ kind: "os", event: { type: "error", sessionId: "s9", sessionName: "Shown by OS", detail: "boom" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(created, ["Shown by OS"]);
    assert.deepEqual(notificationHistory.get().filter((e) => e.id === "s9:error").map((e) => [e.event.sessionName, e.read]), [["Shown by OS", false]]);
  } finally {
    delete window.Notification;
    delete globalThis.Notification;
    act(() => notificationHistory.clear());
  }
});

test("a push the service worker showed reloads the list from the server; other messages are ignored", async () => {
  const worker = new window.EventTarget();
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push([init.method ?? "GET", String(url)]);
    const entries = [{ id: "s7:error", event: { type: "error", sessionId: "s7", sessionName: "Pushed" }, at: 1, read: false }];
    return { ok: true, json: async () => ({ entries }) };
  };
  try {
    renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: () => {} }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    requests.length = 0;
    const post = (data) => act(async () => {
      worker.dispatchEvent(new window.MessageEvent("message", { data }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await post("junk");
    await post({ type: "something-else" });
    assert.deepEqual(requests, []);
    await post({ type: "omp-notification-shown", notification: { type: "error", title: "Pushed", body: "Run failed", tag: "s7:error", sessionId: "s7" } });
    assert.deepEqual(requests, [["GET", "/api/notifications/history"]]);
    assert.deepEqual(notificationHistory.get().map((e) => e.id), ["s7:error"]);
  } finally {
    globalThis.fetch = previousFetch;
    delete window.navigator.serviceWorker;
    act(() => notificationHistory.clear());
  }
});

test("a dismiss frame closes only the toast of its request id, not the next dialog's", () => {
  render(React.createElement(ToastProvider, null));
  renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: () => {} }));
  const cards = () => Array.from(document.querySelectorAll(".toast-card"))
    .filter((card) => card.querySelector(".display-serif")?.textContent === "Approve?");
  const input = (requestId) => ({ type: "notification", kind: "toast", event: { type: "input", sessionId: "s5", sessionName: "Approve?", requestId } });
  const retract = (requestId) => ({ type: "notification-dismiss", sessionId: "s5", tag: "s5:input", requestId });
  const ended = (card) => card.hasAttribute("data-ending-style");
  const live = () => cards().filter((card) => !ended(card));

  act(() => deliverFrame(input("r1")));
  act(() => deliverFrame(retract("r2")));
  assert.equal(live().length, 1, "a retraction of another request keeps the toast");
  act(() => deliverFrame(retract("r1")));
  assert.equal(live().length, 0, "the retraction of its own request closes the toast");

  act(() => deliverFrame(input("rA")));
  act(() => deliverFrame(input("rB")));
  act(() => deliverFrame(retract("rA")));
  assert.equal(live().length, 1, "a late retraction must not close the dialog that replaced it");
  act(() => deliverFrame(retract("rB")));
  assert.equal(live().length, 0);
});

test("a dismiss frame closes only the system notification of its request id", async () => {
  const shown = [];
  const registration = {
    showNotification: async (title, options) => { shown.push({ title, options, closed: 0 }); },
    getNotifications: async ({ tag }) => shown
      .filter((entry) => entry.options.tag === tag)
      .map((entry) => ({ data: entry.options.data, close: () => { entry.closed += 1; } })),
  };
  const worker = new window.EventTarget();
  worker.getRegistration = async () => registration;
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
  globalThis.Notification = window.Notification = class { static permission = "granted"; };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    renderHook(() => useNotifications({ sessionId: null, locale: "en", onOpenSession: () => {} }));
    await act(async () => {
      deliverFrame({ type: "notification", kind: "os", event: { type: "input", sessionId: "s6", sessionName: "Answer", requestId: "r1" } });
      await tick();
    });
    assert.deepEqual(shown.map((entry) => [entry.options.tag, entry.options.data.requestId]), [["s6:input", "r1"]]);
    const retract = async (requestId) => act(async () => {
      deliverFrame({ type: "notification-dismiss", sessionId: "s6", tag: "s6:input", requestId });
      await tick();
    });
    await retract("r2");
    assert.equal(shown[0].closed, 0, "a retraction of another request keeps the notification");
    await retract("r1");
    assert.equal(shown[0].closed, 1);
  } finally {
    delete window.navigator.serviceWorker;
    delete window.Notification;
    delete globalThis.Notification;
    act(() => notificationHistory.clear());
  }
});
