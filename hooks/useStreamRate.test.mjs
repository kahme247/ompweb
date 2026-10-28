import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useStreamRate } = await jiti.import("./useStreamRate.ts");

afterEach(cleanup);

function streamed(chars) {
  return { role: "assistant", timestamp: 1, content: [{ type: "text", text: "a".repeat(chars) }] };
}

/** Deterministic clock: the hook reads Date.now() for its sample timestamps;
 * only the 500 ms publication timer needs real time. */
function useClock(start = 0) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance(ms) { now += ms; },
    restore() { Date.now = realNow; },
  };
}

async function waitForTick() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 560)); });
}

test("publishes a positive rate from streamed text deltas", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    assert.equal(result.current, null, "span and delta floors are not met yet");
    await waitForTick();
    // 100 tokens over 800 ms.
    assert.equal(result.current, 125);
  } finally {
    clock.restore();
  }
});

test("returns null and resets when the stream ends", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    assert.equal(result.current, 125);

    rerender({ message: streamed(800), streaming: false });
    assert.equal(result.current, null);

    // The tracker was reset: the held snapshot is a fresh baseline, so the
    // previous measurement cannot leak into the next stream.
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    assert.equal(result.current, null);
  } finally {
    clock.restore();
  }
});

test("publishes the rate quantized to the one decimal the UI prints", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(750);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    // 100 tokens over 750 ms = 133.3333…; the badge and the footer print one
    // decimal, so the published value must already be that number.
    assert.equal(result.current, 133.3);
  } finally {
    clock.restore();
  }
});

test("ignores non-assistant snapshots mid-stream", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    assert.equal(result.current, 125);

    // An advisor/custom message can appear while the assistant still streams;
    // adopting it would restart the baseline and drop the reading.
    clock.advance(400);
    rerender({
      message: { role: "custom", customType: "advisor", content: "note", display: true, timestamp: 2 },
      streaming: true,
    });
    await waitForTick();
    assert.equal(result.current, 125);
  } finally {
    clock.restore();
  }
});

test("starts a new measurement for a different assistant message", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    assert.equal(result.current, 125);

    // Next message of the same turn: new timestamp, new baseline, no reading
    // from the old delta yet.
    clock.advance(800);
    rerender({ message: { ...streamed(400), timestamp: 2 }, streaming: true });
    await waitForTick();
    assert.equal(result.current, null);
  } finally {
    clock.restore();
  }
});

test("drops the previous message's number the moment the next one starts", async () => {
  const clock = useClock();
  try {
    const { result, rerender } = renderHook(
      ({ message, streaming }) => useStreamRate(message, streaming),
      { initialProps: { message: streamed(400), streaming: true } },
    );
    clock.advance(800);
    rerender({ message: streamed(800), streaming: true });
    await waitForTick();
    assert.equal(result.current, 125);

    // A new assistant message (tool round-trip) can follow without a
    // `streaming=false` frame in between; the old number must not stay on
    // screen until the next publication tick.
    clock.advance(800);
    rerender({ message: { ...streamed(400), timestamp: 2 }, streaming: true });
    assert.equal(result.current, null);
  } finally {
    clock.restore();
  }
});
