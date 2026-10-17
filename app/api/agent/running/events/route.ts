import { getExitedRpcSessions, getRunningRpcSessions, subscribeRunningSessions } from "@/lib/rpc-manager";
import { isValidNotificationId } from "@/lib/notification-events";
import { attachNotificationClient } from "@/lib/notification-hub";
import { subscribeSessionFileChanges } from "@/lib/session-watcher";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Also carries refresh hints when a live session's file metadata
// changes, so the sidebar can show a newly-started session immediately, and
// this tab's notifications when `clientId` is given (one stream per tab:
// browsers allow only six HTTP/1.1 connections per host).
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get("clientId");
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the subscriber.
  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleaned = false;
      let unsubscribeRunning: (() => void) | null = null;
      let unsubscribeFiles: (() => void) | null = null;
      let detachNotifications: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (cleaned) return;
        closed = true;
        cleaned = true;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribeRunning) {
          try { unsubscribeRunning(); } catch {}
          unsubscribeRunning = null;
        }
        if (unsubscribeFiles) {
          try { unsubscribeFiles(); } catch {}
          unsubscribeFiles = null;
        }
        detachNotifications?.();
        detachNotifications = null;
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const encode = (data: unknown) => {
        if (closed) return;
        try {
          const text = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      unsubscribeRunning = subscribeRunningSessions(({ ids, runningSessions, exitedSessions, refreshSessionList }) => {
        encode({
          type: "running",
          runningSessionIds: ids,
          runningSessions,
          exitedSessions,
          ...(refreshSessionList ? { refreshSessionList: true } : {}),
        });
      });

      unsubscribeFiles = subscribeSessionFileChanges((sessionIds) => {
        encode({ type: "sessions-changed", sessionIds, refreshSessionList: true });
      });

      if (isValidNotificationId(clientId)) {
        detachNotifications = attachNotificationClient(clientId, (message) => encode({ type: "notification", ...message }));
      }

      // Initial snapshot so the client renders the correct state immediately.
      const initialRunning = getRunningRpcSessions();
      encode({
        type: "running",
        runningSessionIds: initialRunning.map((s) => s.id),
        runningSessions: initialRunning,
        exitedSessions: getExitedRpcSessions(),
      });
      // Heartbeat to keep the connection alive through proxies/timeouts.
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
