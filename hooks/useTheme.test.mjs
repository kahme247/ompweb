import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const React = require("react");
const { act } = React;
const TestRenderer = require("react-test-renderer");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextThemePreference, resolveTheme, isDarkTheme, LIGHT_THEMES, DARK_THEMES, ALL_THEMES, useTheme } = await jiti.import("./useTheme.ts");

test("cycles explicit and system theme preferences", () => {
  assert.equal(nextThemePreference("light"), "dark");
  assert.equal(nextThemePreference("dark"), "omp");
  assert.equal(nextThemePreference("omp"), "system");
  assert.equal(nextThemePreference("system"), "light");
});

test("resolves system theme from the operating system preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("resolves the omp theme independently of the operating system preference", () => {
  assert.equal(resolveTheme("omp", true), "omp");
  assert.equal(resolveTheme("omp", false), "omp");
});

test("correctly classifies light and dark themes", () => {
  for (const theme of LIGHT_THEMES) {
    assert.equal(isDarkTheme(theme.id), false, `${theme.id} should be light`);
  }
  for (const theme of DARK_THEMES) {
    assert.equal(isDarkTheme(theme.id), true, `${theme.id} should be dark`);
  }
});

test("resolves custom themes directly", () => {
  assert.equal(resolveTheme("dracula"), "dracula");
  assert.equal(resolveTheme("nord"), "nord");
  assert.equal(resolveTheme("catppuccin-latte"), "catppuccin-latte");
  assert.equal(resolveTheme("tokyo-night"), "tokyo-night");
});

test("nextThemePreference toggles custom dark themes to light and custom light themes to dark", () => {
  assert.equal(nextThemePreference("dracula"), "light");
  assert.equal(nextThemePreference("nord"), "light");
  assert.equal(nextThemePreference("tokyo-night"), "light");
  assert.equal(nextThemePreference("catppuccin-latte"), "dark");
  assert.equal(nextThemePreference("one-light"), "dark");
});

test("contains all requested light and dark themes in metadata", () => {
  const lightIds = LIGHT_THEMES.map((t) => t.id);
  const darkIds = DARK_THEMES.map((t) => t.id);
  assert.deepEqual(lightIds, ["light", "one-light", "catppuccin-latte", "rose-pine-dawn"]);
  assert.deepEqual(darkIds, [
    "omp",
    "dark",
    "dracula",
    "harbor",
    "one-dark-pro",
    "rose-pine",
    "catppuccin-mocha",
    "gruvbox-dark",
    "nord",
    "tokyo-night",
  ]);
  assert.equal(ALL_THEMES.length, 14);
});

test("browser chrome follows the selected theme and only follows OS changes in system mode", async (t) => {
  const storage = new Map([["omp-theme", "dracula"]]);
  const classes = new Set();
  const attributes = new Map();
  const metaAttributes = new Map([["content", "#000000"]]);
  const mediaListeners = new Set();
  const media = {
    matches: false,
    addEventListener: (_type, listener) => mediaListeners.add(listener),
    removeEventListener: (_type, listener) => mediaListeners.delete(listener),
  };
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { matchMedia: () => media },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      documentElement: {
        classList: {
          add: (cls) => classes.add(cls),
          remove: (cls) => classes.delete(cls),
          forEach: (callback) => classes.forEach(callback),
          toggle: (cls, force) => force ? classes.add(cls) : classes.delete(cls),
        },
        setAttribute: (key, value) => attributes.set(key, value),
      },
      querySelector: (selector) => selector === 'meta[name="theme-color"]'
        ? { setAttribute: (key, value) => metaAttributes.set(key, value) }
        : null,
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  let current;
  function Probe() {
    current = useTheme();
    return null;
  }
  const assertTheme = (theme, color) => {
    assert.equal(current.theme, theme);
    assert.equal(attributes.get("data-theme"), theme);
    assert.equal(metaAttributes.get("content"), color);
  };
  const changeOS = async (dark) => {
    await act(() => {
      media.matches = dark;
      for (const listener of mediaListeners) listener();
    });
  };
  let renderer;
  try {
    await act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
    assertTheme("dracula", "#282A36");
    await changeOS(true);
    assertTheme("dracula", "#282A36");
    await act(() => current.setTheme("catppuccin-latte"));
    assertTheme("catppuccin-latte", "#EFF1F5");
    await act(() => current.setTheme("system"));
    assertTheme("dark", "#1B1916");
    await changeOS(false);
    assertTheme("light", "#FAF9F6");
    await act(() => current.setTheme("omp"));
    await changeOS(true);
    assertTheme("omp", "#000000");
  } finally {
    await act(() => renderer?.unmount());
  }
});
