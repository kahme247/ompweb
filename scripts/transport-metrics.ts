// Summarizes the browser transport samples (lib/transport-metrics.ts) per transport:
//   bun scripts/transport-metrics.ts [--since 2h|30m|<ISO>] [--until <ISO>] [--client <id>] [--file <path>]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { transportMetricsPath } from "../lib/transport-metrics";
import { asNumber, asString } from "../lib/type-guards";

export type SummaryRow = {
  section: string;
  transport: string;
  key: string;
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  /** Mean `batch` of the reconnects behind a "reconnect ms" row. */
  meanBatch?: number;
};
export type SummaryOptions = { since?: number; until?: number; client?: string };
type Sample = Record<string, unknown>;

// The report's section order, fixed so two runs over different data line up.
const SECTION_ORDER = [
  "action totalMs", "action transportMs", "action upMs", "abort behind upload", "event ms", "reconnect ms", "reconnect fromDropMs",
  "isolation event ms", "isolation action ms", "sockets", "pool size", "rebalance moved", "rebalance settledMs",
  "hang", "resend", "deduped", "outcome", "client",
];

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

type Group = { section: string; transport: string; key: string; count: number; values: number[]; batches: number[] };

const diff = (a: unknown, b: unknown) => {
  const x = asNumber(a);
  const y = asNumber(b);
  return x === undefined || y === undefined ? undefined : x - y;
};

/** Spec D6 cross-session blocking: behind another session's bytes, only its own, or neither; undefined when nothing was measured. */
function isolation(s: Sample): "other" | "same" | "clear" | undefined {
  const other = asNumber(s.behindOtherBytes);
  const same = asNumber(s.behindSameBytes);
  const reply = asNumber(s.replyBehindOtherBytes);
  if (other === undefined && same === undefined && reply === undefined) return undefined;
  if ((other ?? 0) > 0 || (reply ?? 0) > 0) return "other";
  return (same ?? 0) > 0 ? "same" : "clear";
}

export function summarize(samples: Sample[], options: SummaryOptions): SummaryRow[] {
  const kept = samples.filter((s) => {
    const serverAt = asNumber(s.serverAt);
    if (options.since !== undefined && !(serverAt !== undefined && serverAt >= options.since)) return false;
    if (options.until !== undefined && !(serverAt !== undefined && serverAt <= options.until)) return false;
    return options.client === undefined || s.clientId === options.client;
  });

  const groups = new Map<string, Group>();
  // A count-only row passes no value; a value that could not be derived (a field missing) adds nothing.
  const add = (section: string, transport: string, key: string, value?: number, batch?: number) => {
    const id = `${section}\0${transport}\0${key}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { section, transport, key, count: 0, values: [], batches: [] }));
    group.count++;
    if (value !== undefined) group.values.push(value);
    if (batch !== undefined) group.batches.push(batch);
  };
  const addValue = (section: string, transport: string, key: string, value: number | undefined, batch?: number) => {
    if (value !== undefined) add(section, transport, key, value, batch);
  };

  // A hang counts as answered later when the same command ended in a reply (ok or error), not a loss. Built from every
  // sample, so a since/until/client filter that cuts the reply off does not turn it into a hang that was never answered.
  const answered = new Set(
    samples.filter((s) => s.metric === "action" && typeof s.req === "string" && (s.outcome === "ok" || s.outcome === "error")).map((s) => s.req),
  );
  const clients = new Map<string, { samples: number; types: Set<string>; ua: string }>();

  for (const s of kept) {
    const transport = asString(s.transport) ?? "unknown";
    const clientId = asString(s.clientId) ?? "unknown";
    const client = clients.get(clientId) ?? { samples: 0, types: new Set<string>(), ua: "" };
    client.samples++;
    client.types.add(asString(s.effectiveType) ?? "null");
    client.ua = asString(s.ua) ?? client.ua;
    clients.set(clientId, client);
    addValue("sockets", transport, "all", asNumber(s.sockets));
    addValue("pool size", transport, "all", asNumber(s.pool));
    const isolated = isolation(s);

    if (s.metric === "action") {
      const type = asString(s.type);
      const totalMs = diff(s.gotAt, s.sentAt);
      const serverMs = diff(s.repliedAt, s.recvAt);
      const sentAt = asNumber(s.sentAt);
      const offset = asNumber(s.offset);
      const upMs = sentAt === undefined || offset === undefined ? undefined : diff(s.recvAt, sentAt + offset);
      const transportMs = totalMs !== undefined && serverMs !== undefined ? totalMs - serverMs : undefined;
      for (const [section, value] of [["action totalMs", totalMs], ["action transportMs", transportMs], ["action upMs", upMs]] as const) {
        addValue(section, transport, "all", value);
        if (type) addValue(section, transport, type, value);
      }
      if (type?.startsWith("abort")) addValue("abort behind upload", transport, (asNumber(s.behindBytes) ?? 0) > 0 ? "yes" : "no", totalMs);
      if (isolated) addValue("isolation action ms", transport, isolated, totalMs);
      add("outcome", transport, asString(s.outcome) ?? "unknown");
      if ((asNumber(s.attempts) ?? 1) > 1) add("resend", transport, "attempts>1");
      if (s.deduped === true) add("deduped", transport, "deduped");
    } else if (s.metric === "event") {
      const ms = diff(s.gotAt, s.at);
      const offset = asNumber(s.offset);
      const eventMs = ms === undefined || offset === undefined ? undefined : ms + offset;
      addValue("event ms", transport, `${asString(s.conn)} ${asString(s.channel)}`, eventMs);
      if (isolated) addValue("isolation event ms", transport, isolated, eventMs);
    } else if (s.metric === "reconnect") {
      const key = `${asString(s.trigger)} ${asString(s.conn)}`;
      addValue("reconnect ms", transport, key, diff(s.firstFrameAt, s.startAt), asNumber(s.batch));
      addValue("reconnect fromDropMs", transport, key, diff(s.firstFrameAt, s.dropAt));
    } else if (s.metric === "rebalance") {
      const reason = asString(s.reason) ?? "unknown";
      addValue("rebalance moved", transport, reason, asNumber(s.moved));
      addValue("rebalance settledMs", transport, reason, asNumber(s.settledMs));
    } else if (s.metric === "hang") {
      add("hang", transport, "total");
      if (answered.has(s.req)) add("hang", transport, "answered later");
    }
  }
  for (const [id, client] of clients) {
    const key = `${id} ${[...client.types].sort().join(",")} ${client.ua}`.trimEnd();
    groups.set(`client\0all\0${key}`, { section: "client", transport: "all", key, count: client.samples, values: [], batches: [] });
  }

  const rows = [...groups.values()].map((g): SummaryRow => ({
    section: g.section,
    transport: g.transport,
    key: g.key,
    count: g.count,
    p50: percentile(g.values, 50),
    p95: percentile(g.values, 95),
    max: g.values.length ? Math.max(...g.values) : null,
    ...(g.batches.length ? { meanBatch: g.batches.reduce((a, b) => a + b, 0) / g.batches.length } : {}),
  }));
  return rows.sort((a, b) => a.transport.localeCompare(b.transport) || SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.key.localeCompare(b.key));
}

/** One line per row. */
export function formatReport(rows: SummaryRow[]): string {
  const num = (value: number | null) => (value === null ? "-" : String(Math.round(value)));
  const width = (pick: (row: SummaryRow) => string) => Math.max(...rows.map((row) => pick(row).length));
  const transportWidth = width((r) => r.transport);
  const sectionWidth = width((r) => r.section);
  const keyWidth = width((r) => r.key);
  return rows
    .map((r) => {
      const stats = r.p50 === null ? "" : ` p50=${num(r.p50)} p95=${num(r.p95)} max=${num(r.max)}`;
      const batch = r.meanBatch === undefined ? "" : ` batch=${r.meanBatch.toFixed(1)}`;
      return `${r.transport.padEnd(transportWidth)}  ${r.section.padEnd(sectionWidth)}  ${r.key.padEnd(keyWidth)}  n=${r.count}${stats}${batch}`;
    })
    .join("\n");
}

function parseSince(value: string, now: number): number {
  const relative = /^(\d+)([mhd])$/.exec(value);
  if (relative) return now - Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`Not a duration (2h, 30m) or ISO time: ${value}`);
  return time;
}

function readSamples(file: string): Sample[] {
  const samples: Sample[] = [];
  for (const path of [`${file}.1`, file]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const sample: unknown = JSON.parse(line);
        if (typeof sample === "object" && sample !== null) samples.push(sample as Sample);
      } catch {
        // a blank or half-written line
      }
    }
  }
  return samples;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { since: { type: "string" }, until: { type: "string" }, client: { type: "string" }, file: { type: "string" } } });
    const now = Date.now();
    const rows = summarize(readSamples(values.file ?? transportMetricsPath()), {
      since: parseSince(values.since ?? "24h", now),
      until: values.until === undefined ? undefined : parseSince(values.until, now),
      client: values.client,
    });
    console.log(rows.length ? formatReport(rows) : "No samples in range.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
