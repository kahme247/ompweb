import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { remotePlacements } from "@/lib/porbs/controller";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Also carries refresh hints when a live session's file metadata
// changes, so the sidebar can show a newly-started session immediately.
export async function GET(req: Request) {
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the subscriber.
  let streamCleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions(({ refreshSessionList }) => {
        void remotePlacements().then((placements) => {
          const remoteIds = placements.filter((p) => p.lifecycle === "active").map((p) => p.sessionId);
          encode({
            type: "running",
            runningSessionIds: [...getRunningRpcSessionIds(), ...remoteIds],
            ...(refreshSessionList ? { refreshSessionList: true } : {}),
          });
        }).catch(() => {});
      });

      const encodeSnapshot = async () => {
        const remoteIds = (await remotePlacements()).filter((p) => p.lifecycle === "active").map((p) => p.sessionId);
        encode({ type: "running", runningSessionIds: [...getRunningRpcSessionIds(), ...remoteIds] });
      };
      void encodeSnapshot();

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
        void encodeSnapshot();
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      streamCleanup = cleanup;

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }
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
