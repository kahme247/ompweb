import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { appendTransportSamples } from "@/lib/transport-metrics";
import { isRecord } from "@/lib/type-guards";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SAMPLES = 1_000;

// GET /api/transport-metrics — the server clock, the SSE transport's clock probe.
export function GET() {
  return Response.json({ now: Date.now() }, { headers: { "cache-control": "no-store" } });
}

// POST /api/transport-metrics { samples } — appended to <agent dir>/omp-web/transport-metrics.jsonl.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "Transport metrics request is too large", code: "request_too_large" }, { status: 413 });
    body = null;
  }
  if (!isRecord(body) || !Array.isArray(body.samples) || body.samples.length > MAX_SAMPLES) {
    return Response.json({ error: "samples must be an array of at most 1000 objects", code: "invalid_transport_metrics" }, { status: 400 });
  }
  return Response.json({ written: appendTransportSamples(body.samples, req.headers.get("user-agent")) });
}
