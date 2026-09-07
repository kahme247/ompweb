import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextThemePreference, resolveTheme } = await jiti.import("./useTheme.ts");

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
