import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// The daemon in-process against a scripted server on a real WebSocket (`bun test`).
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
const servers = [];
after(() => {
  for (const server of servers) server.stop();
  for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["OMP_WEB_OMP_BIN", saved.bin]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

// The fixture's flood and echoes sizes, shared with the tests that wait for the daemon to read them.
const FLOOD_LINES = 400;
const FLOOD_PAD = 100_000;
const ECHO_PAD = 6_500_000;
const ECHO_CHUNK = 262_144;
/** The flood's output in bytes, less the line envelope. Once all but a buffer's worth is dropped, the daemon has read
 * it all but a few lines. */
const FLOOD_BYTES = FLOOD_LINES * FLOOD_PAD;
/** The echoes' base64 data in bytes, less the line envelope: never above what the daemon queues, so waiting for
 * ECHOES_BYTES minus the buffer cannot hang. */
const ECHOES_BYTES = ["start", "end"].reduce((sum, id) => sum + Math.ceil(Buffer.byteLength(JSON.stringify({ type: `message_${id}`, pad: "z".repeat(ECHO_PAD) })) / 3) * 4, 0);

writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const { type } = command;
  if (type === "state") process.stdout.write(JSON.stringify({ type: "response", id: "g1", command: "get_state", success: true, data: { sessionId: command.sessionId } }) + "\\n");
  if (type === "flood") for (let i = 0; i < ${FLOOD_LINES}; i++) process.stdout.write(JSON.stringify({ type: "x", i, pad: "y".repeat(${FLOOD_PAD}) }) + "\\n");
  if (type === "many") for (let i = 0; i < 25000; i++) process.stdout.write("1\\n");
  if (type === "parts") for (let i = 0; i < command.n; i++) process.stdout.write(JSON.stringify({ type: "p", i, pad: "q".repeat(400_000) }) + "\\n");
  if (type === "cjk") for (let i = 0; i < 100; i++) process.stdout.write(JSON.stringify({ type: "c", i, text: "漢".repeat(10_000) }) + "\\n");
  if (type === "huge") process.stdout.write(JSON.stringify({ type: "x", pad: "y".repeat(9 * 1024 * 1024) }) + "\\n");
  if (type === "echo") process.stdout.write('{"type":"echoed"}\\n');
  // Two frames of ~8.7 MB of rpc_chunk lines each, as omp echoes an image prompt (message_start, message_end).
  if (type === "echoes") for (const id of ["start", "end"]) {
    const bytes = Buffer.from(JSON.stringify({ type: "message_" + id, pad: "z".repeat(${ECHO_PAD}) }));
    const count = Math.ceil(bytes.length / ${ECHO_CHUNK});
    for (let index = 0; index < count; index++) process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: id, index, count, byteLength: bytes.length, data: bytes.subarray(index * ${ECHO_CHUNK}, (index + 1) * ${ECHO_CHUNK}).toString("base64") }) + "\\n");
  }
  if (type === "ask") process.stdout.write('{"type":"extension_ui_request","id":"q1","method":"ask","questions":[]}\\n');
});
`);

/** The daemon's WebSocket with a send buffer the test controls, as a slow link has one: unless the link is
 * unthrottled, `send` queues the frame (counted in `bufferedAmount`) and a 5 ms tick hands the real socket
 * `uplink.bytesPerTick` bytes of them on average, nothing while `uplink.paused`. `uplink.hideBuffer`: the queue sits
 * below the socket, as in kernel and proxy buffers, so `bufferedAmount` does not show it. `uplink.maxBuffered`: the
 * most the queue held. */
const uplink = { paused: false, bytesPerTick: Infinity, hideBuffer: false, maxBuffered: 0 };
const sizeOf = (data) => (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
globalThis.WebSocket = class SlowWebSocket extends globalThis.WebSocket {
  queue = [];
  queued = 0;
  credit = 0;
  get bufferedAmount() {
    return (uplink.hideBuffer ? 0 : this.queued) + super.bufferedAmount;
  }
  send(data) {
    if (!this.timer && !uplink.paused && uplink.bytesPerTick === Infinity) return super.send(data);
    this.queue.push(data);
    this.queued += sizeOf(data);
    uplink.maxBuffered = Math.max(uplink.maxBuffered, this.queued);
    this.timer ??= setTimeout(() => this.tick(), 5);
  }
  tick() {
    this.timer = undefined;
    if (this.readyState > 1) return;
    if (!uplink.paused) {
      // A frame larger than one tick's bytes leaves a debt the next ticks pay off.
      this.credit = Math.min(this.credit + uplink.bytesPerTick, uplink.bytesPerTick);
      while (this.credit > 0 && this.queue.length > 0) {
        const data = this.queue.shift();
        this.queued -= sizeOf(data);
        this.credit -= sizeOf(data);
        super.send(data);
      }
    }
    if (this.queue.length > 0 || this.credit < 0) this.timer = setTimeout(() => this.tick(), 5);
  }
};
test.afterEach(() => Object.assign(uplink, { paused: false, bytesPerTick: Infinity, hideBuffer: false, maxBuffered: 0 }));

const { nextRedialDelay, runHostDaemon } = await import("./daemon.ts");
const { decodeBlobFrame, LINK_LIMITS, LINK_PROTOCOL_VERSION, PartJoiner } = await import("./link-protocol.ts");
const { RpcFrameDecoder } = await import("../omp/rpc-frame.ts");
const { RpcProcess } = await import("../omp/rpc-process.ts");

const decoder = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Wait until the daemon has logged dropping at least `bytes` of a channel's backlog. A fixed sleep guesses how fast
 * the daemon reads a child's output; a slow runner misses the overflow and the uplink resumes before it. */
async function waitForDropped(log, bytes, what = "the overflow") {
  const dropped = () => log.lines.reduce((sum, line) => sum + Number(/dropped (\d+) bytes/.exec(line)?.[1] ?? 0), 0);
  // Under the suite's 30 s per-test timeout, so this message names the stall rather than the runner's timeout.
  await waitFor(() => dropped() >= bytes, what, 25_000);
}

/** A scripted main server. `gets` counts upgrade attempts; `refuse(n)` answers the nth with a status (null: upgrade);
 * a plain GET (the daemon's diagnosis) gets the status the latest attempt got, or 426 after an upgrade, as the hub
 * answers. A socket's first frame is its hello, answered `welcome`; later text frames are split into `acks` (their
 * leading `ack` line) and `up` (`part`s joined into their line); binary frames land in `blobs`. Every frame is
 * answered with an `ack`, as the hub does, unless `holdAcks` (clearing it answers the held frames). `frames` lists
 * every frame after a hello in arrival order. */
function scriptedServer({ refuse = () => null, validToken = null } = {}) {
  let downSeq = 0;
  let ack = 0;
  let latest = 426;
  let socket = null;
  let held = 0;
  let holdAcks = false;
  const joiner = new PartJoiner();
  let partSeq = 0;
  const sendAck = (ws) => ws.send(JSON.stringify({ type: "ack", ack }));
  const server = {
    refuse, validToken, hellos: [], helloTimes: [], upAtHello: [], up: [], acks: [], blobs: [], frames: [], textFrameBytes: [], gets: 0, diagnoses: 0,
    /** Runs when a hello arrives, before its welcome goes. */
    onHello: null,
    get holdAcks() { return holdAcks; },
    set holdAcks(value) {
      holdAcks = value;
      if (!value && socket) for (; held > 0; held--) sendAck(socket);
      held = 0;
    },
  };
  const answer = (ws) => {
    if (holdAcks) held += 1;
    else sendAck(ws);
  };
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, bun) {
      const unauthorized = server.validToken && req.headers.get("authorization") !== `Bearer ${server.validToken}` ? 401 : null;
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        server.diagnoses += 1;
        return Response.json({}, { status: unauthorized ?? latest });
      }
      server.gets += 1;
      const status = unauthorized ?? server.refuse(server.gets);
      latest = status ?? 426;
      if (status) return Response.json({}, { status });
      return bun.upgrade(req, { data: { hello: false } }) ? undefined : Response.json({}, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string") {
          const { id, bytes } = decodeBlobFrame(data);
          server.blobs.push({ id, bytes: decoder.decode(bytes) });
          server.frames.push({ blob: id });
          answer(ws);
          return;
        }
        if (!ws.data.hello) {
          ws.data.hello = true;
          socket = ws;
          held = 0;
          server.hellos.push(JSON.parse(data));
          server.helloTimes.push(Date.now());
          server.upAtHello.push(server.up.length);
          server.onHello?.();
          server.raw({ type: "welcome", v: LINK_PROTOCOL_VERSION, hostId: "h1" });
          return;
        }
        server.textFrameBytes.push(Buffer.byteLength(data));
        const messages = data.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        server.acks.push(messages[0]?.type === "ack" ? messages.shift().ack : "missing");
        server.frames.push(messages);
        for (const message of messages) {
          if (Number.isInteger(message.seq)) ack = Math.max(ack, message.seq);
          if (message.type !== "part") server.up.push(message);
          else if (message.seq > partSeq) {
            // Joined as the hub does: `up` gets the whole line once.
            partSeq = message.seq;
            const line = joiner.add(message);
            if (line !== null) server.up.push(JSON.parse(line));
          }
        }
        answer(ws);
      },
    },
  });
  server.url = `http://127.0.0.1:${http.port}`;
  server.raw = (message) => socket.send(JSON.stringify(message));
  server.send = (message) => {
    downSeq += 1;
    server.raw({ ...message, seq: downSeq });
    return downSeq;
  };
  server.close = (code, reason) => socket.close(code, reason);
  server.drop = () => socket.terminate();
  server.res = (id) => server.up.find((m) => m.type === "res" && m.id === id);
  server.stop = () => http.stop(true);
  servers.push(server);
  return server;
}

/** A loopback URL nothing listens on. */
function deadUrl() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const url = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  return url;
}

function start(server) {
  return runHostDaemon({ url: server.url, token: "t", allowHttp: false });
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

test("an http:// loopback server links without --allow-http", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the link over http://127.0.0.1");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a running host deletes expired staged uploads every hour, not only when it starts or takes an upload", async (t) => {
  const log = captureLog();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const server = scriptedServer();
  const daemon = start(server);
  const staged = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads");
  try {
    await waitFor(() => server.hellos.length === 1, "the link");
    // A cancel that never arrived left this behind after the start-up sweep ran.
    mkdirSync(staged, { recursive: true });
    const leftover = join(staged, "0e5b4d2c-1f3a-4b6c-8d7e-9f0a1b2c3d4e.part");
    writeFileSync(leftover, "x");
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
    utimesSync(leftover, twoDaysAgo, twoDaysAgo);
    t.mock.timers.tick(60 * 60_000);
    await waitFor(() => !existsSync(leftover), "the hourly sweep");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("the hello reports this host's extension auto-approve", async () => {
  const log = captureLog();
  const config = join(process.env.PI_CODING_AGENT_DIR, "config.yml");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "tools:\n  approval:\n    extension: allow\n");
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    assert.equal(server.hellos[0].autoApproveExtension, true);
  } finally {
    await daemon.stop();
    rmSync(config, { force: true });
    log.restore();
  }
});

test("a spawned omp loads the session-edit extension whatever the daemon's working directory", () => {
  const argvFile = join(scratch, "argv.json");
  const recorder = join(scratch, process.platform === "win32" ? "argv-omp.cmd" : "argv-omp");
  writeFakeOmp(recorder, `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));`);
  const localHostFile = fileURLToPath(new URL("./local-host.ts", import.meta.url));
  // A daemon unit runs in HOME, not in the package: a fresh process, as the module resolves the path on load.
  const script = `const { localHost } = await import(${JSON.stringify(localHostFile)});
await localHost.spawnRpc({ cwd: ${JSON.stringify(scratch)}, recordedCwd: null, sessionFile: "", advisor: false });`;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: scratch, env: { ...process.env, OMP_WEB_OMP_BIN: recorder }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const args = JSON.parse(readFileSync(argvFile, "utf8"));
  const extension = args[args.indexOf("--extension") + 1];
  assert.ok(existsSync(extension), extension);
});

test("hostnames that only look like loopback need --allow-http", () => {
  for (const url of ["http://localhost.evil.com", "http://127.0.0.1.nip.io", "http://evil-localhost", "http://127.0.0.1@example.com"]) {
    assert.throws(() => runHostDaemon({ url, token: "t", allowHttp: false }), /https:\/\//, url);
  }
});

test("an http:// server needs loopback or --allow-http", () => {
  assert.throws(() => runHostDaemon({ url: "http://example.com", token: "t", allowHttp: false }), /https:\/\//);
});

test("an unknown op is answered 501 unknown_op and a resent downlink seq runs once", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    assert.equal(server.hellos[0].ack, 0);
    server.raw({ type: "req", seq: 1, id: "r1", op: "exec", args: { command: "id" } });
    const listing = { type: "req", seq: 2, id: "r2", op: "listProjects", args: {} };
    server.raw(listing);
    server.raw(listing);
    await waitFor(() => server.res("r1") && server.res("r2"), "both results");
    await sleep(100);
    assert.deepEqual(server.res("r1").error, { status: 501, code: "unknown_op", message: "Unknown host op: exec" });
    assert.equal(server.res("r2").ok, true);
    assert.equal(server.up.filter((m) => m.id === "r2").length, 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
  assert.equal(await daemon.done, 0);
});

test("an unknown op gets a 501 res, not a refused line", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "r1", op: "exec", args: { command: "id" } });
    await waitFor(() => server.res("r1"), "the answer");
    assert.deepEqual(server.res("r1"), { type: "res", seq: server.res("r1").seq, id: "r1", ok: false, error: { status: 501, code: "unknown_op", message: "Unknown host op: exec" } });
    assert.ok(!log.lines.some((line) => line.includes("malformed")), log.lines.join("|"));
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("an unknown downlink message is skipped and acked, noted once, and later ones still run", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.raw({ type: "future", seq: 1, x: 1 });
    server.raw({ type: "future", seq: 2 });
    server.raw({ type: "ping" });
    await waitFor(() => server.acks.includes(2), "an uplink frame acking both unknown messages");
    server.raw({ type: "req", seq: 3, id: "r3", op: "listProjects", args: {} });
    await waitFor(() => server.res("r3"), "the result after the unknown messages");
    assert.equal(server.res("r3").ok, true);
    assert.equal(log.lines.filter((line) => line.includes('"future"')).length, 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
  assert.equal(await daemon.done, 0);
});

test("unknown-message notes are capped per link, escaped, and start again on a new link", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    for (let i = 0; i < 20; i++) server.send({ type: `t${i}` });
    server.send({ type: "evil\n\u001b[31m" + "x".repeat(100_000) });
    server.send({ type: "stdout", ch: "c", line: "x" });
    server.send({ type: "stdout", ch: "c", line: "x" });
    server.send({ type: "req", id: "r1", op: "listProjects", args: {} });
    await waitFor(() => server.res("r1"), "the result after the flood");
    const notes = log.lines.filter((line) => /ignored an unknown|is not valid from/.test(line));
    assert.equal(notes.filter((line) => line.includes("ignored an unknown")).length, 16);
    assert.equal(notes.filter((line) => line.includes('"stdout" is not valid from the server')).length, 2);
    assert.ok(notes.every((line) => !/[\n\u001b]/.test(line) && line.length < 200));
    // A new link: the same type is noted again.
    const before = log.lines.filter((line) => line.includes('"t0"')).length;
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the redial");
    server.send({ type: "t0" });
    server.send({ type: "req", id: "r2", op: "listProjects", args: {} });
    await waitFor(() => server.res("r2"), "the result on the new link");
    assert.equal(log.lines.filter((line) => line.includes('"t0"')).length, before + 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("each uplink frame starts with the ack of the applied downlink, and the next goes without waiting for the hub's ack", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const echoes = () => server.up.filter((m) => m.type === "stdout" && m.line === '{"type":"echoed"}').length;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    const first = server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => echoes() === 1, "the first echo");
    assert.equal(server.acks.at(-1), first);
    const second = server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => echoes() === 2, "the second echo with the first frame unacked");
    assert.equal(server.acks.at(-1), second);
    server.holdAcks = false;
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a large result goes as one binary frame before its res", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    const hash = "a".repeat(64);
    const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
    mkdirSync(dirname(media), { recursive: true });
    writeFileSync(media, "image-bytes");
    server.send({ type: "req", id: "m1", op: "readMedia", args: { hash } });
    await waitFor(() => server.res("m1"), "the result");
    assert.deepEqual(server.blobs, [{ id: "m1", bytes: "image-bytes" }]);
    assert.deepEqual(server.res("m1").blob, { bytes: "image-bytes".length });
    const blobAt = server.frames.findIndex((frame) => frame.blob === "m1");
    const resAt = server.frames.findIndex((frame) => Array.isArray(frame) && frame.some((m) => m.id === "m1"));
    assert.ok(blobAt !== -1 && blobAt < resAt, `blob in frame ${blobAt}, res in frame ${resAt}`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("acked uplink messages are reported in stats messages of at most statsSamples; a result blob counts as bytes ahead", async (t) => {
  const saved = { statsSamples: LINK_LIMITS.statsSamples, statsFlushMs: LINK_LIMITS.statsFlushMs };
  Object.assign(LINK_LIMITS, { statsSamples: 2, statsFlushMs: 200 });
  t.after(() => Object.assign(LINK_LIMITS, saved));
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const session = "11111111-2222-4333-8444-0000000000cc";
  const reports = () => server.up.filter((m) => m.type === "stats");
  const sampled = () => reports().flatMap((m) => m.samples);
  const lineBytes = (message) => Buffer.byteLength(`${JSON.stringify(message)}\n`);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    // The child names its session in a get_state answer: that output is the session's.
    server.send({ type: "stdin", ch: "c1", line: `${JSON.stringify({ type: "state", sessionId: session })}\n` });
    await waitFor(() => sampled().length === 2, "the spawn result's and the output's samples");

    const hash = "b".repeat(64);
    const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
    mkdirSync(dirname(media), { recursive: true });
    writeFileSync(media, "m".repeat(100_000));
    server.holdAcks = true;
    server.send({ type: "req", id: "m2", op: "readMedia", args: { hash } });
    server.send({ type: "req", id: "x1", op: "nope", args: {} });
    server.send({ type: "req", id: "x2", op: "nope", args: {} });
    await waitFor(() => server.res("m2"), "the media result");
    server.holdAcks = false;
    await waitFor(() => sampled().length === 5, "five samples");

    assert.ok(reports().every((m) => m.samples.length <= 2), JSON.stringify(reports().map((m) => m.samples.length)));
    const [spawned, output, ...rest] = sampled();
    assert.deepEqual([spawned.session, spawned.bytes, spawned.bytesAhead], [null, lineBytes(server.res("spawn-c1")), 0]);
    assert.equal(output.session, session);
    const resultBytes = lineBytes(server.res("m2")) + 100_000;
    // Acked in the order fair sending put them on the wire (the errors may pass the result's pieces).
    const result = rest.find((sample) => sample.bytes === resultBytes);
    assert.equal(result?.bytesAhead, 0);
    const [first, second] = rest.filter((sample) => sample !== result).sort((a, b) => a.bytesAhead - b.bytesAhead);
    // Queued while the result, its bytes and the first error were queued or unacked. A message still queued counts at
    // its size before its seq is filled in: up to 15 bytes more per message ahead.
    const near = (actual, expected, ahead) => assert.ok(actual >= expected && actual <= expected + 15 * ahead, `${actual} vs ${expected}`);
    near(first.bytesAhead, resultBytes, 1);
    near(second.bytesAhead, resultBytes + lineBytes(server.res("x1")), 2);
    for (const { ackMs, at } of sampled()) assert.ok(Number.isSafeInteger(ackMs) && ackMs >= 0 && at > 0, JSON.stringify({ ackMs, at }));
  } finally {
    await daemon.stop();
    log.restore();
  }
});

/** The daemon's link samples as the scripted server got them, with LINK_LIMITS' stats settings set for one test. */
function statsOf(t, server, limits) {
  const saved = { statsSamples: LINK_LIMITS.statsSamples, statsFlushMs: LINK_LIMITS.statsFlushMs };
  Object.assign(LINK_LIMITS, limits);
  t.after(() => Object.assign(LINK_LIMITS, saved));
  const reports = () => server.up.filter((m) => m.type === "stats");
  return { reports, sampled: () => reports().flatMap((m) => m.samples) };
}

test("a sample's ackMs is monotonic: a wall clock stepped back between queue and ack does not make it negative", async (t) => {
  const log = captureLog();
  const server = scriptedServer();
  const { sampled } = statsOf(t, server, { statsSamples: 1 });
  const daemon = start(server);
  const realNow = Date.now;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.holdAcks = true;
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result");
    t.mock.method(Date, "now", () => realNow() - 5_000);
    server.holdAcks = false;
    await waitFor(() => sampled().length === 1, "its sample");
    const [{ ackMs }] = sampled();
    assert.ok(Number.isSafeInteger(ackMs) && ackMs >= 0 && ackMs < 5_000, `ackMs ${ackMs}`);
  } finally {
    Date.now = realNow;
    await daemon.stop();
    log.restore();
  }
});

test("a lone sample is reported statsFlushMs after its ack, not before", async (t) => {
  const log = captureLog();
  const server = scriptedServer();
  const { reports, sampled } = statsOf(t, server, { statsSamples: 1_000, statsFlushMs: 500 });
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result");
    await sleep(250);
    assert.equal(reports().length, 0);
    await waitFor(() => reports().length === 1, "the stats after statsFlushMs");
    assert.equal(sampled().length, 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("after a channel overflow drops its backlog, bytesAhead counts only what is still unacked, never below 0", async (t) => {
  const log = captureLog();
  const server = scriptedServer();
  const { sampled } = statsOf(t, server, { statsSamples: 1_000, statsFlushMs: 300 });
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"flood"}\n' });
    // 40 MB of output: over the 32 MiB channel buffer, so the daemon drops its backlog once.
    await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    server.holdAcks = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "c1"), "resync");
    // The rest of the flood (the lines after the drop) arrives and is acked.
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.ch === "c1" && m.line.includes(`"i":${FLOOD_LINES - 1},`)), "the last flood line", 25_000);
    const before = Date.now();
    server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => sampled().some((s) => s.at >= before), "the echo's sample");
    for (const { bytesAhead } of sampled()) assert.ok(bytesAhead >= 0, `bytesAhead ${bytesAhead}`);
    // Nothing large is unacked any more: the dropped megabytes are not ahead of it.
    for (const { bytesAhead } of sampled().filter((s) => s.at >= before)) assert.ok(bytesAhead < 1_000_000, `bytesAhead ${bytesAhead}`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("stopping sends the samples not yet reported in one last frame", async (t) => {
  const log = captureLog();
  const server = scriptedServer();
  const { reports, sampled } = statsOf(t, server, { statsSamples: 1_000, statsFlushMs: 60_000 });
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result");
    // Its ack is back: no frame in flight.
    await sleep(100);
    assert.equal(reports().length, 0);
    await daemon.stop();
    await waitFor(() => sampled().length === 1, "the last stats");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("uplink messages unacked when the socket drops are resent after the next welcome, once", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.holdAcks = true;
    const seq = server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the unacked result");
    server.drop();
    server.holdAcks = false;
    await waitFor(() => server.up.filter((m) => m.id === "p1").length === 2, "the result resent on the next socket");
    assert.equal(server.hellos.length, 2);
    assert.equal(server.hellos[1].ack, seq);
    await sleep(100);
    const sent = server.up.filter((m) => m.id === "p1");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].seq, sent[0].seq, "the hub applies it once by seq");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("close 4426 exits 1 naming the side to update; close 4409 exits 0", async () => {
  const log = captureLog();
  try {
    for (const [serverVersion, advice] of [[2, "this host's ompweb is newer than the server's: update ompweb on the server"], [9, "update ompweb on this host"]]) {
      log.lines.length = 0;
      const server = scriptedServer();
      const daemon = start(server);
      await waitFor(() => server.hellos.length === 1, "the hello");
      server.close(4426, JSON.stringify({ serverVersion }));
      assert.equal(await daemon.done, 1);
      assert.ok(log.lines.some((line) => line.includes(advice)), log.lines.join("|"));
    }
    const server = scriptedServer();
    const replaced = start(server);
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.close(4409, "replaced by a newer link");
    assert.equal(await replaced.done, 0);
    assert.ok(log.lines.some((line) => line.includes("another ompweb host linked with this token; exiting")), log.lines.join("|"));
  } finally {
    log.restore();
  }
});

test("a refused upgrade is diagnosed with one plain GET: 401 stops every omp child, 503 and others redial", async () => {
  const log = captureLog();
  try {
    rmSync(pidFile, { force: true });
    const revoked = scriptedServer();
    const daemon = start(revoked);
    await waitFor(() => revoked.hellos.length === 1, "the hello");
    await spawnChannel(revoked, "c1");
    await waitFor(() => existsSync(pidFile), "the child");
    const pid = Number(readFileSync(pidFile, "utf8"));
    revoked.refuse = (n) => (n > 1 ? 401 : null);
    revoked.drop();
    assert.equal(await daemon.done, 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(log.lines.some((line) => line.includes("revoked")), log.lines.join("|"));
    assert.ok(revoked.diagnoses >= 1);

    // An outage, then a proxy that drops the upgrade: both logged, the link comes back with the child.
    rmSync(pidFile, { force: true });
    const server = scriptedServer({ refuse: (n) => ({ 2: 503, 3: 426 })[n] ?? null });
    const redialing = start(server);
    try {
      await waitFor(() => server.hellos.length === 1, "the hello");
      await spawnChannel(server, "c1");
      await waitFor(() => existsSync(pidFile), "the child");
      const kept = Number(readFileSync(pidFile, "utf8"));
      server.drop();
      await waitFor(() => server.hellos.length === 2, "the hello on attempt 4");
      assert.equal(server.gets, 4);
      assert.deepEqual(server.hellos[1].channels.map((c) => c.ch), ["c1"]);
      assert.ok(log.lines.some((line) => line.includes("the server is unavailable (503); redialing")), log.lines.join("|"));
      assert.ok(log.lines.some((line) => line.includes("the server did not accept the WebSocket upgrade (HTTP 426): check that a reverse proxy forwards Upgrade and Connection")), log.lines.join("|"));
      assert.doesNotThrow(() => process.kill(kept, 0), "the omp child is still running");
    } finally {
      await redialing.stop();
    }
  } finally {
    log.restore();
  }
});

test("output beyond the channel buffer while the uplink is down is dropped, then resync", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    uplink.paused = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"flood"}\n' });
    // 40 MB of output: the daemon drops its backlog as it reads, however slowly.
    await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    uplink.paused = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "c1"), "resync");
    const floodLines = server.up.filter((m) => m.type === "stdout" && m.ch === "c1").length;
    assert.ok(floodLines < 100, `dropped output must not arrive (${floodLines} lines did)`);
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

/** The channel's messages main gets for the two echoes (~17 MB), written while the uplink is stalled. `log`: the
 * buffer is smaller than the echoes, so wait for the daemon to log dropping all but a buffer's worth. Without it
 * nothing observable says the daemon has read the output, so the stall is timed. */
async function echoesWhileStalled(ch, log) {
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, ch);
    uplink.paused = true;
    server.send({ type: "stdin", ch, line: '{"type":"echoes"}\n' });
    if (log) await waitForDropped(log, ECHOES_BYTES - LINK_LIMITS.channelBufferBytes);
    else await sleep(1_500);
    uplink.paused = false;
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
    const messages = await echoesWhileStalled("drop", log);
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

test("an image prompt's two echoes fit the channel buffer while the uplink is stalled: both go up whole, without a resync", async () => {
  const log = captureLog();
  try {
    assert.deepEqual(framesUp(await echoesWhileStalled("fit")), ["message_start", "message_end"]);
  } finally {
    log.restore();
  }
});

test("a stdout line over the link limit is dropped for a resync", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
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

test("after a link drop the next hello carries each channel's open blocking requests; an answer closes them", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.send({ type: "stdin", ch: "c1", line: '{"type":"ask"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line.includes('"q1"')), "the ask request");
    const request = server.up.find((m) => m.type === "stdout" && m.line.includes('"q1"')).line;
    assert.deepEqual(server.hellos[0].channels, []);
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the relink");
    assert.deepEqual(server.hellos[1].channels, [{ ch: "c1", sessionId: null, cwd: scratch, pending: [request] }]);
    // The answer goes down to omp: the request is no longer open. The echo orders it before the drop.
    server.send({ type: "stdin", ch: "c1", line: '{"type":"extension_ui_response","id":"q1","answers":[]}\n' });
    server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line === '{"type":"echoed"}'), "the echo");
    server.drop();
    await waitFor(() => server.hellos.length === 3, "the second relink");
    assert.deepEqual(server.hellos[2].channels, [{ ch: "c1", sessionId: null, cwd: scratch, pending: [] }]);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a channel's hello names the session its child last reported in get_state", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const A = "11111111-2222-4333-8444-0000000000aa";
  const B = "11111111-2222-4333-8444-0000000000bb";
  const fileA = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-w", "a.jsonl");
  mkdirSync(dirname(fileA), { recursive: true });
  writeFileSync(fileA, `${JSON.stringify({ type: "session", version: 3, id: A, cwd: scratch, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  const relink = async (count) => {
    server.drop();
    await waitFor(() => server.hellos.length === count, "the relink");
    return server.hellos[count - 1].channels.map(({ ch, sessionId }) => ({ ch, sessionId }));
  };
  const reported = async (sessionId) => {
    const before = server.up.filter((m) => m.type === "stdout").length;
    server.send({ type: "stdin", ch: "fresh", line: `${JSON.stringify({ type: "state", sessionId })}\n` });
    await waitFor(() => server.up.filter((m) => m.type === "stdout").length > before, "the get_state response");
  };
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "spawn-a", op: "spawn", args: { ch: "resumed", cwd: scratch, recordedCwd: null, sessionFile: fileA, advisor: false } });
    await waitFor(() => server.res("spawn-a"), "the resume");
    assert.equal(server.res("spawn-a").ok, true, JSON.stringify(server.res("spawn-a")));
    await spawnChannel(server, "fresh");
    assert.deepEqual(await relink(2), [{ ch: "resumed", sessionId: A }, { ch: "fresh", sessionId: null }]);
    // A brand-new session names itself on its first get_state; a switch to another session on the next one.
    await reported(A);
    assert.deepEqual(await relink(3), [{ ch: "resumed", sessionId: A }, { ch: "fresh", sessionId: A }]);
    await reported(B);
    assert.deepEqual(await relink(4), [{ ch: "resumed", sessionId: A }, { ch: "fresh", sessionId: B }]);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("spawn reports a fallback when a new session's cwd is missing on this host", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
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

const hostJson = join(scratch, "agent", "omp-web", "host.json");
function writeHostJson(url, token) {
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url, token }));
}

test("a 401 with a newer token in host.json redials with it and links", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "new" });
  writeHostJson(server.url, "new");
  const daemon = runHostDaemon({ url: server.url, token: "stale", allowHttp: false });
  try {
    await waitFor(() => server.hellos.length === 1, "the link after the token swap");
    assert.ok(log.lines.some((line) => line.includes("new one from host.json")));
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a 401 with host.json still holding the rejected token exits 1", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "new" });
  writeHostJson(server.url, "stale");
  const daemon = runHostDaemon({ url: server.url, token: "stale", allowHttp: false });
  try {
    assert.equal(await daemon.done, 1);
    assert.ok(log.lines.some((line) => line.includes("revoked")));
  } finally {
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a newer token in a host.json that names another server is not adopted", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "new" });
  writeHostJson("https://elsewhere.example.com/", "new");
  const daemon = runHostDaemon({ url: server.url, token: "stale", allowHttp: false });
  try {
    assert.equal(await daemon.done, 1);
  } finally {
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a newer token for the same url is adopted when it differs only by a trailing slash", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "new" });
  writeHostJson(`${server.url}//`, "new");
  const daemon = runHostDaemon({ url: `${server.url}/`, token: "stale", allowHttp: false });
  try {
    await waitFor(() => server.hellos.length === 1, "the link with the new token");
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a failed dial re-reads host.json and follows its new url", async () => {
  const log = captureLog();
  const server = scriptedServer();
  writeHostJson(server.url, "t");
  const daemon = runHostDaemon({ url: deadUrl(), token: "t", allowHttp: false });
  try {
    await waitFor(() => server.hellos.length === 1, "the link to the new url");
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a host.json url the daemon could not have started with is not followed", async () => {
  const log = captureLog();
  writeHostJson("http://example.com:10", "t");
  const server = scriptedServer({ refuse: () => 503 });
  const daemon = start(server);
  try {
    await waitFor(() => server.gets >= 2, "a redial to the same server");
    assert.ok(!log.lines.some((line) => line.includes("host.json changed")), log.lines.join("|"));
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

test("a loopback link redials at most 3 s apart; another server's waits double to 60 s", () => {
  assert.equal(nextRedialDelay(2_000, "http://127.0.0.1:30178"), 3_000);
  assert.equal(nextRedialDelay(2_000, "http://localhost:30178"), 3_000);
  assert.equal(nextRedialDelay(2_000, "https://main.example.com"), 4_000);
  assert.equal(nextRedialDelay(40_000, "https://main.example.com"), 60_000);
});

test("a daemon stopped before its first dial never dials", async () => {
  const server = scriptedServer();
  const daemon = start(server);
  await daemon.stop();
  assert.equal(await daemon.done, 0);
  await sleep(500);
  assert.equal(server.gets, 0);
});

test("a server message whose handling throws closes that socket and redials, logged once", async () => {
  const log = captureLog();
  // The note about the "boom" type throws once, as a bug in handling one message would.
  let thrown = false;
  console.error = (line) => {
    if (!thrown && String(line).includes('"boom"')) {
      thrown = true;
      throw new Error("handler bug");
    }
    log.lines.push(String(line));
  };
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "boom" });
    await waitFor(() => server.hellos.length === 2, "the redial");
    assert.equal(log.lines.filter((line) => line.includes("handler bug")).length, 1, log.lines.join("|"));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await daemon.stop();
    log.restore();
  }
});

test("no frame for offlineMs closes the socket and redials; the omp children keep running", async (t) => {
  const { offlineMs } = LINK_LIMITS;
  LINK_LIMITS.offlineMs = 300;
  t.after(() => {
    LINK_LIMITS.offlineMs = offlineMs;
  });
  const log = captureLog();
  rmSync(pidFile, { force: true });
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    await waitFor(() => existsSync(pidFile), "the child");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // The server stays silent: only the daemon's watchdog ends the socket.
    await waitFor(() => server.hellos.some((hello) => hello.channels.some((c) => c.ch === "c1")), "a redial listing c1");
    assert.ok(log.lines.some((line) => line.includes("no traffic from the server")), log.lines.join("|"));
    assert.doesNotThrow(() => process.kill(pid, 0), "the omp child is still running");
  } finally {
    await daemon.stop();
    log.restore();
  }
});


for (const hideBuffer of [false, true]) {
  test(`uplink: a small stdout line and a pong pass a 6.5 MB result going up in pieces, ${hideBuffer ? "with the backlog below the socket (bufferedAmount 0)" : "with the backlog in bufferedAmount"}`, async () => {
    const log = captureLog();
    const server = scriptedServer();
    const daemon = start(server);
    try {
      await waitFor(() => server.hellos.length === 1, "the hello");
      await spawnChannel(server, "c1");
      const hash = "b".repeat(64);
      const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
      mkdirSync(dirname(media), { recursive: true });
      writeFileSync(media, "m".repeat(6_500_000));
      // About 13 MB/s: the result takes about half a second to go up.
      uplink.bytesPerTick = 64 * 1024;
      uplink.hideBuffer = hideBuffer;
      server.send({ type: "req", id: "big", op: "readMedia", args: { hash } });
      await waitFor(() => server.blobs.some((blob) => blob.id === "big"), "the first piece of the result");
      server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
      server.raw({ type: "ping" });
      await waitFor(() => server.res("big"), "the result");
      const lastPiece = server.frames.findLastIndex((frame) => frame.blob === "big");
      const echoAt = server.frames.findIndex((frame) => Array.isArray(frame) && frame.some((m) => m.line === '{"type":"echoed"}'));
      const pongAt = server.frames.findIndex((frame) => Array.isArray(frame) && frame.some((m) => m.type === "pong"));
      assert.ok(echoAt !== -1 && echoAt < lastPiece, `echo in frame ${echoAt}, the result's last piece in frame ${lastPiece}`);
      assert.ok(pongAt !== -1 && pongAt < lastPiece, `pong in frame ${pongAt}, the result's last piece in frame ${lastPiece}`);
      const pieces = server.blobs.filter((blob) => blob.id === "big");
      assert.equal(pieces.map((blob) => blob.bytes).join(""), "m".repeat(6_500_000));
      assert.ok(pieces.every((blob) => blob.bytes.length <= LINK_LIMITS.pieceBytes));
      assert.deepEqual(server.res("big").blob, { bytes: 6_500_000 });
      // The send buffer bound (2 pieces), or the 512 KiB unacked window when the socket hides its backlog; each plus
      // one unit that may start below it (a piece and its frame header).
      const bound = (hideBuffer ? 512 * 1024 : 2 * LINK_LIMITS.pieceBytes) + LINK_LIMITS.pieceBytes + 1024;
      assert.ok(uplink.maxBuffered <= bound, `the socket held ${uplink.maxBuffered} bytes`);
    } finally {
      await daemon.stop();
      log.restore();
    }
  });
}

test("a redial with about 20,000 unacked lines resends them well within offlineMs", async (t) => {
  // A 1 MiB window, so about 20,000 short lines are unacked when the socket drops.
  const savedWindow = LINK_LIMITS.unackedBytes;
  LINK_LIMITS.unackedBytes = 1024 * 1024;
  t.after(() => {
    LINK_LIMITS.unackedBytes = savedWindow;
  });
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const ones = () => new Set(server.up.filter((m) => m.ch === "c1" && m.line === "1").map((m) => m.seq)).size;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"many"}\n' });
    // The daemon sends what its unacked window holds, then waits.
    await waitFor(() => ones() >= 15_000, "most lines sent once");
    await sleep(300);
    const unacked = ones();
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the redial");
    const started = server.helloTimes[1];
    const before = server.upAtHello[1];
    server.holdAcks = false;
    await waitFor(() => ones() === 25_000 && server.up.length - before >= unacked, "every line, the unacked ones resent", 20_000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `the resend of ${unacked} lines took ${elapsed} ms`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("the daemon acks applied downlink messages promptly, with an ack-only frame when it has nothing to send", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    // A stdin line for no channel: applied, and no output follows.
    const seq = server.send({ type: "stdin", ch: "nobody", line: "{}\n" });
    await waitFor(() => server.acks.at(-1) === seq, "the ack", 1_000);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a malformed request joined from parts still gets its 400 res", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    // A req without args, longer than one piece.
    const inner = JSON.stringify({ type: "req", seq: 0, id: "bad", op: "listProjects", pad: "p".repeat(300_000) });
    server.send({ type: "part", at: 0, end: false, data: inner.slice(0, 200_000) });
    server.send({ type: "part", at: 200_000, end: true, data: inner.slice(200_000) });
    await waitFor(() => server.res("bad"), "the 400 res");
    assert.equal(server.res("bad").error.status, 400);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("result pieces not sent when the socket drops are not sent after the redial; the res still goes", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    const hash = "c".repeat(64);
    const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
    mkdirSync(dirname(media), { recursive: true });
    writeFileSync(media, "m".repeat(6_500_000));
    uplink.paused = true;
    server.send({ type: "req", id: "cut", op: "readMedia", args: { hash } });
    await sleep(300);
    server.drop();
    uplink.paused = false;
    await waitFor(() => server.hellos.length === 2, "the redial");
    await waitFor(() => server.res("cut"), "the res");
    assert.equal(server.blobs.filter((blob) => blob.id === "cut").length, 0, "no piece crossed");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("an acked line sent in parts releases its bytes from the channel buffer once: a later stalled backlog still overflows", async () => {
  const log = captureLog();
  const saved = LINK_LIMITS.channelBufferBytes;
  // 20 lines of 400 KB (two parts each) fit; 30 stalled do not. A release per part would leave 8 MB of extra room,
  // and the 30 would fit.
  LINK_LIMITS.channelBufferBytes = 10 * 1024 * 1024;
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    const lines = () => server.up.filter((m) => m.ch === "c1" && m.type === "stdout").length;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"parts","n":20}\n' });
    await waitFor(() => lines() === 20, "the first 20 lines");
    // Room for their acks.
    await sleep(200);
    assert.equal(server.up.some((m) => m.type === "resync"), false);
    uplink.paused = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"parts","n":30}\n' });
    await waitForDropped(log, 1);
    uplink.paused = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "c1"), "the overflow's resync");
  } finally {
    await daemon.stop();
    LINK_LIMITS.channelBufferBytes = saved;
    log.restore();
  }
});

test("downlink parts join into one stdin line, also when the line is torn across a redial", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    const inner = JSON.stringify({ type: "stdin", seq: 0, ch: "c1", line: `${JSON.stringify({ type: "echo", pad: "q".repeat(600_000) })}\n` });
    const first = server.send({ type: "part", at: 0, end: false, data: inner.slice(0, 300_000) });
    // The daemon acks the part with its next frame, a pong.
    server.raw({ type: "ping" });
    await waitFor(() => server.acks.at(-1) === first, "the first part applied");
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the redial");
    assert.equal(server.hellos[1].ack, first);
    // Resent though applied (dropped by seq), then the rest of the line.
    server.raw({ type: "part", seq: first, at: 0, end: false, data: inner.slice(0, 300_000) });
    server.send({ type: "part", at: 300_000, end: true, data: inner.slice(300_000) });
    await waitFor(() => server.up.some((m) => m.ch === "c1" && m.line === '{"type":"echoed"}'), "the joined line reaching omp");
    await sleep(100);
    assert.equal(server.up.filter((m) => m.line === '{"type":"echoed"}').length, 1);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a text frame batches lines up to one piece of UTF-8 bytes, also for multi-byte output", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.send({ type: "stdin", ch: "c1", line: '{"type":"cjk"}\n' });
    await waitFor(() => server.up.filter((m) => m.ch === "c1" && m.type === "stdout").length === 100, "the 100 lines");
    const largest = Math.max(...server.textFrameBytes);
    assert.ok(largest <= LINK_LIMITS.pieceBytes + 1024, `a ${largest}-byte text frame`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

/** About 20,000 unacked "1" lines on c1 (with a 1 MiB window for the run), then a redial whose resend stalls in the
 * socket after about three frames (the uplink pauses as the hello arrives); `stalled(maxSeq)` runs then, before the
 * uplink resumes. Acks stay held. Returns how many of the lines sent before the drop went again, and how many there
 * were. */
async function stalledRedial(server, stalled) {
  const savedWindow = LINK_LIMITS.unackedBytes;
  LINK_LIMITS.unackedBytes = 1024 * 1024;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    const ones = () => server.up.filter((m) => m.ch === "c1" && m.line === "1");
    server.send({ type: "stdin", ch: "c1", line: '{"type":"many"}\n' });
    await waitFor(() => ones().length >= 15_000, "most lines sent once");
    await sleep(300);
    const unacked = ones().length;
    const maxSeq = Math.max(...ones().map((m) => m.seq));
    server.onHello = () => {
      uplink.paused = true;
    };
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the redial");
    await sleep(100);
    await stalled(maxSeq);
    uplink.paused = false;
    await sleep(1_000);
    const resent = server.up.slice(server.upAtHello[1]).filter((m) => m.ch === "c1" && m.line === "1" && m.seq <= maxSeq).length;
    return { resent, unacked };
  } finally {
    LINK_LIMITS.unackedBytes = savedWindow;
  }
}

test("a resend skips what main acked after the welcome", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    // Main had applied every line before the drop; its ack says so on the new socket.
    const { resent, unacked } = await stalledRedial(server, (maxSeq) => server.raw({ type: "ack", ack: maxSeq }));
    // The resend stalled after about three frames; the fourth frame's lines must not go again.
    assert.ok(unacked - resent >= 2_000, `${resent} of ${unacked} lines resent`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a resend skips a channel's lines dropped by an overflow after the welcome", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    const { resent, unacked } = await stalledRedial(server, async () => {
      server.send({ type: "stdin", ch: "c1", line: '{"type":"flood"}\n' });
      // 40 MB of output, past the channel buffer: wait for the daemon to drop it.
      await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    });
    // The resend stalled after about three frames; the fourth frame's lines must not go again.
    assert.ok(unacked - resent >= 2_000, `${resent} of ${unacked} lines resent`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});
