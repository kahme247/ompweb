import assert from "node:assert/strict";
import test from "node:test";

const { resolveAvailableThinkingLevels, selectableThinkingLevels, thinkingLevelsForMeta } = await import("./thinking-levels.ts");

const LUNA = { provider: "openai", modelId: "gpt-5.6-luna" };
const LIVE_LUNA = { provider: "openai", modelId: "gpt-5.6-luna", reasoning: true, thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] } };
const LIVE_NON_REASONING = { provider: "openai", modelId: "gpt-4", reasoning: false };

test("catalog ladder wins for a known model", () => {
  assert.deepEqual(
    resolveAvailableThinkingLevels(["off", "low", "medium", "high"], LUNA, LIVE_LUNA),
    ["off", "low", "medium", "high"],
  );
});

test("catalog wins even when the live model differs (user just picked a model)", () => {
  const picked = { provider: "google-antigravity", modelId: "gemini-3-pro" };
  assert.deepEqual(
    resolveAvailableThinkingLevels(["off", "low", "high"], picked, LIVE_LUNA),
    ["off", "low", "high"],
  );
});

test("live model ladder backs a non-catalog model", () => {
  assert.deepEqual(
    resolveAvailableThinkingLevels(undefined, LUNA, LIVE_LUNA),
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
});

test("live non-reasoning model offers only off", () => {
  assert.deepEqual(
    resolveAvailableThinkingLevels(undefined, { provider: "openai", modelId: "gpt-4" }, LIVE_NON_REASONING),
    ["off"],
  );
});

test("live model with no efforts resolves to off only", () => {
  const live = { provider: "custom", modelId: "m", reasoning: true, thinking: {} };
  assert.deepEqual(resolveAvailableThinkingLevels(undefined, { provider: "custom", modelId: "m" }, live), ["off"]);
});

test("null when the live model does not match the current model", () => {
  assert.equal(
    resolveAvailableThinkingLevels(undefined, { provider: "openai-codex", modelId: "gpt-5.6-sol" }, LIVE_LUNA),
    null,
  );
});

test("null when there is no live model", () => {
  assert.equal(resolveAvailableThinkingLevels(undefined, LUNA, null), null);
});

test("null when there is no model at all", () => {
  assert.equal(resolveAvailableThinkingLevels(undefined, null, LIVE_LUNA), null);
});

test("empty catalog array is treated as a miss (no levels)", () => {
  assert.deepEqual(resolveAvailableThinkingLevels([], LUNA, LIVE_LUNA), ["off", "low", "medium", "high", "xhigh", "max"]);
});

test("thinkingLevelsForMeta mirrors the models route ladder", () => {
  assert.deepEqual(thinkingLevelsForMeta({ provider: "x", modelId: "y", reasoning: true, thinking: { efforts: ["minimal", "low"] } }), ["off", "minimal", "low"]);
  assert.deepEqual(thinkingLevelsForMeta({ provider: "x", modelId: "y", reasoning: false }), ["off"]);
  assert.deepEqual(thinkingLevelsForMeta({ provider: "x", modelId: "y" }), ["off"]);
});

test("selectable levels preserve provider-defined efforts outside the built-in UI ladder", () => {
  assert.deepEqual(
    selectableThinkingLevels(["off", "low", "ultra", "provider-max", "ultra"]),
    ["auto", "off", "low", "ultra", "provider-max"],
  );
});
