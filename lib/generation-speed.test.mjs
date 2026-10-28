import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./generation-speed.ts");
}

/** usage with the fields the metric reads; cost is irrelevant here. */
function usage(output) {
  return { input: 0, output, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistant(fields) {
  return { role: "assistant", content: [{ type: "text", text: "x" }], model: "m", provider: "p", ...fields };
}

function assertRate(actual, expected, tolerance = 0.02) {
  assert.ok(actual, `expected a rate, got ${actual}`);
  assert.ok(Math.abs(actual.tokensPerSecond - expected) <= tolerance, `${actual.tokensPerSecond} != ${expected}`);
}

test("computes the rate from duration minus ttft for real omp samples", async () => {
  const { messageSpeed } = await loadSubject();

  // Sample A from a real session: usage.output=7751, duration=197638.7748, ttft=2707.7157
  assertRate(messageSpeed(assistant({ usage: usage(7751), duration: 197638.7748, ttft: 2707.7157 })), 39.76);
  // Sample B: output=526, duration=17799.3082, ttft=6500.3954
  assertRate(messageSpeed(assistant({ usage: usage(526), duration: 17799.3082, ttft: 6500.3954 })), 46.55);
  // Sample C: output=17130, duration=386090.2889, ttft=4398.5871
  assertRate(messageSpeed(assistant({ usage: usage(17130), duration: 386090.2889, ttft: 4398.5871 })), 44.88);
});

test("falls back to the whole duration when ttft is missing", async () => {
  const { messageSpeed } = await loadSubject();
  assertRate(messageSpeed(assistant({ usage: usage(7751), duration: 197638.7748 })), 39.22);
});

test("falls back to completedAt - timestamp when the provider reports no duration", async () => {
  const { messageSpeed } = await loadSubject();
  const speed = messageSpeed(assistant({ usage: usage(100), completedAt: 12_000, timestamp: 10_000 }));
  assert.equal(speed.tokensPerSecond, 50);
  assert.equal(speed.spanMs, 2000);
  assert.equal(speed.outputTokens, 100);
});

test("suppresses artefacts: tiny output, sub-100 ms spans, errors and missing data", async () => {
  const { messageSpeed } = await loadSubject();
  // Real 4-token answer whose provider reported 0.95 ms of generation.
  assert.equal(messageSpeed(assistant({ usage: usage(4), duration: 1155.4055, ttft: 1154.4604 })), null);
  assert.equal(messageSpeed(assistant({ usage: usage(0), duration: 1000, ttft: 0 })), null);
  assert.equal(messageSpeed(assistant({ usage: usage(100), duration: 1000, ttft: 950 })), null);
  assert.equal(messageSpeed(assistant({ usage: usage(100), stopReason: "error", duration: 1000, ttft: 0 })), null);
  assert.equal(messageSpeed(assistant({ duration: 1000, ttft: 0 })), null);
  assert.equal(messageSpeed(assistant({ usage: usage(100) })), null);
  assert.equal(messageSpeed(assistant({ usage: usage(100), timestamp: 10_000 })), null);
  // An inverted ttft (>= duration) is ignored, not subtracted.
  assertRate(messageSpeed(assistant({ usage: usage(100), duration: 1000, ttft: 1500 })), 100);
});

test("estimates streamed tokens from text and thinking, ignoring tool-call JSON", async () => {
  const { estimateStreamTokens } = await loadSubject();
  const ascii = "a".repeat(400);
  assert.equal(estimateStreamTokens({ role: "assistant", content: [{ type: "text", text: ascii }] }), 100);
  const cjk = "漢".repeat(10);
  assert.equal(estimateStreamTokens({ role: "assistant", content: [{ type: "text", text: cjk }] }), 10);
  assert.equal(estimateStreamTokens({
    role: "assistant",
    content: [
      { type: "text", text: ascii },
      { type: "thinking", thinking: cjk },
      { type: "toolCall", toolCallId: "t", toolName: "read", input: { path: "a".repeat(4000) } },
    ],
  }), 110);
  assert.equal(estimateStreamTokens({ role: "user", content: ascii }), 0);
  assert.equal(estimateStreamTokens({ role: "assistant", content: "plain string" }), 0);
  assert.equal(estimateStreamTokens(null), 0);
  assert.equal(estimateStreamTokens(undefined), 0);
});

test("tracker measures deltas over the window once span and token floor are met", async () => {
  const { StreamRateTracker } = await loadSubject();
  const tracker = new StreamRateTracker();
  tracker.observe(100, 0);
  tracker.observe(300, 2000);
  assert.equal(tracker.rate(2000), 100);
});

test("tracker returns null while the span or the token delta is too small", async () => {
  const { StreamRateTracker } = await loadSubject();
  const tiny = new StreamRateTracker();
  tiny.observe(100, 0);
  tiny.observe(105, 100);
  assert.equal(tiny.rate(100), null);

  const short = new StreamRateTracker();
  short.observe(100, 0);
  short.observe(400, 500);
  assert.equal(short.rate(500), null);
});

test("tracker ages out a stalled stream and restarts on a shrinking count", async () => {
  const { StreamRateTracker } = await loadSubject();
  const tracker = new StreamRateTracker();
  tracker.observe(100, 0);
  tracker.observe(300, 2000);
  assert.equal(tracker.rate(8000), null);

  const restarted = new StreamRateTracker();
  restarted.observe(300, 0);
  restarted.observe(50, 1000);
  restarted.observe(250, 3000);
  // New baseline 50 at 1000 ms: 200 tokens over 2 s.
  assert.equal(restarted.rate(3000), 100);

  restarted.reset();
  assert.equal(restarted.rate(3000), null);
});

test("tracker ignores samples that arrive out of order", async () => {
  const { StreamRateTracker } = await loadSubject();
  const tracker = new StreamRateTracker();
  tracker.observe(100, 2000);
  tracker.observe(400, 4000);
  tracker.observe(150, 3000); // clock went backwards: ignored, not a shrink
  assert.equal(tracker.rate(4000), 150);
});

test("tracker counts only the window, so an early burst cannot inflate the rate", async () => {
  const { StreamRateTracker } = await loadSubject();
  // 1000 tokens land in the first second, then a steady 100 tokens/s.
  const rolling = new StreamRateTracker();
  rolling.observe(100, 0);
  rolling.observe(1000, 1000);
  for (let second = 2; second <= 10; second += 1) rolling.observe(1000 + (second - 1) * 100, second * 1000);
  assert.equal(rolling.rate(10_000), 100);
});
