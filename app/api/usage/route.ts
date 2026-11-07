import { isRecord } from "@/lib/type-guards";
import { getUsageReport } from "@/lib/usage-service";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

/** The usage page never needs a wider window; a wider one would just make each
 *  distinct `from` a fresh full transcript scan. */
const MAX_USAGE_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

function invalidWindow(): Response {
  return Response.json({ error: "Invalid usage window", code: "invalid_usage_window" }, { status: 400 });
}

/** Epoch milliseconds, digits only; undefined when absent, null when invalid. */
function parseTimestamp(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range");
  const granularityParam = url.searchParams.get("granularity");
  const projectParam = url.searchParams.get("project");
  const refreshParam = url.searchParams.get("refresh");

  const validRanges: UsageTimeRange[] = ["today", "7d", "30d", "90d", "month", "all"];
  const range: UsageTimeRange = validRanges.includes(rangeParam as UsageTimeRange)
    ? (rangeParam as UsageTimeRange)
    : "30d";

  const validGranularities: UsageGranularity[] = ["daily", "monthly", "projects"];
  const granularity: UsageGranularity = validGranularities.includes(granularityParam as UsageGranularity)
    ? (granularityParam as UsageGranularity)
    : "daily";

  const from = parseTimestamp(url.searchParams.get("from"));
  const to = parseTimestamp(url.searchParams.get("to"));
  if (from === null || to === null) return invalidWindow();
  const now = Date.now();
  // Every distinct from/to pair is its own cache key and its own full scan, so
  // an unbounded/backwards/open window would let one client explore the
  // transcript tree without limit. 400 days covers the UI's widest range.
  if (from !== undefined && to !== undefined && (from > to || to - from > MAX_USAGE_WINDOW_MS)) return invalidWindow();
  if (from !== undefined && to === undefined && now - from > MAX_USAGE_WINDOW_MS) return invalidWindow();
  if (to !== undefined && from === undefined && now - to > MAX_USAGE_WINDOW_MS) return invalidWindow();

  const forceRefresh = refreshParam === "true" || refreshParam === "1";

  try {
    const report = await getUsageReport({
      range,
      granularity,
      project: projectParam || undefined,
      from,
      to,
      forceRefresh,
    });
    return Response.json(report);
  } catch (error) {
    // Paths and database messages stay in the server log; the client gets a
    // stable code it can act on. Match on the code, not `instanceof`: a
    // re-evaluated module or a worker restart need not share class identity.
    console.error("[api/usage]", error);
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "usage_busy") {
      return Response.json({ error: "Usage scan busy", code: "usage_busy" }, { status: 503 });
    }
    if (code === "usage_timeout") {
      return Response.json({ error: "Usage scan timed out", code: "usage_timeout" }, { status: 504 });
    }
    return Response.json({ error: "Usage report failed", code: "usage_failed" }, { status: 500 });
  }
}
