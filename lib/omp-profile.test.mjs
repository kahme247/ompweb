import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isValidOmpProfile } = await jiti.import("./omp-profile.ts");

test("accepts profile names omp allows", () => {
  assert.equal(isValidOmpProfile(""), true); // empty = no profile
  assert.equal(isValidOmpProfile("work"), true);
  assert.equal(isValidOmpProfile("nova-insight"), true);
  assert.equal(isValidOmpProfile("a"), true);
  assert.equal(isValidOmpProfile("9lives"), true);
  assert.equal(isValidOmpProfile("a".repeat(64)), true);
  assert.equal(isValidOmpProfile("team.config_v2-2026"), true);
});

test("rejects profile names omp rejects at startup", () => {
  assert.equal(isValidOmpProfile("nova insight"), false); // space — the 500 repro
  assert.equal(isValidOmpProfile("Nova"), false); // uppercase
  assert.equal(isValidOmpProfile("工作"), false); // non-ASCII
  assert.equal(isValidOmpProfile("-lead"), false); // dash-leading (flag smuggling)
  assert.equal(isValidOmpProfile("a".repeat(65)), false); // too long
  assert.equal(isValidOmpProfile(".hidden"), false); // must start with letter/digit
  assert.equal(isValidOmpProfile("trailing."), false); // cannot end with '.'
});

test("rejects Windows reserved device names with or without extension", () => {
  assert.equal(isValidOmpProfile("con"), false);
  assert.equal(isValidOmpProfile("nul"), false);
  assert.equal(isValidOmpProfile("com1"), false);
  assert.equal(isValidOmpProfile("lpt9"), false);
  assert.equal(isValidOmpProfile("con.txt"), false);
  assert.equal(isValidOmpProfile("aux.settings"), false);
  assert.equal(isValidOmpProfile("console"), true); // only exact base names are reserved
  assert.equal(isValidOmpProfile("com1x"), true);
});
