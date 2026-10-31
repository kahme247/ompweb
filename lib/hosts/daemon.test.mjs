import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
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
  const command = JSON.parse(line);
  const { type } = command;
  if (type === "state") process.stdout.write(JSON.stringify({ type: "response", id: "g1", command: "get_state", success: true, data: { sessionId: command.sessionId } }) + "\\n");
  if (type === "flood") for (let i = 0; i < 200; i++) process.stdout.write(JSON.stringify({ type: "x", i, pad: "y".repeat(100_000) }) + "\\n");
  if (type === "huge") process.stdout.write(JSON.stringify({ type: "x", pad: "y".repeat(9 * 1024 * 1024) }) + "\\n");
  if (type === "echo") process.stdout.write('{"type":"echoed"}\\n');
  if (type === "ask") process.stdout.write('{"type":"extension_ui_request","id":"q1","method":"ask","questions":[]}\\n');
});
`);

const jiti = createJiti(import.meta.url);
const { nextRedialDelay, runHostDaemon } = await jiti.import("./daemon.ts");
const { LINK_ACK_HEADER, LINK_HELLO_HEADER, LINK_NONCE_HEADER } = await jiti.import("./link-protocol.ts");

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
function scriptedServer({ getStatus = () => 200, helloStatus = 200, validToken = null } = {}) {
  const server = { validToken, up: [], hellos: [], offered: null, downlink: null, uplinkDown: false, gets: 0, nonce: null, refused: [], blobs: [], postStatus: [], acks: [] };
  let downSeq = 0;
  let ack = 0;
  server.fetch = async (url, init = {}) => {
    if (server.validToken && init.headers?.authorization !== `Bearer ${server.validToken}`) return Response.json({}, { status: 401 });
    if (init.method === "POST" && init.headers[LINK_HELLO_HEADER]) {
      if (helloStatus !== 200) return Response.json({ error: "This link was replaced; wait for the next welcome" }, { status: helloStatus });
      server.offered = { id: `hello-${server.gets + 1}`, hello: JSON.parse(String(init.body)) };
      return Response.json({ helloId: server.offered.id });
    }
    if (!init.method || init.method === "GET") {
      server.gets += 1;
      const status = getStatus(server.gets);
      if (status !== 200) return typeof status === "object" ? status : Response.json({}, { status });
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
    server.acks.push(init.headers[LINK_ACK_HEADER]);
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
  const script = `const { createJiti } = await import(${JSON.stringify(import.meta.resolve("jiti"))});
const { localHost } = await createJiti(${JSON.stringify(localHostFile)}).import(${JSON.stringify(localHostFile)});
await localHost.spawnRpc({ cwd: ${JSON.stringify(scratch)}, recordedCwd: null, sessionFile: "", advisor: false });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: scratch, env: { ...process.env, OMP_WEB_OMP_BIN: recorder }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const args = JSON.parse(readFileSync(argvFile, "utf8"));
  const extension = args[args.indexOf("--extension") + 1];
  assert.ok(existsSync(extension), extension);
});

test("hostnames that only look like loopback need --allow-http", () => {
  for (const url of ["http://localhost.evil.com", "http://127.0.0.1.nip.io", "http://evil-localhost", "http://127.0.0.1@example.com"]) {
    assert.throws(() => runHostDaemon({ url, token: "t", allowHttp: false, fetch: async () => Response.json({}, { status: 503 }) }), /https:\/\//, url);
  }
});

test("an http:// server needs loopback or --allow-http", () => {
  assert.throws(() => runHostDaemon({ url: "http://example.com", token: "t", allowHttp: false, fetch: async () => Response.json({}, { status: 503 }) }), /https:\/\//);
});

test("an unknown op is answered 501 unknown_op and a resent downlink seq runs once", async () => {
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
    await waitFor(() => server.downlink, "the downlink");
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
    await waitFor(() => server.downlink, "the downlink");
    server.raw({ type: "future", seq: 1, x: 1 });
    server.raw({ type: "future", seq: 2 });
    server.raw({ type: "ping" });
    await waitFor(() => server.acks.includes("2"), "an uplink POST acking both unknown messages");
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
    await waitFor(() => server.downlink, "the downlink");
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
    server.downlink.close();
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

test("a 426 names which side to update", async () => {
  const log = captureLog();
  try {
    const newer = start(scriptedServer({ getStatus: () => Response.json({ serverVersion: 2, hostVersion: 3 }, { status: 426 }) }));
    assert.equal(await newer.done, 1);
    assert.ok(log.lines.some((line) => line.includes("this host's ompweb is newer than the server's: update ompweb on the server")), log.lines.join("|"));
    log.lines.length = 0;
    const older = start(scriptedServer({ getStatus: () => Response.json({ serverVersion: 9, hostVersion: 3 }, { status: 426 }) }));
    assert.equal(await older.done, 1);
    assert.ok(log.lines.some((line) => line.includes("update ompweb on this host")), log.lines.join("|"));
  } finally {
    log.restore();
  }
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
    // 20 MB of output, read by the daemon well within this pause.
    await sleep(1_500);
    server.uplinkDown = false;
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
    assert.ok(log.lines.some((line) => line.includes("update ompweb on this host")));

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

test("after a link drop the next hello carries each channel's open blocking requests; an answer closes them", async () => {
  const log = captureLog();
  const server = scriptedServer();
  const daemon = start(server);
  try {
    await waitFor(() => server.downlink, "the downlink");
    await spawnChannel(server, "c1");
    server.send({ type: "stdin", ch: "c1", line: '{"type":"ask"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line.includes('"q1"')), "the ask request");
    const request = server.up.find((m) => m.type === "stdout" && m.line.includes('"q1"')).line;
    assert.deepEqual(server.hellos[0].channels, []);
    server.downlink.close();
    await waitFor(() => server.hellos.length === 2, "the relink");
    assert.deepEqual(server.hellos[1].channels, [{ ch: "c1", sessionId: null, cwd: scratch, pending: [request] }]);
    // The answer goes down to omp: the request is no longer open. The echo orders it before the drop.
    server.send({ type: "stdin", ch: "c1", line: '{"type":"extension_ui_response","id":"q1","answers":[]}\n' });
    server.send({ type: "stdin", ch: "c1", line: '{"type":"echo"}\n' });
    await waitFor(() => server.up.some((m) => m.type === "stdout" && m.line === '{"type":"echoed"}'), "the echo");
    server.downlink.close();
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
    server.downlink.close();
    await waitFor(() => server.hellos.length === count, "the relink");
    return server.hellos[count - 1].channels.map(({ ch, sessionId }) => ({ ch, sessionId }));
  };
  const reported = async (sessionId) => {
    const before = server.up.filter((m) => m.type === "stdout").length;
    server.send({ type: "stdin", ch: "fresh", line: `${JSON.stringify({ type: "state", sessionId })}\n` });
    await waitFor(() => server.up.filter((m) => m.type === "stdout").length > before, "the get_state response");
  };
  try {
    await waitFor(() => server.downlink, "the downlink");
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

const hostJson = join(scratch, "agent", "omp-web", "host.json");
function writeHostJson(token) {
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url: "http://127.0.0.1:9", token }));
}

test("a 401 with a newer token in host.json redials with it and links", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "new" });
  writeHostJson("new");
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "stale", allowHttp: false, fetch: server.fetch });
  try {
    await waitFor(() => server.downlink, "the downlink after the token swap");
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
  writeHostJson("stale");
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "stale", allowHttp: false, fetch: server.fetch });
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
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url: "https://elsewhere.example.com/", token: "new" }));
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "stale", allowHttp: false, fetch: server.fetch });
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
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url: "http://127.0.0.1:9//", token: "new" }));
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9/", token: "stale", allowHttp: false, fetch: server.fetch });
  try {
    await waitFor(() => server.hellos.length === 1, "the link with the new token");
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});

/** The web server moved from port 9 to port 10: dials to port 9 fail. Each dialed port lands in `dialed`. */
function movedServer(server, dialed) {
  return (url, init) => {
    const { port } = new URL(url);
    dialed.push(port);
    return port === "10" ? server.fetch(url, init) : Promise.reject(new TypeError("fetch failed"));
  };
}

test("a failed dial re-reads host.json and follows its new url", async () => {
  const log = captureLog();
  const server = scriptedServer();
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url: "http://127.0.0.1:10", token: "t" }));
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "t", allowHttp: false, fetch: movedServer(server, []) });
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
  mkdirSync(dirname(hostJson), { recursive: true });
  writeFileSync(hostJson, JSON.stringify({ url: "http://example.com:10", token: "t" }));
  const dialed = [];
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "t", allowHttp: false, fetch: movedServer(scriptedServer(), dialed) });
  try {
    await waitFor(() => dialed.length >= 2, "a redial");
    assert.deepEqual([...new Set(dialed)], ["9"]);
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

test("a blob upload refused with 401 after the web server re-keyed retries with the new token", async () => {
  const log = captureLog();
  const server = scriptedServer({ validToken: "old" });
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "old", allowHttp: false, fetch: server.fetch });
  try {
    await waitFor(() => server.downlink, "the downlink");
    const hash = "b".repeat(64);
    const media = join(process.env.PI_CODING_AGENT_DIR, "blobs", hash);
    mkdirSync(dirname(media), { recursive: true });
    writeFileSync(media, "image-bytes");
    writeHostJson("new");
    server.validToken = "new";
    server.send({ type: "req", id: "m2", op: "readMedia", args: { hash } });
    await waitFor(() => server.res("m2"), "the result");
    assert.equal(server.res("m2").ok, true);
    assert.deepEqual(server.blobs, ["m2"]);
  } finally {
    await daemon.stop();
    rmSync(hostJson, { force: true });
    log.restore();
  }
});
