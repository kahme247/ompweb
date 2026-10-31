import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const { type } = command;
  if (type === "state") process.stdout.write(JSON.stringify({ type: "response", id: "g1", command: "get_state", success: true, data: { sessionId: command.sessionId } }) + "\\n");
  if (type === "flood") for (let i = 0; i < 200; i++) process.stdout.write(JSON.stringify({ type: "x", i, pad: "y".repeat(100_000) }) + "\\n");
  if (type === "huge") process.stdout.write(JSON.stringify({ type: "x", pad: "y".repeat(9 * 1024 * 1024) }) + "\\n");
  if (type === "echo") process.stdout.write('{"type":"echoed"}\\n');
  if (type === "ask") process.stdout.write('{"type":"extension_ui_request","id":"q1","method":"ask","questions":[]}\\n');
});
`);

const { nextRedialDelay, runHostDaemon } = await import("./daemon.ts");
const { decodeBlobFrame, LINK_LIMITS, LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");

const decoder = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A scripted main server. `gets` counts upgrade attempts; `refuse(n)` answers the nth with a status (null: upgrade);
 * a plain GET (the daemon's diagnosis) gets the status the latest attempt got, or 426 after an upgrade, as the hub
 * answers. A socket's first frame is its hello, answered `welcome`; later text frames are split into `acks` (their
 * leading `ack` line) and `up`, each answered with an `ack` unless `holdAcks` (clearing it answers the held frame);
 * binary frames land in `blobs`. `frames` lists every frame after a hello in arrival order. */
function scriptedServer({ refuse = () => null, validToken = null } = {}) {
  let downSeq = 0;
  let ack = 0;
  let latest = 426;
  let socket = null;
  let held = null;
  let holdAcks = false;
  const sendAck = (ws) => ws.send(JSON.stringify({ type: "ack", ack }));
  const server = {
    refuse, validToken, hellos: [], up: [], acks: [], blobs: [], frames: [], gets: 0, diagnoses: 0,
    get holdAcks() { return holdAcks; },
    set holdAcks(value) {
      holdAcks = value;
      if (!value && held) sendAck(held);
      held = null;
    },
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
          return;
        }
        if (!ws.data.hello) {
          ws.data.hello = true;
          socket = ws;
          server.hellos.push(JSON.parse(data));
          server.raw({ type: "welcome", v: LINK_PROTOCOL_VERSION, hostId: "h1", nonce: "n" });
          return;
        }
        const messages = data.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        server.acks.push(messages[0]?.type === "ack" ? messages.shift().ack : "missing");
        server.frames.push(messages);
        server.up.push(...messages);
        for (const message of messages) if (Number.isInteger(message.seq)) ack = Math.max(ack, message.seq);
        if (holdAcks) held = ws;
        else sendAck(ws);
      },
      close(ws) {
        if (held === ws) held = null;
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

test("one uplink frame is in flight until its ack, and each frame starts with the ack of the applied downlink", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  const echoes = () => server.up.filter((m) => m.type === "stdout" && m.line === '{"type":"echoed"}').length;
  try {
    await waitFor(() => server.hellos.length === 1, "the hello");
    await spawnChannel(server, "c1");
    server.holdAcks = true;
    const frames = server.acks.length;
    const first = server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => echoes() === 1, "the first echo");
    const second = server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await sleep(300);
    assert.equal(server.acks.length, frames + 1, "no second frame before the hub's ack");
    assert.equal(server.acks.at(-1), first);
    assert.equal(echoes(), 1);
    server.holdAcks = false;
    await waitFor(() => echoes() === 2, "the second echo after the ack");
    assert.equal(server.acks.at(-1), second);
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
    server.holdAcks = true;
    server.send({ type: "stdin", ch: "c1", line: '{"type":"flood"}\n' });
    // 20 MB of output, read by the daemon well within this pause.
    await sleep(1_500);
    server.holdAcks = false;
    await waitFor(() => server.up.some((m) => m.type === "resync" && m.ch === "c1"), "resync");
    const floodLines = server.up.filter((m) => m.type === "stdout" && m.ch === "c1").length;
    assert.ok(floodLines < 200, `dropped output must not arrive (${floodLines} lines did)`);
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

