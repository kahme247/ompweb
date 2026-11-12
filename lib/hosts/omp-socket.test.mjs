import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { ChannelTable } from "./daemon-channels.ts";
import { listenHostSocket } from "./omp-socket.ts";

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
  });
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
