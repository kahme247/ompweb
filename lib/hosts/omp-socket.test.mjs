import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { ChannelTable } from "./daemon-channels.ts";
import { CHANNEL_PROTO, hostSocketPath, listenHostSocket } from "./omp-socket.ts";
import * as runner from "../../runner/src/channel.ts";

const SESSION = "33333333-3333-4333-8333-333333333333";
const scratch = mkdtempSync(join(tmpdir(), "omp-socket-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function until(predicate, what) {
  for (const started = Date.now(); !predicate(); await new Promise(resolve => setTimeout(resolve, 10))) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${what}`);
  }
}

test("a runner that says hello on the host socket is announced as a channel with its session id", { skip: process.platform === "win32" }, async () => {
  const path = join(scratch, "runtime", "ompweb", "host.sock");
  const announced = [];
  const link = { id: "l1", version: 7, isUp: () => true, queue() { return 1; }, output() {}, discard() {} };
  const table = new ChannelTable({ sessionId: () => SESSION, prepareLaunch: launch => launch, log() {}, channelsChanged: ch => announced.push(ch),
    spawn: () => { throw new Error("an attached omp is never spawned"); } });
  const socket = await listenHostSocket(path, { adopt: (spawned, launch) => table.adopt(spawned, launch), log() {} });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(scratch, "runtime", "ompweb")).mode & 0o777, 0o700);

  // The fake runner answers every daemon command, as the real one does.
  const runner = createConnection(path);
  createInterface({ input: runner }).on("line", line => {
    const frame = JSON.parse(line);
    if (frame.t === "cmd") runner.write(JSON.stringify({ t: "res", id: frame.id, ok: true }) + "\n");
  }).on("error", () => {}); // socket.close() below hangs up on the runner: a res still in flight gets EPIPE.
  const closed = new Promise(resolve => runner.once("close", resolve));
  runner.write(JSON.stringify({ t: "hello", proto: 1, pid: 4242, sessionId: SESSION, sessionFile: join(scratch, "s.jsonl"), cwd: scratch }) + "\n");

  await until(() => announced.length > 0, "the channel announcement");
  const [listed] = table.listing(link);
  assert.equal(listed.ch, announced[0]);
  assert.equal(listed.sessionId, SESSION);
  assert.equal(listed.cwd, scratch);

  await socket.close();
  await closed;
  assert.equal(existsSync(path), false);
  await until(() => table.size === 0, "the channel's exit on disconnect");
  await table.stop();
});

test("the host socket refuses a directory others can write", { skip: process.platform === "win32" }, async () => {
  const dir = join(scratch, "open");
  mkdirSync(dir);
  chmodSync(dir, 0o777);
  await assert.rejects(listenHostSocket(join(dir, "host.sock"), { adopt: async () => {}, log() {} }), /group or world writable/);
  assert.equal(existsSync(join(dir, "host.sock")), false);
});

test("the host and the runner agree on the socket path and the channel protocol for the same env", () => {
  assert.equal(CHANNEL_PROTO, runner.CHANNEL_PROTO);
  const saved = { OMPWEB_HOST_SOCKET: process.env.OMPWEB_HOST_SOCKET, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  try {
    for (const env of [{}, { XDG_RUNTIME_DIR: "/run/user/1" }, { OMPWEB_HOST_SOCKET: "/x/h.sock", XDG_RUNTIME_DIR: "/run/user/1" }]) {
      delete process.env.OMPWEB_HOST_SOCKET; delete process.env.XDG_RUNTIME_DIR;
      Object.assign(process.env, env);
      assert.equal(hostSocketPath(), runner.hostSocketPath(), JSON.stringify(env));
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("a second runner on a session that already has a channel is refused with a frame and gets no channel", { skip: process.platform === "win32" }, async () => {
  const path = join(scratch, "dup", "host.sock");
  const table = new ChannelTable({ sessionId: () => null, prepareLaunch: launch => launch, log() {}, spawn: () => { throw new Error("never spawned"); } });
  const socket = await listenHostSocket(path, { adopt: (spawned, launch, sessionId) => table.adopt(spawned, launch, sessionId), log() {} });
  const dial = () => {
    const conn = createConnection(path), lines = [];
    createInterface({ input: conn }).on("line", line => {
      const frame = JSON.parse(line); lines.push(frame);
      if (frame.t === "cmd") conn.write(JSON.stringify({ t: "res", id: frame.id, ok: true }) + "\n");
    });
    // A new session: no file yet, so only the hello's session id names it.
    conn.write(JSON.stringify({ t: "hello", proto: 1, pid: 1, sessionId: SESSION, sessionFile: null, cwd: scratch }) + "\n");
    return { conn, lines, closed: new Promise(resolve => conn.once("close", resolve)) };
  };
  const first = dial();
  await until(() => table.size === 1, "the first channel");
  const second = dial();
  await second.closed;
  assert.deepEqual(second.lines, [{ t: "refused", reason: "This session is already running on another link" }]);
  assert.equal(table.size, 1);
  await socket.close(); await first.closed; await table.stop();
});

test("the socket is 0600 even under umask 0", { skip: process.platform === "win32" }, async () => {
  const path = join(scratch, "umask", "host.sock");
  const old = process.umask(0);
  try {
    const socket = await listenHostSocket(path, { adopt: async () => {}, log() {} });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(process.umask(), 0, "the caller's umask is restored");
    await socket.close();
  } finally { process.umask(old); }
});
