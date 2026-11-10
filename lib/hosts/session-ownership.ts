// Who holds a session's writer lease on this machine, answered where the children run.
//
// omp ≥ 18.5 lets exactly one process write a session: its lease lives in a
// named mutex / abstract socket (no file to read). A second writer does not
// fail, it silently moves the conversation to a fresh sibling file on its first
// write ("open-elsewhere"), which looked like a brand-new chat.
//
// Three facts meet only in the daemon, so this runs there:
//  1. `ChannelTable` is the authority for "ours": spawning, adopted, idle
//     between turns and mid-turn children are all its channels.
//  2. The process scan runs in the same PID namespace and as the same uid as
//     the children, so it excludes the daemon's own children exactly (transport
//     pids plus a bounded ppid-chain walk for the Windows `cmd.exe` wrapper).
//  3. The transcript tail is read on the machine that owns the file.
//
// Ownership and activity are separate answers: a live foreign `omp` owns the
// file even while it is idle between turns (`running: false`), and a fresh
// transcript without positive owner evidence is an activity hint, not proof of
// a live writer (`owner: "none"`, `running: true`, `source: "transcript"`).
// A failed or switched-off scan is `unknown`, never `none`: a caller must be
// able to tell "nobody runs it" from "could not inspect". The op never spawns,
// kills or writes, and it is not an atomic native ownership lock — a writer can
// start between this inspection and a later spawn.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { looksLikeRunningTurn } from "../chat-transcript-plan";
import { parseJsonlLenient } from "../omp/session-files";
import { resolveSessionPath } from "../session-reader";
import { isRecord } from "../type-guards";
import type { AgentMessage, SessionOwnership } from "../types";
import { LINK_LIMITS } from "./link-protocol";
import {
  isProcessAlive,
  listOmpProcesses,
  sessionIdsNamedByProcesses,
  type OmpProcessScan,
  type ProcessLivenessProbe,
} from "./omp-processes";
import type { OpResult } from "./session-ops";

/**
 * Mirror of `EXTERNAL_RUN_STALE_MS` (hooks/useAgentSession-stream.ts): a tail
 * that stopped growing for this long is not a live run any more. The hook
 * constant cannot be imported here — that module is browser-side.
 */
export const OWNERSHIP_ACTIVE_WINDOW_MS = 60_000;

const TAIL_BYTES = 64 * 1024;

export interface SessionTailState {
  /** The last record is omp's own `session_exit` (the writer closed the file). */
  hasTrailingExit: boolean;
  /** The tail looks mid-turn (tool call without result, or a running tool). */
  looksActive: boolean;
  mtimeMs: number;
  /** How many complete records the window parsed. Zero means the window is one
   *  oversized record (a multi-MiB tool result fills it), so `looksActive` is
   *  not a fact about the transcript's end. */
  records: number;
}

/** True for the records omp writes while a tool call is executing. */
const LIVE_TOOL_RECORDS: Record<string, true> = {
  tool_execution_start: true,
  tool_execution_update: true,
};

/**
 * Read the last ≤64 KiB of a session file and describe its end. Backward-safe
 * against a half-written last line (parsed leniently, skipped) and against the
 * window starting mid-line (first partial line dropped). Returns null when the
 * file cannot be read.
 */
export function readSessionTailState(filePath: string): SessionTailState | null {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    size = stat.size;
    // Integer epoch ms: mtimeMs is fractional on Windows, and a typed client
    // that decodes `Long` rejects the whole frame on a fractional value.
    mtimeMs = Math.round(stat.mtimeMs);
  } catch {
    return null;
  }
  if (size === 0) return { hasTrailingExit: false, looksActive: false, mtimeMs, records: 0 };

  const length = Math.min(TAIL_BYTES, size);
  let text: string;
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (length < size) {
    // The window starts mid-record; drop that truncated first line.
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }

  const records = parseJsonlLenient<Record<string, unknown>>(text);
  const tail = records.at(-1);
  const tailType = isRecord(tail) && typeof tail.type === "string" ? tail.type : undefined;
  const hasTrailingExit = tailType === "custom" && tail?.customType === "session_exit";

  let looksActive: boolean;
  if (hasTrailingExit) {
    looksActive = false;
  } else if (tailType === "custom" && typeof tail?.customType === "string" && LIVE_TOOL_RECORDS[tail.customType] === true) {
    // A tool is executing right now; the agent has not settled yet.
    looksActive = true;
  } else {
    // Judge by the last message in the window: a trailing tool result or an
    // assistant tool call means the turn continues.
    const messages: AgentMessage[] = [];
    for (const record of records) {
      if (!isRecord(record) || record.type !== "message") continue;
      const message: unknown = record.message;
      if (isRecord(message) && typeof message.role === "string") {
        // Parsed JSONL entry: the record shape is omp's, validated just enough
        // for `looksLikeRunningTurn` (role + content + stopReason).
        messages.push(message as unknown as AgentMessage);
      }
    }
    looksActive = messages.length > 0 && looksLikeRunningTurn(messages);
  }

  return { hasTrailingExit, looksActive, mtimeMs, records: records.length };
}

/** What this daemon's ChannelTable says about one session. */
export interface DaemonChannelState {
  /** A child of this daemon runs (or is being spawned for) the session. */
  owned: boolean;
  /** That child is mid-turn (or still starting): activity, not ownership. Absent when the channel's lifecycle is not
   *  tracked (a legacy channel), because then activity is unknown rather than idle. */
  running?: boolean;
  /** The channel's launch file, when it knows one, so `lastActivityAt` is answered for a daemon-owned session too. */
  sessionFile?: string;
}

export interface SessionOwnershipChecks {
  /** `ChannelTable.ownership`: the authority for "ours". `sessionFile` is the resolved file, for a channel that knows
   *  the session only by its launch file. */
  channel?(id: string, sessionFile?: string | null): DaemonChannelState;
  /** Pids of this daemon's children, so the foreign scan never counts them. */
  excludePids?(): readonly number[];
  /** One process snapshot for the whole batch (tests, or a caller that already scanned). */
  scan?(): Promise<OmpProcessScan>;
  /** Confirm a scan hit against the OS; defaults to `omp-processes.isProcessAlive`. */
  isAlive?: ProcessLivenessProbe;
  /** Read a session file's tail; defaults to `readSessionTailState`. A null answer means the file could not be read. */
  tail?: (file: string) => SessionTailState | null;
  now?: () => number;
}

const fail = (status: number, code: string, error: string): OpResult<never> => ({ ok: false, status, code, error });

/**
 * Answer `sessionOwnership` for a batch of ids: one entry per requested id, in
 * request order. One bounded process scan covers the whole batch; the
 * transcript tail is read only for ids whose file changed inside the activity
 * window, because a silent old file cannot contribute activity.
 */
export async function detectSessionOwnership(
  ids: string[],
  checks: SessionOwnershipChecks = {},
): Promise<OpResult<SessionOwnership[]>> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > LINK_LIMITS.ownershipIds || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    return fail(400, "invalid_request", `sessionOwnership takes a non-empty array of at most ${LINK_LIMITS.ownershipIds} session ids`);
  }
  const now = checks.now?.() ?? Date.now();
  const channels = new Map<string, DaemonChannelState>();
  const files = new Map<string, string | null>();
  const unique = [...new Set(ids)];
  await Promise.all(unique.map(async (id) => {
    // A daemon-owned session needs no list scan: its channel already knows the launch file, and `lastActivityAt` is
    // part of the contract for every owner ("when it could be read").
    const byId = checks.channel?.(id);
    if (byId?.owned) {
      channels.set(id, byId);
      files.set(id, byId.sessionFile ?? null);
      return;
    }
    // Only ids this daemon does not own need their file resolved: the scan and the tail read it.
    const file = await resolveSessionPath(id).catch(() => null);
    files.set(id, file);
    const byFile = checks.channel?.(id, file);
    if (byFile?.owned) channels.set(id, byFile);
  }));

  const scanned = channels.size === unique.length ? null : await (checks.scan?.() ?? listOmpProcesses());
  // Every requested id goes to the scan, with its file when one resolved: an
  // id whose file did not resolve (a stale list cache, a relocated file) must
  // still match a `--resume <id>` process, or a live foreign writer would be
  // reported as a definite `none` — the one answer a caller may send into.
  const named = scanned?.ok && scanned.enabled
    ? sessionIdsNamedByProcesses(
      scanned.processes,
      unique.map((id) => ({ id, ...(files.get(id) ? { sessionFile: files.get(id) ?? undefined } : {}) })),
      { excludePids: checks.excludePids?.() ?? [], isAlive: checks.isAlive ?? isProcessAlive },
    )
    : new Set<string>();

  const entries: SessionOwnership[] = [];
  for (const id of ids) {
    const channel = channels.get(id);
    const file = files.get(id) ?? null;
    let mtimeMs: number | null = null;
    try {
      const stat = file ? statSync(file) : null;
      mtimeMs = stat?.isFile() ? Math.round(stat.mtimeMs) : null;
    } catch {
      mtimeMs = null;
    }
    const lastActivityAt = mtimeMs === null ? {} : { lastActivityAt: mtimeMs };
    if (channel) {
      // The daemon's own child: spawning, adopted, idle between turns or mid-turn. `running` is activity alone, and
      // omitted when the channel cannot say.
      entries.push({
        id,
        owner: "daemon",
        source: "process",
        ...(channel.running === undefined ? {} : { running: channel.running }),
        ...lastActivityAt,
      });
      continue;
    }
    if (scanned === null || !scanned.ok || !scanned.enabled) {
      // Unsupported, failed or switched-off inspection: the caller must not
      // read this as "nobody runs it", and must not read `running: false` as a
      // fact either — activity is reported only from a successful inspection.
      entries.push({ id, owner: "unknown", ...lastActivityAt });
      continue;
    }
    // Only a file written inside the window can say anything about activity;
    // an idle owner keeps ownership regardless (see `owner` below). A file
    // that exists but cannot be read leaves activity unknown: `running` is
    // then absent instead of a `false` the inspection cannot establish.
    const readTail = checks.tail ?? readSessionTailState;
    const tail = file && mtimeMs !== null && now - mtimeMs < OWNERSHIP_ACTIVE_WINDOW_MS ? readTail(file) : null;
    // A window that parsed no complete record (one oversized tool result fills
    // it) says nothing about the transcript's end: activity is unknown, not idle.
    const tailSaysSomething = tail !== null && tail.records > 0;
    // Only a file that was read and is older than the window proves idleness.
    // With no file to read (an id that does not resolve) activity is unknown too.
    const activity = tailSaysSomething
      ? { running: !tail.hasTrailingExit && tail.looksActive }
      : mtimeMs !== null && now - mtimeMs >= OWNERSHIP_ACTIVE_WINDOW_MS ? { running: false } : {};
    if (named.has(id)) {
      // A live `omp --resume` outside the daemon: ownership is the process, so
      // an idle one still owns the file (`running` only says "mid-turn").
      entries.push({ id, owner: "foreign", source: "process", ...activity, ...lastActivityAt });
      continue;
    }
    // No positive owner evidence. A fresh tail is an activity hint only: it
    // never turns into an owner, so it can never block a send by itself.
    entries.push({ id, owner: "none", ...(tailSaysSomething ? { source: "transcript" as const } : {}), ...activity, ...lastActivityAt });
  }
  return { ok: true, value: entries };
}
