import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { MAX_SESSION_PINS, parseSessionPins, withSessionPinned } from "./session-pins";

// Pinned sessions on disk: ~/.omp/agent/omp-web/session-pins.json, shared by
// every browser and device (and every omp-web instance on the agent dir).
// Session files belong to omp, so pins live beside them rather than in them.
// Written atomically (temp file + rename), like the project registry.

export class SessionPinLimitError extends Error {
  code = "session_pin_limit";
  constructor() {
    super(`At most ${MAX_SESSION_PINS} sessions can be pinned`);
    this.name = "SessionPinLimitError";
  }
}

function pinsPath(): string {
  return resolve(getAgentDir(), "omp-web", "session-pins.json");
}

/** Pinned session ids in sidebar order; unreadable files yield none. */
export function loadSessionPins(): string[] {
  const path = pinsPath();
  if (!existsSync(path)) return [];
  try {
    return parseSessionPins(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function saveSessionPins(pins: readonly string[]): void {
  const path = pinsPath();
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, pins }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Pin or unpin one session. `exists` lets a pin that would exceed the limit
 *  first drop pins whose session is gone (deleted outside omp-web, e.g. with
 *  the omp CLI), so stale entries never block a new pin. */
export function setSessionPinned(id: string, pinned: boolean, exists?: (pin: string) => boolean): void {
  const current = loadSessionPins();
  let next = withSessionPinned(current, id, pinned);
  if (next === current) return;
  if (next.length > MAX_SESSION_PINS && exists) next = next.filter(exists);
  if (next.length > MAX_SESSION_PINS) throw new SessionPinLimitError();
  saveSessionPins(next);
}

/** Drop pins for sessions that were deleted or archived. Best effort: a pin
 *  file failure must never fail the deletion that triggered it. */
export function forgetSessionPins(ids: Iterable<string | undefined>): void {
  try {
    let pins: readonly string[] = loadSessionPins();
    const before = pins;
    for (const id of ids) if (id) pins = withSessionPinned(pins, id, false);
    if (pins !== before) saveSessionPins(pins);
  } catch {
    // A stale pin is harmless: the sidebar skips pins with no session.
  }
}
