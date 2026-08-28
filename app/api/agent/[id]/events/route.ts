import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // SSE is observer-only: listing or opening a saved session must not create
  // another omp process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this route attaches.
  const existing = getRpcSession(id);
  const session = existing?.isAlive() ? existing : undefined;
  if (!session) return new Response("Session is not managed by omp-web", { status: 409 });

  const encoder = new TextEncoder();
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the RpcProcess listener.
  let streamCleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleaned = false;
      let unsubscribe: (() => void) | null = null;
      // Backpressure slot: while the consumer is behind (desiredSize < 0),
      // replaceable `message_update` frames collapse to the latest one (omp
      // sends the FULL accumulated message each time, so latest-wins is safe).
      // Control/terminal frames are small and never dropped; they flush the
      // pending update first so ordering is preserved.
      let pendingUpdate: unknown | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (cleaned) return;
        closed = true;
        cleaned = true;
        pendingUpdate = null;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
          unsubscribe = null;
        }
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const flushPendingUpdate = (): boolean => {
        const data = pendingUpdate;
        pendingUpdate = null;
        if (data === null) return true;
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const encode = (data: unknown) => {
        if (closed) return;
        const type = (data as { type?: string } | null)?.type;
        // Coalesce while backpressured; never buffer unboundedly.
        if (type === "message_update" && controller.desiredSize !== null && controller.desiredSize < 0) {
          pendingUpdate = data;
          return;
        }
        if (!flushPendingUpdate()) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        if (!flushPendingUpdate()) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      encode({ type: "connected", sessionId: id });
      if (closed) return;
      unsubscribe = session.onEvent((event) => encode(event));
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
