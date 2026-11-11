import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { act, renderHook, cleanup } = await import("@testing-library/react/pure.js");
const { getInitialNavigation, readCreationInitialization, rememberCreationInitialization } = await import("./initial-navigation.ts");
const { useRouter, useSearchParams } = await import("./navigation.ts");
const { useNavigationHistory } = await import("../hooks/useNavigationHistory.ts");

test("a pooled URL never treats a worker path as a standalone fallback", () => {
  const target = getInitialNavigation(new URLSearchParams("poolId=workers&projectId=app&creationId=original&cwd=%2Fworker%2Frepo&hostId=local&session=other"));
  assert.deepEqual(target, { requestedCwd: null, sessionId: null, poolId: "workers", projectId: "app", creationId: "original" });
  const incomplete = getInitialNavigation(new URLSearchParams("poolId=workers&cwd=%2Fworker%2Frepo"));
  assert.equal(incomplete.poolId, "workers");
  assert.equal(incomplete.requestedCwd, null);
});

test("Back restores a pooled creation's frozen initialization without losing forward history", async () => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  const useView = () => ({ router: useRouter(), params: useSearchParams(), history: useNavigationHistory() });
  const view = renderHook(useView);
  const original = '{"type":"ensure_session","creationId":"original","poolId":"workers","projectId":"app","modelId":"original-model"}';
  try {
    act(() => view.result.current.router.push("/?poolId=workers&projectId=app&creationId=original&sidebar=open"));
    assert.equal(rememberCreationInitialization("original", original), original);
    act(() => view.result.current.router.push("/?poolId=workers&projectId=app&creationId=original&sidebar=closed"));
    act(() => view.result.current.router.push("/?session=other&sidebar=closed"));
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      view.result.current.history.back();
      await popped;
    });
    assert.equal(getInitialNavigation(view.result.current.params).creationId, "original");
    assert.equal(readCreationInitialization("original"), original);
    assert.equal(rememberCreationInitialization("original", '{"modelId":"changed"}'), original);
    assert.equal(view.result.current.history.canForward, true);
    view.unmount();
    const reloaded = renderHook(useView);
    assert.equal(readCreationInitialization("original"), original);
    assert.equal(reloaded.result.current.params.get("creationId"), "original");
    assert.equal(reloaded.result.current.history.canForward, true);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});
