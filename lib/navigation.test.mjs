import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { useRouter, useSearchParams } = await import("./navigation.ts");

const renderNav = () => renderHook(() => ({ router: useRouter(), params: useSearchParams() }));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

test("replace updates the search params without adding a history entry", () => {
  const { result } = renderNav();
  const length = window.history.length;
  act(() => result.current.router.replace("/?session=b"));
  assert.equal(result.current.params.get("session"), "b");
  assert.equal(window.history.length, length);
});

test("popstate re-renders with the new search", () => {
  const { result } = renderNav();
  window.history.replaceState(null, "", "/?session=d");
  act(() => {
    window.dispatchEvent(new window.Event("popstate"));
  });
  assert.equal(result.current.params.get("session"), "d");
});
