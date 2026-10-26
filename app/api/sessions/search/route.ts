import { NextResponse } from "next/server";
import { searchSessions } from "@/lib/session-content-search";

const MAX_QUERY_LENGTH = 500;

// GET /api/sessions/search?q= — NDJSON, one `{ scores }` line per batch of
// scanned sessions (empty batches too, so the scan keeps reaching the reader).
// Closing the request stops the scan after the batch being read (no resume).
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: "Query too long", code: "query_too_long" }, { status: 400 });
  }
  const batches = searchSessions(q);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    // Pull-driven: the scan only advances while the client keeps reading.
    async pull(controller) {
      const next = await batches.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`${JSON.stringify({ scores: next.value })}\n`));
    },
    async cancel() {
      await batches.return(undefined);
    },
  });
  // X-Accel-Buffering: nginx must pass batches through as they arrive.
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
