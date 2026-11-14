import assert from "node:assert/strict";
import test from "node:test";
import {
  AppUpdateApiError,
  commitAppUpdate,
  fetchAppUpdateJson,
  isAwaitingAppUpdateApproval,
  isStaleAppUpdatePlanError,
  prepareAppUpdate,
} from "./AppShell-app-update";

const plan = { id: "plan-1", hosts: [], requiresForce: false };

/** Replace fetch for one test and record the requests it saw. */
function stubFetch(t, respond) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    return respond(requests.length - 1);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

test("preparing an update sends only a prepare request and never commits", async (t) => {
  const requests = stubFetch(t, () => Response.json({ attemptId: "attempt-1", targetVersion: "0.8.0", plan }, { status: 202 }));
  const prepared = await prepareAppUpdate();
  assert.deepEqual(prepared, { attemptId: "attempt-1", targetVersion: "0.8.0", plan });
  assert.deepEqual(requests, [{ url: "/api/app-update", method: "POST", body: { action: "prepare" } }]);
});

test("a prepare response without a plan is rejected rather than committed blind", async (t) => {
  stubFetch(t, () => Response.json({ attemptId: "attempt-1", targetVersion: "0.8.0" }, { status: 202 }));
  await assert.rejects(prepareAppUpdate(), /Invalid update response/);
});

test("a commit carries exactly the approval the user gave, naming the plan", async (t) => {
  const requests = stubFetch(t, () => Response.json({ accepted: true, attemptId: "attempt-1" }, { status: 202 }));
  await commitAppUpdate("attempt-1", { planId: "plan-1", force: true });
  assert.deepEqual(requests, [{
    url: "/api/app-update", method: "POST",
    body: { action: "commit", attemptId: "attempt-1", approval: { planId: "plan-1", force: true } },
  }]);
});

test("a refused commit surfaces its HTTP status so a changed plan is re-reviewed", async (t) => {
  stubFetch(t, () => Response.json({ error: "The upgrade plan no longer matches the connected hosts" }, { status: 409 }));
  const error = await commitAppUpdate("attempt-1", { planId: "plan-1", force: false }).catch((cause) => cause);
  assert.ok(error instanceof AppUpdateApiError);
  assert.equal(error.status, 409);
  assert.equal(isStaleAppUpdatePlanError(error), true);
});

test("only plan-mismatch statuses trigger a re-prepare; other failures stay failures", async (t) => {
  stubFetch(t, (index) => index === 0
    ? Response.json({ error: "Disk full" }, { status: 500 })
    : new Response("{}", { status: 503 }));
  const server = await fetchAppUpdateJson("/api/app-update").catch((cause) => cause);
  assert.equal(isStaleAppUpdatePlanError(server), false);
  const unavailable = await fetchAppUpdateJson("/api/app-update").catch((cause) => cause);
  assert.equal(unavailable.status, 503);
  assert.equal(isStaleAppUpdatePlanError(unavailable), false);
  assert.equal(isStaleAppUpdatePlanError(new Error("HTTP 409")), false);
});

test("a prepared attempt without a recorded approval is only a proposal", () => {
  const status = { attemptId: "attempt-1", state: "prepared", fromVersion: "0.7.0", targetVersion: "0.8.0", preparedAt: "now", stage: "preparing" };
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status, upgradePlan: plan }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: status, upgradePlan: { ...plan, approved: { force: false, at: "now" } } }), true);
  assert.equal(isAwaitingAppUpdateApproval({ selfUpdateStatus: { ...status, state: "running" } }), false);
  assert.equal(isAwaitingAppUpdateApproval(null), false);
});
