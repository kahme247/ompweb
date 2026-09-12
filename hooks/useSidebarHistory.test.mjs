import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useSidebarHistory } = await jiti.import("./useSidebarHistory.ts");
const { setDraft, getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
let restoreHistory;
afterEach(() => {
  try {
    cleanup();
  } finally {
    restoreHistory?.();
    restoreHistory = undefined;
  }
});

// jsdom supplies the real DOM and event dispatch, not native navigation. This
// protocol model queues traversal and records document exit; root history.back()
// remains a no-op. Chromium activation/skipping, Android app dismissal, and Next
// router listener ordering still require real-browser verification.
function browserHistory({ prior = true, standalone = false } = {}) {
  const win = window;
  const originalUrl = win.location.href;
  const originalState = win.history.state;
  const replaceUrl = win.history.replaceState.bind(win.history);
  const originals = [];
  const stub = (target, key, descriptor) => {
    originals.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };
  const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "chat" }, other: "retained" };
  const entries = prior ? [{ url: "https://previous.test/", state: null }] : [];
  entries.push({ url: "https://omp.test/?session=first", state: nextState });
  let index = entries.length - 1;
  const pending = [];
  let activated = false;
  let skippable = false;
  const result = { entries, departed: false, closeAttempts: 0 };
  const syncLocation = () => replaceUrl(entries[index].state, "", entries[index].url);
  function fire(type, extra = {}) {
    const event = type === "popstate"
      ? new win.PopStateEvent(type, { state: extra.state })
      : new win.Event(type, { cancelable: true });
    win.dispatchEvent(event);
    return event;
  }
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    replaceState(state, _, url) {
      entries[index] = { state: structuredClone(state), url: new URL(url ?? win.location.href, win.location.href).href };
      syncLocation();
    },
    pushState(state, _, url) {
      if (!activated) skippable = true;
      entries.splice(index + 1);
      entries.push({ state: structuredClone(state), url: new URL(url ?? win.location.href, win.location.href).href });
      index += 1;
      syncLocation();
    },
    go(delta) { pending.push(delta); },
    back() { this.go(-1); },
    forward() { this.go(1); },
  };
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(history))) {
    stub(win.history, key, descriptor);
  }
  stub(win, "navigation", { value: { get canGoBack() { return index > 0; } } });
  stub(win, "matchMedia", { value: () => ({ matches: standalone }) });
  stub(win, "close", { value: () => { result.closeAttempts += 1; } });
  // The root layout installs this bridge before Next's popstate listener.
  const bridge = (event) => win.dispatchEvent(new win.CustomEvent("omp:sidebar-popstate", { detail: event }));
  win.addEventListener("popstate", bridge);
  restoreHistory = () => {
    win.removeEventListener("popstate", bridge);
    for (const [target, key, descriptor] of originals.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
    replaceUrl(originalState, "", originalUrl);
  };
  syncLocation();
  result.window = win;
  result.fire = fire;
  result.activate = () => { activated = true; skippable = false; };
  result.nativeBack = () => {
    if (skippable) result.departed = true;
    else win.history.back();
  };
  result.flush = async () => {
    while (pending.length) {
      const target = index + pending.shift();
      if (target < 0 || target >= entries.length) continue;
      // Model Chromium dropping earlier activation after history traversal:
      // a subsequent pushState can make native Back skip the document.
      activated = false;
      if (entries[target].url.startsWith("https://previous.test/")) {
        if (fire("beforeunload").defaultPrevented) continue;
        result.departed = true;
        index = target;
        // Cross-document navigation is represented by departed, not performed
        // on jsdom's live document (which ReactDOM must retain for teardown).
      } else {
        index = target;
        syncLocation();
        await act(() => fire("popstate", { state: entries[index].state }));
      }
    }
  };
  return result;
}

async function mount({ open = false, strict = false, active = true } = {}) {
  const hook = renderHook(({ url }) => {
    const [sidebarOpen, setSidebarOpen] = React.useState(open);
    const navigation = useSidebarHistory({ active, ready: true, sidebarOpen, setSidebarOpen, url });
    return { ...navigation, sidebarOpen, setSidebarOpen };
  }, {
    initialProps: { url: "first" },
    wrapper: strict ? React.StrictMode : undefined,
  });
  return {
    get api() { return hook.result.current; },
    async update(url) { hook.rerender({ url }); },
    async unmount() { hook.unmount(); },
  };
}

const draftKey = "sidebar-history-regression";

test("closed conversation Back opens the sidebar, Forward recloses it, second clean Back exits", async () => {
  const world = browserHistory();
  const shell = await mount();
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
  const shell = await mount();
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
  const shell = await mount();
  try {
    await act(() => setDraft(draftKey, { value: "do not discard", images: [], files: [] }));
    world.activate();
    world.nativeBack();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, true);
    world.nativeBack();
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
  let shell = await mount({ strict: true });
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
    shell = await mount({ strict: true });
    assert.equal(world.entries.length, 3);
    world.window.history.back();
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(world.departed, true);
  } finally { await shell.unmount(); }
});

test("a new-session URL committed during sidebar collapse survives the pending traversal", async () => {
  const world = browserHistory();
  const shell = await mount();
  try {
    await act(() => shell.api.setSidebarOpen(true));
    world.window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "new-session" } }, "", "/");
    await shell.update("new");
    await act(() => shell.api.setSidebarOpen(false));
    await act(() => setDraft(draftKey, { value: "new draft", images: [], files: [] }));
    world.activate();
    await world.flush();
    assert.equal(world.window.location.href, "https://omp.test/");
    assert.equal(world.entries.length, 3);
    world.nativeBack();
    await world.flush();
    world.nativeBack();
    await world.flush();
    assert.equal(world.departed, false);
    assert.equal(shell.api.exitConfirmationOpen, true);
    assert.equal(getDraft(draftKey)?.value, "new draft");
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});

test("desktop open sidebar has no clean interception; attachment-only stored drafts protect Back and reload", async () => {
  const world = browserHistory();
  const shell = await mount({ open: true, active: false });
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

test("wide layouts keep a collapsed sidebar unchanged while protecting drafts on the first Back", async () => {
  const world = browserHistory();
  const shell = await mount({ active: false });
  try {
    assert.equal(world.entries.length, 2);
    await act(() => setDraft(draftKey, { value: "desktop draft", images: [], files: [] }));
    world.activate();
    world.nativeBack();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, true);
    assert.equal(shell.api.sidebarOpen, false);
    await act(() => shell.api.cancelExit());
    assert.equal(getDraft(draftKey)?.value, "desktop draft");
    assert.equal(world.fire("beforeunload").defaultPrevented, true);
    await act(() => clearDraft(draftKey));
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(world.departed, true);
  } finally {
    await act(() => clearDraft(draftKey));
    await shell.unmount();
  }
});

test("wide layouts do not restore sidebar state from a previous mobile history entry", async () => {
  const world = browserHistory();
  let shell = await mount();
  await shell.unmount();
  shell = await mount({ active: false, open: true });
  try {
    await world.flush();
    world.window.history.forward();
    await world.flush();
    assert.equal(shell.api.sidebarOpen, true);
  } finally { await shell.unmount(); }
});

for (const standalone of [false, true]) {
test(`direct ${standalone ? "standalone" : "browser"} launch confirms dirty Back and limits app-close guidance to standalone`, async () => {
  const world = browserHistory({ prior: false, standalone });
  const shell = await mount();
  try {
    await act(() => setDraft(draftKey, { value: "", images: [], files: [{ name: "draft.txt", content: "draft", mimeType: "text/plain", size: 5 }] }));
    world.window.history.back();
    await world.flush();
    world.window.history.back();
    await world.flush();
    assert.equal(shell.api.exitConfirmationOpen, true);
    await act(() => shell.api.leave());
    await world.flush();
    assert.equal(world.closeAttempts, standalone ? 1 : 0);
    assert.equal(shell.api.exitNeedsNativeBack, standalone);
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
}
