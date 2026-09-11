import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useSidebarHistory } = await jiti.import("./useSidebarHistory.ts");
const { setDraft, getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Model asynchronous history traversal and document exit separately: a root
// history.back() really is a no-op, unlike Android's native Back/app dismissal.
function browserHistory({ prior = true, standalone = false } = {}) {
  const listeners = new Map();
  const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "chat" }, other: "retained" };
  const entries = prior ? [{ url: "https://previous.test/", state: null }] : [];
  entries.push({ url: "https://omp.test/?session=first", state: nextState });
  let index = entries.length - 1;
  const pending = [];
  let activated = false;
  let skippable = false;
  const result = { entries, departed: false, closeAttempts: 0 };
  function fire(type, extra = {}) {
    const event = { type, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const { fn } of [...(listeners.get(type) ?? [])]) {
      fn(event);
      if (event.stopped) break;
    }
    return event;
  }
  const win = {
    activate() { activated = true; skippable = false; },
    nativeBack() {
      if (skippable) result.departed = true;
      else this.history.back();
    },
    location: { href: entries[index].url },
    navigation: { get canGoBack() { return index > 0; } },
    matchMedia: () => ({ matches: standalone }),
    close() { result.closeAttempts += 1; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn });
    },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)); },
    history: {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      replaceState(state, _, url) {
        entries[index] = { state: structuredClone(state), url: new URL(url ?? win.location.href, win.location.href).href };
        win.location.href = entries[index].url;
      },
      pushState(state, _, url) {
        if (!activated) skippable = true;
        entries.splice(index + 1);
        entries.push({ state: structuredClone(state), url: new URL(url ?? win.location.href, win.location.href).href });
        index += 1;
        win.location.href = entries[index].url;
      },
      go(delta) { pending.push(delta); },
      back() { this.go(-1); },
      forward() { this.go(1); },
    },
  };
  // The root layout installs this bridge before Next's popstate listener.
  win.addEventListener("popstate", (event) => fire("omp:sidebar-popstate", { detail: event }));
  // Router integration and actual listener ordering need browser verification;
  // this model tests navigation outcomes, not a simulated Next listener.
  result.window = win;
  result.fire = fire;
  result.flush = async () => {
    while (pending.length) {
      const target = index + pending.shift();
      if (target < 0 || target >= entries.length) continue;
      // Chromium stops honoring earlier activation after history traversal.
      // A subsequent pushState makes this document skippable by native Back.
      activated = false;
      if (entries[target].url.startsWith("https://previous.test/")) {
        if (fire("beforeunload").defaultPrevented) continue;
        result.departed = true;
        index = target;
        win.location.href = entries[index].url;
      } else {
        index = target;
        win.location.href = entries[index].url;
        await act(() => fire("popstate", { state: entries[index].state }));
      }
    }
  };
  return result;
}

async function mount(world, { open = false, strict = false } = {}) {
  globalThis.window = world.window;
  let api;
  function Shell({ url = "first" }) {
    const [sidebarOpen, setSidebarOpen] = React.useState(open);
    const navigation = useSidebarHistory({ active: true, ready: true, sidebarOpen, setSidebarOpen, url });
    api = { ...navigation, sidebarOpen, setSidebarOpen };
    return null;
  }
  let renderer;
  const element = (url) => strict
    ? React.createElement(React.StrictMode, null, React.createElement(Shell, { url }))
    : React.createElement(Shell, { url });
  await act(() => { renderer = TestRenderer.create(element("first")); });
  return {
    get api() { return api; },
    async update(url) { await act(() => renderer.update(element(url))); },
    async unmount() { await act(() => renderer.unmount()); },
  };
}

const draftKey = "sidebar-history-regression";

test("closed conversation Back opens the sidebar, Forward recloses it, second clean Back exits", async () => {
  const world = browserHistory();
  const shell = await mount(world);
  try {
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, true);
    assert.equal(world.window.location.href, "https://omp.test/?session=first");
    assert.equal(world.departed, false);
    world.window.history.forward();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, false);
    world.window.history.back();
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(world.departed, true);
  } finally { await shell.unmount(); }
});

test("dirty second Back cancels without losing content and Leave exits without a duplicate unload prompt", async () => {
  const world = browserHistory();
  const shell = await mount(world);
  try {
    await act(() => setDraft(draftKey, { value: "keep my draft", images: [], files: [] }));
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, true);
    assert.equal(shell.api.exitConfirmationOpen, false);
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, true);
    await act(() => shell.api.cancelExit());
    assert.equal(world.departed, false);
    assert.equal(world.fire("beforeunload").defaultPrevented, true);
    world.window.history.back();
    await world.flush();
    assert.equal(getDraft(draftKey)?.value, "keep my draft");
    await act(() => shell.api.leave());
    await world.flush();
    assert.equal(world.departed, true);
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});

test("native Back keeps a dirty conversation guarded without another tap between Back presses", async () => {
  const world = browserHistory();
  const shell = await mount(world);
  try {
    await act(() => setDraft(draftKey, { value: "do not discard", images: [], files: [] }));
    world.window.activate();
    world.window.nativeBack();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, true);
    world.window.nativeBack();
    await world.flush();
    assert.equal(world.departed, false);
    assert.equal(shell.api.exitConfirmationOpen, true);
    assert.equal(getDraft(draftKey)?.value, "do not discard");
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});

test("session replacement, repeated close/Back, StrictMode and reload retain one history pair and Next state", async () => {
  const world = browserHistory();
  let shell = await mount(world, { strict: true });
  try {
    // router.replace may replace custom state; the URL commit must retain the
    // existing pair rather than adding a second sentinel.
    world.window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "new-session" }, other: "retained" }, "", "?session=second");
    await shell.update("second");
    for (let i = 0; i < 4; i += 1) {
      world.window.history.back();
      await world.flush();
      assert.equal(shell.api.sidebarOpen, true);
      assert.equal(world.window.location.href, "https://omp.test/?session=second");
      assert.deepEqual(world.window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE, { tree: "new-session" });
      assert.equal(world.window.history.state.other, "retained");
      await act(() => shell.api.setSidebarOpen(false));
    }
    await shell.unmount();
    shell = await mount(world, { strict: true });
    assert.equal(world.entries.length, 3);
    world.window.history.back();
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(world.departed, true);
  } finally { await shell.unmount(); }
});

test("desktop open sidebar has no clean interception; attachment-only stored drafts protect Back and reload", async () => {
  const world = browserHistory();
  const shell = await mount(world, { open: true });
  try {
    assert.equal(world.entries.length, 2);
    assert.equal(world.fire("beforeunload").defaultPrevented, false);
    await act(() => setDraft(draftKey, { value: "", images: [{ data: "AA==", mimeType: "image/png" }], files: [] }));
    assert.equal(world.fire("beforeunload").defaultPrevented, true);
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, true);
    await act(() => shell.api.cancelExit());
    await act(() => clearDraft(draftKey));
    await world.flush();
    assert.equal(world.fire("beforeunload").defaultPrevented, false);
    world.window.history.back();
    await world.flush();
    assert.equal(world.departed, true);
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});

test("direct standalone launch confirms dirty Back and disarms if the shell cannot close programmatically", async () => {
  const world = browserHistory({ prior: false, standalone: true });
  const shell = await mount(world);
  try {
    await act(() => setDraft(draftKey, { value: "", images: [], files: [{ name: "draft.txt", content: "draft", mimeType: "text/plain", size: 5 }] }));
    world.window.history.back();
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, true);
    await act(() => shell.api.leave());
    await world.flush();
    assert.equal(world.closeAttempts, 1);
    assert.equal(shell.api.exitNeedsNativeBack, true);
    assert.equal(world.entries.length, 2);
    assert.equal(world.fire("beforeunload").defaultPrevented, false);
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, false);
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});
