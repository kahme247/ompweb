import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { nextThemePreference, resolveTheme, isDarkTheme, LIGHT_THEMES, DARK_THEMES, ALL_THEMES, useTheme } = await import("./useTheme.ts");

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

test("each theme's browser chrome color is its CSS --bg-panel, the top bar's color", async () => {
  // The pre-paint script reads the CSS and the hook reads the table: a mismatch
  // flickers the status bar after hydration and sends a stale manifest color.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const { id, panel } of ALL_THEMES) {
    const selector = id === "light" ? ":root" : id === "omp" ? "html.omp" : `html.theme-${id}`;
    // The first `:root` block holds the self-hosted font variables; take the one that sets --bg-panel.
    const match = css.match(new RegExp(`(^|, )${selector.replace(".", "\\.")} \\{[^}]*--bg-panel:\\s*(#[0-9A-Fa-f]{6})`, "m"));
    assert.equal(match?.[2].toUpperCase(), panel, id);
  }
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
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/api/manifest";
  document.head.append(manifest);
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
    manifest.remove();
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
    assert.match(document.cookie, new RegExp(`(^|; )omp-theme-color=${color.slice(1)}(;|$)`));
    // A new href makes Chrome drop its cached manifest and refetch the new color.
    assert.equal(manifest.getAttribute("href"), `/api/manifest?theme=${color.slice(1)}`);
    assert.equal(localStorage.getItem("omp-theme"), preference);
  };
  const changeOS = async (dark) => {
    await act(() => {
      media.matches = dark;
      media.dispatchEvent(new window.Event("change"));
    });
  };

  assertTheme("dracula", "#21222C", true, ["dark", "theme-dracula"]);
  await changeOS(true);
  assertTheme("dracula", "#21222C", true, ["dark", "theme-dracula"]);
  await act(() => hook.result.current.setTheme("catppuccin-latte"));
  assertTheme("catppuccin-latte", "#E6E9EF", false, ["theme-catppuccin-latte"]);
  await act(() => hook.result.current.setTheme("system"));
  assertTheme("dark", "#231F1B", true, ["dark", "theme-dark"], "system");
  await changeOS(false);
  assertTheme("light", "#F2F0EA", false, ["theme-light"], "system");
  await act(() => hook.result.current.setTheme("omp"));
  await changeOS(true);
  assertTheme("omp", "#0A0A0C", true, ["omp"]);

  await act(() => hook.result.current.setTheme("system"));
  assertTheme("dark", "#231F1B", true, ["dark", "theme-dark"], "system");
  hook.unmount();
  await changeOS(false);
  assert.equal(root.getAttribute("data-theme"), "dark", "unmounted consumers no longer update browser chrome");
  assert.equal(meta.getAttribute("content"), "#231F1B");
  hook = renderHook(() => useTheme());
  assertTheme("light", "#F2F0EA", false, ["theme-light"], "system");
});
