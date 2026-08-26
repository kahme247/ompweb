import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SETTINGS_CATEGORIES, getNormalizedActive } = await jiti.import("./SettingsTabs.tsx");

test("all 8 settings categories have required metadata for mobile index view", () => {
  assert.equal(SETTINGS_CATEGORIES.length, 8);
  const ids = SETTINGS_CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, [
    "general",
    "safety",
    "models",
    "providers",
    "intelligence",
    "agents",
    "mcp",
    "system",
  ]);

  for (const cat of SETTINGS_CATEGORIES) {
    assert.ok(cat.label && cat.label.length > 0, `Category ${cat.id} missing label`);
    assert.ok(cat.description && cat.description.length > 0, `Category ${cat.id} missing description`);
    assert.ok(cat.Icon, `Category ${cat.id} missing Icon component`);
  }
});

test("getNormalizedActive maps sub-tabs correctly for unified mobile navigation", () => {
  assert.equal(getNormalizedActive("skills"), "mcp");
  assert.equal(getNormalizedActive("plugins"), "mcp");
  assert.equal(getNormalizedActive("extensions"), "mcp");
  assert.equal(getNormalizedActive("general"), "general");
  assert.equal(getNormalizedActive("providers"), "providers");
});
