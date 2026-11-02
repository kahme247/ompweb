import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./model-catalog.ts");
}

// Minimal models.dev/api.json-shaped fixture.
const CATALOG = {
  anthropic: {
    name: "Anthropic",
    api: "https://api.anthropic.com",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 },
        limit: { context: 200000, output: 32000 },
      },
      "claude-3-5-haiku": {
        id: "claude-3-5-haiku",
        name: "Claude 3.5 Haiku",
        modalities: { input: ["text"] },
        cost: { input: 1, output: 2 },
      },
    },
  },
  openai: {
    name: "OpenAI",
    api: "https://api.openai.com",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        modalities: { input: ["text", "image"] },
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000, output: 16384 },
      },
      "claude-3-5-haiku": {
        id: "claude-3-5-haiku",
        name: "Claude 3.5 Haiku",
        modalities: { input: ["text"] },
        cost: { input: 1, output: 2 },
      },
    },
  },
  empty: { name: "No Models" },
};

test("flattens models.dev providers and models with normalized fields", async () => {
  const { flattenModelsDevCatalog } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);

  assert.equal(entries.length, 4);

  const sonnet = entries.find((entry) => entry.key === "anthropic/claude-sonnet-4-6");
  assert.ok(sonnet);
  assert.equal(sonnet.providerId, "anthropic");
  assert.equal(sonnet.providerName, "Anthropic");
  assert.equal(sonnet.providerBaseUrl, "https://api.anthropic.com");
  assert.equal(sonnet.reasoning, true);
  // "audio" is not a supported input modality and must be filtered out.
  assert.deepEqual(sonnet.input, ["text", "image"]);
  assert.equal(sonnet.contextWindow, 200000);
  assert.equal(sonnet.maxTokens, 32000);
  assert.deepEqual(sonnet.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });

  const haiku = entries.filter((entry) => entry.id === "claude-3-5-haiku");
  assert.equal(haiku.length, 2);
  assert.deepEqual(haiku.map((entry) => entry.providerId).sort(), ["anthropic", "openai"]);
});

test("flattening tolerates missing ids, names, and providers without models", async () => {
  const { flattenModelsDevCatalog } = await loadSubject();
  const entries = flattenModelsDevCatalog({
    bare: { name: "Bare", models: { "no-id": { name: "Falls Back" } } },
    empty: { name: "No Models" },
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "no-id");
  assert.equal(entries[0].name, "Falls Back");
  assert.equal(entries[0].key, "bare/no-id");
  assert.deepEqual(entries[0].cost, {});

  assert.deepEqual(flattenModelsDevCatalog(null), []);
  assert.deepEqual(flattenModelsDevCatalog([1, 2]), []);
});

test("search ranks exact ids first and applies provider-hint bonus", async () => {
  const { flattenModelsDevCatalog, searchModelCatalog } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);

  const exact = searchModelCatalog(entries, "gpt-4o");
  assert.equal(exact.length, 1);
  assert.equal(exact[0].providerId, "openai");

  const partial = searchModelCatalog(entries, "claude");
  assert.equal(partial[0].id, "claude-3-5-haiku");
  assert.ok(partial.some((entry) => entry.id === "claude-sonnet-4-6"));

  // Same id under two providers: the hinted provider wins the tie-break.
  const hinted = searchModelCatalog(entries, "claude-3-5-haiku", "openai");
  assert.equal(hinted[0].providerId, "openai");

  assert.equal(searchModelCatalog(entries, "claude", "", 1).length, 1);
  assert.deepEqual(searchModelCatalog(entries, "zzz-no-such-model"), []);
});

test("recommendation without a match reports no-exact-match", async () => {
  const { flattenModelsDevCatalog, recommendModelCatalogPreset } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);
  const recommendation = recommendModelCatalogPreset(entries, "does-not-exist");

  assert.equal(recommendation.exactMatches, 0);
  assert.equal(recommendation.metadataMethod, "none");
  assert.deepEqual(recommendation.preset, {});
  assert.deepEqual(recommendation.price, {
    status: "unreliable",
    reason: "no-exact-match",
    support: 0,
    total: 0,
  });
});

test("recommendation prefers the provider hint for metadata and pricing", async () => {
  const { flattenModelsDevCatalog, recommendModelCatalogPreset } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);
  const recommendation = recommendModelCatalogPreset(entries, "gpt-4o", "openai");

  assert.equal(recommendation.metadataMethod, "provider");
  assert.equal(recommendation.matchedProviderId, "openai");
  assert.equal(recommendation.preset.name, "GPT-4o");
  assert.deepEqual(recommendation.preset.cost, { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(recommendation.price, {
    status: "reliable",
    method: "provider",
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    providerId: "openai",
    providerName: "OpenAI",
    support: 1,
    total: 1,
  });
});

test("recommendation matches a known provider host from the base URL", async () => {
  const { flattenModelsDevCatalog, recommendModelCatalogPreset } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);
  const recommendation = recommendModelCatalogPreset(
    entries,
    "claude-sonnet-4-6",
    "",
    "https://api.anthropic.com",
  );

  assert.equal(recommendation.metadataMethod, "base-url");
  assert.equal(recommendation.matchedProviderId, "anthropic");
  assert.equal(recommendation.price.status, "reliable");
  assert.equal(recommendation.price.method, "base-url");
  assert.equal(recommendation.preset.cost?.input, 3);
});

test("recommendation falls back to consensus across providers", async () => {
  const { flattenModelsDevCatalog, recommendModelCatalogPreset } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);
  const recommendation = recommendModelCatalogPreset(entries, "claude-3-5-haiku");

  // Same id under anthropic + openai with identical pricing → consensus.
  assert.equal(recommendation.exactMatches, 2);
  assert.equal(recommendation.metadataMethod, "consensus");
  assert.equal(recommendation.preset.name, "Claude 3.5 Haiku");
  assert.deepEqual(recommendation.price, {
    status: "reliable",
    method: "consensus",
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    support: 2,
    total: 2,
  });
});

test("single-entry consensus is unreliable due to insufficient support", async () => {
  const { flattenModelsDevCatalog, recommendModelCatalogPreset } = await loadSubject();
  const entries = flattenModelsDevCatalog(CATALOG);
  const recommendation = recommendModelCatalogPreset(entries, "gpt-4o");

  assert.equal(recommendation.metadataMethod, "consensus");
  assert.deepEqual(recommendation.price, {
    status: "unreliable",
    reason: "insufficient-support",
    support: 1,
    total: 1,
  });
  assert.equal(recommendation.preset.cost, undefined);
});
