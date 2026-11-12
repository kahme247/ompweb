import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHostControlServer, hostControlDescriptorPath, hostControlPath, requestHostControl } from "./host-control.ts";
import { runHostDaemon } from "./daemon.ts";

const unixOnly = { skip: process.platform === "win32" && "Unix socket ownership and permissions; Windows uses the named-pipe tests below" };
const windowsOnly = { skip: process.platform !== "win32" && "Windows named-pipe control" };

async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await sleep(10);
  }
}

async function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "ompweb-host-control-"));
  const agent = join(scratch, "agent");
  const path = process.platform === "win32" ? null : hostControlPath(agent);
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, omp: process.env.OMP_WEB_OMP_BIN };
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.OMP_WEB_OMP_BIN = join(scratch, "missing-omp");
  // No session or credentials are needed: this real daemon simply redials an unused local port.
  const daemon = runHostDaemon({ url: "http://127.0.0.1:9", token: "must-not-appear-in-status", allowHttp: false });
  t.after(async () => {
    await daemon.stop();
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["OMP_WEB_OMP_BIN", saved.omp]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (path) rmSync(dirname(path), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  // Drain refuses while startup work runs; tests exercise admission, not that race.
  await daemon.started;
  return { scratch, agent, path, daemon };
}

async function rawRequest(path, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("local control response timed out")));
    socket.on("error", reject);
    // Write, not end: Windows named pipes cannot half-close, which drops the reply.
    socket.on("connect", () => socket.write(input));
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("end", () => resolve(text));
  });
}

test("a real daemon is controlled through an owned private Unix endpoint without disclosing its login", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  assert.equal(server.path, f.path);
  assert.equal(lstatSync(dirname(f.path)).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.path).isSocket(), true);
  assert.equal(lstatSync(f.path).uid, process.getuid());
  const status = await requestHostControl("status", f.agent);
  assert.equal(status.pid, process.pid);
  assert.equal(status.linked, false);
  assert.equal(status.drained, false);
  assert.equal(JSON.stringify(status).includes("must-not-appear-in-status"), false);
  assert.equal((await requestHostControl("drain", f.agent)).drained, true);
  assert.equal(f.daemon.control("status").drained, true, "the socket changes the actual daemon, not an echo fixture");
  assert.equal((await requestHostControl("status", f.agent)).drained, true, "a closed caller cannot release drain");
  assert.equal((await requestHostControl("resume", f.agent)).drained, false);
  await server.close();
  assert.equal(existsSync(f.path), false);
});

test("agent identity gives a short deterministic isolated path even under long Darwin roots", unixOnly, async (t) => {
  const f = await fixture(t);
  const agent = join(f.scratch, "long-agent-root-".repeat(12), "agent");
  const path = hostControlPath(agent);
  t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(path) < 100, `Unix socket path is too long: ${path}`);
  assert.equal(hostControlPath(agent), path);
  assert.notEqual(path, hostControlPath(join(agent, "other")));
  const server = await createHostControlServer(f.daemon.control, agent);
  t.after(() => server.close());
  assert.equal((await requestHostControl("status", agent)).pid, process.pid);
});

test("a second endpoint acquisition refuses the live daemon and preserves its inode and connection", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  const before = lstatSync(f.path);
  await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /already|running|occupied|in use/i);
  assert.equal(lstatSync(f.path).ino, before.ino);
  assert.equal((await requestHostControl("status", f.agent)).pid, process.pid);
});

test("non-socket and symlink endpoints are never removed by either client or server", unixOnly, async (t) => {
  const f = await fixture(t);
  mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
  const target = join(f.scratch, "preserve-me");
  writeFileSync(target, "foreign data");
  for (const kind of ["file", "symlink"]) {
    if (kind === "file") writeFileSync(f.path, "not a socket", { mode: 0o600 });
    else symlinkSync(target, f.path);
    const before = lstatSync(f.path);
    await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /socket|symlink|unsafe|owned/i);
    await assert.rejects(requestHostControl("status", f.agent), /socket|symlink|unsafe|owned/i);
    assert.equal(lstatSync(f.path).ino, before.ino);
    assert.equal(readFileSync(target, "utf8"), "foreign data");
    unlinkSync(f.path);
  }
});

test("a symlink or non-private runtime directory is refused without changing it", unixOnly, async (t) => {
  const f = await fixture(t);
  const dir = dirname(f.path);
  const target = join(f.scratch, "foreign-directory");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, dir);
  await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /directory|symlink|unsafe|private/i);
  assert.equal(lstatSync(dir).isSymbolicLink(), true);
  unlinkSync(dir);
  mkdirSync(dir, { mode: 0o755 });
  await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /permission|private|0700|unsafe/i);
  assert.equal(lstatSync(dir).mode & 0o777, 0o755);
});

test("an actual refused stale owned socket is recovered after its process dies", unixOnly, async (t) => {
  const f = await fixture(t);
  mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
  const source = `const fs=require('node:fs');require('node:net').createServer().listen(${JSON.stringify(f.path)},()=>{fs.chmodSync(${JSON.stringify(f.path)},0o600);console.log('listening')});`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  await until(() => stdout.includes("listening"), "the real Unix listener");
  child.kill("SIGKILL");
  await exited;
  assert.equal(lstatSync(f.path).isSocket(), true, "the crashed process left its own endpoint");
  await assert.rejects(rawRequest(f.path, '{"command":"status"}\n'), { code: "ECONNREFUSED" });
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  assert.equal((await requestHostControl("status", f.agent)).pid, process.pid);
});

test("closing an endpoint never unlinks a replacement created after acquisition", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  unlinkSync(f.path);
  writeFileSync(f.path, "replacement must survive", { mode: 0o600 });
  const replacement = lstatSync(f.path);
  await server.close();
  assert.equal(lstatSync(f.path).ino, replacement.ino);
  assert.equal(readFileSync(f.path, "utf8"), "replacement must survive");
});

test("foreign-owned sockets are not reclaimed", { ...unixOnly, skip: process.platform === "win32" || process.getuid?.() !== 0 ? "Requires Unix root to create an actually foreign-owned endpoint" : false }, async (t) => {
  const f = await fixture(t);
  mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(f.path, resolve); });
  chownSync(f.path, 65534, 65534);
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const before = lstatSync(f.path);
  await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /owner|owned|foreign|unsafe/i);
  await assert.rejects(requestHostControl("status", f.agent), /owner|owned|foreign|unsafe/i);
  assert.equal(lstatSync(f.path).ino, before.ino);
});

test("malformed and oversized control messages cannot change daemon admission", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  for (const line of ['not-json\n', '{"command":"spawn"}\n', '{"command":"drain","token":"untrusted"}\n', 'x'.repeat(8192) + '\n']) {
    await rawRequest(f.path, line).catch((error) => {
      assert.ok(["ECONNRESET", "EPIPE"].includes(error.code), String(error));
    });
    assert.equal(f.daemon.control("status").drained, false);
  }
  assert.equal((await requestHostControl("drain", f.agent)).drained, true);
});

test("clients reject insecure socket permissions instead of sending a command", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  chmodSync(f.path, 0o666);
  await assert.rejects(requestHostControl("drain", f.agent), /permission|private|0600|unsafe/i);
  assert.equal(f.daemon.control("status").drained, false);
});

test("losing a real resume response does not undo admission or permit the caller to assume drain remains held", unixOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  assert.equal((await requestHostControl("drain", f.agent)).drained, true);
  await new Promise((resolve, reject) => {
    const socket = createConnection(f.path);
    socket.once("error", reject);
    socket.once("connect", () => socket.write('{"command":"resume"}\n', () => {
      // Flush the real command, then discard the socket before consuming any acknowledgement.
      socket.destroy();
      resolve();
    }));
  });
  await until(() => !f.daemon.control("status").drained, "the real resume despite its lost response");
  assert.equal((await requestHostControl("status", f.agent)).drained, false);
});

test("Windows: a real daemon is controlled through a random named pipe and a per-start token", windowsOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  assert.match(server.path, /^\\\\\.\\pipe\\ompweb-host-[0-9a-f]{32}$/);
  const descriptor = JSON.parse(readFileSync(hostControlDescriptorPath(f.agent), "utf8"));
  assert.equal(descriptor.pipe, server.path);
  assert.match(descriptor.token, /^[A-Za-z0-9_-]{43}$/);
  const status = await requestHostControl("status", f.agent);
  assert.equal(status.pid, process.pid);
  assert.equal(JSON.stringify(status).includes("must-not-appear-in-status"), false);
  assert.equal((await requestHostControl("drain", f.agent)).drained, true);
  assert.equal(f.daemon.control("status").drained, true, "the pipe changes the actual daemon, not an echo fixture");
  assert.equal((await requestHostControl("resume", f.agent)).drained, false);
  await server.close();
  assert.equal(existsSync(hostControlDescriptorPath(f.agent)), false);
  await assert.rejects(rawRequest(descriptor.pipe, '{"command":"status"}\n'), (error) => error.code === "ENOENT");
});

test("Windows: requests without the current token cannot change daemon admission", windowsOnly, async (t) => {
  const f = await fixture(t);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => server.close());
  const { token } = JSON.parse(readFileSync(hostControlDescriptorPath(f.agent), "utf8"));
  const wrong = (token[0] === "A" ? "B" : "A") + token.slice(1);
  for (const line of ['{"command":"drain"}\n', `{"command":"drain","token":"${wrong}"}\n`, `{"command":"drain","token":"${token}","extra":1}\n`, '{"command":"drain","token":7}\n']) {
    const reply = JSON.parse(await rawRequest(server.path, line));
    assert.equal(reply.ok, false, line);
    assert.equal(f.daemon.control("status").drained, false, line);
  }
  assert.equal(JSON.parse(await rawRequest(server.path, `{"command":"drain","token":"${token}"}\n`)).status.drained, true);
});

test("Windows: a second start refuses the live pipe and keeps its descriptor; a stale descriptor is replaced", windowsOnly, async (t) => {
  const f = await fixture(t);
  const file = hostControlDescriptorPath(f.agent);
  const server = await createHostControlServer(f.daemon.control, f.agent);
  const live = readFileSync(file, "utf8");
  await assert.rejects(createHostControlServer(f.daemon.control, f.agent), /already running/);
  assert.equal(readFileSync(file, "utf8"), live);
  assert.equal((await requestHostControl("status", f.agent)).pid, process.pid);
  await server.close();
  // A crashed daemon leaves its descriptor behind; nothing answers on its pipe.
  writeFileSync(file, live);
  const replacement = await createHostControlServer(f.daemon.control, f.agent);
  t.after(() => replacement.close());
  assert.notEqual(replacement.path, JSON.parse(live).pipe);
  assert.equal((await requestHostControl("status", f.agent)).pid, process.pid);
});

test("Windows: clients never connect to a pipe outside the descriptor contract", windowsOnly, async (t) => {
  const f = await fixture(t);
  const file = hostControlDescriptorPath(f.agent);
  await assert.rejects(requestHostControl("status", f.agent), /No host daemon is running/);
  const decoy = createServer((socket) => { socket.destroy(); assert.fail("the client connected to a decoy pipe"); });
  const listened = Promise.withResolvers();
  decoy.listen("\\\\.\\pipe\\decoy-" + process.pid, listened.resolve);
  await listened.promise;
  t.after(() => decoy.close());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pipe: "\\\\.\\pipe\\decoy-" + process.pid, token: "x".repeat(43) }));
  await assert.rejects(requestHostControl("drain", f.agent), /Invalid host control descriptor/);
  assert.equal(f.daemon.control("status").drained, false);
});
