// omp owns the steering/follow-up queue: the panel renders its snapshots
// (`get_state.queuedMessages` and live `queue_update` events), so every
// client viewing the session shows the same queue.
import type { QueuedMessages } from "@/lib/pi-types";

export type { QueuedMessages };

export const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };

/**
 * `lib/rpc-manager.ts` answers a prompt/steer with this when a `!!` shell
 * command owned the session: it forwarded the message into omp's follow-up
 * queue instead of rejecting the frame. It reports what happened — it is not
 * queue state, so the chip still comes from omp's own snapshot.
 */
export function isQueuedWhileShellRunning(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const value = reply as { queued?: unknown; queue?: unknown; reason?: unknown };
  return value.queued === true && value.queue === "followUp" && value.reason === "shellRunning";
}
