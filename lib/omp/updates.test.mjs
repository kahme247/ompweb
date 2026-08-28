import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseOmpUpdateStatus, createCachedOmpUpdateCheck, OMP_UPDATE_CHECK_TTL_MS } = jiti("./updates.ts");
test("parses OMP update availability without assuming an update exists", () => {
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.11\nNew version available: 17.2.12"), {
    currentVersion: "17.2.11",
    availableVersion: "17.2.12",
    updateAvailable: true,
    updateCommand: "omp update",
  });
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.12\nOMP is up to date"), {
    currentVersion: "17.2.12",
    availableVersion: null,
    updateAvailable: false,
    updateCommand: "omp update",
  });
});

test("createCachedOmpUpdateCheck deduplicates concurrent calls and caches results within TTL", async () => {
  let runCalls = 0;
  let currentTime = 1_000_000;

  const fakeRun = async () => {
    runCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return "Current version: 17.2.11\nNew version available: 17.2.12";
  };

  const checker = createCachedOmpUpdateCheck(fakeRun, () => currentTime);

  // 1. Concurrent calls share one promise
  const [res1, res2, res3] = await Promise.all([checker(), checker(), checker()]);
  assert.equal(runCalls, 1, "Concurrent checks must only invoke run once");
  assert.equal(res1.availableVersion, "17.2.12");
  assert.equal(res2.availableVersion, "17.2.12");
  assert.equal(res3.availableVersion, "17.2.12");

  // 2. Cached within TTL
  currentTime += OMP_UPDATE_CHECK_TTL_MS - 1000;
  const resCached = await checker();
  assert.equal(runCalls, 1, "Must hit cache before TTL expiration");
  assert.equal(resCached.availableVersion, "17.2.12");

  // 3. TTL expiration causes new run
  currentTime += 2000;
  const resAfterTtl = await checker();
  assert.equal(runCalls, 2, "Must run check again after TTL expires");
  assert.equal(resAfterTtl.availableVersion, "17.2.12");

  // 4. Force bypasses completed cache
  const resForced = await checker(true);
  assert.equal(runCalls, 3, "force=true must bypass completed cache");
  assert.equal(resForced.availableVersion, "17.2.12");
});

test("createCachedOmpUpdateCheck reuses in-flight promise even when force is passed", async () => {
  let runCalls = 0;
  let resolveRun;
  const fakeRun = () => {
    runCalls += 1;
    return new Promise((resolve) => { resolveRun = resolve; });
  };

  const checker = createCachedOmpUpdateCheck(fakeRun);
  const firstPromise = checker(false);
  const secondPromise = checker(true); // force while first is still in flight

  assert.equal(runCalls, 1, "In-flight check must be reused even when force is true");
  resolveRun("Current version: 17.2.11\nOMP is up to date");
  const [res1, res2] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(res1.updateAvailable, false);
  assert.equal(res2.updateAvailable, false);
});

test("createCachedOmpUpdateCheck does not cache failures and allows retry", async () => {
  let runCalls = 0;
  let shouldFail = true;
  const fakeRun = async () => {
    runCalls += 1;
    if (shouldFail) throw new Error("Network error");
    return "Current version: 17.2.11\nNew version available: 17.2.13";
  };

  const checker = createCachedOmpUpdateCheck(fakeRun);

  await assert.rejects(checker(), /Network error/);
  assert.equal(runCalls, 1);

  shouldFail = false;
  const resRetry = await checker();
  assert.equal(runCalls, 2, "Must retry after prior failure");
  assert.equal(resRetry.availableVersion, "17.2.13");
});
