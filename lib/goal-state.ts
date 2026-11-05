/**
 * Defensive readers for omp's goal payloads.
 *
 * `get_state.goal`, the `goal` command response and `goal_updated` events use
 * three slightly different shapes (the command may answer `state: null` while
 * the event still carries a `dropped` goal). Never hand an untrusted payload
 * straight to the banner.
 */

import type { Goal, GoalCommandResponse, GoalModeState, GoalStatus } from "./pi-types";
import { asNumber, asString, isRecord } from "./type-guards";

function readGoal(value: unknown): Goal | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const objective = asString(value.objective)?.trim();
  if (!id || !objective) return null;
  return {
    id,
    objective,
    status: (asString(value.status) ?? "unknown") as GoalStatus,
    tokensUsed: Math.max(0, asNumber(value.tokensUsed) ?? 0),
    timeUsedSeconds: Math.max(0, asNumber(value.timeUsedSeconds) ?? 0),
    createdAt: Math.max(0, asNumber(value.createdAt) ?? 0),
    updatedAt: Math.max(0, asNumber(value.updatedAt) ?? 0),
  };
}

/** A state without its envelope (older/partial payloads) is synthesized from the goal itself. */
function stateFromGoal(goal: Goal | null): GoalModeState | null {
  if (!goal) return null;
  return { enabled: goal.status === "active", mode: goal.status, goal };
}

export function readGoalModeState(value: unknown): GoalModeState | null {
  if (!isRecord(value)) return null;
  const goal = readGoal(value.goal);
  // A present-but-malformed goal is not "no goal": refuse the snapshot.
  if (value.goal != null && !goal) return null;
  const enabled = value.enabled;
  const mode = asString(value.mode);
  if (typeof enabled !== "boolean" || mode === undefined) return stateFromGoal(goal);
  return { enabled, mode, goal };
}

/**
 * `goal_updated` event: prefer the full state, fall back to the bare goal.
 * `undefined` means the payload is malformed and must not clear a displayed
 * goal; `null` is a valid clear (`goal: null`).
 */
export function readGoalUpdatedEvent(value: unknown): GoalModeState | null | undefined {
  if (!isRecord(value)) return undefined;
  const hasGoal = "goal" in value;
  const hasState = "state" in value;
  if (!hasGoal && !hasState) return undefined;

  if (value.state != null) {
    const state = readGoalModeState(value.state);
    if (state) return state;
    // A malformed state is only recoverable from a valid bare goal.
    if (!hasGoal || value.goal == null) return undefined;
  }

  if (value.goal === null) return null;
  return stateFromGoal(readGoal(value.goal)) ?? undefined;
}

export function readGoalCommandResponse(value: unknown): GoalCommandResponse | null {
  if (!isRecord(value)) return null;
  if (!("goal" in value) && !("state" in value)) return null;
  const state = readGoalModeState(value.state);
  const goal = readGoal(value.goal);
  if (value.goal != null && !goal) return null;
  if (value.state != null && !state) return null;
  if (goal && state && state.goal?.id !== goal.id) return null;
  if (state || goal) return { goal: goal ?? state?.goal ?? null, state: state ?? stateFromGoal(goal) };
  // Both null is a valid "no goal" answer (drop/get).
  return { goal: null, state: null };
}

/** True while the goal exists; completed/dropped are terminal and drop off when omp sends null. */
export function hasGoal(state: GoalModeState | null | undefined): boolean {
  return Boolean(state?.goal);
}

export function isGoalControllable(state: GoalModeState | null | undefined): boolean {
  return state?.goal?.status === "active" || state?.goal?.status === "paused";
}

/** omp reports `timeUsedSeconds`; while active, extrapolate from `updatedAt` for a live display. */
export function goalElapsedSeconds(state: GoalModeState | null | undefined, now = Date.now()): number {
  const goal = state?.goal;
  if (!goal) return 0;
  if (goal.status !== "active" || goal.updatedAt <= 0) return goal.timeUsedSeconds;
  return goal.timeUsedSeconds + Math.max(0, (now - goal.updatedAt) / 1000);
}

export function formatGoalDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${secs}s`;
}

/** Keep an already-displayed goal when a slower response carries an older snapshot. */
export function isStaleGoalState(
  current: GoalModeState | null,
  incoming: GoalModeState | null,
): boolean {
  if (!current?.goal || !incoming?.goal) return false;
  return incoming.goal.updatedAt < current.goal.updatedAt;
}
