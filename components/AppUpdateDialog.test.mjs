import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppUpdateDialog } from "./AppUpdateDialog";

const host = (overrides = {}) => ({
  id: "box", label: "Box", currentVersion: "0.7.0", protocolVersion: 12, targetVersion: "0.8.0", needsUpgrade: true,
  recovery: "maintenance", sessionProcesses: 0, activeTurns: 0, blockedReason: null, stage: "pending", ...overrides,
});
const makePlan = (overrides = {}) => ({
  id: "plan-1", fromVersion: "0.7.0", targetVersion: "0.8.0", compatibility: { min: 12, max: 13 },
  hosts: [host()], requiresForce: false, blockedReason: null,
  preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  state: "prepared", ...overrides,
});
const update = { currentVersion: "0.7.0", availableVersion: "0.8.0", updateAvailable: false, selfUpdateSupported: true, installMethod: "binary" };

/** Render the real dialog; every callback is recorded so tests can prove what was (not) sent. */
async function renderDialog(t, props) {
  const calls = { proceed: [], refresh: 0, notNow: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const render = async (next) => act(async () => {
    root.render(createElement(AppUpdateDialog, {
      open: true, update, phase: "idle", error: null, plan: null, planStatus: "ready",
      onRefreshPlan: () => { calls.refresh += 1; },
      onCheckStatus: () => { calls.check = (calls.check ?? 0) + 1; },
      onProceed: (approval) => { calls.proceed.push(approval); },
      onNotNow: () => { calls.notNow += 1; },
      ...next,
    }));
  });
  await render(props);
  return { calls, render };
}

const button = (label) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label);
const checkbox = () => document.querySelector('input[type="checkbox"]');

test("no approval is possible while the plan is still being prepared", async (t) => {
  const { calls } = await renderDialog(t, { plan: null, planStatus: "loading" });
  const proceed = button("Update and restart");
  assert.ok(proceed.disabled);
  act(() => proceed.click());
  assert.deepEqual(calls.proceed, []);
  assert.ok(document.body.textContent.includes("Checking the release and connected hosts"));
});

test("the plan, transitions, sessions and blockers are shown before anything is approved", async (t) => {
  const { calls } = await renderDialog(t, {
    plan: makePlan({
      hosts: [
        host({ id: "local", label: "Local", recovery: "shared-local", sessionProcesses: 2, activeTurns: 1 }),
        host({ id: "far", label: "Far", needsUpgrade: false, targetVersion: null, blockedReason: "Host is offline", stage: "unchanged" }),
      ],
    }),
  });
  const text = document.body.textContent;
  assert.match(text, /v0\.7\.0 → v0\.8\.0/);
  assert.match(text, /Local/);
  assert.match(text, /Local host, replaced together with the server/);
  assert.match(text, /Sessions: 2 · Active turns: 1/);
  assert.match(text, /Blocked: Host is offline/);
  assert.match(text, /Supported host protocol: 12–13/);
  assert.deepEqual(calls.proceed, [], "rendering a plan must not approve it");
});

test("an ordinary plan is approved with its own id and force:false", async (t) => {
  const { calls } = await renderDialog(t, { plan: makePlan() });
  assert.equal(checkbox(), null, "an ordinary plan offers no force option");
  act(() => button("Update and restart").click());
  assert.deepEqual(calls.proceed, [{ planId: "plan-1", force: false }]);
});

test("a plan requiring force stays disabled until the termination is explicitly confirmed", async (t) => {
  const { calls } = await renderDialog(t, { plan: makePlan({ requiresForce: true, hosts: [host({ sessionProcesses: 3, activeTurns: 2 })] }) });
  const proceed = button("Force update and restart");
  assert.ok(proceed, "the forced action is distinctly labelled");
  assert.equal(button("Update and restart"), undefined);
  assert.equal(checkbox().checked, false, "force starts unchecked");
  assert.ok(proceed.disabled);
  act(() => proceed.click());
  assert.deepEqual(calls.proceed, []);

  act(() => checkbox().click());
  assert.equal(checkbox().checked, true);
  assert.equal(button("Force update and restart").disabled, false);
  act(() => checkbox().click());
  assert.ok(button("Force update and restart").disabled, "unchecking withdraws the confirmation");

  act(() => checkbox().click());
  act(() => button("Force update and restart").click());
  assert.deepEqual(calls.proceed, [{ planId: "plan-1", force: true }]);
});

test("a confirmation given to one plan never carries over to a refreshed plan", async (t) => {
  const { render } = await renderDialog(t, { plan: makePlan({ requiresForce: true }) });
  act(() => checkbox().click());
  assert.equal(button("Force update and restart").disabled, false);
  await render({ plan: makePlan({ id: "plan-2", requiresForce: true }) });
  assert.equal(checkbox().checked, false);
  assert.ok(button("Force update and restart").disabled);
});

test("a blocked plan cannot be approved, even by checking force", async (t) => {
  const { calls } = await renderDialog(t, { plan: makePlan({ requiresForce: true, blockedReason: "Host Far has no recovery path" }) });
  assert.ok(document.body.textContent.includes("Host Far has no recovery path"));
  assert.ok(checkbox().disabled);
  assert.ok(button("Force update and restart").disabled);
  act(() => button("Force update and restart").click());
  assert.deepEqual(calls.proceed, []);
});

test("an expired plan must be refreshed and cannot be approved", async (t) => {
  const { calls } = await renderDialog(t, { plan: makePlan({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
  assert.ok(button("Update and restart").disabled);
  act(() => button("Update and restart").click());
  assert.deepEqual(calls.proceed, []);
  act(() => button("Refresh plan").click());
  assert.equal(calls.refresh, 1);
});

test("a failed plan preparation reports the error and offers a retry, never an approval", async (t) => {
  const { calls } = await renderDialog(t, { plan: null, planStatus: "failed", error: "Release digest mismatch" });
  assert.ok(document.body.textContent.includes("Release digest mismatch"));
  assert.ok(button("Update and restart").disabled);
  act(() => button("Retry").click());
  assert.equal(calls.refresh, 1);
  assert.deepEqual(calls.proceed, []);
});

test("after a failed update Retry asks for a fresh plan and reports partial host recovery", async (t) => {
  const failing = makePlan({
    state: "recovery-required",
    hosts: [host({ stage: "failed", error: "Host did not reconnect" }), host({ id: "ok", label: "Ok", stage: "ready" })],
  });
  const { calls } = await renderDialog(t, { phase: "failed", error: "Update failed", plan: failing, update: { ...update, upgradePlan: failing } });
  const text = document.body.textContent;
  assert.match(text, /Host did not reconnect/);
  assert.match(text, /partially updated/);
  act(() => button("Retry").click());
  assert.equal(calls.refresh, 1);
  assert.deepEqual(calls.proceed, [], "Retry must not re-approve");
});

test("the update progress lists each host's durable stage", async (t) => {
  const live = makePlan({ state: "updating-hosts", hosts: [host({ stage: "updating" }), host({ id: "ok", label: "Ok", stage: "ready" })] });
  await renderDialog(t, { phase: "restarting", plan: makePlan(), update: { ...update, upgradePlan: live } });
  const text = document.body.textContent;
  assert.match(text, /BoxUpdating/);
  assert.match(text, /OkUpdated/);
});

test("a stalled update says it may still be running, offers a status check and no retry, approval or failure", async (t) => {
  const live = makePlan({ state: "updating-hosts", hosts: [host({ stage: "updating" })] });
  const { calls } = await renderDialog(t, { phase: "stalled", visibleStage: "installing", plan: live, update: { ...update, upgradePlan: live } });
  const text = document.body.textContent;
  assert.match(text, /may still be running/);
  assert.doesNotMatch(text, /update failed/i);
  assert.equal(button("Retry"), undefined, "a stalled update is never retried or re-approved");
  assert.equal(button("Update and restart"), undefined);
  assert.equal(button("Force update and restart"), undefined);
  act(() => button("Check status").click());
  assert.equal(calls.check, 1);
  assert.deepEqual(calls.proceed, []);
  assert.equal(calls.refresh, 0);
  act(() => button("Close").click());
  assert.equal(calls.notNow, 1, "a stalled dialog can be closed; the update keeps running server-side");
});
