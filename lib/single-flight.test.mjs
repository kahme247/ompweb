import assert from "node:assert/strict";
import test from "node:test";

const { runSingleFlight } = await import("./single-flight.ts");

const deferred = () => Promise.withResolvers();

test("concurrent callers for one key share a single run", async () => {
  const flights = new Map();
  const gate = deferred();
  let runs = 0;
  const run = () => {
    runs++;
    return gate.promise;
  };

  const first = runSingleFlight(flights, "k", run);
  const second = runSingleFlight(flights, "k", run);
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  await Promise.resolve(); // the runner starts once the slot is recorded
  assert.equal(runs, 1);

  gate.resolve("report");
  assert.equal(await first.promise, "report");
  assert.equal(await second.promise, "report");
  assert.equal(flights.size, 0, "the slot is released once the run settles");
});

test("a settled run is not reused", async () => {
  const flights = new Map();
  let runs = 0;
  const run = async () => ++runs;

  assert.equal(await runSingleFlight(flights, "k", run).promise, 1);
  assert.equal(await runSingleFlight(flights, "k", run).promise, 2);
  assert.equal(runs, 2);
});

test("different keys run independently", async () => {
  const flights = new Map();
  const a = deferred();
  const b = deferred();
  let runs = 0;

  const first = runSingleFlight(flights, "a", () => {
    runs++;
    return a.promise;
  });
  const second = runSingleFlight(flights, "b", () => {
    runs++;
    return b.promise;
  });
  assert.equal(first.shared, false);
  assert.equal(second.shared, false);
  await Promise.resolve(); // the runners start once their slots are recorded
  assert.equal(runs, 2);

  a.resolve("a");
  b.resolve("b");
  assert.equal(await first.promise, "a");
  assert.equal(await second.promise, "b");
});

test("a failed run releases the slot and the next call retries", async () => {
  const flights = new Map();
  const failure = new Error("scan failed");
  const gate = deferred();
  let runs = 0;

  const first = runSingleFlight(flights, "k", () => {
    runs++;
    return gate.promise;
  });
  gate.reject(failure);
  await assert.rejects(first.promise, /scan failed/);
  assert.equal(flights.size, 0);

  const retry = runSingleFlight(flights, "k", async () => {
    runs++;
    return "ok";
  });
  assert.equal(await retry.promise, "ok");
  assert.equal(runs, 2);
});

test("a runner that throws synchronously releases the slot instead of poisoning it", async () => {
  const flights = new Map();
  const failure = new Error("sync failure");
  let runs = 0;

  const first = runSingleFlight(flights, "k", () => {
    runs++;
    throw failure;
  });
  assert.equal(flights.size, 1, "the slot is held before the runner executes");
  assert.equal(first.shared, false);
  await assert.rejects(first.promise, /sync failure/);
  assert.equal(flights.size, 0, "the failed flight must not stay cached");

  const retry = runSingleFlight(flights, "k", async () => {
    runs++;
    return "ok";
  });
  assert.equal(retry.shared, false, "the next caller starts a fresh run");
  assert.equal(await retry.promise, "ok");
  assert.equal(runs, 2);
});

test("a settling run deletes only its own entry", async () => {
  const flights = new Map();
  const gate = deferred();
  const first = runSingleFlight(flights, "k", () => gate.promise);
  const replacement = Promise.resolve("replacement");
  flights.set("k", replacement);
  gate.resolve("first");
  assert.equal(await first.promise, "first");
  assert.equal(flights.get("k"), replacement, "a successor's slot survives the earlier run settling");
});
