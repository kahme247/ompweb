// Head-of-line load on one host link, for the link samples (metric "link", lib/hosts/hub.ts and daemon.ts):
//
//   OMP_WEB_TRUSTED_HEADER_SECRET=<secret> bun scripts/link-hol-probe.ts --host <host id> --model <provider/modelId> \
//     [--server http://127.0.0.1:30185] [--cwd /tmp] [--seconds 60]
//
// Against a running omp-web whose server and host both record link samples, it starts three sessions in --cwd on
// --host (the directory must exist there) and runs two phases of --seconds, each with
//   (c) session C answering get_state every 200 ms: small lines both ways, whose ack times are the signal;
// plus, in the `down` phase,
//   (a) prompts to session A, each with a ~4.8 MB PNG made here (the server's per-image cap is 5 MiB; base64 makes the
//       stdin line ~6.5 MB), aborted as soon as omp takes them,
// and in the `up` phase,
//   (b) reads of session B (GET /api/sessions/<B>), which holds ten images (~0.5 MB each once omp re-encodes them),
//       so each read is a ~6.5 MB result blob from the host. readMedia would be the plainer read, but the server keeps
//       a copy of a remote image after its first fetch, so only one read would cross the link; a session read is not
//       cached.
// A and B take one cheap model call per prompt (B one in total, before the phases); C none. Each phase waits 70 s after
// its load stops, so its samples are written (the daemon reports every 30 s, the server then writes every 30 s) before
// the next one starts, then the probe prints the summary command for its window. It deletes the three sessions it
// made, and nothing else, at the end (also on Ctrl-C). OMP_WEB_TRUSTED_HEADER_SECRET goes in `x-omp-web-auth` (as
// pr-watcher sends it); leave it unset for a server without a password.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { percentile } from "./transport-metrics";

const SMALL_EVERY_MS = 200;
const SETTLE_MS = 70_000;
const IDLE_TIMEOUT_MS = 60_000;
// 1270² RGB pixels of noise: incompressible, so the PNG is ~4.8 MB, under the server's 5 MiB per image.
const IMAGE_SIDE = 1270;

const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://127.0.0.1:30185" },
    host: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string", default: "/tmp" },
    seconds: { type: "string", default: "60" },
  },
});
const server = values.server.replace(/\/+$/, "");
const seconds = Number(values.seconds);
const slash = values.model?.indexOf("/") ?? -1;
if (!values.host || !values.model || slash <= 0 || !(seconds > 0)) {
  console.error("usage: bun scripts/link-hol-probe.ts --host <host id> --model <provider/modelId> [--server <url>] [--cwd <dir on the host>] [--seconds 60]");
  process.exit(2);
}
const hostId = values.host;
const model = { provider: values.model.slice(0, slash), modelId: values.model.slice(slash + 1) };

const secret = process.env.OMP_WEB_TRUSTED_HEADER_SECRET;
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
// Ctrl-C cuts a wait short.
const sleep = (ms: number) => delay(ms, undefined, { signal: stop.signal }).catch(() => {});

/** One API call; throws on a status outside 2xx unless `allow` lists it. */
async function api(path: string, init: { method?: string; body?: unknown; allow?: number[] } = {}): Promise<{ bytes: number; json: Record<string, unknown> }> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const response = await fetch(`${server}${path}`, {
    method,
    headers: { ...(secret ? { "x-omp-web-auth": secret } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok && !init.allow?.includes(response.status)) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: the status says enough.
  }
  return { bytes: Buffer.byteLength(text), json };
}

const command = (session: string, body: Record<string, unknown>) => api(`/api/agent/${session}`, { body });

/** A valid PNG of random pixels: 8-bit RGB, or 1-bit gray. */
function noisePng(side: number, rgb: boolean): Buffer {
  const row = 1 + (rgb ? side * 3 : Math.ceil(side / 8));
  const raw = randomBytes(row * side);
  for (let y = 0; y < side; y++) raw[y * row] = 0;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data, crc32(type)));
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = rgb ? 8 : 1; // bits per sample
  header[9] = rgb ? 2 : 0; // RGB or gray
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function waitIdle(session: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (!stop.signal.aborted) {
    const { json } = await command(session, { type: "get_state" });
    if ((json.data as { isStreaming?: unknown } | undefined)?.isStreaming !== true) return;
    if (Date.now() > deadline) throw new Error(`session ${session} still streaming after ${IDLE_TIMEOUT_MS / 1000} s`);
    await sleep(100);
  }
}

const png = noisePng(IMAGE_SIDE, true);
// The server refuses an image over 5 MiB (lib/image-attachments.ts).
assert(png.byteLength <= 5 * 1024 * 1024 && png.byteLength > 4_000_000, `the probe image is ${png.byteLength} bytes`);
const asImage = (bytes: Buffer) => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
const largePrompt = { type: "prompt", message: "omp-web link probe: ignore this image.", images: [asImage(png)] };
// omp stores every image re-encoded as a JPEG of a few hundred KB (the 4.8 MB one comes back ~0.4 MB), so one image
// cannot make B large: B gets ten, 1-bit noise of the same size (~0.2 MB each as PNG, 2 MB together).
const storedPrompt = { type: "prompt", message: "omp-web link probe: ignore these images.", images: Array.from({ length: 10 }, () => asImage(noisePng(IMAGE_SIDE, false))) };

/** One prompt, aborted once omp took it. */
async function promptAndAbort(session: string, body: Record<string, unknown>): Promise<void> {
  await command(session, body);
  await command(session, { type: "abort" });
  await waitIdle(session);
}

const created: string[] = [];
async function newSession(withModel: boolean): Promise<string> {
  const { json } = await api("/api/agent/new", { body: { cwd: values.cwd, hostId, type: "ensure_session", ...(withModel ? model : {}) } });
  if (typeof json.sessionId !== "string") throw new Error(`POST /api/agent/new: no sessionId in ${JSON.stringify(json).slice(0, 300)}`);
  created.push(json.sessionId);
  return json.sessionId;
}

const summaries: string[] = [];

/** `load` back to back while C answers get_state, for --seconds; then the settle wait. */
async function phase(name: string, load: () => Promise<void>, c: string): Promise<void> {
  const start = new Date();
  const deadline = Date.now() + seconds * 1000;
  const running = () => Date.now() < deadline && !stop.signal.aborted;
  const small: number[] = [];
  let rounds = 0;
  console.log(`phase ${name}: ${seconds} s from ${start.toISOString()}`);
  await Promise.all([
    (async () => {
      while (running()) {
        const sent = performance.now();
        await command(c, { type: "get_state" });
        small.push(performance.now() - sent);
        await sleep(SMALL_EVERY_MS);
      }
    })(),
    (async () => {
      for (; running(); rounds++) await load();
    })(),
  ]);
  console.log(`phase ${name}: ${rounds} large rounds; get_state on C over HTTP n=${small.length} p50=${Math.round(percentile(small, 50) ?? 0)} ms p95=${Math.round(percentile(small, 95) ?? 0)} ms; settling ${SETTLE_MS / 1000} s`);
  await sleep(SETTLE_MS);
  summaries.push(`${name}: bun scripts/transport-metrics.ts --since ${start.toISOString()} --until ${new Date().toISOString()}`);
}

try {
  const { json } = await api("/api/hosts");
  const host = (json.hosts as { id: string; status: string }[] | undefined)?.find((h) => h.id === hostId);
  if (host?.status !== "online") throw new Error(`host ${hostId} is ${host ? host.status : "not listed"}`);
  await api("/api/cwd/validate", { body: { cwd: values.cwd, hostId } });

  const a = await newSession(true);
  const b = await newSession(true);
  const c = await newSession(false);
  console.log(`sessions on ${hostId} in ${values.cwd}: A ${a} (image prompts), B ${b} (read), C ${c} (get_state)`);

  // B holds the ten images: from here each read of it is a large result from the host.
  await promptAndAbort(b, storedPrompt);
  const read = await api(`/api/sessions/${b}`);
  console.log(`a read of B is ${(read.bytes / 1e6).toFixed(1)} MB${read.bytes < 1024 * 1024 ? " (under 1 MiB: did the model take the images? not a large frame)" : ""}`);

  if (!stop.signal.aborted) await phase("down", () => promptAndAbort(a, largePrompt), c);
  if (!stop.signal.aborted) await phase("up", async () => { await api(`/api/sessions/${b}`); }, c);
  console.log(summaries.join("\n"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Only what this run made. A session never written (C) answers 404 once its omp is stopped.
  for (const id of created) {
    try {
      await api(`/api/sessions/${id}`, { method: "DELETE", allow: [404] });
    } catch (error) {
      console.error(`could not delete session ${id}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}
