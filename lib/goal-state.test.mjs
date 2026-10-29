import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  formatGoalDuration,
  goalElapsedSeconds,
  isGoalControllable,
  isStaleGoalState,
  readGoalCommandResponse,
  readGoalModeState,
  readGoalUpdatedEvent,
} = await jiti.import("./goal-state.ts");

const GOAL = {
  id: "g1",
  objective: "Ship the export",
  status: "active",
  tokensUsed: 1200,
  timeUsedSeconds: 90,
  createdAt: 1000,
  updatedAt: 2000,
};

test("reads omp's goal shapes defensively", () => {
  assert.deepEqual(readGoalModeState({ enabled: true, mode: "active", goal: GOAL }), {
    enabled: true,
    mode: "active",
    goal: GOAL,
  });
  assert.deepEqual(readGoalModeState({ enabled: true, mode: "active", goal: null }), {
    enabled: true,
    mode: "active",
    goal: null,
  });
  // A present-but-malformed goal must not be mistaken for "no goal".
  assert.equal(readGoalModeState({ enabled: true, mode: "active", goal: { objective: "" } }), null);
  assert.equal(readGoalModeState("nope"), null);
});

test("goal_updated falls back to the bare goal and tolerates a dropped state", () => {
  assert.equal(readGoalUpdatedEvent({ goal: GOAL })?.goal?.objective, "Ship the export");
  assert.deepEqual(readGoalUpdatedEvent({ goal: null }), null);
  const dropped = readGoalUpdatedEvent({
    goal: { ...GOAL, status: "dropped", updatedAt: 3000 },
    state: { enabled: false, mode: "active", goal: { ...GOAL, status: "dropped", updatedAt: 3000 } },
  });
  assert.equal(dropped?.goal?.status, "dropped");
});

test("the command response accepts drop's null state and synthesizes a bare goal", () => {
  assert.deepEqual(readGoalCommandResponse({ goal: null, state: null }), { goal: null, state: null });
  const bare = readGoalCommandResponse({ goal: GOAL, state: null });
  assert.equal(bare?.state?.goal?.id, "g1");
  assert.equal(bare?.state?.enabled, true);
});

test("elapsed time extrapolates only while active and formats compactly", () => {
  const active = { enabled: true, mode: "active", goal: GOAL };
  assert.equal(goalElapsedSeconds(active, 2500), 90.5);
  assert.equal(goalElapsedSeconds({ ...active, goal: { ...GOAL, status: "paused" } }, 2500), 90);
  assert.equal(formatGoalDuration(-1), "0s");
  assert.equal(formatGoalDuration(59), "59s");
  assert.equal(formatGoalDuration(60), "1m");
  assert.equal(formatGoalDuration(3660), "1h 1m");
});

test("only active and paused goals are controllable; older snapshots lose", () => {
  assert.equal(isGoalControllable({ enabled: true, mode: "active", goal: GOAL }), true);
  assert.equal(isGoalControllable({ enabled: false, mode: "active", goal: { ...GOAL, status: "paused" } }), true);
  assert.equal(isGoalControllable({ enabled: false, mode: "active", goal: { ...GOAL, status: "completed" } }), false);
  assert.equal(isStaleGoalState(
    { enabled: true, mode: "active", goal: GOAL },
    { enabled: true, mode: "active", goal: { ...GOAL, updatedAt: 1000 } },
  ), true);
  assert.equal(isStaleGoalState(
    { enabled: true, mode: "active", goal: GOAL },
    { enabled: true, mode: "active", goal: { ...GOAL, updatedAt: 3000 } },
  ), false);
});
