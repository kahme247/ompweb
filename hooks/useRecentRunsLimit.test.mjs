import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CUSTOM_STORAGE_KEY,
  DEFAULT_LIMIT,
  DEFAULT_PRESET,
  MAX_LIMIT,
  MIN_LIMIT,
  RECENT_RUNS_LIMIT_CHANGE_EVENT,
  STORAGE_KEY,
  clampLimit,
  resolvePresetLimit,
  saveRecentRunsLimitState,
  storedRecentRunsLimitState,
} = await jiti.import("./useRecentRunsLimit.ts");

test("has expected constants", () => {
  assert.equal(STORAGE_KEY, "omp-recent-runs-limit");
  assert.equal(CUSTOM_STORAGE_KEY, "omp-recent-runs-custom-limit");
  assert.equal(DEFAULT_PRESET, "10");
  assert.equal(DEFAULT_LIMIT, 10);
  assert.equal(MIN_LIMIT, 1);
  assert.equal(MAX_LIMIT, 100);
  assert.equal(RECENT_RUNS_LIMIT_CHANGE_EVENT, "omp-recent-runs-limit-change");
});

test("resolves presets 10, 15, 20 and custom limits", () => {
  assert.equal(resolvePresetLimit("10", 25), 10);
  assert.equal(resolvePresetLimit("15", 25), 15);
  assert.equal(resolvePresetLimit("20", 25), 20);
  assert.equal(resolvePresetLimit("custom", 25), 25);
  assert.equal(resolvePresetLimit("custom", 120), 100);
  assert.equal(resolvePresetLimit("custom", -5), 1);
  assert.equal(resolvePresetLimit("unknown", 25), 10);
});

test("clamps limits strictly between 1 and 100 with fallback on invalid values", () => {
  assert.equal(clampLimit(1), 1);
  assert.equal(clampLimit(100), 100);
  assert.equal(clampLimit(50), 50);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-10), 1);
  assert.equal(clampLimit(101), 100);
  assert.equal(clampLimit(999), 100);
  assert.equal(clampLimit(14.7), 15);
  assert.equal(clampLimit(NaN), 10);
  assert.equal(clampLimit(Infinity), 10);
  assert.equal(clampLimit("50"), 10);
});

test("stored limit state returns default in non-browser environment", () => {
  const state = storedRecentRunsLimitState();
  assert.equal(state.preset, "10");
  assert.equal(state.limit, 10);
  assert.equal(state.customValue, 10);
});

test("storage roundtrip and event dispatch in browser environment", () => {
  const hadWindow = "window" in globalThis;
  const store = new Map();
  const events = [];

  const mockWindow = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, val) => store.set(key, String(val)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    },
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  };

  globalThis.window = mockWindow;
  if (!globalThis.CustomEvent) {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }

  try {
    // 1. Initial state when storage empty
    let state = storedRecentRunsLimitState();
    assert.equal(state.preset, "10");
    assert.equal(state.limit, 10);

    // 2. Save preset 15
    saveRecentRunsLimitState("15");
    assert.equal(store.get(STORAGE_KEY), "15");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, RECENT_RUNS_LIMIT_CHANGE_EVENT);
    assert.equal(events[0].detail.preset, "15");
    assert.equal(events[0].detail.limit, 15);

    state = storedRecentRunsLimitState();
    assert.equal(state.preset, "15");
    assert.equal(state.limit, 15);

    // 3. Save preset 20
    saveRecentRunsLimitState("20");
    assert.equal(store.get(STORAGE_KEY), "20");
    state = storedRecentRunsLimitState();
    assert.equal(state.preset, "20");
    assert.equal(state.limit, 20);

    // 4. Save custom limit 35
    saveRecentRunsLimitState("custom", 35);
    assert.equal(store.get(STORAGE_KEY), "custom");
    assert.equal(store.get(CUSTOM_STORAGE_KEY), "35");
    state = storedRecentRunsLimitState();
    assert.equal(state.preset, "custom");
    assert.equal(state.limit, 35);
    assert.equal(state.customValue, 35);

    // 5. Clamps out-of-range custom limit on save
    saveRecentRunsLimitState("custom", 150);
    assert.equal(store.get(CUSTOM_STORAGE_KEY), "100");
    state = storedRecentRunsLimitState();
    assert.equal(state.limit, 100);

    saveRecentRunsLimitState("custom", -20);
    assert.equal(store.get(CUSTOM_STORAGE_KEY), "1");
    state = storedRecentRunsLimitState();
    assert.equal(state.limit, 1);

    // 6. Preserves custom value when toggling back and forth
    saveRecentRunsLimitState("custom", 42);
    state = storedRecentRunsLimitState();
    assert.equal(state.limit, 42);
    assert.equal(state.customValue, 42);

    saveRecentRunsLimitState("10");
    state = storedRecentRunsLimitState();
    assert.equal(state.preset, "10");
    assert.equal(state.limit, 10);
    assert.equal(state.customValue, 42); // preserved in storage

    saveRecentRunsLimitState("custom");
    state = storedRecentRunsLimitState();
    assert.equal(state.preset, "custom");
    assert.equal(state.limit, 42);
  } finally {
    if (!hadWindow) {
      delete globalThis.window;
    }
  }
});

test("handles corrupted or unknown localStorage values gracefully", () => {
  const hadWindow = "window" in globalThis;
  const store = new Map();

  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, val) => store.set(key, String(val)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    },
    dispatchEvent: () => true,
  };

  try {
    store.set(STORAGE_KEY, "corrupted-preset");
    store.set(CUSTOM_STORAGE_KEY, "not-a-number");

    const state = storedRecentRunsLimitState();
    assert.equal(state.preset, "10");
    assert.equal(state.limit, 10);
    assert.equal(state.customValue, 10);
  } finally {
    if (!hadWindow) {
      delete globalThis.window;
    }
  }
});
