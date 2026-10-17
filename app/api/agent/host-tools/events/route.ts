import { subscribeHostToolCalls } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/host-tools/events - SSE stream of host tool calls (open_url,
// notify, open_file) from sessions no tab is watching. Every open omp-web tab
// holds one, so a session keeps its host tools while the user views another.
export async function GET(req: Request) {
  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        try { unsubscribe?.(); } catch {}
        unsubscribe = null;
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const send = (text: string) => {
        if (closed) return;
        try {
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

      unsubscribe = subscribeHostToolCalls((call) => {
        send(`data: ${JSON.stringify({ type: "host_tool_call", ...call })}\n\n`);
      });
      // Heartbeat to keep the connection alive through proxies/timeouts.
      heartbeatTimer = setInterval(() => send(":\n\n"), 30_000);
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
