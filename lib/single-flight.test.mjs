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
  assert.equal(first, second, "the second caller joins the first run");
  await Promise.resolve(); // the runner starts once the slot is recorded
  assert.equal(runs, 1);

  gate.resolve("report");
  assert.equal(await first, "report");
  assert.equal(await second, "report");
  assert.equal(flights.size, 0, "the slot is released once the run settles");
});

test("a settled run is not reused", async () => {
  const flights = new Map();
  let runs = 0;
  const run = async () => ++runs;

  assert.equal(await runSingleFlight(flights, "k", run), 1);
  assert.equal(await runSingleFlight(flights, "k", run), 2);
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
  assert.notEqual(first, second);
  await Promise.resolve(); // the runners start once their slots are recorded
  assert.equal(runs, 2);

  a.resolve("a");
  b.resolve("b");
  assert.equal(await first, "a");
  assert.equal(await second, "b");
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
  await assert.rejects(first, /scan failed/);
  assert.equal(flights.size, 0);

  const retry = runSingleFlight(flights, "k", async () => {
    runs++;
    return "ok";
  });
  assert.equal(await retry, "ok");
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
  await assert.rejects(first, /sync failure/);
  assert.equal(flights.size, 0, "the failed flight must not stay cached");

  const retry = runSingleFlight(flights, "k", async () => {
    runs++;
    return "ok";
  });
  assert.notEqual(retry, first, "the next caller starts a fresh run");
  assert.equal(await retry, "ok");
  assert.equal(runs, 2);
});

test("a settling run deletes only its own entry", async () => {
  const flights = new Map();
  const gate = deferred();
  const first = runSingleFlight(flights, "k", () => gate.promise);
  const replacement = Promise.resolve("replacement");
  flights.set("k", replacement);
  gate.resolve("first");
  assert.equal(await first, "first");
  assert.equal(flights.get("k"), replacement, "a successor's slot survives the earlier run settling");
});
