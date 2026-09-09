import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createReconcileGuard } = await jiti.import("./reconcile-guard.ts");

test("first acquire wins, concurrent acquires coalesce into one re-issue", async () => {
  const guard = createReconcileGuard();
  const first = guard.tryAcquire();
  assert.notEqual(first, null, "first trigger starts a request");
  assert.equal(guard.tryAcquire(), null, "second trigger coalesces");
  assert.equal(guard.tryAcquire(), null, "third trigger coalesces");
  // Completion: coalesced triggers must force one re-issue.
  assert.equal(guard.release(first), true, "release reports a pending trigger");
});

test("release without concurrent triggers returns false (no extra poll)", async () => {
  const guard = createReconcileGuard();
  const token = guard.tryAcquire();
  assert.equal(guard.release(token), false);
});

test("reset drops in-flight state so the next run can reconcile immediately", async () => {
  const guard = createReconcileGuard();
  guard.tryAcquire();
  // Old run's request is still in flight; identity changed (new run started).
  guard.reset();
  const token = guard.tryAcquire();
  assert.notEqual(token, null, "new run acquires despite old in-flight");
  assert.equal(guard.release(token), false, "no stale coalesced trigger");
});

test("acquire after settle works (steady-state interval)", async () => {
  const guard = createReconcileGuard();
  let token = guard.tryAcquire();
  guard.release(token);
  token = guard.tryAcquire();
  assert.notEqual(token, null);
  guard.release(token);
  token = guard.tryAcquire();
  assert.notEqual(token, null);
  guard.release(token);
});

test("a stale request cannot release the new run's lock or eat its pending trigger", async () => {
  const guard = createReconcileGuard();

  // Old run's request goes out.
  const oldToken = guard.tryAcquire();
  assert.notEqual(oldToken, null);

  // The old run ends and a new run starts while the old request is in flight.
  guard.reset();
  const newToken = guard.tryAcquire();
  assert.notEqual(newToken, null, "new run acquires after reset");

  // A trigger lands during the NEW request — it must coalesce into the new run.
  assert.equal(guard.tryAcquire(), null, "trigger during new request coalesces");

  // The OLD request finally settles and calls release() with its stale token.
  // This must be a no-op: the new run's lock survives, and the new run's
  // coalesced trigger is NOT reported to the stale owner.
  assert.equal(guard.release(oldToken), false, "stale release must not release the new run's lock");
  assert.equal(guard.tryAcquire(), null, "new run's lock still held after stale release");

  // The NEW request completes: its own release owns the lock and sees the
  // coalesced trigger, so the re-issue is delivered to the new run only.
  assert.equal(guard.release(newToken), true, "new owner release reports the coalesced trigger");

  // Lock is fully free afterwards; the next acquire works.
  const next = guard.tryAcquire();
  assert.notEqual(next, null, "subsequent acquire succeeds after both settles");
});

test("stale release must not consume a newer request's coalesced trigger", async () => {
  const guard = createReconcileGuard();

  // Run A in flight.
  const tokenA = guard.tryAcquire();
  // Run B takes over mid-flight.
  guard.reset();
  const tokenB = guard.tryAcquire();

  // Trigger coalesces onto run B's lock.
  assert.equal(guard.tryAcquire(), null);

  // Run A's finally runs with the old token: no-op.
  assert.equal(guard.release(tokenA), false);

  // Run B's request finishes: it — and only it — must see again=true so the
  // caller re-issues under the new run.
  assert.equal(guard.release(tokenB), true, "B's release carries the re-issue flag");
  assert.notEqual(tokenA, tokenB, "distinct ownership tokens per acquire");
});

test("replaying a stale release (double finally) cannot break the lock", async () => {
  const guard = createReconcileGuard();
  const token = guard.tryAcquire();
  // A duplicated release of the SAME token — second call is a no-op.
  assert.equal(guard.release(token), false);
  assert.equal(guard.release(token), false, "double release of the same token is inert");
  const next = guard.tryAcquire();
  assert.notEqual(next, null, "lock freed exactly once");
  assert.equal(guard.release(next), false);
});
// ============================================================================
// Timeout recovery: a request that never settles must not hold the lock
// forever (TODO §5 — cancel/timeout recovery).
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a stalled request auto-releases after timeoutMs so the next trigger can reconcile", async () => {
  const guard = createReconcileGuard({ timeoutMs: 25 });
  const stalled = guard.tryAcquire();
  assert.notEqual(stalled, null);

  // Triggers during the stall coalesce as usual.
  assert.equal(guard.tryAcquire(), null);

  await sleep(60); // > timeoutMs: the stall timer must have fired
  assert.notEqual(guard.tryAcquire(), null, "acquire must succeed after the stalled request timed out");
});

test("the timed-out request's late release is inert and cannot eat the new owner's trigger", async () => {
  const guard = createReconcileGuard({ timeoutMs: 25 });
  const stalled = guard.tryAcquire();
  assert.notEqual(stalled, null);

  await sleep(60); // stall timer fires; lock released by timeout

  const next = guard.tryAcquire();
  assert.notEqual(next, null);
  assert.equal(guard.tryAcquire(), null, "trigger during the new request coalesces");

  // The stalled request FINALLY settles now: with its old token this must be
  // a no-op — the new owner's lock and coalesced trigger survive.
  assert.equal(guard.release(stalled), false, "late release from a timed-out request must be inert");
  assert.equal(guard.tryAcquire(), null, "new owner's lock still held after the late stale release");
  assert.equal(guard.release(next), true, "new owner's release reports the coalesced trigger");
});

test("release before the timeout leaves no stale timer window (lock survives past the old deadline)", async () => {
  const guard = createReconcileGuard({ timeoutMs: 80 });
  const first = guard.tryAcquire();
  guard.release(first); // clears the stall timer at t~0

  // Re-acquire at t~50: past the FIRST request's original deadline (t~80
  // below) but well before this request's own (t~130). If a leaked timer
  // (or a token mismatch) ever released the new owner early, the acquire
  // below would succeed instead of coalescing.
  await sleep(50);
  const next = guard.tryAcquire();
  assert.notEqual(next, null);
  await sleep(45); // t~95: past the old deadline, before the new one
  assert.equal(guard.tryAcquire(), null, "new owner's lock must survive past the previous request's deadline");
  // The probe above coalesced a trigger, so the owner's release reports it.
  assert.equal(guard.release(next), true);
});

test("reset clears the stall timer; the lock survives past the pre-reset deadline", async () => {
  const guard = createReconcileGuard({ timeoutMs: 80 });
  const stalled = guard.tryAcquire();
  guard.reset(); // clears the stall timer at t~0

  // New generation acquires at t~50 and must still hold the lock at t~95,
  // past the pre-reset request's original deadline (t~80).
  await sleep(50);
  const next = guard.tryAcquire();
  assert.notEqual(next, null);
  await sleep(45);
  assert.equal(guard.tryAcquire(), null, "new generation's lock must survive the pre-reset deadline");
  assert.equal(guard.release(stalled), false, "stale token stays inert across reset");
  // The probe above coalesced a trigger, so the owner's release reports it.
  assert.equal(guard.release(next), true);
});

test("guards without timeoutMs keep the old semantics (no auto-release)", async () => {
  const guard = createReconcileGuard();
  const token = guard.tryAcquire();
  await sleep(60);
  assert.equal(guard.tryAcquire(), null, "without timeoutMs the in-flight lock persists");
  // The probe coalesced a trigger: the owner's release must report it.
  assert.equal(guard.release(token), true);
  assert.notEqual(guard.tryAcquire(), null, "lock freed normally after release");
});
