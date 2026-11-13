/**
 * Fork targets for the message transcript.
 *
 * omp's `branch` command — what the UI calls "fork" / "New session" —
 * only accepts a **user** message entry. Verified against a live
 * omp: branching at an assistant entry answers
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

export interface ForkTarget {
  entryId: string;
  /** Put the branched prompt's text back into the composer. */
  editPrompt: boolean;
}

export function resolveForkTargets(
  messages: readonly { role: string; branchSummary?: boolean }[],
  entryIds: readonly (string | undefined)[],
): (ForkTarget | undefined)[] {
  // Branch summaries render as user rows but are not entries omp can branch at.
  const roles = messages.map((message) => (message.branchSummary ? "branchSummary" : message.role));
  const targets: (ForkTarget | undefined)[] = roles.map(() => undefined);
  let nextUserEntryId: string | undefined;
  for (let index = roles.length - 1; index >= 0; index--) {
    if (roles[index] === "user") nextUserEntryId = entryIds[index];
    else if (roles[index] === "assistant" && nextUserEntryId) {
      targets[index] = { entryId: nextUserEntryId, editPrompt: false };
    }
  }
  // The row-0 prompt has nothing before it (a compaction summary would be row 0).
  let ownUserEntryId: string | undefined;
  let ownIsFirstPrompt = false;
  for (let index = 0; index < roles.length; index++) {
    if (roles[index] === "user") {
      ownIsFirstPrompt = index === 0;
      ownUserEntryId = entryIds[index];
    }
    if (targets[index] || !ownUserEntryId || ownIsFirstPrompt) continue;
    if (roles[index] === "user" || roles[index] === "assistant") {
      targets[index] = { entryId: ownUserEntryId, editPrompt: true };
    }
  }
  return targets;
}
