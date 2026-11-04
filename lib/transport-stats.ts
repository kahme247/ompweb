// Durations derived from transport samples (lib/event-stream-worker.ts, lib/agent-client.ts), shared by
// scripts/transport-metrics.ts and the worker's live diagnostics so both compute the same numbers. Browser-safe.

import { NO_OMP_REPLY_COMMANDS } from "./event-stream-protocol";
import { asNumber } from "./type-guards";

type Sample = Record<string, unknown>;

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sortedPercentile(sorted, p);
}

function sortedPercentile(sorted: number[], p: number): number {
  // p * n / 100, not p / 100 * n: 99.9 / 100 * 2000 is 1998.0000000000002, whose ceiling is one rank too high.
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p * sorted.length) / 100))) - 1];
}

export const diff = (a: unknown, b: unknown): number | undefined => {
  const x = asNumber(a);
  const y = asNumber(b);
  return x === undefined || y === undefined ? undefined : x - y;
};

/** An action's whole round trip (tab clock). */
export const totalMsOf = (s: Sample) => diff(s.gotAt, s.sentAt);
/** An action's time on the server: received to replied (server clock), which includes omp's own work. */
export const serverMsOf = (s: Sample) => diff(s.repliedAt, s.recvAt);

/** totalMs − serverMs: clock-free, and what the transport added to an action. */
export function transportMsOf(s: Sample): number | undefined {
  const totalMs = totalMsOf(s);
  const serverMs = serverMsOf(s);
  return totalMs !== undefined && serverMs !== undefined ? totalMs - serverMs : undefined;
}

/** An action's one-way trip to the server, through the worker's clock offset. */
export function upMsOf(s: Sample): number | undefined {
  const sentAt = asNumber(s.sentAt);
  const offset = asNumber(s.offset);
  return sentAt === undefined || offset === undefined ? undefined : diff(s.recvAt, sentAt + offset);
}

/** An event's one-way trip from the server, through the worker's clock offset. */
export function eventMsOf(s: Sample): number | undefined {
  const ms = diff(s.gotAt, s.at);
  const offset = asNumber(s.offset);
  return ms === undefined || offset === undefined ? undefined : ms + offset;
}

/** Below this many values p99.9 is just the max, so it is reported as null. */
export const P999_MIN_COUNT = 1000;

export interface DurationSummary {
  count: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p999: number | null;
  max: number | null;
}

export function summarizeDurations(values: number[]): DurationSummary {
  if (values.length === 0) return { count: 0, mean: null, p50: null, p95: null, p999: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sortedPercentile(sorted, 50),
    p95: sortedPercentile(sorted, 95),
    p999: sorted.length >= P999_MIN_COUNT ? sortedPercentile(sorted, 99.9) : null,
    max: sorted[sorted.length - 1],
  };
}

export type DiagnosticMetric = "upMs" | "transportMs" | "ompMs" | "serverMs" | "totalMs" | "eventMs";
const METRIC_ORDER: DiagnosticMetric[] = ["upMs", "transportMs", "ompMs", "serverMs", "totalMs", "eventMs"];

export interface DiagnosticStat extends DurationSummary {
  transport: string;
  metric: DiagnosticMetric;
}

/** The diagnostics panel's rows: per transport, each metric with at least one value. */
export function diagnosticStats(samples: Sample[]): DiagnosticStat[] {
  const groups = new Map<string, number[]>();
  const add = (transport: string, metric: DiagnosticMetric, value: number | undefined) => {
    if (value === undefined) return;
    const key = `${transport}\0${metric}`;
    const values = groups.get(key);
    if (values) values.push(value);
    else groups.set(key, [value]);
  };
  for (const s of samples) {
    const transport = typeof s.transport === "string" ? s.transport : "unknown";
    if (s.metric === "action") {
      // A local timeout/proxy refusal never confirms an omp round trip; this panel measures successful commands only.
      if (s.outcome !== "ok" || serverMsOf(s) === undefined) continue;
      add(transport, "upMs", upMsOf(s));
      const totalMs = totalMsOf(s);
      // A backward clock step during the command makes its round trip (and so its transport share) meaningless.
      if (totalMs !== undefined && totalMs >= 0) add(transport, "transportMs", transportMsOf(s));
      if (typeof s.type === "string" && NO_OMP_REPLY_COMMANDS.has(s.type)) continue;
      if (s.type === "get_state") add(transport, "ompMs", serverMsOf(s));
      add(transport, "serverMs", serverMsOf(s));
      if (totalMs !== undefined && totalMs >= 0) add(transport, "totalMs", totalMs);
    } else if (s.metric === "event") {
      add(transport, "eventMs", eventMsOf(s));
    }
  }
  return [...groups].map(([key, values]): DiagnosticStat => {
    const [transport, metric] = key.split("\0") as [string, DiagnosticMetric];
    return { transport, metric, ...summarizeDurations(values) };
  }).sort((a, b) => a.transport.localeCompare(b.transport) || METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
}
