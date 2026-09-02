import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_UI_SCALE,
  STORAGE_KEY,
  nextUiScalePreference,
  resolveUiScaleFactor,
  resolveUiScalePercent,
  storedUiScalePreference,
} = await jiti.import("./useUiScale.ts");

test("has expected constants", () => {
  assert.equal(DEFAULT_UI_SCALE, "standard");
  assert.equal(STORAGE_KEY, "omp-ui-scale");
});

test("cycles UI scale preferences through compact -> standard -> comfortable -> large -> compact", () => {
  assert.equal(nextUiScalePreference("compact"), "standard");
  assert.equal(nextUiScalePreference("standard"), "comfortable");
  assert.equal(nextUiScalePreference("comfortable"), "large");
  assert.equal(nextUiScalePreference("large"), "compact");
});

test("falls back safely on unknown preference input", () => {
  assert.equal(nextUiScalePreference("unknown"), "standard");
});

test("resolves UI scale factor correctly", () => {
  assert.equal(resolveUiScaleFactor("compact"), 0.9);
  assert.equal(resolveUiScaleFactor("standard"), 1.0);
  assert.equal(resolveUiScaleFactor("comfortable"), 1.1);
  assert.equal(resolveUiScaleFactor("large"), 1.2);
  assert.equal(resolveUiScaleFactor("unknown"), 1.0);
});

test("resolves UI scale percentage correctly", () => {
  assert.equal(resolveUiScalePercent("compact"), 90);
  assert.equal(resolveUiScalePercent("standard"), 100);
  assert.equal(resolveUiScalePercent("comfortable"), 110);
  assert.equal(resolveUiScalePercent("large"), 120);
  assert.equal(resolveUiScalePercent("unknown"), 100);
});

test("stored preference returns default in non-browser environment", () => {
  assert.equal(storedUiScalePreference(), "standard");
});
