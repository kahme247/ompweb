import assert from "node:assert/strict";
import test from "node:test";

const {
  STORAGE_KEY,
  nextTouchTargetsPreference,
  storedTouchTargetsPreference,
} = await import("./useTouchTargets.ts");

function withStoredValue(value, fn) {
  const hadWindow = "window" in globalThis;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  globalThis.window ??= globalThis;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => (key === STORAGE_KEY ? value : null) },
  });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
    if (!hadWindow) delete globalThis.window;
  }
}

test("cycles touch targets preferences through auto -> compact -> accessible -> auto", () => {
  assert.equal(nextTouchTargetsPreference("auto"), "compact");
  assert.equal(nextTouchTargetsPreference("compact"), "accessible");
  assert.equal(nextTouchTargetsPreference("accessible"), "auto");
});

test("falls back safely on unknown preference input", () => {
  assert.equal(nextTouchTargetsPreference("unknown"), "auto");
});

test("stored preference returns default in non-browser environment", () => {
  assert.equal(storedTouchTargetsPreference(), "auto");
});

test("stored preference keeps valid values and rejects unknown or prototype keys", () => {
  withStoredValue("accessible", () => assert.equal(storedTouchTargetsPreference(), "accessible"));
  withStoredValue("compact", () => assert.equal(storedTouchTargetsPreference(), "compact"));
  for (const bogus of ["garbage", "constructor", "toString", "__proto__"]) {
    withStoredValue(bogus, () => assert.equal(storedTouchTargetsPreference(), "auto", bogus));
  }
});
