import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const childrenFile = join(scratch, "children.jsonl");
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

/** The flood's output in bytes, less the line envelope. Once all but a buffer's worth is dropped, the daemon has read
 * it all but a few lines. */
const FLOOD_BYTES = FLOOD_LINES * FLOOD_PAD;
/** The echoes' lines in bytes, less the line envelope: never above what the daemon queues, so waiting for
 * ECHOES_BYTES minus the buffer cannot hang. */
const ECHOES_BYTES = 2 * ECHO_PAD;

writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
if (process.argv.includes("update") && process.argv.includes("--check")) { console.log("Current version: 14.0.0-fake"); process.exit(0); }
if (process.argv.includes("--export")) {
  const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(join(scratch, "export-entered"))}, String(process.pid));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(scratch, "export-release"))})) return;
    clearInterval(timer);
    fs.writeFileSync(process.argv[process.argv.length - 1], "<html>real export child</html>");
    process.exit(0);
  }, 10);
  return;
}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require("node:fs").appendFileSync(${JSON.stringify(childrenFile)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + "\\n");
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  // The runner channel protocol: a command is {t: "cmd", id, op, args}; the daemon's own set-up commands get a reply, the test ops none.
  const { op, args = {} } = command;
  if (command.t !== "cmd") return;
  if (op === "set_event_filter" || op === "set_subagent_subscription") return emit({ t: "res", id: command.id, ok: true, data: {} });
  if (op === "state") emit({ t: "session", sessionId: args.sessionId });
  if (op === "flood") for (let i = 0; i < ${FLOOD_LINES}; i++) emit({ t: "x", i, pad: "y".repeat(${FLOOD_PAD}) });
  if (op === "many") for (let i = 0; i < 25000; i++) process.stdout.write('{"t":"n"}\\n');
  if (op === "parts") for (let i = 0; i < args.n; i++) emit({ t: "p", i, pad: "q".repeat(400_000) });
  if (op === "cjk") for (let i = 0; i < 100; i++) emit({ t: "c", i, text: "漢".repeat(10_000) });
  if (op === "huge") emit({ t: "x", pad: "y".repeat(9 * 1024 * 1024) });
  if (op === "echo") emit({ t: "echoed" });
  if (op === "identify") emit({ t: "identity", pid: process.pid });
  if (op === "exit") process.exit(0);
  if (op === "frame") emit({ t: "event", event: args.big ? { ...args.frame, pad: "x".repeat(1024 * 1024) } : args.frame });
  // Two ~6.5 MB event lines, as omp echoes an image prompt (message_start, message_end).
  if (op === "echoes") for (const id of ["start", "end"]) emit({ t: "event", event: { type: "message_" + id, pad: "z".repeat(${ECHO_PAD}) } });
  if (op === "ask") emit({ t: "ui_request", id: 7, method: "ask", args: [[]] });
});
// The runner's hello: the daemon waits for it before it opens the channel.
emit({ t: "hello", proto: 1, pid: process.pid, cwd: process.cwd() });
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
function scriptedServer({ refuse = () => null, validToken = null, version = LINK_PROTOCOL_VERSION } = {}) {
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
    /** Runs when a hello arrives, before its welcome goes; the messages it returns go in the welcome's frame, after it,
     * so the daemon applies them in the same event as the welcome. */
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
          const after = server.onHello?.() ?? [];
          socket.send([{ type: "welcome", v: version, hostId: "h1" }, ...after].map((m) => JSON.stringify(m)).join("\n"));
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
  server.binary = (frame) => socket.send(frame);
  server.send = (message) => {
    downSeq += 1;
    server.raw({ ...message, seq: downSeq });
    return downSeq;
  };
  server.close = (code, reason) => socket.close(code, reason);
  server.drop = () => socket.terminate();
  server.res = (id) => server.up.find((m) => m.type === "res" && m.id === id);
  /** The daemon's channel id for each name `spawnChannel` opened. */
  server.chs = {};
  let cmdSeq = 0;
  /** A test op for channel `name` in the runner protocol; the daemon renumbers the command id. */
  server.stdin = (name, op, args = {}) => server.send({ type: "stdin", ch: server.chs[name], line: JSON.stringify({ t: "cmd", id: ++cmdSeq, op, args }) + "\n" });
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

async function spawnChannel(server, name) {
  const id = `spawn-${name}`;
  server.send({ type: "req", id, op: "open", args: { sessionId: null, launch: { cwd: scratch, recordedCwd: null, sessionFile: "", advisor: false } } });
  await waitFor(() => server.res(id), "the spawn result");
  assert.equal(server.res(id).ok, true, JSON.stringify(server.res(id)));
  server.chs[name] = server.res(id).result.ch;
}

function childrenIn(cwd) {
  if (!existsSync(childrenFile)) return [];
  const canonicalCwd = realpathSync(cwd);
  return readFileSync(childrenFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((child) => realpathSync(child.cwd) === canonicalCwd);
}

const CREATION = "8d324c57-2398-448f-b14f-110000000001";
const openCreation = (cwd, extra = {}) => ({ sessionId: null, launch: { cwd, recordedCwd: null, sessionFile: "", advisor: false, creationId: CREATION, ...extra } });

test("concurrent same-channel creation repeats join one real child and retain identity across reconnect", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const cwd = realpathSync(mkdtempSync(join(scratch, "concurrent-")));
  const { localHost } = await import("./local-host.ts");
  const realSpawn = localHost.spawnRpc;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const spawnedChildren = [];
  localHost.spawnRpc = async (args) => {
    await gate;
    const spawned = await realSpawn.call(localHost, args);
    spawnedChildren.push(spawned.transport);
    await waitFor(() => childrenIn(cwd).length >= spawnedChildren.length, "each real child's startup");
    return spawned;
  };
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "first", op: "open", args: openCreation(cwd) });
    const second = server.send({ type: "req", id: "repeat", op: "open", args: openCreation(cwd) });
    await waitFor(() => server.acks.some((ack) => ack >= second), "both concurrent requests applied before spawning");
    assert.throws(() => daemon.control("drain"), { code: "host_busy" }, "an accepted spawn blocks drain before channel registration");
    assert.equal(daemon.control("status").drained, false);
    release();
    await waitFor(() => server.res("first") && server.res("repeat"), "both creation results");
    assert.equal(server.res("first").ok, true, JSON.stringify(server.res("first")));
    assert.equal(server.res("repeat").ok, true, JSON.stringify(server.res("repeat")));
    assert.equal(server.res("repeat").result.ch, server.res("first").result.ch);
    server.chs.owned = server.res("first").result.ch;
    server.stdin("owned", "identify");
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line.includes('"identity"')), "the real child's identity");
    assert.equal(childrenIn(cwd).length, 1, "one creation must launch exactly one process");
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the reconnect");
    assert.equal(server.hellos[1].channels.find((c) => c.ch === server.chs.owned).creationId, CREATION);
    server.send({ type: "req", id: "after-relink", op: "open", args: openCreation(cwd) });
    await waitFor(() => server.res("after-relink"), "the repeated creation after reconnect");
    assert.equal(server.res("after-relink").ok, true, JSON.stringify(server.res("after-relink")));
    assert.equal(server.res("after-relink").result.ch, server.res("first").result.ch);
    assert.equal(childrenIn(cwd).length, 1);
  } finally {
    release();
    localHost.spawnRpc = realSpawn;
    await daemon.stop();
    for (const transport of spawnedChildren) transport.killTree(true);
    log.restore();
  }
});

test("a creation cannot move to another channel, change spawn arguments, or restart after its child exits", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const cwd = realpathSync(mkdtempSync(join(scratch, "identity-")));
  const conflict = async (id, args) => {
    server.send({ type: "req", id, op: "open", args });
    await waitFor(() => server.res(id), id);
    assert.equal(server.res(id).ok, false, JSON.stringify(server.res(id)));
    assert.equal(server.res(id).error.status, 409);
    assert.equal(server.res(id).error.code, "creation_conflict");
  };
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "first", op: "open", args: openCreation(cwd) });
    await waitFor(() => server.res("first"), "the initial creation");
    assert.equal(server.res("first").ok, true, JSON.stringify(server.res("first")));
    server.chs.owned = server.res("first").result.ch;
    for (const [key, value] of [
      ["cwd", scratch], ["recordedCwd", scratch], ["sessionFile", join(scratch, "other.jsonl")],
      ["advisor", true], ["toolNames", ["read"]], ["spawnModel", "provider/model"],
    ]) await conflict(`different-${key}`, openCreation(cwd, { [key]: value }));
    server.stdin("owned", "exit");
    await waitFor(() => server.up.some((m) => m.type === "exit" && m.ch === server.chs.owned), "the child exit");
    await conflict("after-exit", openCreation(cwd));
    assert.equal(childrenIn(cwd).length, 1, "neither conflicts nor terminal repeats launch a replacement");
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("unsafe creation identities are rejected before launching a child", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const cwd = mkdtempSync(join(scratch, "invalid-identity-"));
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    for (const [index, creationId] of ["", "../start", "two words", "x".repeat(129), null, 42].entries()) {
      const id = `invalid-${index}`;
      server.send({ type: "req", id, op: "open", args: openCreation(cwd, { creationId }) });
      await waitFor(() => server.res(id), "the invalid identity result");
      assert.equal(server.res(id).ok, false, JSON.stringify(server.res(id)));
      assert.equal(server.res(id).error.status, 400);
      assert.equal(server.res(id).error.code, "invalid_request");
    }
    assert.deepEqual(childrenIn(cwd), []);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("capacity follows real turns, reconnects with fresh unsequenced samples, and stops sampling off-link", () => {
  // Builtin replacements are confined to this child; daemon, sampler, WS, and omp subprocesses remain real.
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const { syncBuiltinESMExports } = require("node:module");
    const scratch = ${JSON.stringify(scratch)};
    const servers = [];
    const decoder = new TextDecoder();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const files = {
      "/proc/self/cgroup": "0::/omp\\n",
      "/proc/self/mountinfo": "31 22 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\\n",
      "/proc/meminfo": "MemAvailable: 8388608 kB\\n",
      "/sys/fs/cgroup/omp/cpu.max": "250000 100000\\n",
      "/sys/fs/cgroup/omp/cpuset.cpus.effective": "0-3\\n",
      "/sys/fs/cgroup/omp/memory.max": "8589934592\\n",
      "/sys/fs/cgroup/omp/memory.current": "2147483648\\n",
      "/sys/fs/cgroup/cpu.max": "max 100000\\n",
      "/sys/fs/cgroup/cpuset.cpus.effective": "0-7\\n",
      "/sys/fs/cgroup/memory.max": "max\\n",
      "/sys/fs/cgroup/memory.current": "0\\n",
    };
    const readFileSync = fs.readFileSync;
    let reads = 0, load1 = 0.75, failProc = false;
    fs.readFileSync = (path, ...args) => {
      if (typeof path !== "string" || (!path.startsWith("/proc/") && !path.startsWith("/sys/fs/cgroup/"))) return readFileSync(path, ...args);
      if (path === "/proc/stat") {
        reads += 1;
        if (failProc) throw Object.assign(new Error("Counter unavailable"), { code: "EIO" });
        return "cpu " + (100 + reads * 10) + " 0 0 " + (900 + reads * 90) + " 0 0 0 0\\n";
      }
      if (!(path in files)) throw Object.assign(new Error("No fixture file: " + path), { code: "ENOENT" });
      return files[path];
    };
    os.availableParallelism = () => 8;
    os.loadavg = () => [load1, 0, 0];
    syncBuiltinESMExports();
    const capacityUrl = ${JSON.stringify(new URL("./capacity.ts", import.meta.url).href)};
    const capacity = await import(capacityUrl);
    const sampleHostCapacity = capacity.sampleHostCapacity;
    const { mock } = await import("bun:test");
    mock.module(capacityUrl, () => ({ ...capacity, sampleHostCapacity(activeSessions) {
      const platform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try { return sampleHostCapacity(activeSessions); }
      finally { Object.defineProperty(process, "platform", { value: platform }); }
    } }));
    // Accelerate only the five-second cadence, preserving watchdog/redial/child timers.
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 25 : ms, ...args);
    const { runHostDaemon } = await import(${JSON.stringify(new URL("./daemon.ts", import.meta.url).href)});
    const { decodeBlobFrame, LINK_PROTOCOL_VERSION, PartJoiner } = await import(${JSON.stringify(new URL("./link-protocol.ts", import.meta.url).href)});
    ${waitFor.toString()}
    ${scriptedServer.toString()}
    ${start.toString()}
    ${spawnChannel.toString()}
    const server = scriptedServer();
    const daemon = start(server);
    const capacities = () => server.up.filter((m) => m.type === "capacity");
    const nextCapacity = async (activeSessions) => {
      const before = capacities().length;
      await waitFor(() => capacities().length > before, "a fresh capacity report", 2000);
      const message = capacities().at(-1);
      assert.equal("seq" in message, false, "capacity is never replay-sequenced");
      assert.deepEqual(message.sample, {
        effectiveCpus: 2.5, load1, busyFraction: 0.1, stealFraction: 0,
        availableMemoryBytes: 6442450944, activeSessions,
      });
    };
    const emit = async (ch, frame, big = false) => {
      const before = server.up.filter((m) => m.type === "stdout" && m.ch === server.chs[ch]).length;
      server.stdin(ch, "frame", { frame, big });
      // A following plain echo is a barrier after the entire big frame was read.
      server.stdin(ch, "echo");
      await waitFor(() => server.up.filter((m) => m.type === "stdout" && m.ch === server.chs[ch]).slice(before).some((m) => m.line === '{"t":"echoed"}'), "the emitted turn frame");
    };
    try {
      await waitFor(() => server.hellos.length === 1, "the hello");
      await spawnChannel(server, "c1");
      await spawnChannel(server, "c2");
      await nextCapacity(0);
      await emit("c1", { type: "agent_start" });
      await emit("c1", { type: "agent_start" });
      await nextCapacity(1);
      await emit("c2", { type: "agent_start" }, true);
      await nextCapacity(2);
      await emit("c1", { type: "agent_end" });
      await emit("c1", { type: "agent_end" });
      await nextCapacity(1);
      await emit("c2", { type: "agent_end" }, true);
      await nextCapacity(0);
      await emit("c1", { type: "agent_start" });
      await nextCapacity(1);
      failProc = true;
      await sleep(60);
      const missingAt = capacities().length;
      await sleep(80);
      assert.equal(capacities().length, missingAt, "unavailable counters cannot become fabricated capacity");
      failProc = false;
      await nextCapacity(1);
      server.holdAcks = true;
      await nextCapacity(1);
      server.refuse = () => 503;
      server.drop();
      await waitFor(() => server.diagnoses > 0, "the refused redial");
      const disconnectedReads = reads;
      await sleep(100);
      assert.equal(reads, disconnectedReads, "disconnected sampling timers stop");
      load1 = 1.25;
      server.refuse = () => null;
      server.holdAcks = false;
      await waitFor(() => server.hellos.length === 2, "the relink");
      await nextCapacity(1);
      const sinceHello = server.up.slice(server.upAtHello[1]).filter((m) => m.type === "capacity");
      assert.ok(sinceHello.length > 0);
      assert.ok(sinceHello.every((m) => m.sample.load1 === 1.25 && !("seq" in m)), "old samples cannot be replayed as fresh ones");
      server.stdin("c1", "exit");
      await waitFor(() => server.up.some((m) => m.type === "exit" && m.ch === server.chs.c1), "the active child's exit");
      await nextCapacity(0);
    } finally {
      await daemon.stop();
      for (const server of servers) server.stop();
    }
    const stoppedReads = reads;
    await sleep(100);
    assert.equal(reads, stoppedReads, "stopped daemons retain no sampling timer");
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

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

const quotePath = (path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

// As in P5: real upload-pack behind an isolated HTTPS-to-SSH rewrite, never user Git config.
async function withPoolGit(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-daemon-pool-")));
  const savedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = "https://pool-fixture.invalid/repo.git";
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const workers = join(root, "workers");
  const ssh = join(root, "ssh");
  const uploadPack = `exec git-upload-pack ${quotePath(remote)}`;
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0", GIT_SSH_COMMAND: `sh ${quotePath(ssh)}`, GIT_SSH_VARIANT: "simple", PI_CODING_AGENT_DIR: join(root, "agent"),
    });
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
    writeFileSync(ssh, `#!/bin/sh\n${uploadPack}\n`, { mode: 0o700 });
    git(root, "config", "--global", "url.ssh://fixture/repo.git.insteadOf", origin);
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", source);
    git(source, "config", "user.name", "Pool fixture");
    git(source, "config", "user.email", "pool@example.invalid");
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    git(source, "add", ".");
    git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "main");
    mkdirSync(workers);
    const cloneRoot = join(workers, "registered-project");
    await run({
      root, workers, source, ssh, git, origin, cloneRoot, uploadPack,
      input: { projectId: "registered-project", origin, cloneRoot, creationId: "creation-1" },
      baseCommit: git(source, "rev-parse", "HEAD"),
    });
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, savedGit);
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

async function daemonOp(server, id, op, args) {
  server.send({ type: "req", id, op, args });
  await waitFor(() => server.res(id), `${op} result ${id}`);
  return server.res(id);
}

test("pool preparation dispatch creates the worker's real external Git worktree and preserves retries", () => withPoolGit(async (f) => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    const answer = await daemonOp(server, "prepare", "preparePoolProject", { input: f.input });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.result.ok, true, JSON.stringify(answer.result));
    const value = answer.result.value;
    assert.deepEqual(value, {
      cwd: join(f.workers, ".registered-project_worktrees", "session", "creation-1"),
      projectRoot: f.cloneRoot, baseCommit: f.baseCommit,
    });
    assert.notEqual(value.cwd, process.cwd());
    assert.equal(f.git(value.cwd, "branch", "--show-current"), "session/creation-1");
    assert.equal(f.git(f.cloneRoot, "config", "--get", "remote.origin.url"), f.origin);
    assert.equal(readFileSync(join(value.cwd, "tracked.txt"), "utf8"), "committed\n");
    writeFileSync(join(value.cwd, "tracked.txt"), "session edit\n");
    writeFileSync(join(f.cloneRoot, "private.txt"), "worker private data\n");
    const retry = await daemonOp(server, "retry", "preparePoolProject", { input: f.input });
    assert.deepEqual(retry.result, answer.result);
    assert.equal(readFileSync(join(value.cwd, "tracked.txt"), "utf8"), "session edit\n");
    assert.equal(readFileSync(join(f.cloneRoot, "private.txt"), "utf8"), "worker private data\n");
    const conflict = await daemonOp(server, "conflict", "preparePoolProject", {
      input: { ...f.input, origin: "https://different.invalid/repo.git", creationId: "creation-2" },
    });
    assert.equal(conflict.ok, true);
    assert.equal(conflict.result.ok, false);
    assert.equal(conflict.result.status, 409);
    assert.equal(conflict.result.value, undefined);
    assert.equal(readFileSync(join(f.cloneRoot, "private.txt"), "utf8"), "worker private data\n");
    assert.equal(existsSync(join(f.workers, ".registered-project_worktrees", "session", "creation-2")), false);
    const invalid = await daemonOp(server, "invalid", "preparePoolProject", { input: { ...f.input, creationId: "../escape" } });
    assert.equal(invalid.ok, true);
    assert.equal(invalid.result.ok, false);
    assert.equal(invalid.result.status, 400);
    assert.equal(invalid.result.value, undefined);
  } finally {
    await daemon.stop();
    server.stop();
    log.restore();
  }
}));

test("real linked preparation survives the ordinary operation deadline while Git is still running", { timeout: 45_000 }, () => withPoolGit(async (f) => {
  const hub = await import("./hub.ts");
  const { createHost } = await import("./registry.ts");
  const { host, token } = createHost("Slow preparation worker");
  const log = captureLog();
  const entered = join(f.root, "fetch-entered");
  const release = join(f.root, "release-fetch");
  let daemon;
  let requested = false;
  let replied = false;
  let settled = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, bun) {
      return hub.handleLinkUpgrade(req, (data) => bun.upgrade(req, { data }));
    },
    websocket: {
      ...hub.hostLinkSocket,
      message(ws, data) {
        hub.hostLinkSocket.message(ws, data);
        if (typeof data === "string" && data.split("\n").filter(Boolean).some((line) => JSON.parse(line).type === "res")) replied = true;
      },
    },
  });
  try {
    f.git(f.root, "clone", f.origin, f.cloneRoot);
    writeFileSync(f.ssh, `#!/bin/sh
touch ${quotePath(entered)}
while [ ! -f ${quotePath(release)} ]; do sleep 0.02; done
${f.uploadPack}
`, { mode: 0o700 });
    daemon = runHostDaemon({ url: `http://127.0.0.1:${server.port}`, token, allowHttp: false });
    await waitFor(() => hub.listHosts().some((entry) => entry.id === host.id && entry.status === "online"), "the real hub/daemon link");
    const completed = hub.getHost(host.id).sessionOps.preparePoolProject(f.input).then(
      (result) => { settled = true; return { result }; },
      (error) => { settled = true; return { error }; },
    );
    requested = true;
    await waitFor(() => existsSync(entered), "the real held Git fetch");
    // Intentionally cross the real 30-second transport deadline, not a shortened fixture deadline.
    await sleep(31_000);
    assert.equal(settled, false, "a healthy preparation must remain pending beyond the ordinary operation deadline");
    assert.equal(replied, false, "the worker is still preparing, not returning an early acknowledgement");
    writeFileSync(release, "");
    await waitFor(() => settled, "the prepared result after releasing Git");
    const outcome = await completed;
    if (outcome.error) throw outcome.error;
    assert.deepEqual(outcome.result, {
      ok: true,
      value: {
        cwd: join(f.workers, ".registered-project_worktrees", "session", "creation-1"),
        projectRoot: f.cloneRoot,
        baseCommit: f.baseCommit,
      },
    });
    assert.equal(readFileSync(join(outcome.result.value.cwd, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(f.git(outcome.result.value.cwd, "branch", "--show-current"), "session/creation-1");
  } finally {
    writeFileSync(release, "");
    try {
      if (requested) await waitFor(() => replied, "the released worker's preparation reply");
    } finally {
      await daemon?.stop();
      hub.closeHostLink(host.id);
      hub.flushLinkSamples();
      server.stop(true);
      log.restore();
    }
  }
}));

test("in-flight real preparations block native daemon updates until both failure and success finish", () => withPoolGit(async (f) => {
  const install = join(f.root, "node_modules", "@kahme247", "ompweb");
  const launcher = join(install, "bin", "omp-web-host.js");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, "");
  const packageJson = (await import("../../package.json", { with: { type: "json" } })).default;
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: packageJson.version }));
  const argv = process.argv;
  const oldPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const disabled = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const fetch = globalThis.fetch;
  const log = captureLog();
  const server = scriptedServer();
  let daemon;
  let preparationsSent = false;
  const failedRoot = join(f.workers, "failed-project");
  const releaseSuccess = join(f.root, "release-registered-project");
  const releaseFailure = join(f.root, "release-failed-project");
  try {
    process.argv = [process.execPath, launcher];
    process.env.OMP_WEB_PACKAGE_DIR = install;
    delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    globalThis.fetch = async (url) => String(url).startsWith("https://registry.npmjs.org/")
      ? Response.json({ version: "99.0.0" }) : new Response(`export const LINK_PROTOCOL_VERSION = ${LINK_PROTOCOL_VERSION};\n`);
    f.git(f.root, "clone", f.origin, f.cloneRoot);
    f.git(f.root, "clone", f.origin, failedRoot);
    writeFileSync(f.ssh, `#!/bin/sh
name="\${PWD##*/}"
touch ${quotePath(join(f.root, "entered-"))}"$name"
while [ ! -f ${quotePath(join(f.root, "release-"))}"$name" ]; do sleep 0.02; done
if [ "$name" = "failed-project" ]; then exit 128; fi
${f.uploadPack}
`, { mode: 0o700 });
    daemon = start(server);
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "held-success", op: "preparePoolProject", args: { input: f.input } });
    server.send({ type: "req", id: "held-failure", op: "preparePoolProject", args: { input: { ...f.input, cloneRoot: failedRoot } } });
    preparationsSent = true;
    await waitFor(() => existsSync(join(f.root, "entered-registered-project")) && existsSync(join(f.root, "entered-failed-project")), "both real Git fetches");
    const compatibility = { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION };
    const both = await daemonOp(server, "check-both", "checkUpdates", { compatibility, force: true });
    assert.equal(both.result.ompweb.canUpdate, false);
    assert.match(both.result.ompweb.blockedReason, /prepar/i);
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    assert.equal(daemon.control("status").drained, false, "busy drain must not change admission");
    writeFileSync(releaseFailure, "");
    await waitFor(() => server.res("held-failure"), "the failed preparation");
    assert.equal(server.res("held-failure").result.ok, false);
    assert.equal(server.res("held-failure").result.value, undefined);
    const one = await daemonOp(server, "check-one", "checkUpdates", { compatibility, force: true });
    assert.equal(one.result.ompweb.canUpdate, false, "one completion cannot clear another accepted preparation");
    assert.match(one.result.ompweb.blockedReason, /prepar/i);
    assert.throws(() => daemon.control("drain"), { code: "host_busy" }, "one remaining real fetch still blocks local drain");
    writeFileSync(releaseSuccess, "");
    await waitFor(() => server.res("held-success"), "the successful preparation");
    assert.equal(server.res("held-success").result.ok, true);
    const finished = await daemonOp(server, "check-finished", "checkUpdates", { compatibility, force: true });
    assert.doesNotMatch(finished.result.ompweb.blockedReason ?? "", /prepar/i);
    await drainWhenIdle(daemon);
    assert.equal(daemon.control("resume").drained, false);
  } finally {
    writeFileSync(releaseFailure, "");
    writeFileSync(releaseSuccess, "");
    try {
      if (preparationsSent) await waitFor(() => server.res("held-success") && server.res("held-failure"), "released Git operations");
    } finally {
      await daemon?.stop();
      server.stop();
      log.restore();
      globalThis.fetch = fetch;
      process.argv = argv;
      for (const [key, value] of [["OMP_WEB_PACKAGE_DIR", oldPackage], ["OMP_WEB_DISABLE_AUTOUPDATE", disabled]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}));

test("a persisted native daemon update rejects new preparation before touching its clone root", () => withPoolGit(async (f) => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    const updateRoot = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "host-update");
    mkdirSync(updateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(updateRoot, "status.json"), JSON.stringify({
      operation: { id: "prepare-block", target: "ompweb", version: "99.0.0", state: "running" },
      daemonPid: process.pid, workerPid: process.pid, startedAt: Date.now(),
    }), { mode: 0o600 });
    const answer = await daemonOp(server, "blocked-prepare", "preparePoolProject", { input: f.input });
    assert.equal(answer.ok, false);
    assert.equal(answer.error.status, 409);
    assert.equal(answer.error.code, "host_updating");
    assert.equal(existsSync(f.cloneRoot), false);
    assert.equal(existsSync(join(f.workers, ".registered-project_worktrees")), false);
  } finally {
    await daemon.stop();
    server.stop();
    log.restore();
  }
}));

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

test("setUploadRetention validates days, persists them under the agent dir and sweeps; the next daemon sweeps with them at start", async () => {
  const log = captureLog();
  const upload = (name, ageDays) => {
    const file = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-w", "s1", "local", "uploads", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(file, when, when);
    return file;
  };
  const stored = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "upload-retention.json");
  const old = upload("old.bin", 40);
  const fresh = upload("fresh.bin", 1);
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    assert.equal(existsSync(old), true, "no stored value yet: no sweep");
    for (const [id, days] of [["bad0", 0], ["bad1", "7"], ["bad2", 3651], ["bad3", undefined]]) {
      server.send({ type: "req", id, op: "setUploadRetention", args: { days } });
      await waitFor(() => server.res(id), "the refusal");
      assert.equal(server.res(id).ok, false);
      assert.equal(server.res(id).error.status, 400);
    }
    assert.equal(existsSync(stored), false);
    server.send({ type: "req", id: "ok", op: "setUploadRetention", args: { days: 7 } });
    await waitFor(() => server.res("ok"), "the answer");
    assert.equal(server.res("ok").ok, true);
    assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")), { days: 7 });
    await waitFor(() => !existsSync(old), "the sweep");
    assert.equal(existsSync(fresh), true);
  } finally {
    await daemon.stop();
  }
  // A restart: the stored value alone drives the sweep at start.
  const again = upload("old.bin", 40);
  const restarted = start(scriptedServer());
  try {
    await waitFor(() => !existsSync(again), "the sweep at start");
  } finally {
    await restarted.stop();
    rmSync(stored, { force: true });
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
  const echoes = () => server.up.filter((m) => m.type === "stdout" && m.line === '{"t":"echoed"}').length;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    const first = server.stdin("c1", "echo");
    await waitFor(() => echoes() === 1, "the first echo");
    assert.equal(server.acks.at(-1), first);
    const second = server.stdin("c1", "echo");
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
    // The child names its session in a session frame: that output is the session's.
    server.stdin("c1", "state", { sessionId: session });
    await waitFor(() => sampled().some((sample) => sample.session === session), "the output's sample");
    // Linking and opening queue other messages (channels_changed, notifier, ...): wait until their samples stop coming.
    let settled = -1;
    await waitFor(() => { const n = sampled().length; const done = n === settled; settled = n; return done; }, "the opening samples to settle", 5_000);
    const opening = sampled().length;

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
    await waitFor(() => sampled().length === opening + 3, "the three later samples");

    assert.ok(reports().every((m) => m.samples.length <= 2), JSON.stringify(reports().map((m) => m.samples.length)));
    const spawned = sampled().find((sample) => sample.session === null && sample.bytes === lineBytes(server.res("spawn-c1")));
    assert.ok(spawned, "the open result's sample");
    const rest = sampled().slice(opening);
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
    // The link-up messages (notifier, channels_changed, ...) are sampled too: let them go first.
    await sleep(300);
    const base = sampled().length;
    server.holdAcks = true;
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result");
    t.mock.method(Date, "now", () => realNow() - 5_000);
    server.holdAcks = false;
    await waitFor(() => sampled().length === base + 1, "its sample");
    const { ackMs } = sampled().at(-1);
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
    // The link-up messages are sampled too: let their stats go out first.
    await sleep(1_100);
    const [sent, samples] = [reports().length, sampled().length];
    server.send({ type: "req", id: "p1", op: "listProjects", args: {} });
    await waitFor(() => server.res("p1"), "the result");
    await sleep(250);
    assert.equal(reports().length, sent);
    await waitFor(() => reports().length === sent + 1, "the stats after statsFlushMs");
    assert.equal(sampled().length, samples + 1);
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
    server.stdin("c1", "flood");
    // 40 MB of output: over the 32 MiB channel buffer, so the daemon drops its backlog once.
    await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    server.holdAcks = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === server.chs.c1), "resync");
    // The rest of the flood (the lines after the drop) arrives and is acked.
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.ch === server.chs.c1 && m.line.includes(`"i":${FLOOD_LINES - 1},`)), "the last flood line", 25_000);
    const before = Date.now();
    server.stdin("c1", "echo");
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
    await waitFor(() => reports().length === 1, "the last stats");
    assert.ok(sampled().length >= 1);
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
    for (const [serverVersion, advice] of [[2, "this host's ompweb is newer than the server's: update ompweb on the server"], [10, "update ompweb on this host"]]) {
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
      assert.deepEqual(server.hellos[1].channels.map((c) => c.ch), [server.chs.c1]);
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
    server.stdin("c1", "flood");
    // 40 MB of output: the daemon drops its backlog as it reads, however slowly.
    await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    uplink.paused = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === server.chs.c1), "resync");
    const floodLines = server.up.filter((m) => m.type === "stdout" && m.ch === server.chs.c1).length;
    assert.ok(floodLines < 100, `dropped output must not arrive (${floodLines} lines did)`);
    // Output flows again after the resync.
    server.stdin("c1", "echo");
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line === '{"t":"echoed"}'), "output after resync");
    const resyncAt = server.up.findIndex((m) => m.type === "resync");
    const echoAt = server.up.findIndex((m) => m.line === '{"t":"echoed"}');
    assert.ok(resyncAt < echoAt);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

/** What a channel's up messages carried: each event's type, and where a resync fell. */
function framesUp(messages) {
  return messages.flatMap((m) => (m.type === "resync" ? ["resync"] : m.type === "stdout" ? [JSON.parse(m.line).event.type] : []));
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
    server.stdin(ch, "echoes");
    if (log) await waitForDropped(log, ECHOES_BYTES - LINK_LIMITS.channelBufferBytes);
    else await sleep(1_500);
    uplink.paused = false;
    // Settled: the last thing up is a resync or the second echo.
    await waitFor(() => {
      const last = server.up.findLast((m) => m.ch === server.chs[ch]);
      if (last?.type === "resync") return true;
      const record = last?.type === "stdout" ? JSON.parse(last.line) : null;
      return record?.event?.type === "message_end";
    }, "the echoes or a resync");
    return server.up.filter((m) => m.ch === server.chs[ch]);
  } finally {
    await daemon.stop();
  }
}

test("an overflow drops the backlog of whole lines and sends a resync", async () => {
  const log = captureLog();
  const saved = LINK_LIMITS.channelBufferBytes;
  // Smaller than one echo, so the backlog overflows twice over.
  LINK_LIMITS.channelBufferBytes = 4 * 1024 * 1024;
  try {
    const messages = await echoesWhileStalled("drop", log);
    assert.ok(messages.some((m) => m.type === "resync"), "the overflow sent a resync");
    assert.ok(messages.every((m) => m.type !== "stdout" || JSON.parse(m.line).t === "event"), "what went up is whole lines");
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
    server.stdin("big", "huge");
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === server.chs.big), "resync");
    server.stdin("big", "echo");
    await waitFor(() => server.up.some((m) => m.ch === server.chs.big && m.line === '{"t":"echoed"}'), "output after the oversize line");
    assert.equal(server.up.some((m) => m.ch === server.chs.big && m.type === "stdout" && m.line.length > 1_000), false, "the oversize line never goes up");
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
    server.stdin("c1", "ask");
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line.includes('"ui_request"')), "the ask request");
    const request = server.up.find((m) => m.type === "stdout" && m.line.includes('"ui_request"')).line;
    assert.deepEqual(server.hellos[0].channels, []);
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the relink");
    assert.deepEqual(server.hellos[1].channels, [{ ch: server.chs.c1, sessionId: null, cwd: scratch, pending: [request] }]);
    // The answer goes down to omp: the request is no longer open. The echo orders it before the drop.
    server.send({ type: "stdin", ch: server.chs.c1, line: '{"t":"ui_response","id":7,"value":"x"}\n' });
    server.stdin("c1", "echo");
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line === '{"t":"echoed"}'), "the echo");
    server.drop();
    await waitFor(() => server.hellos.length === 3, "the second relink");
    assert.deepEqual(server.hellos[2].channels, [{ ch: server.chs.c1, sessionId: null, cwd: scratch, pending: [] }]);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

test("a channel's hello names the session its child last reported in a session frame", async () => {
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
    server.stdin("fresh", "state", { sessionId });
    await waitFor(() => server.up.filter((m) => m.type === "stdout").length > before, "the session frame");
  };
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    server.send({ type: "req", id: "spawn-a", op: "open", args: { sessionId: A, launch: { cwd: scratch, recordedCwd: null, sessionFile: fileA, advisor: false } } });
    await waitFor(() => server.res("spawn-a"), "the resume");
    assert.equal(server.res("spawn-a").ok, true, JSON.stringify(server.res("spawn-a")));
    server.chs.resumed = server.res("spawn-a").result.ch;
    await spawnChannel(server, "fresh");
    assert.deepEqual(await relink(2), [{ ch: server.chs.resumed, sessionId: A }, { ch: server.chs.fresh, sessionId: null }]);
    // A brand-new session names itself on its first session frame; a switch to another session on the next one.
    await reported(A);
    assert.deepEqual(await relink(3), [{ ch: server.chs.resumed, sessionId: A }, { ch: server.chs.fresh, sessionId: A }]);
    await reported(B);
    assert.deepEqual(await relink(4), [{ ch: server.chs.resumed, sessionId: A }, { ch: server.chs.fresh, sessionId: B }]);
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
    server.send({ type: "req", id: "s1", op: "open", args: { sessionId: null, launch: { cwd: gone, recordedCwd: null, sessionFile: "", advisor: false } } });
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

test("a primary loopback link caps at 3 s; every other link caps at 30 s", () => {
  assert.equal(nextRedialDelay(2_000, "http://127.0.0.1:30178"), 3_000);
  assert.equal(nextRedialDelay(2_000, "http://localhost:30178"), 3_000);
  assert.equal(nextRedialDelay(2_000, "https://main.example.com"), 4_000);
  assert.equal(nextRedialDelay(40_000, "https://main.example.com"), 30_000);
  assert.equal(nextRedialDelay(2_000, "http://localhost:30178", false), 4_000);
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
    await waitFor(() => server.hellos.some((hello) => hello.channels.some((c) => c.ch === server.chs.c1)), "a redial listing c1");
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
      server.stdin("c1", "echo");
      server.raw({ type: "ping" });
      await waitFor(() => server.res("big"), "the result");
      const lastPiece = server.frames.findLastIndex((frame) => frame.blob === "big");
      const echoAt = server.frames.findIndex((frame) => Array.isArray(frame) && frame.some((m) => m.line === '{"t":"echoed"}'));
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
  // A 2 MiB window, so about 20,000 short lines (about 100 bytes each with their channel id) are unacked when the socket drops.
  const savedWindow = LINK_LIMITS.unackedBytes;
  LINK_LIMITS.unackedBytes = 2 * 1024 * 1024;
  t.after(() => {
    LINK_LIMITS.unackedBytes = savedWindow;
  });
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const ones = () => new Set(server.up.filter((m) => m.ch === server.chs.c1 && m.line === '{"t":"n"}').map((m) => m.seq)).size;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    server.stdin("c1", "many");
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
    const lines = () => server.up.filter((m) => m.ch === server.chs.c1 && m.type === "stdout").length;
    server.stdin("c1", "parts", { n: 20 });
    await waitFor(() => lines() === 20, "the first 20 lines");
    // Room for their acks.
    await sleep(200);
    assert.equal(server.up.some((m) => m.type === "resync"), false);
    uplink.paused = true;
    server.stdin("c1", "parts", { n: 30 });
    await waitForDropped(log, 1);
    uplink.paused = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === server.chs.c1), "the overflow's resync");
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
    const inner = JSON.stringify({ type: "stdin", seq: 0, ch: server.chs.c1, line: `${JSON.stringify({ t: "cmd", id: 1, op: "echo", args: { pad: "q".repeat(600_000) } })}\n` });
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
    await waitFor(() => server.up.some((m) => m.ch === server.chs.c1 && m.line === '{"t":"echoed"}'), "the joined line reaching omp");
    await sleep(100);
    assert.equal(server.up.filter((m) => m.line === '{"t":"echoed"}').length, 1);
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
    server.stdin("c1", "cjk");
    await waitFor(() => server.up.filter((m) => m.ch === server.chs.c1 && m.type === "stdout").length === 100, "the 100 lines");
    const largest = Math.max(...server.textFrameBytes);
    assert.ok(largest <= LINK_LIMITS.pieceBytes + 1024, `a ${largest}-byte text frame`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

/** About 20,000 unacked "1" lines on c1 (a full 1 MiB window for the run), then a redial whose resend stalls in the
 * socket after about three frames (the uplink pauses as the hello arrives). `afterWelcome(maxSeq)` returns messages
 * that go in the welcome's frame, so the daemon applies them right after the stalled flush and before the uplink
 * resumes; `stalled(maxSeq)` runs once the redial is welcomed, also before it resumes. Acks stay held. Returns how
 * many of the lines sent before the drop went again, and how many there were. */
async function stalledRedial(server, { afterWelcome = () => [], stalled = async () => {} }) {
  const savedWindow = LINK_LIMITS.unackedBytes;
  LINK_LIMITS.unackedBytes = 1024 * 1024;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    const heldFrom = server.textFrameBytes.length;
    const ones = () => server.up.filter((m) => m.ch === server.chs.c1 && m.line === '{"t":"n"}');
    server.stdin("c1", "many");
    // The daemon stops at a full unacked window, and every frame since the hold is unacked: nothing more goes up.
    await waitFor(() => server.textFrameBytes.slice(heldFrom).reduce((sum, bytes) => sum + bytes, 0) >= LINK_LIMITS.unackedBytes,
      "a full unacked window of lines");
    const unacked = ones().length;
    const maxSeq = Math.max(...ones().map((m) => m.seq));
    server.onHello = () => {
      uplink.paused = true;
      uplink.maxBuffered = 0;
      return afterWelcome(maxSeq);
    };
    server.drop();
    await waitFor(() => server.hellos.length === 2, "the redial");
    // The hello reached the server, not yet the welcome the daemon: its stalled flush, and the messages after it in the
    // same frame, are applied once frames wait in the paused uplink. Resuming before that lets the resend go unstalled.
    await waitFor(() => uplink.maxBuffered > 0, "the daemon to apply the welcome");
    await stalled(maxSeq);
    uplink.paused = false;
    // The resend is done once a message sequenced after the old lines arrives: new lines come after the snapshot.
    await waitFor(() => server.up.slice(server.upAtHello[1]).some((m) => m.seq > maxSeq), "the resend to finish");
    const resent = server.up.slice(server.upAtHello[1]).filter((m) => m.ch === server.chs.c1 && m.line === '{"t":"n"}' && m.seq <= maxSeq).length;
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
    // Main had applied every line before the drop; its ack says so on the new socket, right after the welcome.
    const { resent, unacked } = await stalledRedial(server, { afterWelcome: (maxSeq) => [{ type: "ack", ack: maxSeq }] });
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
    const { resent, unacked } = await stalledRedial(server, { stalled: async () => {
      server.stdin("c1", "flood");
      // 40 MB of output, past the channel buffer: wait for the daemon to drop it.
      await waitForDropped(log, FLOOD_BYTES - LINK_LIMITS.channelBufferBytes);
    } });
    // The resend stalled after about three frames; the fourth frame's lines must not go again.
    assert.ok(unacked - resent >= 2_000, `${resent} of ${unacked} lines resent`);
  } finally {
    await daemon.stop();
    log.restore();
  }
});

async function drainWhenIdle(daemon) {
  let status;
  await waitFor(() => {
    try { status = daemon.control("drain"); return true; }
    catch (error) { if (error.code !== "host_busy") throw error; return false; }
  }, "all meaningful daemon work and reliable bytes to finish");
  assert.equal(status.drained, true);
  return status;
}

test("local status identifies the daemon and idle-but-open children veto drain without being killed", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    const before = daemon.control("status");
    assert.equal(before.pid, process.pid);
    assert.equal(before.protocol, LINK_PROTOCOL_VERSION);
    assert.equal(before.version, (await import("../../package.json", { with: { type: "json" } })).default.version);
    assert.equal(before.drained, false);
    assert.equal(before.linked, false, "opening a socket is not a welcomed link");
    assert.equal(before.executable, realpathSync(process.execPath));
    assert.equal(typeof before.entrypoint, "string");
    assert.deepEqual(Object.keys(before).sort(), ["drained", "entrypoint", "executable", "linked", "pid", "protocol", "version"]);
    await waitFor(() => daemon.control("status").linked, "the daemon's welcome");
    await spawnChannel(server, "drain-child");
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    assert.equal(daemon.control("status").drained, false);
    server.stdin("drain-child", "identify");
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.ch === server.chs["drain-child"] && m.line.includes('"identity"')), "the un-killed idle child");
    server.stdin("drain-child", "exit");
    await waitFor(() => server.up.some((m) => m.type === "exit" && m.ch === server.chs["drain-child"]), "the child's voluntary exit");
    await drainWhenIdle(daemon);
  } finally {
    await daemon.stop();
    server.stop();
    log.restore();
  }
});

test("synchronous local drain closes spawn, preparation and upload admission until explicit resume", () => withPoolGit(async (f) => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const id = "a030c96d-1660-46d4-a120-000000000001";
  try {
    await waitFor(() => daemon.control("status").linked, "the welcomed link");
    const drained = daemon.control("drain");
    assert.equal(typeof drained.then, "undefined", "admission must close in this daemon turn, not after an await");
    assert.equal(drained.drained, true);
    for (const [requestId, op, args] of [
      ["drained-spawn", "open", openCreation(f.root)],
      ["drained-prepare", "preparePoolProject", { input: f.input }],
      ["drained-upload", "uploadStart", { id, attempt: id, name: "blocked.bin", size: 1, type: "" }],
      ["drained-attach", "uploadAttach", { id, sessionId: id, sessionFile: join(process.env.PI_CODING_AGENT_DIR, "sessions", `${id}.jsonl`) }],
      ["drained-abort", "uploadAbort", { id }],
      ["drained-read", "listSessions", {}],
      ["drained-check", "checkUpdates", { compatibility: { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION } }],
      ["drained-update", "updateSoftware", { target: "ompweb", version: "99.0.0", compatibility: { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION } }],
    ]) {
      const answer = await daemonOp(server, requestId, op, args);
      assert.equal(answer.ok, false, requestId);
      assert.equal(answer.error.code, "host_drained", requestId);
    }
    assert.equal(existsSync(f.cloneRoot), false);
    assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads", `${id}.part`)), false);
    assert.equal(childrenIn(f.root).length, 0);
    server.raw({ type: "ping" });
    await waitFor(() => server.up.some((m) => m.type === "pong"), "pongs while drained");
    assert.equal(daemon.control("status").drained, true, "a deployer disconnect cannot reopen admission");
    assert.equal(daemon.control("resume").drained, false);
    const prepared = await daemonOp(server, "resumed-prepare", "preparePoolProject", { input: f.input });
    assert.equal(prepared.result.ok, true, JSON.stringify(prepared));
    assert.equal(readFileSync(join(prepared.result.value.cwd, "tracked.txt"), "utf8"), "committed\n");
    const spawned = await daemonOp(server, "resumed-spawn", "open", openCreation(prepared.result.value.cwd));
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    await waitFor(() => childrenIn(prepared.result.value.cwd).length === 1, "one real child after resume");
  } finally {
    await daemon.stop();
    server.stop();
    log.restore();
  }
}));

test("a real pending non-preparation host operation vetoes drain until its child and reliable result finish", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const id = "c8400752-045c-4dcc-8b80-000000000001";
  const file = join(process.env.PI_CODING_AGENT_DIR, "sessions", "control-export", `${id}.jsonl`);
  const entered = join(scratch, "export-entered");
  const release = join(scratch, "export-release");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: scratch, timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  rmSync(entered, { force: true });
  rmSync(release, { force: true });
  try {
    await waitFor(() => server.hellos.length === 1, "the link");
    await daemonOp(server, "export-invalidate", "invalidateSessionLists", {});
    server.send({ type: "req", id: "held-export", op: "exportSession", args: { id } });
    await waitFor(() => existsSync(entered), "the real export process");
    const pid = Number(readFileSync(entered, "utf8"));
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    assert.equal(daemon.control("status").drained, false);
    assert.doesNotThrow(() => process.kill(pid, 0), "busy refusal leaves the real operation alive");
    server.holdAcks = true;
    writeFileSync(release, "");
    await waitFor(() => server.res("held-export"), "the real export reply");
    assert.equal(server.res("held-export").result.value.html, "<html>real export child</html>");
    assert.throws(() => daemon.control("drain"), { code: "host_busy" }, "the reply is still reliable and unacknowledged");
    server.holdAcks = false;
    await drainWhenIdle(daemon);
  } finally {
    writeFileSync(release, "");
    await daemon.stop();
    server.stop();
    rmSync(file, { force: true });
    log.restore();
  }
});

test("unacknowledged result blobs block local drain across link loss, but link telemetry does not", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const hash = "ac".repeat(32);
  const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
  mkdirSync(dirname(media), { recursive: true });
  writeFileSync(media, "result bytes, not telemetry");
  try {
    await waitFor(() => daemon.control("status").linked, "the welcomed link");
    server.holdAcks = true;
    await daemonOp(server, "control-blob", "readMedia", { hash });
    assert.deepEqual(server.blobs, [{ id: "control-blob", bytes: "result bytes, not telemetry" }]);
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    server.drop();
    await waitFor(() => !daemon.control("status").linked, "link loss");
    assert.throws(() => daemon.control("drain"), { code: "host_busy" }, "disconnect cannot discard reliable obligations");
    await waitFor(() => server.hellos.length === 2, "the real reconnect");
    server.holdAcks = false;
    await drainWhenIdle(daemon);
    assert.equal(daemon.control("status").linked, true);
  } finally {
    await daemon.stop();
    server.stop();
    rmSync(media, { force: true });
    log.restore();
  }
});

test("an open partial upload blocks drain; its actual completed bytes survive explicit resume", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const id = "0f7d9e43-61b8-4619-8053-000000000001";
  const part = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads", `${id}.part`);
  try {
    await waitFor(() => server.hellos.length === 1, "the link");
    assert.equal((await daemonOp(server, "control-upload", "uploadStart", { id, attempt: id, name: "real.bin", size: 4, type: "" })).ok, true);
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    const { encodeBlobFrame } = await import("./link-protocol.ts");
    server.raw({ type: "ping" });
    // Send real binary frames on the scripted hub's socket, not through a fake upload callback.
    server.binary(encodeBlobFrame(id, Buffer.from("data")));
    await waitFor(() => server.up.some((m) => m.type === "upload_ack" && m.id === id && m.done), "the durable upload acknowledgement");
    assert.equal(readFileSync(part, "utf8"), "data");
    await drainWhenIdle(daemon);
    assert.equal(daemon.control("resume").drained, false);
    const resumed = await daemonOp(server, "control-upload-resume", "uploadStart", { id, attempt: id, name: "real.bin", size: 4, type: "" });
    assert.deepEqual(resumed.result, { received: 4, done: true });
    await daemonOp(server, "control-upload-abort", "uploadAbort", { id });
  } finally {
    await daemon.stop();
    server.stop();
    log.restore();
  }
});
