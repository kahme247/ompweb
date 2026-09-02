import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_FONT_SIZE,
  STORAGE_KEY,
  nextFontSizePreference,
  resolveFontSizePx,
  storedFontSizePreference,
} = await jiti.import("./useFontSize.ts");

test("has expected constants", () => {
  assert.equal(DEFAULT_FONT_SIZE, "md");
  assert.equal(STORAGE_KEY, "omp-font-size");
});

test("cycles font size preferences through sm -> md -> lg -> xl -> sm", () => {
  assert.equal(nextFontSizePreference("sm"), "md");
  assert.equal(nextFontSizePreference("md"), "lg");
  assert.equal(nextFontSizePreference("lg"), "xl");
  assert.equal(nextFontSizePreference("xl"), "sm");
});

test("falls back safely on unknown preference input", () => {
  assert.equal(nextFontSizePreference("unknown"), "md");
});

test("resolves font size in pixels correctly", () => {
  assert.equal(resolveFontSizePx("sm"), 13);
  assert.equal(resolveFontSizePx("md"), 14);
  assert.equal(resolveFontSizePx("lg"), 16);
  assert.equal(resolveFontSizePx("xl"), 18);
  assert.equal(resolveFontSizePx("unknown"), 14);
});

test("stored preference returns default in non-browser environment", () => {
  assert.equal(storedFontSizePreference(), "md");
});
