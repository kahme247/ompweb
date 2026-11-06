// Computes one usage report — transcript sync, the uncounted-usage pass and the
// analytics queries — in a Bun Worker. lib/usage-db.ts drives `bun:sqlite`
// synchronously (a transaction over every changed transcript, then several
// aggregate queries); on the server's event loop a cold scan stopped every
// other answer for tens of seconds. The parent (lib/usage-report-worker.ts)
// spawns this file, and the request path only awaits its message.
//
// The definition of the report stays in lib/usage-db.ts: the worker and the
// server share one implementation and cannot drift apart.
import { parentPort } from "node:worker_threads";
import { closeUsageDatabase, getUsageReportFromDb } from "./usage-db";
import { asNumber, asString, isRecord } from "./type-guards";
import type { UsageGranularity, UsageQueryOptions, UsageTimeRange } from "./usage-types";

const port = parentPort;
if (!port) {
  throw new Error("lib/usage-worker.ts must run as a worker thread");
}

const TIME_RANGES: UsageTimeRange[] = ["today", "7d", "30d", "90d", "month", "all"];
const GRANULARITIES: UsageGranularity[] = ["daily", "monthly", "projects"];

/** The query the parent sent; anything outside the typed shape is ignored. */
function readOptions(value: unknown): UsageQueryOptions {
  if (!isRecord(value)) return {};
  const range = asString(value.range);
  const granularity = asString(value.granularity);
  const project = asString(value.project);
  return {
    range: TIME_RANGES.includes(range as UsageTimeRange) ? (range as UsageTimeRange) : undefined,
    granularity: GRANULARITIES.includes(granularity as UsageGranularity)
      ? (granularity as UsageGranularity)
      : undefined,
    project: project || undefined,
    from: asNumber(value.from),
    to: asNumber(value.to),
    forceRefresh: value.forceRefresh === true,
  };
}

port.once("message", (message: unknown) => {
  const options = readOptions(isRecord(message) ? message.options : undefined);
  getUsageReportFromDb(options)
    .then((report) => {
      // Close before answering: on Windows the open usage.db handle would keep
      // the agent directory locked after the parent already has its answer.
      closeUsageDatabase();
      port.postMessage({ ok: true, report });
    })
    .catch((error: unknown) => {
      closeUsageDatabase();
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
});
