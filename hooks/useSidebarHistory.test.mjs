import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");
const { useSidebarHistory } = await import("./useSidebarHistory.ts");
const { useNavigationHistory } = await import("./useNavigationHistory.ts");
const { useRouter, useSearchParams } = await import("../lib/navigation.ts");
const { setDraft, getDraft, clearDraft } = await import("@/lib/draft-store");
const draftKey = "browser-history-exit-regression";
let restoreHistory;
afterEach(() => {
  cleanup();
  clearDraft(draftKey);
  restoreHistory?.();
  restoreHistory = undefined;
  window.sessionStorage.clear();
});

// jsdom cannot leave a document. Model only the native entry/traversal boundary;
// production hooks, draft storage, subscriptions and DOM events remain real.
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
  const entries = prior ? [{ url: "https://previous.test/", state: null }] : [];
  entries.push({ url: "https://omp.test/?session=first", state: { other: "retained" } });
  let index = entries.length - 1;
  const pending = [];
  const result = { entries, departed: false, closeAttempts: 0 };
  const syncLocation = () => replaceUrl(entries[index].state, "", entries[index].url);
  const fire = (type, extra = {}) => {
    const event = type === "popstate"
      ? new win.PopStateEvent(type, { state: extra.state })
      : new win.Event(type, { cancelable: true });
    win.dispatchEvent(event);
    return event;
  };
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    replaceState(state, _, url) {
      entries[index] = { state: structuredClone(state), url: new URL(url ?? win.location.href, win.location.href).href };
      syncLocation();
    },
    pushState(state, _, url) {
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
  restoreHistory = () => {
    for (const [target, key, descriptor] of originals.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
    replaceUrl(originalState, "", originalUrl);
  };
  syncLocation();
  result.fire = fire;
  result.flush = async () => {
    while (pending.length) {
      const target = index + pending.shift();
      if (target < 0 || target >= entries.length) continue;
      if (entries[target].url.startsWith("https://previous.test/")) {
        if (fire("beforeunload").defaultPrevented) continue;
        result.departed = true;
        index = target;
      } else {
        index = target;
        syncLocation();
        await act(() => fire("popstate", { state: entries[index].state }));
      }
    }
  };
  // A traversal to an entry of a discarded (pre-reload) document loads it afresh: no popstate.
  result.loadDocument = (delta) => {
    index += delta;
    syncLocation();
  };
  return result;
}

function mount(strict = false) {
  return renderHook(() => ({
    ...useSidebarHistory(), ...useNavigationHistory(), router: useRouter(),
    session: useSearchParams().get("session"), sidebar: useSearchParams().get("sidebar"),
  }), { wrapper: strict ? React.StrictMode : undefined });
}
const draft = { value: "do not lose me", images: [], files: [] };

test("dirty root Back cancellation keeps URL, mounted view, drafts and forward history intact", async () => {
  const browser = browserHistory();
  const hook = mount(true);
  act(() => hook.result.current.router.push("/?session=second&sidebar=closed"));
  window.history.back();
  await browser.flush();
  act(() => setDraft(draftKey, draft));
  const states = browser.entries.map((entry) => entry.state);
  const seen = [];
  const observer = renderHook(() => { seen.push(useSearchParams().get("session")); });
  window.history.back();
  await browser.flush();
  assert.equal(hook.result.current.exitConfirmationOpen, true);
  assert.equal(hook.result.current.session, "first");
  assert.equal(window.location.search, "?session=first");
  assert.equal(hook.result.current.canBack, false);
  assert.equal(hook.result.current.canForward, true);
  assert.equal(browser.departed, false);
  assert.deepEqual(browser.entries.map((entry) => entry.state), states);
  assert.equal(seen.every((session) => session === "first"), true);
  act(() => hook.result.current.cancelExit());
  assert.equal(getDraft(draftKey).value, "do not lose me");
  assert.equal(browser.fire("beforeunload").defaultPrevented, true);
  window.history.forward();
  await browser.flush();
  assert.equal(hook.result.current.session, "second");
  assert.equal(hook.result.current.sidebar, "closed");
  assert.equal(hook.result.current.exitConfirmationOpen, false);
  observer.unmount();
});

test("dirty inter-session Back and Forward never prompt, root Leave exits without another prompt", async () => {
  const browser = browserHistory();
  const hook = mount();
  act(() => setDraft(draftKey, draft));
  act(() => hook.result.current.router.push("/?session=second"));
  window.history.back();
  await browser.flush();
  assert.equal(hook.result.current.exitConfirmationOpen, false);
  window.history.forward();
  await browser.flush();
  assert.equal(hook.result.current.session, "second");
  assert.equal(hook.result.current.exitConfirmationOpen, false);
  window.history.back();
  await browser.flush();
  window.history.back();
  await browser.flush();
  assert.equal(hook.result.current.exitConfirmationOpen, true);
  act(() => hook.result.current.leave());
  await browser.flush();
  assert.equal(browser.departed, true);
  assert.equal(browser.fire("beforeunload").defaultPrevented, false);
});

test("a multi-entry root traversal restores the last accepted URL rather than showing the sentinel URL", async () => {
  const browser = browserHistory();
  const hook = mount();
  act(() => hook.result.current.router.replace("/?session=renamed"));
  act(() => hook.result.current.router.push("/?session=second"));
  act(() => setDraft(draftKey, draft));
  const seen = [];
  renderHook(() => { seen.push(useSearchParams().get("session")); });
  window.history.go(-2);
  await browser.flush();
  assert.equal(hook.result.current.exitConfirmationOpen, true);
  assert.equal(window.location.search, "?session=second");
  assert.equal(hook.result.current.session, "second");
  assert.equal(seen.every((session) => session === "second"), true);
  assert.equal(hook.result.current.canBack, true);
});

test("attachment-only drafts protect unload and repeated root Back after reload uses one guard", async () => {
  const browser = browserHistory();
  let hook = mount(true);
  act(() => setDraft(draftKey, { value: "", images: [{ data: "abc", mimeType: "image/png" }], files: [] }));
  const length = browser.entries.length;
  hook.unmount();
  hook = mount(true);
  assert.equal(browser.entries.length, length);
  assert.equal(window.history.state.other, "retained");
  assert.equal(browser.fire("beforeunload").defaultPrevented, true);
  for (let i = 0; i < 2; i++) {
    window.history.back();
    await browser.flush();
    assert.equal(hook.result.current.exitConfirmationOpen, true);
    act(() => hook.result.current.cancelExit());
    assert.equal(browser.departed, false);
    assert.equal(browser.entries.length, length);
  }
});

// Forward from the previous site onto the guard loads a fresh document, which must recover into the app.
async function assertForwardReentry(browser, hook) {
  hook.unmount();
  browser.departed = false;
  browser.loadDocument(1);
  const reentered = mount();
  await browser.flush();
  assert.equal(browser.departed, false);
  assert.equal(window.history.state.__ompViewHistory.guard, false);
  assert.equal(reentered.result.current.session, "first");
}

test("a fragment link's native entry joins the managed stack, so in-app Back still changes the view", async () => {
  const browser = browserHistory();
  const hook = mount();
  // The skip link pushes a stateless same-document entry and fires popstate.
  window.history.pushState(null, "", "/?session=first#main-content");
  await act(() => browser.fire("popstate", { state: null }));
  act(() => hook.result.current.router.push("/?session=second"));
  act(() => hook.result.current.back());
  await browser.flush();
  assert.equal(hook.result.current.session, "first");
  act(() => hook.result.current.router.push("/?session=third"));
  assert.equal(hook.result.current.session, "third");
});

test("clean native root Back leaves rather than consuming a sidebar-only step", async () => {
  const browser = browserHistory();
  const hook = mount();
  window.history.back();
  await browser.flush();
  assert.equal(browser.departed, true);
  assert.equal(hook.result.current.exitConfirmationOpen, false);
  await assertForwardReentry(browser, hook);
});

test("after a reload, native root Back exits across documents and Forward re-entry restores the app", async () => {
  const browser = browserHistory();
  let hook = mount();
  act(() => hook.result.current.router.push("/?session=second"));
  hook.unmount();
  hook = mount();
  for (let reloads = 0; reloads < 2; reloads++) {
    hook.unmount();
    browser.loadDocument(-1);
    hook = mount();
  }
  await browser.flush();
  assert.equal(browser.departed, true);
  await assertForwardReentry(browser, hook);
});

for (const standalone of [false, true]) {
  test(`direct launch keeps its URL after exit fallback (standalone=${standalone})`, async () => {
    const browser = browserHistory({ prior: false, standalone });
    const hook = mount();
    act(() => setDraft(draftKey, draft));
    window.history.back();
    await browser.flush();
    act(() => hook.result.current.leave());
    await browser.flush();
    assert.equal(browser.departed, false);
    assert.equal(window.location.search, "?session=first");
    assert.equal(browser.closeAttempts, standalone ? 1 : 0);
    assert.equal(hook.result.current.exitNeedsNativeBack, standalone);
    act(() => setDraft(draftKey, { ...draft, value: "new edit" }));
    assert.equal(hook.result.current.exitNeedsNativeBack, false);
    assert.equal(browser.fire("beforeunload").defaultPrevented, true);
    window.history.back();
    await browser.flush();
    assert.equal(hook.result.current.exitConfirmationOpen, true);
  });
}
