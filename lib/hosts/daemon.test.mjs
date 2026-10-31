import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The daemon in-process against a scripted server (the `fetch` option).
const scratch = mkdtempSync(join(tmpdir(), "omp-web-daemon-test-"));
const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, bin: process.env.OMP_WEB_OMP_BIN };
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
const pidFile = join(scratch, "omp.pid");
process.env.OMP_WEB_OMP_BIN = fakeOmp;
// Windows cannot spawn a shebang script: run it through a .cmd launcher (which wrapWindowsScript routes via cmd.exe).
function writeFakeOmp(file, source) {
  if (process.platform !== "win32") {
    writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return;
  }
  writeFileSync(`${file}.cjs`, source);
  writeFileSync(file, `@"${process.execPath.replaceAll("%", "%%")}" "${file.replaceAll("%", "%%")}.cjs" %*\r\n`);
}
after(() => {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["OMP_WEB_OMP_BIN", saved.bin]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { type } = JSON.parse(line);
  if (type === "flood") for (let i = 0; i < 400; i++) process.stdout.write(JSON.stringify({ type: "x", i, pad: "y".repeat(100_000) }) + "\\n");
  if (type === "huge") process.stdout.write(JSON.stringify({ type: "x", pad: "y".repeat(9 * 1024 * 1024) }) + "\\n");
  if (type === "echo") process.stdout.write('{"type":"echoed"}\\n');
  // Two frames of ~8.7 MB of rpc_chunk lines each, as omp echoes an image prompt (message_start, message_end).
  if (type === "echoes") for (const id of ["start", "end"]) {
    const bytes = Buffer.from(JSON.stringify({ type: "message_" + id, pad: "z".repeat(6_500_000) }));
    const count = Math.ceil(bytes.length / 262144);
    for (let index = 0; index < count; index++) process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: id, index, count, byteLength: bytes.length, data: bytes.subarray(index * 262144, (index + 1) * 262144).toString("base64") }) + "\\n");
  }
});
`);

const jiti = createJiti(import.meta.url);
const { runHostDaemon } = await jiti.import("./daemon.ts");
const { LINK_HELLO_HEADER, LINK_LIMITS, LINK_NONCE_HEADER } = await jiti.import("./link-protocol.ts");
const { RpcFrameDecoder } = await jiti.import("../omp/rpc-frame.ts");
const { RpcProcess } = await jiti.import("../omp/rpc-process.ts");

const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A scripted main server: one downlink at a time, uplink POSTs recorded and acked.
 * Like the hub, it takes the hello as a POST and refuses (409) POSTs and blob
 * uploads that name another link's nonce. `hellos` are the ones a downlink opened. */
function scriptedServer({ getStatus = () => 200, helloStatus = 200 } = {}) {
  const server = { up: [], hellos: [], offered: null, downlink: null, uplinkDown: false, gets: 0, nonce: null, refused: [], blobs: [], postStatus: [] };
  let downSeq = 0;
  let ack = 0;
  server.fetch = async (url, init = {}) => {
    if (init.method === "POST" && init.headers[LINK_HELLO_HEADER]) {
      if (helloStatus !== 200) return Response.json({ error: "This link was replaced; wait for the next welcome" }, { status: helloStatus });
      server.offered = { id: `hello-${server.gets + 1}`, hello: JSON.parse(String(init.body)) };
      return Response.json({ helloId: server.offered.id });
    }
    if (!init.method || init.method === "GET") {
      server.gets += 1;
      const status = getStatus(server.gets);
      if (status !== 200) return Response.json({}, { status });
      assert.equal(init.headers[LINK_HELLO_HEADER], server.offered?.id, "the GET names the hello just posted");
      server.hellos.push(server.offered.hello);
      const body = new ReadableStream({ start(controller) { server.downlink = controller; } });
      const downlink = server.downlink;
      // Like real fetch: aborting the request errors its body.
      init.signal?.addEventListener("abort", () => {
        try { downlink.error(new Error("aborted")); } catch { /* already closed */ }
      });
      server.nonce = `link-${server.gets}`;
      server.raw({ type: "welcome", v: 1, hostId: "h1", nonce: server.nonce });
      return new Response(body);
    }
    const blob = /\/blob\/(.+)$/.exec(String(url));
    if (init.headers[LINK_NONCE_HEADER] !== server.nonce) {
      server.refused.push(blob ? `blob ${blob[1]}` : "post");
      return Response.json({}, { status: 409 });
    }
    if (blob) {
      server.blobs.push(blob[1]);
      return Response.json({ ok: true });
    }
    if (server.uplinkDown) throw new TypeError("fetch failed");
    const status = server.postStatus.shift();
    if (status) return Response.json({}, { status });
    const messages = String(init.body).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    server.up.push(...messages);
    for (const message of messages) if (Number.isInteger(message.seq)) ack = Math.max(ack, message.seq);
    return Response.json({ ack });
  };
  server.raw = (message) => server.downlink.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  server.send = (message) => {
    downSeq += 1;
    server.raw({ ...message, seq: downSeq });
    return downSeq;
  };
  server.res = (id) => server.up.find((m) => m.type === "res" && m.id === id);
  return server;
}

function start(server) {
  return runHostDaemon({ url: "http://127.0.0.1:9", token: "t", allowHttp: false, fetch: server.fetch });
}

async function spawnChannel(server, ch) {
  server.send({ type: "req", id: `spawn-${ch}`, op: "spawn", args: { ch, cwd: scratch, recordedCwd: null, sessionFile: "", advisor: false } });
  await waitFor(() => server.res(`spawn-${ch}`), "the spawn result");
  assert.equal(server.res(`spawn-${ch}`).ok, true, JSON.stringify(server.res(`spawn-${ch}`)));
}

function captureLog() {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  return { lines, restore: () => { console.error = original; } };
}

test("an http:// server needs loopback or --allow-http", () => {
  assert.throws(() => runHostDaemon({ url: "http://example.com", token: "t", allowHttp: false, fetch: async () => Response.json({}, { status: 503 }) }), /https:\/\//);
});

test("ops outside the allow-list are refused and a resent downlink seq runs once", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    assert.equal(server.hellos[0].ack, 0);
    server.raw({ type: "req", seq: 1, id: "r1", op: "exec", args: { command: "id" } });
    const listing = { type: "req", seq: 2, id: "r2", op: "listProjects", args: {} };
    server.raw(listing);
    server.raw(listing);
    await waitFor(() => server.res("r1") && server.res("r2"), "both results");
    await sleep(100);
    assert.deepEqual(server.res("r1").error, { status: 400, code: "invalid_request", message: "unknown host op: exec" });
    assert.equal(server.res("r2").ok, true);
    assert.equal(server.up.filter((m) => m.id === "r2").length, 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
  assert.equal(await daemon.done, 0);
});

test("output beyond the channel buffer while the uplink is down is dropped, then resync", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, "c1");
    server.uplinkDown = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"flood"}\n' });
    // 40 MB of output, read by the daemon well within this pause.
    await sleep(1_500);
    server.uplinkDown = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "c1"), "resync");
    const floodLines = server.up.filter((m) => m.type === "stdout" && m.ch === "c1").length;
    assert.ok(floodLines < 400, `dropped output must not arrive (${floodLines} lines did)`);
    // Output flows again after the resync.
    server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line === '{"type":"echoed"}'), "output after resync");
    const resyncAt = server.up.findIndex((m) => m.type === "resync");
    const echoAt = server.up.findIndex((m) => m.line === '{"type":"echoed"}');
    assert.ok(resyncAt < echoAt);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

/** The frames in a channel's up messages through omp's chunk decoder, never
 * reset, so output dropped from inside a frame throws. */
function framesUp(messages) {
  const decoder = new RpcFrameDecoder();
  const frames = [];
  let open = false;
  for (const m of messages) {
    if (m.type === "resync") {
      assert.equal(open, false, "a resync inside a chunk sequence");
      frames.push("resync");
    } else if (m.type === "stdout") {
      const frame = decoder.push(JSON.parse(m.line));
      open = frame === undefined;
      if (frame) frames.push(frame.type);
    }
  }
  return frames;
}

/** The channel's messages main gets for the two echoes, written while no POST gets through. */
async function echoesWithoutAck(ch) {
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, ch);
    server.uplinkDown = true;
    server.send({ type: "stdin", ch, line: '{"type":"echoes"}\n' });
    // ~17 MB of output, read by the daemon well within this pause.
    await sleep(1_500);
    server.uplinkDown = false;
    // Settled: the last thing up is a resync or the second echo's last chunk.
    await waitFor(() => {
      const last = server.up.findLast((m) => m.ch === ch);
      if (last?.type === "resync") return true;
      const record = last?.type === "stdout" ? JSON.parse(last.line) : null;
      return record?.chunkId === "end" && record.index === record.count - 1;
    }, "the echoes or a resync");
    return server.up.filter((m) => m.ch === ch);
  } finally {
    await daemon.stop();
  }
}

test("an overflow drops the backlog mid chunk sequence: main's RpcProcess resets, skips the tail, and decodes the next frame", async () => {
  const log = captureLog();
  const saved = LINK_LIMITS.channelBufferBytes;
  // Smaller than one echo, so the backlog overflows twice over.
  LINK_LIMITS.channelBufferBytes = 4 * 1024 * 1024;
  try {
    const messages = await echoesWithoutAck("drop");
    assert.ok(messages.some((m) => m.type === "resync"), "the overflow sent a resync");
    const listeners = { line: [], resync: [], exit: [] };
    const transport = {
      endInputCalls: 0,
      write(line, callback) {
        const { id, type } = JSON.parse(line);
        callback(null);
        const data = type === "negotiate_protocol" ? { protocolVersion: 2 } : undefined;
        queueMicrotask(() => { for (const l of listeners.line) l(JSON.stringify({ type: "response", id, command: type, success: true, data })); });
      },
      onLine(l) { listeners.line.push(l); },
      onStderr() {},
      onExit(l) { listeners.exit.push(l); },
      onResync(l) { listeners.resync.push(l); },
      endInput() {
        transport.endInputCalls += 1;
        queueMicrotask(() => { for (const l of listeners.exit) l(0, null); });
      },
    };
    const proc = new RpcProcess({ cwd: process.cwd(), transport });
    queueMicrotask(() => { for (const l of listeners.line) l('{"type":"ready"}'); });
    await proc.waitReady();
    await proc.negotiateProtocol({ type: "ready", supportedProtocolVersions: [2] });
    const frames = [];
    proc.onFrame((frame) => frames.push(frame.type));
    // Replay what the daemon sent, as RemoteRpcTransport hands it to RpcProcess.
    for (const m of messages) {
      if (m.type === "resync") for (const l of listeners.resync) l();
      else if (m.type === "stdout") for (const l of listeners.line) l(m.line);
    }
    for (const l of listeners.line) l('{"type":"agent_end"}');
    assert.equal(frames.at(-1), "agent_end", "a frame after the resync decodes");
    assert.equal(transport.endInputCalls, 0, "no decode error disposed the child");
    assert.equal(proc.isAlive, true);
    await proc.dispose(0);
  } finally {
    LINK_LIMITS.channelBufferBytes = saved;
    log.restore();
  }
});

test("an image prompt's two echoes fit the channel buffer with no ack: both go up whole, without a resync", async () => {
  const log = captureLog();
  try {
    assert.deepEqual(framesUp(await echoesWithoutAck("fit")), ["message_start", "message_end"]);
  } finally {
    log.restore();
  }
});

test("a stdout line over the link limit is dropped for a resync", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, "big");
    server.send({ type: "stdin", ch: "big", line: '{"type":"huge"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "big"), "resync");
    server.send({ type: "stdin", ch: "big", line: '{"type":"echo"}\n' });
    await waitFor(() => server.up.some((m) => m.ch === "big" && m.line === '{"type":"echoed"}'), "output after the oversize line");
    assert.equal(server.up.some((m) => m.ch === "big" && m.type === "stdout" && m.line.length > 1_000), false, "the oversize line never goes up");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a 401 on redial (revoked) kills every omp child and exits 1", async () => {
  const log = captureLog();
  rmSync(pidFile, { force: true });
  const server = scriptedServer({ getStatus: (n) => (n === 1 ? 200 : 401) });
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, "c1");
    await waitFor(() => existsSync(pidFile), "the child");
    const pid = Number(readFileSync(pidFile, "utf8"));
    server.downlink.close();
    assert.equal(await daemon.done, 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(log.lines.some((line) => line.includes("revoked")));
  } finally {
    log.restore();
  }
});

test("426 exits 1 asking for an upgrade; replaced exits 0", async () => {
  const log = captureLog();
  try {
    const outdated = start(scriptedServer({ getStatus: () => 426 }));
    assert.equal(await outdated.done, 1);
    assert.ok(log.lines.some((line) => line.includes("upgrade omp-web on this host")));

    const server = scriptedServer();
    const replaced = start(server);
    await waitFor(() => server.downlink, "the downlink");
    server.send({ type: "replaced" });
    assert.equal(await replaced.done, 0);
  } finally {
    log.restore();
  }
});

test("a main that does not understand the hello POST (an older ompweb) exits 1 asking to upgrade it, once", async () => {
  const log = captureLog();
  try {
    // A v1 main answers a POST with no link nonce 409 ("replaced"); a missing route is 404.
    for (const helloStatus of [409, 404]) {
      const server = scriptedServer({ helloStatus });
      assert.equal(await start(server).done, 1);
      assert.equal(server.gets, 0, "no downlink is dialed");
    }
    assert.equal(log.lines.filter((line) => line.includes("the server runs an older ompweb: upgrade it")).length, 2);
  } finally {
    log.restore();
  }
});

test("a POST or blob upload refused as from a replaced link is resent on the next link", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    const hash = "a".repeat(64);
    const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
    mkdirSync(dirname(media), { recursive: true });
    writeFileSync(media, "image-bytes");
    // Main has moved on to a newer link this daemon has not seen yet.
    server.nonce = "newer";
    server.send({ type: "req", id: "m1", op: "readMedia", args: { hash } });
    await waitFor(() => server.refused.includes("blob m1"), "the blob refusal");
    // Held, not posted, until the next welcome.
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await sleep(100);
    assert.deepEqual(server.refused, ["blob m1"]);
    server.downlink.close();
    await waitFor(() => server.res("m1") && server.res("p1"), "both results on the new link");
    assert.deepEqual(server.blobs, ["m1"]);
    assert.deepEqual(server.res("m1").blob, { bytes: "image-bytes".length });

    // The same for an uplink POST.
    server.nonce = "newer-again";
    server.send({ type: "req", id: "p2", op: "listProjects", args: {} });
    await waitFor(() => server.refused.includes("post"), "the POST refusal");
    server.downlink.close();
    await waitFor(() => server.res("p2"), "the result on the next link");
    // Each result arrived once.
    assert.deepEqual(server.up.filter((m) => m.type === "res").map((m) => m.id).sort(), ["m1", "p1", "p2"]);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("5xx answers are retried and the omp children keep running", async () => {
  const log = captureLog();
  rmSync(pidFile, { force: true });
  // The redial after the first link fails once, as when main cannot read its host registry.
  const server = scriptedServer({ getStatus: (n) => (n === 2 ? 503 : 200) });
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, "c1");
    await waitFor(() => existsSync(pidFile), "the child");
    const pid = Number(readFileSync(pidFile, "utf8"));
    server.postStatus.push(503);
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result after a 503 POST");
    server.downlink.close();
    await waitFor(() => server.hellos.length === 2, "the relink after a 503 GET");
    assert.equal(server.gets, 3);
    assert.deepEqual(server.hellos[1].channels.map((c) => c.ch), ["c1"]);
    assert.doesNotThrow(() => process.kill(pid, 0), "the omp child is still running");
  } finally {
    await daemon.stop();
    log.restore();
  }
  assert.equal(await daemon.done, 0);
});

test("spawn reports a fallback when a new session's cwd is missing on this host", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    const gone = join(scratch, "gone");
    server.send({ type: "req", id: "s1", op: "spawn", args: { ch: "c1", cwd: gone, recordedCwd: null, sessionFile: "", advisor: false } });
    await waitFor(() => server.res("s1"), "the spawn result");
    const { result } = server.res("s1");
    assert.equal(result.fellBack, true);
    assert.notEqual(result.cwd, gone);
  } finally {
    await daemon.stop();
    log.restore();
  }
});
