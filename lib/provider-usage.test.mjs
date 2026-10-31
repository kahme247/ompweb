import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseProviderUsageOutput, getProviderUsage } = await import("./provider-usage.ts");
test("parseProviderUsageOutput selects matching model windows", () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  const output = JSON.stringify({
    generatedAt: 123,
    reports: [
      {
        provider: "openai-codex",
        metadata: { email: "account@example.com", planType: "plus" },
        limits: [
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "5h" },
            amount: { usedFraction: 0.09 },
            window: { resetsAt: now + (2 * 60 + 39) * 60_000 },
          },
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "7d" },
            amount: { usedFraction: 0.04 },
            window: { resetsAt: now + (5 * 24 + 20) * 3_600_000 },
          },
          {
            scope: { modelId: "other-model", windowId: "5h" },
            amount: { usedFraction: 0.88 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
      {
        provider: "ollama",
        limits: [
          {
            scope: { windowId: "5h" },
            amount: { usedFraction: 0.5 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "openai-codex", modelId: "GPT-5.6-LUNA" }, now), {
    generatedAt: 123,
    reports: [{
      provider: "openai-codex",
      accountLabel: "account@example.com",
      plan: "plus",
      modelId: "gpt-5.6-luna",
      fiveHour: { percent: 9, resetMinutes: 159 },
      sevenDay: { percent: 4, resetHours: 140 },
    }],
  });
});

test("parseProviderUsageOutput selects the binding meter for repeated windows", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.7 }, window: { resetsAt: now + 30 * 60_000 } },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now).reports[0]?.fiveHour, {
    percent: 70,
    resetMinutes: 30,
  });
});
test("parseProviderUsageOutput returns every model when no model is selected", () => {
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      metadata: { accountId: "account-1" },
      limits: [
        { scope: { modelId: "model-a", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: {} },
        { scope: { modelId: "model-a", windowId: "7d" }, amount: { usedFraction: 0.2 }, window: {} },
        { scope: { modelId: "model-b", windowId: "5h" }, amount: { usedFraction: 0.3 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }), {
    generatedAt: null,
    reports: [
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-a",
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
      },
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-b",
        fiveHour: { percent: 30 },
      },
    ],
  });
});

test("parseProviderUsageOutput keeps accounts without reported limits", () => {
  const output = JSON.stringify({
    reports: [{ provider: "ollama", metadata: { email: "ollama@example.com" }, limits: [] }],
  });

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: null,
    reports: [{
      provider: "ollama",
      accountLabel: "ollama@example.com",
      noLimits: true,
    }],
  });
});

test("parseProviderUsageOutput falls back to duration and ignores malformed limits", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    generatedAt: "not-a-number",
    reports: [{
      provider: "provider",
      limits: [
        {
          scope: {},
          amount: { usedFraction: 0.12 },
          window: { durationMs: 30 * 24 * 60 * 60 * 1000, resetsAt: now + 48 * 3_600_000 },
        },
        { scope: { windowId: "5h" }, amount: { usedFraction: "bad" }, window: {} },
        { scope: { windowId: "unknown" }, amount: { usedFraction: 0.2 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now), {
    generatedAt: null,
    reports: [{
      provider: "provider",
      accountIndex: 1,
      monthly: { percent: 12, resetHours: 48 },
    }],
  });
});

test("parseProviderUsageOutput rejects invalid JSON", () => {
  assert.throws(() => parseProviderUsageOutput("not-json"), /invalid JSON/);
});

test("manual refresh replaces cached limits while automatic reads keep using the cache", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ompweb-provider-usage-"));
  const bin = join(dir, "omp");
  const data = join(dir, "usage.json");
  const cache = join(dir, "cached-usage.json");
  const failOnce = join(dir, "fail-once");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  const usage = (fraction) => JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: fraction }, window: {} }],
    }],
  });
  try {
    await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const cache = ${JSON.stringify(cache)};
const failOnce = ${JSON.stringify(failOnce)};
if (process.argv.includes("--redact")) {
  // Redaction turns account emails into "an*" in the sidebar.
  process.exit(2);
} else if (process.argv[3] === "invalidate") {
  fs.rmSync(cache, { force: true });
} else if (fs.existsSync(failOnce)) {
  fs.rmSync(failOnce);
  setTimeout(() => process.exit(1), 100);
} else {
  if (!fs.existsSync(cache)) fs.copyFileSync(${JSON.stringify(data)}, cache);
  process.stdout.write(fs.readFileSync(cache, "utf8"));
}
`, { mode: 0o755 });
    process.env.OMP_WEB_OMP_BIN = bin;
    await writeFile(data, usage(0.1));
    await writeFile(failOnce, "");
    const automatic = getProviderUsage();
    const manual = getProviderUsage({}, true);
    await Promise.all([
      assert.rejects(automatic),
      manual.then((report) => assert.equal(report.reports[0].fiveHour.percent, 10, "manual refresh must recover after an overlapping automatic fetch fails")),
    ]);
    await writeFile(data, usage(0.8));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 10);
    assert.equal((await getProviderUsage({}, true)).reports[0].fiveHour.percent, 80);
    await writeFile(data, usage(0.4));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 80);
  } finally {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseProviderUsageOutput keeps Anthropic's Fable tier separate from the shared row (#284)", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "anthropic",
      metadata: { email: "user@example.com" },
      limits: [
        { scope: { windowId: "5h" }, amount: { usedFraction: 0.5 }, window: { resetsAt: now + 60_000 } },
        { scope: { windowId: "7d" }, amount: { usedFraction: 0.4 }, window: { resetsAt: now + 3_600_000 } },
        { scope: { windowId: "7d", tier: "fable" }, amount: { usedFraction: 0.77 }, window: { resetsAt: now + 3_600_000 } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].tier, undefined);
  assert.equal(reports[0].bucket, undefined);
  assert.equal(reports[0].fiveHour.percent, 50);
  assert.equal(reports[0].sevenDay.percent, 40);
  assert.equal(reports[1].tier, "fable");
  assert.equal(reports[1].sevenDay.percent, 77);
  assert.equal(reports[1].fiveHour, undefined);
});

test("parseProviderUsageOutput keeps Antigravity's Gemini and shared Claude & GPT buckets separate (#284)", () => {
  const now = 1_000_000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:weekly", label: "Gemini", scope: { windowId: "weekly" }, amount: { usedFraction: 0.8 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        // omp duplicates the shared third-party bucket into anthropic/openai
        // counter ids; it is still one bucket, not two.
        { id: "google-antigravity:anthropic:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        { id: "google-antigravity:openai:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[0].sevenDay.percent, 80);
  assert.equal(reports[1].bucket, "Claude & GPT (shared)");
  assert.equal(reports[1].sevenDay.percent, 35);
});

test("model-filtered Antigravity queries keep both buckets, not just the first (#284, CodeRabbit)", () => {
  const now = 1_000_000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:weekly", label: "Gemini", scope: { windowId: "weekly" }, amount: { usedFraction: 0.8 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
        { id: "google-antigravity:anthropic:default:weekly", label: "Claude & GPT (shared)", scope: { windowId: "weekly", shared: true }, amount: { usedFraction: 0.35 }, window: { durationMs: weekMs, resetsAt: now + weekMs } },
      ],
    }],
  });

  // Neither limit carries a scoped modelId, so both survive the model
  // filter — and both buckets must survive selection, not just Gemini.
  const { reports } = parseProviderUsageOutput(output, { modelId: "some-model" }, now);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[1].bucket, "Claude & GPT (shared)");
});

test("parseProviderUsageOutput reads Antigravity buckets from Usage (...) labels and id counters (#284)", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "google-antigravity",
      limits: [
        { id: "google-antigravity:google:default:7d", label: "Usage (Google)", scope: { windowId: "7d" }, amount: { usedFraction: 0.6 }, window: { resetsAt: now + 3_600_000 } },
        { id: "google-antigravity:anthropic:default:7d", label: "Usage (Anthropic)", scope: { windowId: "7d" }, amount: { usedFraction: 0.2 }, window: { resetsAt: now + 3_600_000 } },
        { id: "google-antigravity:google:default:5h", scope: { windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
      ],
    }],
  });

  const { reports } = parseProviderUsageOutput(output, {}, now);
  // The unlabelled id-counter limit joins the Gemini bucket's 7d report
  // (same bucket, different window), it does not invent a third bucket.
  // "Usage (Google)" is unified to "Gemini", the quota-summary name for
  // the same counter.
  assert.equal(reports.length, 2);
  assert.equal(reports[0].bucket, "Gemini");
  assert.equal(reports[0].sevenDay.percent, 60);
  assert.equal(reports[0].fiveHour.percent, 10);
  assert.equal(reports[1].bucket, "Anthropic");
  assert.equal(reports[1].sevenDay.percent, 20);
});
