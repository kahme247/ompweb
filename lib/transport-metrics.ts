import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

const MAX_METRIC_NAME_CHARS = 32;
const MAX_SAMPLE_BYTES = 4_096;
const MAX_UA_CHARS = 200;
const ROTATE_BYTES = 20 * 1024 * 1024;

export function transportMetricsPath(): string {
  return join(getAgentDir(), "omp-web", "transport-metrics.jsonl");
}

/** Appends the valid samples (stamped with the server clock and user agent) as JSONL; returns how many were kept. */
export function appendTransportSamples(samples: unknown[], ua: string | null): number {
  const serverAt = Date.now();
  const userAgent = ua?.slice(0, MAX_UA_CHARS) ?? null;
  const lines: string[] = [];
  for (const sample of samples) {
    if (!isRecord(sample) || typeof sample.metric !== "string" || sample.metric.length > MAX_METRIC_NAME_CHARS) continue;
    if (Buffer.byteLength(JSON.stringify(sample)) > MAX_SAMPLE_BYTES) continue;
    lines.push(JSON.stringify({ ...sample, serverAt, ua: userAgent }));
  }
  if (lines.length === 0) return 0;

  const file = transportMetricsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return lines.length;
}
