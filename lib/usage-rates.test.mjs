import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
async function loadSubject() {
  return jiti.import("./usage-rates.ts");
}

test("resolves default rates for major models", async () => {
  const { resolveModelRates } = await loadSubject();

  // Anthropic Claude 3.7 Sonnet
  const claudeRates = resolveModelRates("anthropic", "claude-3-7-sonnet");
  assert.ok(claudeRates);
  assert.equal(claudeRates.input, 3.0);
  assert.equal(claudeRates.output, 15.0);
  assert.equal(claudeRates.cacheRead, 0.3);

  // OpenAI GPT-4o
  const gpt4oRates = resolveModelRates("openai", "openai/gpt-4o");
  assert.ok(gpt4oRates);
  assert.equal(gpt4oRates.input, 2.5);
  assert.equal(gpt4oRates.output, 10.0);

  // Gemini 2.5 Flash
  const geminiRates = resolveModelRates("google", "gemini-2.5-flash");
  assert.ok(geminiRates);
  assert.equal(geminiRates.input, 0.075);
  assert.equal(geminiRates.output, 0.3);

  // DeepSeek Chat
  const deepseekRates = resolveModelRates("deepseek", "deepseek-chat");
  assert.ok(deepseekRates);
  assert.equal(deepseekRates.input, 0.14);
  assert.equal(deepseekRates.output, 0.28);
});

test("prefers custom models.yml rates when available", async () => {
  const { resolveModelRates } = await loadSubject();

  const customConfig = {
    providers: {
      "my-custom-provider": {
        models: [
          {
            id: "custom-llama",
            cost: { input: 0.12, output: 0.45, cacheRead: 0.02, cacheWrite: 0.15 },
          },
        ],
      },
    },
  };

  const rates = resolveModelRates("my-custom-provider", "custom-llama", customConfig);
  assert.ok(rates);
  assert.equal(rates.input, 0.12);
  assert.equal(rates.output, 0.45);
  assert.equal(rates.cacheRead, 0.02);
  assert.equal(rates.cacheWrite, 0.15);
});

test("memoizes resolved rates across repeated calls and clears with clearRatesCache", async () => {
  const { resolveModelRates, clearRatesCache } = await loadSubject();
  clearRatesCache();

  const rates1 = resolveModelRates("anthropic", "claude-3-7-sonnet");
  const rates2 = resolveModelRates("anthropic", "claude-3-7-sonnet");
  assert.equal(rates1, rates2); // Identical reference from memoization cache

  clearRatesCache();
  const rates3 = resolveModelRates("anthropic", "claude-3-7-sonnet");
  assert.deepEqual(rates1, rates3);
});

test("calculates usage cost correctly for provider-reported vs model-priced", async () => {
  const { calculateUsageCost } = await loadSubject();

  // 1. Provider reported cost number
  const rep1 = calculateUsageCost({ cost: 0.042, input: 1000, output: 500 }, null);
  assert.equal(rep1.cost, 0.042);
  assert.equal(rep1.quality, "provider_reported");

  // 2. Provider reported cost object with total
  const rep2 = calculateUsageCost(
    { cost: { input: 0.01, output: 0.03, total: 0.04 }, input: 1000, output: 500 },
    null,
  );
  assert.equal(rep2.cost, 0.04);
  assert.equal(rep2.quality, "provider_reported");

  // 3. Model priced calculation
  const rates = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
  const priced = calculateUsageCost(
    { input: 10000, output: 1000, cacheRead: 5000, cacheWrite: 2000 },
    rates,
  );
  assert.equal(priced.quality, "model_priced");
  // inCost: 10000 * 3 / 1M = 0.03
  // outCost: 1000 * 15 / 1M = 0.015
  // crCost: 5000 * 0.3 / 1M = 0.0015
  // cwCost: 2000 * 3.75 / 1M = 0.0075
  // total = 0.054
  assert.ok(Math.abs(priced.cost - 0.054) < 0.000001);

  // 4. Unpriced fallback
  const unpriced = calculateUsageCost({ input: 1000, output: 500 }, null);
  assert.equal(unpriced.cost, 0);
  assert.equal(unpriced.quality, "unpriced");
});

test("calculates prompt cache savings correctly", async () => {
  const { calculateCacheSavings } = await loadSubject();

  const rates = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
  // 100,000 cache read tokens -> savings = 100k * (3.0 - 0.3) / 1M = 0.27
  const savings = calculateCacheSavings({ cacheRead: 100000 }, rates);
  assert.ok(Math.abs(savings - 0.27) < 0.000001);

  // 0 cache read or null rates
  assert.equal(calculateCacheSavings({ cacheRead: 0 }, rates), 0);
  assert.equal(calculateCacheSavings({ cacheRead: 100000 }, null), 0);
});

test("resolves provider colors and display names", async () => {
  const { getProviderColor, getProviderDisplayName } = await loadSubject();

  assert.equal(getProviderDisplayName("anthropic"), "Anthropic");
  assert.equal(getProviderDisplayName("openai"), "OpenAI");
  assert.equal(getProviderDisplayName("deepseek"), "DeepSeek");

  assert.equal(getProviderColor("anthropic"), "#D97706");
  assert.equal(getProviderColor("openai"), "#10B981");

  // Custom provider produces deterministic HSL color
  const customColor1 = getProviderColor("my-custom-ai");
  const customColor2 = getProviderColor("my-custom-ai");
  assert.equal(customColor1, customColor2);
  assert.ok(customColor1.startsWith("hsl("));
});
