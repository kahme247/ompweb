import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  DEFAULT_DESKTOP_MODE,
  DEFAULT_MOBILE_FAB,
  storedChatMinimapPreference,
  saveChatMinimapPreference,
  STORAGE_KEY_DESKTOP,
  STORAGE_KEY_MOBILE_FAB,
} = await jiti.import("./useChatMinimapPreference.ts");

test("storedChatMinimapPreference returns defaults in clean environment", () => {
  const state = storedChatMinimapPreference();
  assert.equal(state.desktopMode, DEFAULT_DESKTOP_MODE);
  assert.equal(state.mobileFab, DEFAULT_MOBILE_FAB);
});

test("storedChatMinimapPreference reads from mock localStorage and saves updates", () => {
  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, val) => storage.set(key, String(val)),
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  try {
    saveChatMinimapPreference({ desktopMode: "fab", mobileFab: true });
    assert.equal(storage.get(STORAGE_KEY_DESKTOP), "fab");
    assert.equal(storage.get(STORAGE_KEY_MOBILE_FAB), "true");

    const state = storedChatMinimapPreference();
    assert.equal(state.desktopMode, "fab");
    assert.equal(state.mobileFab, true);

    // Save mobileFab to false
    saveChatMinimapPreference({ mobileFab: false });
    assert.equal(storage.get(STORAGE_KEY_MOBILE_FAB), "false");
    const state2 = storedChatMinimapPreference();
    assert.equal(state2.mobileFab, false);
    assert.equal(state2.desktopMode, "fab");
  } finally {
    delete globalThis.window;
    delete globalThis.CustomEvent;
  }
});
