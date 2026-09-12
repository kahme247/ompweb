import assert from "node:assert/strict";
import test from "node:test";
import { formatGenerationSpeed } from "./generation-speed.ts";

test("generation speed promotes rounded rates before they exceed the fixed numeric slot", () => {
  for (const [rate, value, unit] of [
    [0, "0.0", "t/s"],
    [999.9, "999.9", "t/s"],
    [999.95, "1.0", "kt/s"],
    [12_345.6, "12.3", "kt/s"],
    [999_950, "1.0", "Mt/s"],
    [1e20, "100.0", "Et/s"],
    [1e30, "1.0", "Qt/s"],
  ]) {
    const result = formatGenerationSpeed(rate);
    assert.deepEqual(result, { value, unit });
    assert.ok(result.value.length <= 5);
    assert.ok(result.unit.length <= 4);
  }
});

test("generation speed rejects invalid and unrepresentable rates instead of overflowing", () => {
  for (const rate of [null, undefined, -1, NaN, Infinity, 1e33]) {
    assert.equal(formatGenerationSpeed(rate), null);
  }
});
