import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./navigation-history.ts");
}


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
