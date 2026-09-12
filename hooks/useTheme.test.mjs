import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextThemePreference, resolveTheme, isDarkTheme, LIGHT_THEMES, DARK_THEMES, useTheme } = await jiti.import("./useTheme.ts");

afterEach(cleanup);

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

test("browser chrome follows the selected theme and only follows OS changes in system mode", async (t) => {
  const root = document.documentElement;
  const originalClass = root.getAttribute("class");
  const originalTheme = root.getAttribute("data-theme");
  const originalPreference = localStorage.getItem("omp-theme");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#000000";
  document.head.append(meta);
  root.className = "keep-layout dark theme-nord";
  localStorage.setItem("omp-theme", "dracula");

  const media = Object.assign(new window.EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query) => query === "(prefers-color-scheme: dark)" ? media : { matches: false },
  });
  t.after(() => {
    cleanup();
    meta.remove();
    for (const [attribute, value] of [["class", originalClass], ["data-theme", originalTheme]]) {
      if (value === null) root.removeAttribute(attribute);
      else root.setAttribute(attribute, value);
    }
    if (originalPreference === null) localStorage.removeItem("omp-theme");
    else localStorage.setItem("omp-theme", originalPreference);
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete window.matchMedia;
  });

  let hook = renderHook(() => useTheme());
  const assertTheme = (theme, color, dark, classes, preference = theme) => {
    assert.equal(hook.result.current.theme, theme);
    assert.equal(hook.result.current.preference, preference);
    assert.equal(hook.result.current.isDark, dark);
    assert.equal(root.getAttribute("data-theme"), theme);
    assert.deepEqual([...root.classList].sort(), ["keep-layout", ...classes].sort());
    assert.equal(meta.getAttribute("content"), color);
    assert.equal(localStorage.getItem("omp-theme"), preference);
  };
  const changeOS = async (dark) => {
    await act(() => {
      media.matches = dark;
      media.dispatchEvent(new window.Event("change"));
    });
  };

  assertTheme("dracula", "#282A36", true, ["dark", "theme-dracula"]);
  await changeOS(true);
  assertTheme("dracula", "#282A36", true, ["dark", "theme-dracula"]);
  await act(() => hook.result.current.setTheme("catppuccin-latte"));
  assertTheme("catppuccin-latte", "#EFF1F5", false, ["theme-catppuccin-latte"]);
  await act(() => hook.result.current.setTheme("system"));
  assertTheme("dark", "#1B1916", true, ["dark", "theme-dark"], "system");
  await changeOS(false);
  assertTheme("light", "#FAF9F6", false, ["theme-light"], "system");
  await act(() => hook.result.current.setTheme("omp"));
  await changeOS(true);
  assertTheme("omp", "#000000", true, ["omp"]);

  await act(() => hook.result.current.setTheme("system"));
  assertTheme("dark", "#1B1916", true, ["dark", "theme-dark"], "system");
  hook.unmount();
  await changeOS(false);
  assert.equal(root.getAttribute("data-theme"), "dark", "unmounted consumers no longer update browser chrome");
  assert.equal(meta.getAttribute("content"), "#1B1916");
  hook = renderHook(() => useTheme());
  assertTheme("light", "#FAF9F6", false, ["theme-light"], "system");
});
