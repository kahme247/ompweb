import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./navigation-history.ts");
}

const session = (id, cwd = "/repo") => ({ sessionId: id, cwd });
const newChat = (cwd) => ({ sessionId: null, cwd });

test("pushing onto an empty history seeds the first entry", async () => {
  const { createNavigationHistory, pushNavigationEntry, currentNavigationEntry } = await loadSubject();
  const seeded = pushNavigationEntry(createNavigationHistory(), session("a"));
  assert.equal(currentNavigationEntry(seeded)?.sessionId, "a");
  assert.equal(seeded.entries.length, 1);
  assert.equal(seeded.index, 0);
});

test("pushing the same session again is a no-op that keeps the identity", async () => {
  const { createNavigationHistory, pushNavigationEntry } = await loadSubject();
  const seeded = pushNavigationEntry(createNavigationHistory(), session("a"));
  const same = pushNavigationEntry(seeded, session("a"));
  assert.equal(same, seeded);
  assert.equal(same.entries.length, 1);
});

test("session entries compare by id only; cwd changes do not fork history", async () => {
  const { createNavigationHistory, pushNavigationEntry } = await loadSubject();
  const seeded = pushNavigationEntry(createNavigationHistory(), session("a", "/one"));
  assert.equal(pushNavigationEntry(seeded, session("a", "/two")), seeded);
});

test("new-chat entries compare by cwd", async () => {
  const { createNavigationHistory, pushNavigationEntry } = await loadSubject();
  const seeded = pushNavigationEntry(createNavigationHistory(), newChat("/one"));
  assert.equal(pushNavigationEntry(seeded, newChat("/one")), seeded);
  const moved = pushNavigationEntry(seeded, newChat("/two"));
  assert.equal(moved.entries.length, 2);
  assert.equal(moved.index, 1);
});

test("new-chat entries on two hosts are different views even for the same path", async () => {
  const { createNavigationHistory, pushNavigationEntry } = await loadSubject();
  const seeded = pushNavigationEntry(createNavigationHistory(), newChat("/one"));
  const remote = pushNavigationEntry(seeded, { ...newChat("/one"), hostId: "h1" });
  assert.equal(remote.entries.length, 2);
  assert.equal(pushNavigationEntry(remote, { ...newChat("/one"), hostId: "h1" }), remote);
});

test("pushing after stepping back truncates the forward branch", async () => {
  const { createNavigationHistory, pushNavigationEntry, stepNavigationHistory } = await loadSubject();
  let h = createNavigationHistory();
  h = pushNavigationEntry(h, session("a"));
  h = pushNavigationEntry(h, session("b"));
  h = pushNavigationEntry(h, session("c"));
  h = stepNavigationHistory(h, -1); // now at b
  h = pushNavigationEntry(h, session("d"));
  assert.deepEqual(h.entries.map((e) => e.sessionId), ["a", "b", "d"]);
  assert.equal(h.index, 2);
});

test("history is capped at the maximum entry count, dropping the oldest", async () => {
  const { createNavigationHistory, pushNavigationEntry, NAVIGATION_HISTORY_MAX_ENTRIES } = await loadSubject();
  let h = createNavigationHistory();
  const total = NAVIGATION_HISTORY_MAX_ENTRIES + 10;
  for (let i = 0; i < total; i++) h = pushNavigationEntry(h, session(`s${i}`));
  assert.equal(h.entries.length, NAVIGATION_HISTORY_MAX_ENTRIES);
  assert.equal(h.index, h.entries.length - 1);
  assert.equal(h.entries[0].sessionId, `s${total - NAVIGATION_HISTORY_MAX_ENTRIES}`);
});

test("back/forward availability follows the index bounds", async () => {
  const { createNavigationHistory, pushNavigationEntry, canGoNavigationBack, canGoNavigationForward } = await loadSubject();
  const empty = createNavigationHistory();
  assert.equal(canGoNavigationBack(empty), false);
  assert.equal(canGoNavigationForward(empty), false);
  let h = pushNavigationEntry(empty, session("a"));
  assert.equal(canGoNavigationBack(h), false);
  assert.equal(canGoNavigationForward(h), false);
  h = pushNavigationEntry(h, session("b"));
  assert.equal(canGoNavigationBack(h), true);
  assert.equal(canGoNavigationForward(h), false);
  const back = h.entries[0];
  h = { entries: h.entries, index: 0 };
  assert.equal(canGoNavigationBack(h), false);
  assert.equal(canGoNavigationForward(h), true);
  assert.equal(back.sessionId, "a");
});

test("peek returns the neighbor entry without moving; missing neighbors are null", async () => {
  const { createNavigationHistory, pushNavigationEntry, peekNavigationEntry } = await loadSubject();
  let h = createNavigationHistory();
  assert.equal(peekNavigationEntry(h, -1), null);
  assert.equal(peekNavigationEntry(h, 1), null);
  h = pushNavigationEntry(h, session("a"));
  h = pushNavigationEntry(h, session("b"));
  h = pushNavigationEntry(h, session("c"));
  assert.equal(peekNavigationEntry(h, -1)?.sessionId, "b");
  assert.equal(peekNavigationEntry(h, 1), null);
});

test("stepping is clamped and never mutates the input history", async () => {
  const { createNavigationHistory, pushNavigationEntry, stepNavigationHistory, currentNavigationEntry } = await loadSubject();
  let h = createNavigationHistory();
  h = pushNavigationEntry(h, session("a"));
  h = pushNavigationEntry(h, session("b"));
  const frozen = h;
  const before = currentNavigationEntry(h)?.sessionId;
  const clamped = stepNavigationHistory(h, 1);
  assert.equal(clamped, h); // no-op returns the same reference
  const stepped = stepNavigationHistory(h, -1);
  assert.equal(currentNavigationEntry(stepped)?.sessionId, "a");
  assert.equal(currentNavigationEntry(frozen)?.sessionId, before);
  assert.equal(currentNavigationEntry(h)?.sessionId, before);
});

test("removing an entry before the current one shifts the index onto the same entry", async () => {
  const { createNavigationHistory, pushNavigationEntry, removeNavigationEntryAt } = await loadSubject();
  let h = createNavigationHistory();
  h = pushNavigationEntry(h, session("a"));
  h = pushNavigationEntry(h, session("dead"));
  h = pushNavigationEntry(h, session("c"));
  h = removeNavigationEntryAt(h, 1);
  assert.deepEqual(h.entries.map((e) => e.sessionId), ["a", "c"]);
  assert.equal(h.index, 1); // still points at c
});

test("removing an entry after the current one keeps the index", async () => {
  const { createNavigationHistory, pushNavigationEntry, removeNavigationEntryAt } = await loadSubject();
  let h = createNavigationHistory();
  h = pushNavigationEntry(h, session("a"));
  h = pushNavigationEntry(h, session("dead"));
  h = removeNavigationEntryAt(h, 1);
  assert.deepEqual(h.entries.map((e) => e.sessionId), ["a"]);
  assert.equal(h.index, 0);
});

test("removing out-of-range or from an empty history is a no-op", async () => {
  const { createNavigationHistory, pushNavigationEntry, removeNavigationEntryAt } = await loadSubject();
  const empty = createNavigationHistory();
  assert.equal(removeNavigationEntryAt(empty, 0), empty);
  let h = pushNavigationEntry(empty, session("a"));
  assert.equal(removeNavigationEntryAt(h, 5), h);
  assert.equal(removeNavigationEntryAt(h, -1), h);
});

test("shortcut matcher: macOS uses Cmd+[ / Cmd+]", async () => {
  const { navigateShortcutDirection } = await loadSubject();
  const ev = (fields) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", isComposing: false, ...fields });
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, key: "[" }), true), -1);
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, key: "]" }), true), 1);
  // Alt+Arrow is word-wise caret movement on macOS — must stay free.
  assert.equal(navigateShortcutDirection(ev({ altKey: true, key: "ArrowLeft" }), true), 0);
  assert.equal(navigateShortcutDirection(ev({ altKey: true, key: "ArrowRight" }), true), 0);
  // Ctrl+[ is the macOS terminal escape — not a navigation alias there.
  assert.equal(navigateShortcutDirection(ev({ ctrlKey: true, key: "[" }), true), 0);
});

test("shortcut matcher: Windows/Linux use Alt+Arrow and accept Ctrl+[ as an alias", async () => {
  const { navigateShortcutDirection } = await loadSubject();
  const ev = (fields) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", isComposing: false, ...fields });
  assert.equal(navigateShortcutDirection(ev({ altKey: true, key: "ArrowLeft" }), false), -1);
  assert.equal(navigateShortcutDirection(ev({ altKey: true, key: "ArrowRight" }), false), 1);
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, key: "[" }), false), -1);
  assert.equal(navigateShortcutDirection(ev({ ctrlKey: true, key: "]" }), false), 1);
});

test("shortcut matcher: hardware browser keys work on every platform", async () => {
  const { navigateShortcutDirection } = await loadSubject();
  const ev = (fields) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", isComposing: false, ...fields });
  assert.equal(navigateShortcutDirection(ev({ key: "BrowserBack" }), true), -1);
  assert.equal(navigateShortcutDirection(ev({ key: "BrowserForward" }), false), 1);
});

test("shortcut matcher: rejects modified/plain/unrelated keys and composition", async () => {
  const { navigateShortcutDirection } = await loadSubject();
  const ev = (fields) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", isComposing: false, ...fields });
  assert.equal(navigateShortcutDirection(ev({ key: "[" }), false), 0);
  assert.equal(navigateShortcutDirection(ev({ key: "]" }), true), 0);
  assert.equal(navigateShortcutDirection(ev({ key: "ArrowLeft" }), false), 0);
  // Shift chords belong to tab switching (Cmd+Shift+]) and selection.
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, shiftKey: true, key: "[" }), true), 0);
  assert.equal(navigateShortcutDirection(ev({ altKey: true, shiftKey: true, key: "ArrowLeft" }), false), 0);
  // Mixed modifiers.
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, altKey: true, key: "[" }), true), 0);
  assert.equal(navigateShortcutDirection(ev({ altKey: true, ctrlKey: true, key: "ArrowLeft" }), false), 0);
  // IME composition must never navigate.
  assert.equal(navigateShortcutDirection(ev({ metaKey: true, key: "[", isComposing: true }), true), 0);
});

test("shortcut hints render per platform", async () => {
  const { navigateShortcutHint } = await loadSubject();
  assert.equal(navigateShortcutHint(-1, true), "⌘[");
  assert.equal(navigateShortcutHint(1, true), "⌘]");
  assert.equal(navigateShortcutHint(-1, false), "Alt+←");
  assert.equal(navigateShortcutHint(1, false), "Alt+→");
});
