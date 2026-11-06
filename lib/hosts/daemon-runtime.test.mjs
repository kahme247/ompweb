import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeBlobFrame, encodeLine, PartJoiner } from "./link-protocol.ts";

const scratch = mkdtempSync(join(tmpdir(), "daemon-multi-runtime-"));
const old = { agent: process.env.PI_CODING_AGENT_DIR, bin: process.env.OMP_WEB_OMP_BIN };
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const fakeOmp = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
const spawns = join(scratch, "spawns");
const source = `if (process.argv.includes("--version")) { console.log("99.0.0-fake"); process.exit(0); }
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");
const file = process.argv[process.argv.indexOf("--resume") + 1];
const id = JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]).id;
const emit = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  emit({type:"response",id:command.id,command:command.type,success:true,data:command.type==="negotiate_protocol"?{protocolVersion:2}:command.type==="get_state"?{sessionId:id,sessionFile:file,pid:process.pid,isStreaming:false}: {}});
});
setImmediate(() => emit({type:"ready",supportedProtocolVersions:[1,2]}));
`;
if (process.platform === "win32") {
  writeFileSync(fakeOmp + ".cjs", source);
  writeFileSync(fakeOmp, `@"${process.execPath}" "${fakeOmp}.cjs" %*\r\n`);
} else writeFileSync(fakeOmp, `#!${process.execPath}\n${source}`, { mode: 0o755 });
process.env.OMP_WEB_OMP_BIN = fakeOmp;
const { runHostDaemon } = await import("./daemon.ts");
test.after(() => {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", old.agent], ["OMP_WEB_OMP_BIN", old.bin]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error("daemon runtime timeout"); await sleep(10); }
}
function hub(t, autoWelcome = true) {
  const hellos = [], messages = [], closed = [], joiner = new PartJoiner();
  let socket, ack = 0, seq = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("", { status: 426 }); },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string") throw new Error("Unexpected binary result");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "hello") {
            socket = ws; hellos.push(message);
            if (autoWelcome) ws.send(encodeLine({ type: "welcome", v: 7, hostId: "fixture" }));
          } else if (typeof message.seq === "number") {
            ack = Math.max(ack, message.seq);
            if (message.type === "part") { const whole = joiner.add(message); if (whole) messages.push(JSON.parse(whole)); }
            else messages.push(message);
          }
        }
        ws.send(encodeLine({ type: "ack", ack }));
      }, close(_ws, code) { closed.push(code); },
    },
  });
  t.after(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, hellos, messages, closed,
    send(message) { socket.send(encodeLine({ ...message, seq: ++seq })); },
    welcome() { socket.send(encodeLine({ type: "welcome", v: 7, hostId: "fixture" })); },
    bytes(id, text) { socket.send(encodeBlobFrame(id, Buffer.from(text))); },
    close(code) { socket.close(code); },
    result(id) { return messages.find(message => message.type === "res" && message.id === id); },
  };
}

test("configuration reload, source ops/uploads and peer-only deletion preserve other links and one process", async t => {
  const a = hub(t), b = hub(t), c = hub(t);
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web"), root = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-project");
  mkdirSync(dir, { recursive: true }); mkdirSync(root, { recursive: true });
  const config = join(dir, "host.json"), file = join(root, "2026-11-06_fixture.jsonl"), id = "11111111-1111-4111-8111-111111111111";
  const session = () => writeFileSync(file, [
    { type: "session", version: 3, id, cwd: scratch, timestamp: "2026-11-06T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-06T00:00:01.000Z", message: { role: "user", content: "hello" } },
  ].map(frame => JSON.stringify(frame)).join("\n") + "\n");
  const save = servers => writeFileSync(config, JSON.stringify({ url: a.url, token: "a", links: servers.map(server => ({ url: server.url, token: "token" })) }));
  session(); save([a, b]);
  const daemon = runHostDaemon({ allowHttp: false }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  assert.notEqual(a.hellos[0].link.id, b.hellos[0].link.id);
  await until(() => a.messages.some(message => message.type === "notifier" && message.on));
  assert.equal(a.hellos[0].link.notifier, false); assert.equal(b.hellos[0].link.notifier, false);
  const launch = { cwd: scratch, recordedCwd: scratch, sessionFile: file, advisor: false };
  a.send({ type: "req", id: "open-a", op: "open", args: { sessionId: id, launch } });
  await until(() => a.result("open-a")); assert.equal(a.result("open-a").ok, true);
  const firstCh = a.result("open-a").result.ch;
  const changes = server => server.messages.filter(message => message.type === "sessions_changed").length;
  await until(() => changes(a) > 0 && changes(b) > 0);
  const beforeA = changes(a), beforeB = changes(b);
  b.send({ type: "req", id: "rename", op: "renameSessionFile", args: { id, title: "Shared title", source: "user" } });
  await until(() => b.result("rename") && changes(a) > beforeA && changes(b) > beforeB);
  assert.equal(b.result("rename").result.ok, true);
  // B has no membership or wrapper: the daemon, not B's live-id snapshot, must stop A's child.
  b.send({ type: "req", id: "delete", op: "deleteSession", args: { id, liveSessionIds: [] } });
  await until(() => b.result("delete") && a.messages.some(message => message.type === "exit" && message.ch === firstCh));
  assert.equal(b.result("delete").result.ok, true); assert.equal(existsSync(file), false);
  assert.equal(b.messages.some(message => message.type === "exit"), false);
  session(); a.send({ type: "req", id: "open-again", op: "open", args: { sessionId: id, launch } });
  await until(() => a.result("open-again")); const ch = a.result("open-again").result.ch;
  writeFileSync(config, "{bad"); await sleep(300);
  a.send({ type: "req", id: "same", op: "sessionFileExists", args: { path: file } });
  b.send({ type: "req", id: "same", op: "sessionFileExists", args: { path: join(root, "missing.jsonl") } });
  await until(() => a.result("same") && b.result("same")); assert.equal(a.result("same").result, true); assert.equal(b.result("same").result, false);
  const upload = "33333333-3333-4333-8333-333333333333", attempt = "44444444-4444-4444-8444-444444444444";
  const args = { id: upload, attempt, name: "file.txt", size: 3, type: "text/plain" };
  a.send({ type: "req", id: "upload", op: "uploadStart", args }); await until(() => a.result("upload"));
  b.send({ type: "req", id: "collision", op: "uploadStart", args: { ...args, attempt: "55555555-5555-4555-8555-555555555555" } });
  await until(() => b.result("collision")); assert.equal(b.result("collision").error.status, 409);
  b.bytes(upload, "bad"); a.bytes(upload, "yes"); await until(() => a.messages.some(message => message.type === "upload_ack" && message.done));
  assert.equal(b.messages.some(message => message.type === "upload_ack"), false);
  assert.equal(readFileSync(join(dir, "uploads", upload + ".part"), "utf8"), "yes");
  save([a, b, c]); await until(() => c.hellos.length === 1); assert.equal(a.hellos.length, 1); assert.equal(b.hellos.length, 1);
  save([a, c]); await until(() => b.closed.length > 0); assert.equal(a.closed.length, 0); assert.equal(c.closed.length, 0);
  a.close(4409); await until(() => c.messages.some(message => message.type === "notifier" && message.on));
  c.send({ type: "req", id: "join-c", op: "open", args: { sessionId: id, launch } }); await until(() => c.result("join-c"));
  assert.equal(c.result("join-c").result.ch, ch); assert.equal(c.result("join-c").result.joined, true);
  c.send({ type: "stdin", ch, line: JSON.stringify({ type: "get_state", id: "c-state" }) + "\n" });
  await until(() => c.messages.some(message => message.type === "stdout" && JSON.parse(message.line).id === "c-state"));
  assert.equal(readFileSync(spawns, "utf8").trim().split("\n").length, 2, "only the explicitly deleted session was respawned");
  c.close(1000); assert.equal(await daemon.done, 1);
});

test("a channel created during another link's handshake is announced when that link comes up", async t => {
  const a = hub(t), b = hub(t, false);
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
  const sessions = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-handshake");
  mkdirSync(dir, { recursive: true }); mkdirSync(sessions, { recursive: true });
  const id = "77777777-7777-4777-8777-777777777777";
  const file = join(sessions, "handshake.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: scratch })}\n`);
  writeFileSync(join(dir, "host.json"), JSON.stringify({ url: a.url, token: "a", links: [{ url: a.url, token: "a" }, { url: b.url, token: "b" }] }));
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  assert.equal(b.hellos[0].channels.length, 0);
  a.send({ type: "req", id: "during-handshake", op: "open", args: { sessionId: id, launch: { cwd: scratch, recordedCwd: scratch, sessionFile: file, advisor: false } } });
  await until(() => a.result("during-handshake"));
  assert.equal(a.result("during-handshake").ok, true);
  b.welcome();
  await until(() => b.messages.some(m => m.type === "channels_changed" && m.channels.some(c => c.sessionId === id)));
});

test("a removed link stops owning its uploads while an active link keeps exclusion", async t => {
  const a = hub(t), b = hub(t), dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
  mkdirSync(dir, { recursive: true });
  const save = servers => writeFileSync(join(dir, "host.json"), JSON.stringify({ url: a.url, token: "a", links: servers.map(server => ({ url: server.url, token: "token" })) }));
  save([a, b]);
  const daemon = runHostDaemon({ allowHttp: false }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  const upload = "66666666-6666-4666-8666-666666666666", args = { id: upload, attempt: "88888888-8888-4888-8888-888888888888", name: "file.txt", size: 3, type: "text/plain" };
  b.send({ type: "req", id: "own", op: "uploadStart", args }); await until(() => b.result("own")); assert.equal(b.result("own").ok, true);
  a.send({ type: "req", id: "blocked", op: "uploadStart", args: { ...args, attempt: "99999999-9999-4999-8999-999999999999" } });
  await until(() => a.result("blocked")); assert.equal(a.result("blocked").error.status, 409);
  save([a]); await until(() => b.closed.length > 0);
  a.send({ type: "req", id: "take", op: "uploadStart", args: { ...args, attempt: "99999999-9999-4999-8999-999999999999" } });
  await until(() => a.result("take")); assert.equal(a.result("take").ok, true);
  a.bytes(upload, "yes"); await until(() => a.messages.some(message => message.type === "upload_ack" && message.done));
});
