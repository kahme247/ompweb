/**
 * Fork targets for the message transcript.
 *
 * omp's `branch` RPC command — what the UI calls "fork" / "New session" —
 * only accepts a **user** message entry. Verified against a live
 * `omp --mode rpc-ui`: branching at an assistant entry answers
 * `success:false, error:"Invalid entry ID for branching"`. The new session
 * holds the history *before* that user entry, and the command returns the
 * entry's prompt text so the client can offer it for editing and re-sending.
 *
 * The UI offers the action on every message and resolves each one to a branch
 * point omp supports:
 * - a user message forks at itself and its prompt is put back into the
 *   composer (edit-and-resend, like omp's TUI `/branch`);
 * - an assistant reply forks at the NEXT user prompt, so the new session keeps
 *   that reply (and the rest of its turn) in its history;
 * - the newest reply has no next prompt, so it falls back to its own turn's
 *   prompt with the edit-and-resend prefill (#103).
 * Editing the first prompt would fork into an empty session, so rows that
 * resolve to that have no fork target, nor do rows with no usable user entry.
 */

export interface ForkBranchTarget {
  type: "branch";
  entryId: string;
  /** Put the branched prompt's text back into the composer. */
  editPrompt: boolean;
}

export interface ForkLeafTarget {
  type: "fork";
  entryId?: undefined;
  /** Leaf fork clones session in-place with full history; composer remains untouched. */
  editPrompt: false;
}

export type ForkTarget = ForkBranchTarget | ForkLeafTarget;

export interface ResolveForkTargetsOptions {
  /** Active branch leaf id in the UI, if navigated away from HEAD. */
  activeLeafId?: string | null;
  /** Authoritative leaf id of the running session process. */
  headLeafId?: string | null;
}

export function resolveForkTargets(
  messages: readonly { role: string; branchSummary?: boolean }[],
  entryIds: readonly (string | undefined)[],
  options?: ResolveForkTargetsOptions,
): (ForkTarget | undefined)[] {
  // Branch summaries render as user rows but are not entries omp can branch at.
  const roles = messages.map((message) => (message.branchSummary ? "branchSummary" : message.role));
  const targets: (ForkTarget | undefined)[] = roles.map(() => undefined);

  // If there are no user entries in the session, there is no usable conversation to fork or branch.
  const hasUserEntry = roles.some((role, index) => role === "user" && !!entryIds[index]);
  if (!hasUserEntry) return targets;
  // 1. Identify the active branch leaf (the last assistant or user message with a valid entryId)
  let leafIndex = -1;
  for (let index = roles.length - 1; index >= 0; index--) {
    if ((roles[index] === "assistant" || roles[index] === "user") && entryIds[index]) {
      leafIndex = index;
      break;
    }
  }

  // 2. When synchronized with HEAD, the active leaf triggers an in-place session clone (CLI /fork parity)
  const isHeadSynchronized = options?.activeLeafId == null || options.activeLeafId === options.headLeafId;
  if (leafIndex !== -1 && isHeadSynchronized) {
    targets[leafIndex] = { type: "fork", editPrompt: false };
  }

  // 3. Historical assistant replies fork at the NEXT user prompt, keeping the reply in history
  let nextUserEntryId: string | undefined;
  for (let index = roles.length - 1; index >= 0; index--) {
    if (roles[index] === "user") {
      nextUserEntryId = entryIds[index];
    } else if (roles[index] === "assistant" && nextUserEntryId && !targets[index]) {
      targets[index] = { type: "branch", entryId: nextUserEntryId, editPrompt: false };
    }
  }

  // 4. Historical user prompts rewind to their own entry, returning the prompt for edit-and-resend
  let ownUserEntryId: string | undefined;
  let ownIsFirstPrompt = false;
  for (let index = 0; index < roles.length; index++) {
    if (roles[index] === "user") {
      ownIsFirstPrompt = index === 0;
      ownUserEntryId = entryIds[index];
    }
    if (targets[index] || !ownUserEntryId || ownIsFirstPrompt) continue;
    if (roles[index] === "user" || roles[index] === "assistant") {
      targets[index] = { type: "branch", entryId: ownUserEntryId, editPrompt: true };
    }
  }
  return targets;
}
