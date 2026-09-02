import { getRunningRpcSessions, subscribeRunningSessions } from "@/lib/rpc-manager";
import { subscribeSessionFileChanges } from "@/lib/session-watcher";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Also carries refresh hints when a live session's file metadata
// changes, so the sidebar can show a newly-started session immediately.
export async function GET(req: Request) {
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
      unsubscribeRunning = subscribeRunningSessions(({ ids, runningSessions, refreshSessionList }) => {
        encode({
          type: "running",
          runningSessionIds: ids,
          runningSessions,
          ...(refreshSessionList ? { refreshSessionList: true } : {}),
        });
      });

      unsubscribeFiles = subscribeSessionFileChanges((sessionIds) => {
        encode({ type: "sessions-changed", sessionIds, refreshSessionList: true });
      });

      // Initial snapshot so the client renders the correct state immediately.
      const initialRunning = getRunningRpcSessions();
      encode({
        type: "running",
        runningSessionIds: initialRunning.map((s) => s.id),
        runningSessions: initialRunning,
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
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
