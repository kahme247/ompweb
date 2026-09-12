// In-flight dedup for the agent-state reconcile poll.
//
// reconcileAgentState() is triggered from several independent sources: the
// 15s interval, visibilitychange, the `online` event, todo updates, and the
// delayed post-fork reconcile. Without a guard, a slow server response lets
// those triggers stack concurrent GET /api/agent/[id] requests; their
// responses can then arrive out of order and apply stale state to the same
// run. The guard collapses concurrent triggers to ONE in-flight request and
// reports when a trigger arrived during the flight so the caller can
// immediately re-issue once the current response lands (the drop is a
// coalesce, not a lost poll).

export interface ReconcileGuard {
  /** Try to start a reconcile. Returns an ownership token when acquired, or
   * null when one is already in flight; the caller skips the request (the
   * in-flight completion re-issues when a trigger arrived meanwhile). */
  tryAcquire(): number | null;
  /** Reconcile finished (success or network error). `token` must be the one
   * returned by tryAcquire() for THIS request. Returns true when calls tried
   * to acquire while this one was in flight — the caller SHOULD run another
   * reconcile immediately. A token from before reset()/a newer acquire is a
   * stale owner and releases nothing: an old request's finally must never
   * clear the new run's lock or eat its coalesced trigger. */
  release(token: number): boolean;
  /** Clear the in-flight marker, any coalesced trigger, and invalidate every
   * outstanding token. Call when the run/session identity changes: an old
   * run's in-flight request must not block the new run's poll, its late
   * response is dropped by the run-id fence anyway, and its release() must
   * not undo the new run's lock. */
  reset(): void;
}

export interface ReconcileGuardOptions {
  /** Auto-release the in-flight lock after this long without the request
   * settling, so a permanently stalled request (hung connection, lost
   * response) cannot block reconciliation forever: the next trigger after
   * the timeout acquires and re-issues. The stalled request's LATE
   * release() stays inert — its token no longer matches the owner. */
  timeoutMs?: number;
}

export function createReconcileGuard(options: ReconcileGuardOptions = {}): ReconcileGuard {
  const timeoutMs = options.timeoutMs;
  let inFlight = false;
  let ownerToken = 0;
  // Monotonic counter also bumped by reset(): every acquire after a reset gets
  // a token the pre-reset owner can never match, so its release() is a no-op.
  let generation = 0;
  let pendingWhileInFlight = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStallTimer = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  return {
    tryAcquire(): number | null {
      if (inFlight) {
        pendingWhileInFlight = true;
        return null;
      }
      inFlight = true;
      ownerToken = ++generation;
      pendingWhileInFlight = false;
      if (timeoutMs !== undefined) {
        clearStallTimer();
        const token = ownerToken;
        stallTimer = setTimeout(() => {
          stallTimer = null;
          // A request that never settled must not hold the lock forever.
          // Only the current owner's lock is lifted; a coalesced trigger
          // during the stall is served by the NEXT acquire, which IS the
          // re-issue (tryAcquire resets the pending flag on success).
          if (inFlight && ownerToken === token) {
            inFlight = false;
            pendingWhileInFlight = false;
          }
        }, timeoutMs);
      }
      return ownerToken;
    },
    release(token: number): boolean {
      // Only the CURRENT owner may release. An old request (stale token) can
      // never clear the new run's in-flight lock or consume its coalesced
      // trigger, and a release after reset() while nothing new acquired is
      // equally inert.
      if (!inFlight || token !== ownerToken) return false;
      clearStallTimer();
      inFlight = false;
      if (pendingWhileInFlight) {
        pendingWhileInFlight = false;
        return true;
      }
      return false;
    },
    reset(): void {
      clearStallTimer();
      inFlight = false;
      ownerToken = 0;
      pendingWhileInFlight = false;
      generation += 1;
    },
  };
}