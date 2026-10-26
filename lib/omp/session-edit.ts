import { randomUUID } from "node:crypto";
import path from "node:path";
import { RpcCommandTimeoutError, type RpcFrame, type RpcProcess } from "./rpc-process";
import type { RpcAvailableSlashCommand } from "../pi-types";
import { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } from "./session-edit-extension.mjs";

export { SESSION_EDIT_COMMAND };
// Next's dev/start commands and the installed launcher run in the package root.
export const SESSION_EDIT_EXTENSION_PATH = path.join(process.cwd(), "lib", "omp", "session-edit-extension.mjs");
const EDIT_TIMEOUT_MS = 15_000;

export interface SessionEditResult {
  sessionId: string;
  cancelled: boolean;
  leafId: string | null;
}

/** A redirected command must keep its run ownership or stop before Edit unlocks. */
export class SessionEditAgentInvocationError extends Error {
  constructor(readonly agentStarted: boolean) {
    super("An OMP input hook invoked the agent instead of executing the history edit command");
    this.name = "SessionEditAgentInvocationError";
  }
}

export function isSessionEditReply(frame: RpcFrame): boolean {
  return frame.type === "extension_ui_request" && frame.method === "notify"
    && typeof frame.message === "string" && frame.message.startsWith(SESSION_EDIT_RESPONSE_PREFIX);
}

/** Use omp's public extension navigation API. Input hooks must pass the internal
 * command through; a catalog entry alone cannot guarantee its execution.
 * Correlated replies, not prompt acknowledgements, confirm navigation. */
export async function editSessionHistory(
  proc: Pick<RpcProcess, "sendCommand" | "onFrame">,
  entryId: string,
  sessionId: string,
): Promise<SessionEditResult> {
  const catalog = await proc.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, EDIT_TIMEOUT_MS);
  if (!catalog.commands?.some((command) => command.name === SESSION_EDIT_COMMAND && command.source === "extension")) {
    throw new Error("The OMP session edit extension is unavailable; restart the session before editing");
  }
  const requestId = randomUUID();
  const { promise: reply, resolve, reject } = Promise.withResolvers<SessionEditResult>();
  const timer = setTimeout(() => reject(new RpcCommandTimeoutError("edit_message", EDIT_TIMEOUT_MS, "OMP did not confirm the history edit")), EDIT_TIMEOUT_MS);
  timer.unref?.();
  let persistenceError: Error | null = null;
  let agentInvocationError: SessionEditAgentInvocationError | null = null;
  const unsubscribe = proc.onFrame((frame) => {
    if (frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error") {
      // A notice can arrive while navigation is suspended in a hook. It is
      // not handler completion: retain the fence until a reply or timeout.
      persistenceError ??= new Error(typeof frame.message === "string" ? frame.message : "OMP could not persist the history edit");
      return;
    }
    if (frame.type === "agent_start") {
      agentInvocationError ??= new SessionEditAgentInvocationError(true);
      reject(agentInvocationError);
      return;
    }
    if (!isSessionEditReply(frame)) return;
    let result: Record<string, unknown>;
    try {
      result = JSON.parse((frame.message as string).slice(SESSION_EDIT_RESPONSE_PREFIX.length));
    } catch {
      return;
    }
    if (!result || typeof result !== "object" || result.requestId !== requestId) return;
    if (typeof result.error === "string") {
      reject(new Error(result.error));
    } else if (typeof result.sessionId !== "string" || !result.sessionId.trim() || typeof result.cancelled !== "boolean"
      || (result.leafId !== null && typeof result.leafId !== "string")) {
      reject(new Error("OMP returned an invalid history edit result"));
    } else {
      // The wrapper verifies changed identities against native migration state.
      resolve({ sessionId: result.sessionId, cancelled: result.cancelled, leafId: result.leafId });
    }
  });
  // An extension may reject before the command's acknowledgement arrives.
  void reply.catch(() => {});
  try {
    const acknowledgement = await proc.sendCommand<{ agentInvoked?: boolean } | undefined>({ type: "prompt", message: `/${SESSION_EDIT_COMMAND} ${JSON.stringify({ requestId, entryId, sessionId })}` }, EDIT_TIMEOUT_MS);
    if (acknowledgement?.agentInvoked === true) {
      agentInvocationError ??= new SessionEditAgentInvocationError(false);
    }
    if (agentInvocationError) throw agentInvocationError;
    const result = await reply;
    // A success reply may precede a write-error notice or the prompt ack.
    if (persistenceError) throw persistenceError;
    if (agentInvocationError) throw agentInvocationError;
    return result;
  } catch (error) {
    // Preserve uncertain completion until the wrapper has stopped the child;
    // it retains the persistence notice for the final user-visible error.
    if (error instanceof RpcCommandTimeoutError) throw error;
    throw agentInvocationError ?? persistenceError ?? error;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
