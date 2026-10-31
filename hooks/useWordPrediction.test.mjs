import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

// Drives the composer's ghost-text controller with a fake omp: the ghost a
// user would see (peek) and the feedback omp would learn from.

const { useWordPrediction } = await import("../hooks/useWordPrediction.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (ms = 120) => act(() => sleep(ms));

function fakeOmp(answer) {
  const calls = [];
  const feedback = [];
  return {
    calls,
    feedback,
    predict: (text, cursor) => {
      calls.push([text, cursor]);
      return answer(text, cursor);
    },
    onFeedback: (...args) => feedback.push(args),
  };
}

function render(omp) {
  return renderHook(() => useWordPrediction(omp.predict, omp.onFeedback)).result.current;
}

function type(prediction, text) {
  act(() => prediction.update(text, text.length, text.length));
}

afterEach(cleanup);

test("shows the answer for the latest draft and drops a slower stale answer", async () => {
  const slow = Promise.withResolvers();
  const omp = fakeOmp((text) => (text === "the we" ? slow.promise : Promise.resolve("ather")));
  const prediction = render(omp);

  type(prediction, "the we");
  await settle();
  type(prediction, "the weathe");
  // No ghost to carry forward yet: a fresh answer is needed.
  assert.equal(prediction.peek(), null);
  await settle();
  assert.deepEqual(prediction.peek(), { text: "the weathe", cursor: 10, suffix: "ather" });

  await act(async () => slow.resolve("ek"));
  assert.equal(prediction.peek().suffix, "ather", "the stale answer for 'the we' must not replace it");
});

test("typing through keeps the ghost, typing past reports one rejection", async () => {
  const omp = fakeOmp((text) => Promise.resolve(text === "the weath" ? "er" : null));
  const prediction = render(omp);

  type(prediction, "the weath");
  await settle();
  type(prediction, "the weathe");
  await settle();
  assert.equal(prediction.peek()?.suffix, "r", "a null re-answer keeps the carried ghost");

  type(prediction, "the weathex");
  assert.equal(prediction.peek(), null);
  assert.deepEqual(omp.feedback, [["the weathe", 10, "r", false]]);
});

test("take hands over the ghost once and reports the accept", async () => {
  const omp = fakeOmp(() => Promise.resolve("er"));
  const prediction = render(omp);
  type(prediction, "the weath");
  await settle();

  let taken;
  act(() => {
    taken = prediction.take();
  });
  assert.deepEqual(taken, { text: "the weath", cursor: 9, suffix: "er" });
  assert.equal(prediction.peek(), null);
  assert.equal(prediction.take(), null);
  assert.deepEqual(omp.feedback, [["the weath", 9, "er", true]]);
});

test("an omp without predict_word is not asked again on every keystroke", async () => {
  const omp = fakeOmp(() => Promise.reject(new Error("Unknown command: predict_word")));
  const prediction = render(omp);
  type(prediction, "the weath");
  await settle();
  type(prediction, "the weathe");
  await settle();
  assert.equal(omp.calls.length, 1);
});

test("mid-line carets, selections, and oversized drafts never ask omp", async () => {
  const omp = fakeOmp(() => Promise.resolve("er"));
  const prediction = render(omp);
  act(() => prediction.update("the weath and more", 9, 9));
  act(() => prediction.update("the weath", 4, 9));
  type(prediction, `${"x ".repeat(10_001)}weath`);
  await settle();
  assert.deepEqual(omp.calls, []);
  assert.equal(prediction.peek(), null);
});
