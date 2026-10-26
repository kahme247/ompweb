import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { EventStreamConnection, getEventStreamConnection } from "@/lib/event-stream-hub";
import { parseEventStreamRequest, UNKNOWN_CONNECTION_CODE } from "@/lib/event-stream-protocol";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 16 * 1024;

// GET /api/events — the browser's single multiplexed live-event stream.
// Subscriptions are attached with POST (see lib/event-stream-protocol.ts).
export function GET(req: Request) {
  const connection = new EventStreamConnection(req.signal);
  return new Response(connection.stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST /api/events — { connectionId, subscribe: { id, channel } } | { connectionId, unsubscribe }
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid event stream request", code: "invalid_event_stream_request" }, { status });
  }
  const request = parseEventStreamRequest(body);
  if (!request) {
    return NextResponse.json({ error: "Invalid event stream request", code: "invalid_event_stream_request" }, { status: 400 });
  }
  const connection = getEventStreamConnection(request.connectionId);
  if (!connection) {
    return NextResponse.json({ error: "Unknown event stream connection", code: UNKNOWN_CONNECTION_CODE }, { status: 404 });
  }
  if ("unsubscribe" in request) {
    connection.unsubscribe(request.unsubscribe);
    return NextResponse.json({ ok: true });
  }
  const result = await connection.subscribe(request.subscribe.id, request.subscribe.channel);
  return result.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
}
