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
  "isolation event ms", "isolation action ms", "sockets", "pool size", "clock offsetRtt", "rebalance moved", "rebalance settledMs",
  "hang", "resend", "deduped", "outcome", "client",
];
// Mirrors public/event-stream-worker.js: the downlink logs frames from this size, and the uplink counts as blocking from it.
const LARGE_FRAME_BYTES = 64 * 1024;

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

/** totalMs − serverMs: clock-free, and what the transport added to an action. */
function transportMsOf(s: Sample): number | undefined {
  const totalMs = diff(s.gotAt, s.sentAt);
  const serverMs = diff(s.repliedAt, s.recvAt);
  return totalMs !== undefined && serverMs !== undefined ? totalMs - serverMs : undefined;
}

/**
 * Spec D6 cross-session blocking, the same in every transport: behind at least LARGE_FRAME_BYTES of another session
 * (uplink or reply), else of its own, else clear when every field was measured, else unknown. A lone small command
 * in flight ahead (an HTTP POST, an unacked frame) is not blocking. Undefined for a sample without the fields.
 */
function isolation(s: Sample): "other" | "same" | "clear" | "unknown" | undefined {
  const fields = s.metric === "action" ? [s.behindOtherBytes, s.behindSameBytes, s.replyBehindOtherBytes] : [s.behindOtherBytes, s.behindSameBytes];
  if (fields.every((field) => field === undefined)) return undefined;
  const blocking = (field: unknown) => (asNumber(field) ?? 0) >= LARGE_FRAME_BYTES;
  if (blocking(s.behindOtherBytes) || blocking(s.replyBehindOtherBytes)) return "other";
  if (blocking(s.behindSameBytes)) return "same";
  return fields.every((field) => asNumber(field) !== undefined) ? "clear" : "unknown";
}

/**
 * A WS hang is a missed ack: the transport stalled. An HTTP hang is a missed response, so it is a stall only when the
 * transport alone took the ack formula's time (its action's transportMs ≥ waitedMs), else the server's time made the
 * command slow; unclassified without that action's times.
 */
function hangKind(s: Sample, transportByReq: Map<unknown, number | undefined>): string {
  if (s.via !== "http") return "stalled";
  const transportMs = transportByReq.get(s.req);
  const waitedMs = asNumber(s.waitedMs);
  if (transportMs === undefined || waitedMs === undefined) return "unclassified";
  return transportMs >= waitedMs ? "stalled" : "slow command";
}

/**
 * A reconnect's trigger family, so the rows line up across transports: a socket's silence and hang are how it notices
 * the dead connection an EventSource reports as `error`; a network wake is split by whether the effective type changed
 * (`navigator.connection` `change` also fires on RTT or downlink drift, when WS redials healthy sockets).
 */
function reconnectFamily(s: Sample): string {
  switch (s.trigger) {
    case "error":
    case "close":
    case "silence":
    case "hang":
    case "end":
      return "error/close";
    case "online":
    case "visible":
      return "online/visible";
    case "network":
      return s.effectiveTypeBefore !== s.effectiveType ? "network (type changed)" : "network (same type)";
    default:
      return asString(s.trigger) ?? "unknown";
  }
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
  const transportByReq = new Map(samples.filter((s) => s.metric === "action" && typeof s.req === "string").map((s) => [s.req, transportMsOf(s)]));

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
    addValue("clock offsetRtt", transport, "all", asNumber(s.offsetRtt));
    const isolated = isolation(s);

    if (s.metric === "action") {
      const type = asString(s.type);
      const totalMs = diff(s.gotAt, s.sentAt);
      const sentAt = asNumber(s.sentAt);
      const offset = asNumber(s.offset);
      const upMs = sentAt === undefined || offset === undefined ? undefined : diff(s.recvAt, sentAt + offset);
      const transportMs = transportMsOf(s);
      for (const [section, value] of [["action totalMs", totalMs], ["action transportMs", transportMs], ["action upMs", upMs]] as const) {
        addValue(section, transport, "all", value);
        if (type) addValue(section, transport, type, value);
      }
      if (type?.startsWith("abort")) addValue("abort behind upload", transport, (asNumber(s.behindBytes) ?? 0) > 0 ? "yes" : "no", totalMs);
      // transportMs, not totalMs: the server's time differs by command type, not by what the pipe was carrying.
      if (isolated) addValue("isolation action ms", transport, isolated, transportMs);
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
      const key = reconnectFamily(s);
      addValue("reconnect ms", transport, key, diff(s.firstFrameAt, s.startAt), asNumber(s.batch));
      addValue("reconnect fromDropMs", transport, key, diff(s.firstFrameAt, s.dropAt));
    } else if (s.metric === "rebalance") {
      const reason = asString(s.reason) ?? "unknown";
      addValue("rebalance moved", transport, reason, asNumber(s.moved));
      addValue("rebalance settledMs", transport, reason, asNumber(s.settledMs));
    } else if (s.metric === "hang") {
      add("hang", transport, "total");
      if (answered.has(s.req)) add("hang", transport, "answered later");
      add("hang", transport, hangKind(s, transportByReq));
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
