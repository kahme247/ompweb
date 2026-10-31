import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

// lib/navigation-history.test.mjs covers the pure stack arithmetic; this file
// covers the React wrapper: recording from a view-change effect, the
// peek/commit/drop choreography AppShell drives around dead sessions, and
// that committing a step makes the subsequent re-record a no-op (that is
// what keeps back/forward from pushing onto themselves).

const { useNavigationHistory } = await import("./useNavigationHistory.ts");

const session = (id, cwd = "/repo") => ({ sessionId: id, cwd });
const newChat = (cwd) => ({ sessionId: null, cwd });

function renderNav() {
  return renderHook(() => useNavigationHistory());
}

afterEach(() => {
  cleanup();
});

test("starts with nothing navigable", () => {
  const { result } = renderNav();
  assert.equal(result.current.canBack, false);
  assert.equal(result.current.canForward, false);
  assert.equal(result.current.peekBack(), null);
  assert.equal(result.current.peekForward(), null);
});

test("recording views tracks back/forward availability", () => {
  const { result } = renderNav();
  act(() => result.current.record(session("a")));
  assert.equal(result.current.canBack, false);
  act(() => result.current.record(session("b")));
  assert.equal(result.current.canBack, true);
  assert.equal(result.current.canForward, false);
  assert.equal(result.current.peekBack()?.sessionId, "a");
});

test("re-recording the same view changes nothing", () => {
  const { result } = renderNav();
  act(() => result.current.record(session("a")));
  act(() => result.current.record(session("a")));
  assert.equal(result.current.peekBack(), null);
  assert.equal(result.current.canForward, false);
});

test("commitBack lands on the target and suppresses the re-record", () => {
  const { result } = renderNav();
  act(() => result.current.record(session("a")));
  act(() => result.current.record(session("b")));
  act(() => result.current.commitBack());
  assert.equal(result.current.peekForward()?.sessionId, "b");
  assert.equal(result.current.canBack, false);
  // The view-change effect now re-records the entry we landed on: this must
  // not push a duplicate or truncate the forward branch.
  act(() => result.current.record(session("a")));
  assert.equal(result.current.peekForward()?.sessionId, "b");
  assert.equal(result.current.canForward, true);
});

test("recording a new view after going back truncates the forward branch", () => {
  const { result } = renderNav();
  act(() => result.current.record(session("a")));
  act(() => result.current.record(session("b")));
  act(() => result.current.commitBack());
  act(() => result.current.record(session("c")));
  assert.equal(result.current.canForward, false);
  assert.equal(result.current.peekBack()?.sessionId, "a");
});

test("dropping a peeked dead entry keeps the cursor on the live view", () => {
  const { result } = renderNav();
  act(() => result.current.record(session("a")));
  act(() => result.current.record(session("dead")));
  act(() => result.current.record(session("c")));
  assert.equal(result.current.peekBack()?.sessionId, "dead");
  act(() => result.current.dropPeekedBack());
  assert.equal(result.current.peekBack()?.sessionId, "a");
  assert.equal(result.current.canBack, true);
});

test("commitForward walks forward through recorded views", () => {
  const { result } = renderNav();
  act(() => result.current.record(newChat("/one")));
  act(() => result.current.record(session("a")));
  act(() => result.current.commitBack());
  assert.equal(result.current.peekForward()?.sessionId, "a");
  act(() => result.current.commitForward());
  assert.equal(result.current.canForward, false);
  assert.equal(result.current.peekBack()?.cwd, "/one");
});

test("new-chat views with different cwds are distinct entries", () => {
  const { result } = renderNav();
  act(() => result.current.record(newChat("/one")));
  act(() => result.current.record(newChat("/two")));
  assert.equal(result.current.canBack, true);
  assert.equal(result.current.peekBack()?.cwd, "/one");
});
