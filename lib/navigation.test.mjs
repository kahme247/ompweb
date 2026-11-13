import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");
const { useRouter, useSearchParams } = await import("./navigation.ts");
const { useNavigationHistory } = await import("../hooks/useNavigationHistory.ts");

const renderNav = (strict = false) => renderHook(() => ({
  router: useRouter(), params: useSearchParams(), history: useNavigationHistory(),
}), { wrapper: strict ? React.StrictMode : undefined });

async function traverse(action) {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    action();
    await popped;
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

test("push uses native entries and preserves unrelated state; duplicate URLs do nothing", () => {
  window.history.replaceState({ other: { retained: true } }, "", "/?session=a");
  const { result } = renderNav();
  const length = window.history.length;
  act(() => result.current.router.push("/?session=b&sidebar=closed"));
  assert.equal(result.current.params.get("session"), "b");
  assert.equal(result.current.params.get("sidebar"), "closed");
  assert.equal(window.history.length, length + 1);
  assert.deepEqual(window.history.state.other, { retained: true });
  const state = window.history.state;
  act(() => result.current.router.push(window.location.href));
  act(() => result.current.router.replace("/?session=b&sidebar=closed"));
  assert.equal(window.history.length, length + 1);
  assert.equal(window.history.state, state);
});

test("replace keeps its position and Back/Forward restore actual session and sidebar URLs", async () => {
  window.history.replaceState(null, "", "/?session=a");
  const { result } = renderNav();
  act(() => result.current.router.push("/?session=b&sidebar=closed"));
  const length = window.history.length;
  act(() => result.current.router.replace("/?session=renamed&sidebar=closed"));
  assert.equal(window.history.length, length);
  await traverse(() => result.current.router.back());
  assert.equal(result.current.params.get("session"), "a");
  await traverse(() => window.history.forward());
  assert.equal(result.current.params.get("session"), "renamed");
  assert.equal(result.current.params.get("sidebar"), "closed");
});

test("reload markers retain forward bounds and a new push truncates the native branch", async () => {
  window.history.replaceState(null, "", "/?session=a");
  let hook = renderNav();
  act(() => hook.result.current.router.push("/?session=b"));
  act(() => hook.result.current.router.push("/?session=c"));
  await traverse(() => window.history.back());
  hook.unmount();
  const length = window.history.length;
  hook = renderNav(true);
  assert.equal(window.history.length, length);
  assert.equal(hook.result.current.history.canBack, true);
  assert.equal(hook.result.current.history.canForward, true);
  act(() => hook.result.current.router.push("/?session=d"));
  assert.equal(hook.result.current.history.canForward, false);
  await traverse(() => hook.result.current.router.back());
  await traverse(() => hook.result.current.router.forward());
  assert.equal(hook.result.current.params.get("session"), "d");
});

test("StrictMode and reload create only one non-navigable root guard", () => {
  window.history.replaceState(null, "", "/?session=direct");
  const before = window.history.length;
  const hook = renderNav(true);
  assert.equal(window.history.length, before + 1);
  assert.equal(hook.result.current.params.get("session"), "direct");
  assert.equal(hook.result.current.history.canBack, false);
  assert.equal(hook.result.current.history.canForward, false);
  hook.unmount();
  const reloaded = renderNav(true);
  assert.equal(window.history.length, before + 1);
  assert.equal(reloaded.result.current.history.canBack, false);
});
