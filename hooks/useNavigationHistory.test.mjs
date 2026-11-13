import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");
const { useNavigationHistory } = await import("./useNavigationHistory.ts");
const { useRouter, useSearchParams } = await import("../lib/navigation.ts");

const renderNav = () => renderHook(() => ({
  ...useNavigationHistory(), router: useRouter(), session: useSearchParams().get("session"),
}));
const traverse = async (action) => act(async () => {
  const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
  action();
  await popped;
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

test("in-app controls stop at owned bounds while native traversal updates availability", async () => {
  window.history.replaceState(null, "", "/?session=a");
  const { result } = renderNav();
  act(() => result.current.back());
  act(() => result.current.forward());
  assert.equal(result.current.session, "a");
  assert.equal(result.current.canBack, false);
  assert.equal(result.current.canForward, false);
  act(() => result.current.router.push("/?session=b"));
  act(() => result.current.router.push("/?session=c"));
  await traverse(() => window.history.back());
  assert.equal(result.current.session, "b");
  assert.equal(result.current.canBack, true);
  assert.equal(result.current.canForward, true);
  await traverse(() => result.current.back());
  assert.equal(result.current.session, "a");
  assert.equal(result.current.canBack, false);
  assert.equal(result.current.canForward, true);
  act(() => result.current.back());
  assert.equal(result.current.session, "a");
  await traverse(() => result.current.forward());
  await traverse(() => result.current.forward());
  assert.equal(result.current.session, "c");
  assert.equal(result.current.canBack, true);
  assert.equal(result.current.canForward, false);
});

test("rapid in-app Back presses cannot traverse the synthetic root guard", async () => {
  window.history.replaceState(null, "", "/?session=a");
  const { result } = renderNav();
  act(() => result.current.router.push("/?session=b"));
  await traverse(() => {
    result.current.back();
    result.current.back();
  });
  assert.equal(result.current.session, "a");
  assert.equal(result.current.canBack, false);
  assert.equal(result.current.canForward, true);
});
