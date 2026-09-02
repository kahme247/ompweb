import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { getUsageReport } from "@/lib/usage-service";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get("range");
    const granularityParam = url.searchParams.get("granularity");
    const projectParam = url.searchParams.get("project");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const refreshParam = url.searchParams.get("refresh");

    const validRanges: UsageTimeRange[] = ["today", "7d", "30d", "90d", "month", "all"];
    const range: UsageTimeRange = validRanges.includes(rangeParam as UsageTimeRange)
      ? (rangeParam as UsageTimeRange)
      : "30d";

    const validGranularities: UsageGranularity[] = ["daily", "monthly", "projects"];
    const granularity: UsageGranularity = validGranularities.includes(granularityParam as UsageGranularity)
      ? (granularityParam as UsageGranularity)
      : "daily";

    const from = fromParam ? parseInt(fromParam, 10) : undefined;
    const to = toParam ? parseInt(toParam, 10) : undefined;
    const forceRefresh = refreshParam === "true" || refreshParam === "1";

    const report = await getUsageReport({
      range,
      granularity,
      project: projectParam || undefined,
      from: !isNaN(from as number) ? from : undefined,
      to: !isNaN(to as number) ? to : undefined,
      forceRefresh,
    });

    return NextResponse.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
