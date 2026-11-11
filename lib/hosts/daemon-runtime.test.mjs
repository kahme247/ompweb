import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeBlobFrame, encodeLine, PartJoiner } from "./link-protocol.ts";

const scratch = mkdtempSync(join(tmpdir(), "daemon-multi-runtime-"));
const old = { agent: process.env.PI_CODING_AGENT_DIR, bin: process.env.OMP_WEB_OMP_BIN, home: process.env.HOME, profile: process.env.USERPROFILE };
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
// A member applies the master's configuration under its home directory too (`~/.agents/skills`).
process.env.HOME = process.env.USERPROFILE = join(scratch, "home");
mkdirSync(process.env.HOME, { recursive: true });
const fakeOmp = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
const spawns = join(scratch, "spawns");
const envs = join(scratch, "envs");
const LINK_TOKEN = "link-token-that-must-never-reach-a-child";
// Records whether the broker variables arrived, whether the link's token leaked and the AGENTS.md omp starts on; never the broker token itself.
// `omp plugin list` (a member's plugin step) answers no plugins and starts nothing.
const source = version => `if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv[2] === "plugin") { console.log(JSON.stringify({ npm: [], marketplace: [] })); process.exit(0); }
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");
const rules = (() => { try { return fs.readFileSync(${JSON.stringify(join(scratch, "agent", "AGENTS.md"))}, "utf8"); } catch { return null; } })();
fs.appendFileSync(${JSON.stringify(envs)}, JSON.stringify({ url: process.env.OMP_AUTH_BROKER_URL ?? null, token: !!process.env.OMP_AUTH_BROKER_TOKEN,
  leaked: JSON.stringify([process.env, process.argv]).includes(${JSON.stringify(LINK_TOKEN)}), rules }) + "\\n");
const file = process.argv[process.argv.indexOf("--resume") + 1];
const id = JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]).id;
const emit = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  emit({type:"response",id:command.id,command:command.type,success:true,data:command.type==="negotiate_protocol"?{protocolVersion:2}:command.type==="get_state"?{sessionId:id,sessionFile:file,pid:process.pid,isStreaming:false}: {}});
  if (command.type === "prompt") emit({type:"agent_start"});
});
setImmediate(() => emit({type:"ready",supportedProtocolVersions:[1,2]}));
`;
// Rewriting the binary changes its fingerprint, so the daemon probes the new version.
function writeFakeOmp(version) {
  if (process.platform === "win32") {
    writeFileSync(fakeOmp + ".cjs", source(version));
    writeFileSync(fakeOmp, `@"${process.execPath}" "${fakeOmp}.cjs" %*\r\n`);
  } else writeFileSync(fakeOmp, `#!${process.execPath}\n${source(version)}`, { mode: 0o755 });
}
writeFakeOmp("99.0.0-fake");
process.env.OMP_WEB_OMP_BIN = fakeOmp;
const { runHostDaemon } = await import("./daemon.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
test.after(() => {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", old.agent], ["OMP_WEB_OMP_BIN", old.bin], ["HOME", old.home], ["USERPROFILE", old.profile]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error("daemon runtime timeout"); await sleep(10); }
}
/** A fake server. `version`: the link protocol it welcomes; `config`: the master's configuration it serves (masterConfig).
 * `states` holds each `config_state` with its `owned`. */
function hub(t, autoWelcome = true, { version = 8, config = null } = {}) {
  const hellos = [], messages = [], states = [], closed = [], joiner = new PartJoiner();
  let socket, ack = 0, seq = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (config && path.startsWith("/api/hosts/cluster-config/")) {
        config.auth.push(req.headers.get("authorization"));
        if (path.endsWith("/manifest")) {
          config.manifests++;
          if (config.stall) return new Promise(() => {});
          return config.fail ? new Response("", { status: 500 }) : Response.json(config.build.manifest);
        }
        const bytes = config.build.content(path.split("/").at(-1));
        return bytes ? new Response(bytes) : new Response("", { status: 404 });
      }
      return server.upgrade(req) ? undefined : new Response("", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string") throw new Error("Unexpected binary result");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "hello") {
            socket = ws; hellos.push(message);
            if (autoWelcome) ws.send(encodeLine({ type: "welcome", v: version, hostId: "fixture" }));
          } else if (message.type === "config_state") states.push({ ...message.state, owned: message.owned });
          else if (typeof message.seq === "number") {
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
  return { url: `http://127.0.0.1:${server.port}`, hellos, messages, states, closed,
    send(message) { socket.send(encodeLine({ ...message, seq: ++seq })); },
    welcome() { socket.send(encodeLine({ type: "welcome", v: version, hostId: "fixture" })); },
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
  assert.equal(daemon.control("status").linked, true, "ending one link must not hide a still-linked secondary server");
  assert.throws(() => daemon.control("drain"), { code: "host_busy" }, "another link's native child still prevents maintenance");
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

test("local maintenance accounts for workspace reads and uploads on every native link", async t => {
  const a = hub(t), b = hub(t);
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: "a" }, { url: b.url, token: "b" }] });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  const file = join(scratch, "maintenance-read.txt");
  writeFileSync(file, "native secondary read");
  const owner = { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: scratch };
  b.send({ type: "req", id: "read", op: "openFile", args: { input: { segments: [file], sessionId: owner.sessionId, owner } } });
  await until(() => b.result("read"));
  assert.equal(b.result("read").result.ok, true);
  assert.throws(() => daemon.control("drain"), { code: "host_busy" });
  a.send({ type: "req", id: "home-while-read", op: "home", args: {} });
  await until(() => a.result("home-while-read"));
  assert.equal(a.result("home-while-read").result.ok, true);
  b.send({ type: "req", id: "close-read", op: "closeFile", args: { id: b.result("read").result.value.id } });
  await until(() => b.result("close-read"));
  await until(() => {
    try { return daemon.control("drain").drained; }
    catch (error) { if (error.code !== "host_busy") throw error; return false; }
  });
  a.send({ type: "req", id: "read-drained", op: "openFile", args: { input: { segments: [file], sessionId: owner.sessionId, owner } } });
  await until(() => a.result("read-drained"));
  assert.equal(a.result("read-drained").error.code, "host_drained");
  daemon.control("resume");
  const id = "99999999-9999-4999-8999-999999999990";
  b.send({ type: "req", id: "upload-maintenance", op: "uploadStart", args: { id, attempt: "99999999-9999-4999-8999-999999999991", name: "native.bin", type: "application/octet-stream", size: 3 } });
  await until(() => b.result("upload-maintenance"));
  assert.equal(b.result("upload-maintenance").ok, true);
  assert.throws(() => daemon.control("drain"), { code: "host_busy" });
  b.send({ type: "req", id: "abort-maintenance", op: "uploadAbort", args: { id } });
  await until(() => b.result("abort-maintenance"));
  await until(() => {
    try { return daemon.control("drain").drained; }
    catch (error) { if (error.code !== "host_busy") throw error; return false; }
  });
  assert.equal(daemon.control("status").linked, true);
  daemon.control("resume");
});

const lines = path => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
function sessionFile(name, id) {
  const dir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "-sharing");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + ".jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: scratch })}\n`);
  return file;
}

test("a sharing open on an omp too old to share starts no process and leaves no channel", async t => {
  writeFakeOmp("15.13.0"); t.after(() => writeFakeOmp("99.0.0-fake"));
  const a = hub(t), id = "12121212-1212-4121-8121-121212121212", file = sessionFile("old-omp", id);
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  const before = lines(spawns).length;
  a.send({ type: "req", id: "old", op: "open", args: { sessionId: id, launch: { cwd: scratch, recordedCwd: scratch, sessionFile: file, advisor: false, shareCredentials: true } } });
  await until(() => a.result("old"));
  assert.equal(a.result("old").error.code, "host_omp_too_old");
  assert.equal(lines(spawns).length, before, "no omp process started");
  assert.equal(a.messages.some(message => message.type === "channels_changed" && message.channels.length > 0), false, "no channel left behind");
});

test("a sharing open starts omp with the loopback broker, never with the link's token", async t => {
  const a = hub(t), id = "13131313-1313-4131-8131-131313131313", file = sessionFile("sharing", id);
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  const before = lines(envs).length;
  a.send({ type: "req", id: "share", op: "open", args: { sessionId: id, launch: { cwd: scratch, recordedCwd: scratch, sessionFile: file, advisor: false, shareCredentials: true } } });
  await until(() => a.result("share"));
  assert.equal(a.result("share").ok, true);
  const started = lines(envs).slice(before).map(line => JSON.parse(line));
  assert.equal(started.length, 1);
  const url = new URL(started[0].url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/" + Buffer.from(a.url).toString("base64url"), "the broker forwards to the opening link's server");
  assert.equal(started[0].token, true);
  assert.equal(started[0].leaked, false, "the link's token is in neither the environment nor the arguments");
});

test("a recovered sharing session resumes through its link; one whose server is no longer linked is not started", async t => {
  const a = hub(t), linked = "14141414-1414-4141-8141-141414141414", gone = "15151515-1515-4151-8151-151515151515";
  const entry = (sessionId, name, credentialsServer) => ({ sessionId, launch: { cwd: scratch, recordedCwd: scratch, sessionFile: sessionFile(name, sessionId), advisor: false, credentialsServer } });
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "host-running.json"), JSON.stringify([entry(linked, "recovered-linked", a.url), entry(gone, "recovered-gone", "https://gone.example")]));
  saveWebServerSettings({ autoResumeSessions: true }); t.after(() => saveWebServerSettings({ autoResumeSessions: false }));
  const logs = [], error = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); }; t.after(() => { console.error = error; });
  const before = lines(envs).length;
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => logs.some(line => line.includes(gone) && line.includes("The web server that shares its credentials with this session is no longer linked to this host")));
  await until(() => lines(envs).length > before);
  const started = lines(envs).slice(before).map(line => JSON.parse(line));
  assert.equal(started.length, 1, "only the linked session started");
  assert.equal(new URL(started[0].url).pathname, "/" + Buffer.from(a.url).toString("base64url"));
});

// Link protocol 10: a cluster session starts only on the master's configuration (spec K3, K4, K6).
const { buildManifest } = await import("./cluster-config.ts");
const memberRules = join(process.env.PI_CODING_AGENT_DIR, "AGENTS.md");
// The member's own file, which the first apply backs up and a restore puts back.
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true }); writeFileSync(memberRules, "member rules\n");
/** A master configuration whose AGENTS.md says `rules`; the fake server counts its manifest requests and their bearer tokens. */
function masterConfig(rules) {
  const root = mkdtempSync(join(scratch, "master-"));
  const roots = { agent: join(root, "agent"), home: join(root, "home") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(roots.agent, "AGENTS.md"), rules);
  return { build: buildManifest(roots, { agentEnv: {}, plugins: [] }), manifests: 0, auth: [], fail: false, stall: false };
}
const memberLaunch = (name, id, version) => ({ cwd: scratch, recordedCwd: scratch, sessionFile: sessionFile(name, id), advisor: false, shareCredentials: true, configVersion: version });
/** `server`'s leave: its restore answers, and the member's own AGENTS.md is back. */
async function restoreOver(server, id) {
  server.send({ type: "req", id, op: "clusterConfig", args: { action: "restore" } });
  await until(() => server.result(id));
  assert.equal(server.result(id).ok, true, JSON.stringify(server.result(id).error));
  assert.equal(readFileSync(memberRules, "utf8"), "member rules\n");
}
const clusterConfigReq = (server, id, args) => { server.send({ type: "req", id, op: "clusterConfig", args }); return until(() => server.result(id)).then(() => server.result(id)); };

test("an open with a version the member lacks applies it before omp starts; host-running.json never records the version", async t => {
  const config = masterConfig("master rules one\n"), version = config.build.manifest.version;
  const a = hub(t, true, { version: 10, config }), id = "16161616-1616-4161-8161-161616161616";
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && a.states.length > 0);
  const before = lines(envs).length;
  a.send({ type: "req", id: "apply-open", op: "open", args: { sessionId: id, launch: memberLaunch("config-apply", id, version) } });
  await until(() => a.result("apply-open"));
  assert.equal(a.result("apply-open").ok, true);
  assert.deepEqual(lines(envs).slice(before).map(line => JSON.parse(line).rules), ["master rules one\n"], "omp started on the applied files");
  assert.equal(config.manifests, 1);
  assert.ok(config.auth.length > 1 && config.auth.every(header => header === `Bearer ${LINK_TOKEN}`), "every fetch carried the link's token");
  await until(() => a.states.some(state => state.version === version && state.files === "current"));
  const ch = a.result("apply-open").result.ch;
  a.send({ type: "stdin", ch, line: JSON.stringify({ type: "prompt", id: "p", message: "go" }) + "\n" });
  const running = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "host-running.json");
  await until(() => existsSync(running) && readFileSync(running, "utf8").includes(id));
  const recorded = JSON.parse(readFileSync(running, "utf8")).find(entry => entry.sessionId === id);
  assert.equal(recorded.launch.credentialsServer, a.url);
  assert.equal("configVersion" in recorded.launch, false);
  await restoreOver(a, "leave-one");
});

test("a failing apply starts no process and answers cluster_config_failed", async t => {
  const config = masterConfig("master rules two\n"); config.fail = true;
  const a = hub(t, true, { version: 10, config }), id = "17171717-1717-4171-8171-171717171717";
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  const before = lines(spawns).length;
  a.send({ type: "req", id: "failed-open", op: "open", args: { sessionId: id, launch: memberLaunch("config-fail", id, config.build.manifest.version) } });
  await until(() => a.result("failed-open"));
  assert.equal(a.result("failed-open").error.code, "cluster_config_failed");
  assert.equal(lines(spawns).length, before, "no omp process started");
  await until(() => a.states.some(state => state.files === "failed"));
});

test("two opens at once apply the version once", async t => {
  const config = masterConfig("master rules three\n"), version = config.build.manifest.version;
  const a = hub(t, true, { version: 10, config });
  const ids = ["18181818-1818-4181-8181-181818181818", "19191919-1919-4191-8191-191919191919"];
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  ids.forEach((id, i) => a.send({ type: "req", id: `both-${i}`, op: "open", args: { sessionId: id, launch: memberLaunch(`config-both-${i}`, id, version) } }));
  await until(() => a.result("both-0") && a.result("both-1"));
  assert.deepEqual([a.result("both-0").ok, a.result("both-1").ok], [true, true]);
  assert.equal(config.manifests, 1);
  await restoreOver(a, "leave-three");
});

test("the clusterConfig op applies through the link that sent it, and restore puts the member's own files back", async t => {
  const config = masterConfig("master rules four\n"), version = config.build.manifest.version;
  const a = hub(t, true, { version: 10, config });
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  a.send({ type: "req", id: "apply", op: "clusterConfig", args: { action: "apply", version } });
  await until(() => a.result("apply"));
  assert.equal(a.result("apply").result.state.version, version);
  assert.equal(readFileSync(memberRules, "utf8"), "master rules four\n");
  a.send({ type: "req", id: "restore", op: "clusterConfig", args: { action: "restore" } });
  await until(() => a.result("restore"));
  assert.deepEqual(a.result("restore").result.state, { version: null, files: "none", plugins: "none", error: null, missingCommands: [] });
  assert.equal(readFileSync(memberRules, "utf8"), "member rules\n");
  a.send({ type: "req", id: "bad", op: "clusterConfig", args: { action: "apply", version: "x" } });
  await until(() => a.result("bad"));
  assert.equal(a.result("bad").error.code, "invalid_request");
});

test("after its server's restore, a start with that server's version is refused until its next apply; a drained host still restores", async t => {
  const config = masterConfig("master rules five\n"), version = config.build.manifest.version;
  const a = hub(t, true, { version: 10, config }), id = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  await until(() => {
    try { return daemon.control("drain").drained; }
    catch (error) { if (error.code !== "host_busy") throw error; return false; }
  });
  const left = await clusterConfigReq(a, "drained-restore", { action: "restore" });
  assert.deepEqual(left.result, { state: { version: null, files: "none", plugins: "none", error: null, missingCommands: [] }, owned: false });
  assert.equal((await clusterConfigReq(a, "drained-apply", { action: "apply", version })).error.code, "host_drained");
  daemon.control("resume");

  const before = lines(spawns).length;
  a.send({ type: "req", id: "late-open", op: "open", args: { sessionId: id, launch: memberLaunch("config-left", id, version) } });
  await until(() => a.result("late-open"));
  assert.deepEqual([a.result("late-open").error.code, a.result("late-open").error.message], ["cluster_config_failed", "This host has left the cluster"]);
  assert.equal(lines(spawns).length, before, "no omp process started");
  assert.equal(config.manifests, 0);
  assert.equal(readFileSync(memberRules, "utf8"), "member rules\n");

  assert.equal((await clusterConfigReq(a, "rejoin", { action: "apply", version })).result.owned, true);
  assert.equal(readFileSync(memberRules, "utf8"), "master rules five\n");
  a.send({ type: "req", id: "member-open", op: "open", args: { sessionId: id, launch: memberLaunch("config-left", id, version) } });
  await until(() => a.result("member-open"));
  assert.equal(a.result("member-open").ok, true);
  await restoreOver(a, "leave-five");
});

test("one cluster per host: another server is refused naming the holding one, which alone restores; each v10 link hears whether it holds the configuration", async t => {
  const ca = masterConfig("master rules six\n"), cb = masterConfig("other rules\n");
  const a = hub(t, true, { version: 10, config: ca }), b = hub(t, true, { version: 10, config: cb }), old = hub(t);
  const daemon = runHostDaemon({ allowHttp: false, links: [a, b, old].map(server => ({ url: server.url, token: LINK_TOKEN })) }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1 && old.hellos.length === 1 && a.states.length > 0 && b.states.length > 0);
  assert.equal((await clusterConfigReq(a, "a-apply", { action: "apply", version: ca.build.manifest.version })).result.owned, true);
  await until(() => a.states.at(-1).owned && a.states.at(-1).version === ca.build.manifest.version && b.states.at(-1).version === ca.build.manifest.version);
  assert.equal(b.states.at(-1).owned, false);

  const refusal = `This host runs the cluster configuration of ${a.url}; it must leave that cluster first`;
  const bApply = await clusterConfigReq(b, "b-apply", { action: "apply", version: cb.build.manifest.version });
  assert.deepEqual([bApply.error.code, bApply.error.message], ["cluster_config_failed", refusal]);
  const id = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b", before = lines(spawns).length;
  b.send({ type: "req", id: "b-open", op: "open", args: { sessionId: id, launch: memberLaunch("config-other", id, cb.build.manifest.version) } });
  await until(() => b.result("b-open"));
  assert.deepEqual([b.result("b-open").error.code, b.result("b-open").error.message], ["cluster_config_failed", refusal]);
  assert.equal(lines(spawns).length, before, "no omp process started");
  assert.equal(cb.manifests, 0);
  // The other server's leave keeps the holding server's configuration.
  assert.equal((await clusterConfigReq(b, "b-restore", { action: "restore" })).result.owned, false);
  assert.equal(readFileSync(memberRules, "utf8"), "master rules six\n");

  await restoreOver(a, "a-restore");
  await until(() => !a.states.at(-1).owned && a.states.at(-1).version === null);
  assert.equal((await clusterConfigReq(b, "b-apply-again", { action: "apply", version: cb.build.manifest.version })).result.owned, true);
  assert.equal(readFileSync(memberRules, "utf8"), "other rules\n");
  await restoreOver(b, "b-leave");
  assert.deepEqual(old.states, [], "a link below protocol 10 never hears config_state");
});

test("a master that stops answering fails the apply within the time limit, and the daemon stops at once during a stalled request", async t => {
  const { clusterConfigTimings } = await import("./daemon-cluster-config.ts");
  const config = masterConfig("master rules seven\n"), version = config.build.manifest.version;
  config.stall = true;
  const a = hub(t, true, { version: 10, config });
  const saved = clusterConfigTimings.fetchMs;
  clusterConfigTimings.fetchMs = 300; t.after(() => { clusterConfigTimings.fetchMs = saved; });
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  let started = Date.now();
  const failed = await clusterConfigReq(a, "stalled", { action: "apply", version });
  assert.deepEqual([failed.error.code, failed.error.message], ["cluster_config_failed", "the master did not send the manifest within 0.3 s"]);
  assert.ok(Date.now() - started < 5000, "failed at the time limit");

  clusterConfigTimings.fetchMs = saved;
  a.send({ type: "req", id: "stalled-again", op: "clusterConfig", args: { action: "apply", version } });
  await until(() => config.manifests === 2);
  started = Date.now();
  await daemon.stop();
  assert.ok(Date.now() - started < 5000, "the stop did not wait for the request's 30 s limit");
  assert.equal(readFileSync(memberRules, "utf8"), "member rules\n");
});

test("a member re-linked to its server at a new address: that address holds the configuration, its apply takes it over without a download and its restore puts the member's own back", async t => {
  const config = masterConfig("master rules eight\n"), version = config.build.manifest.version;
  // One server at two addresses: the same configuration behind both.
  const before = hub(t, true, { version: 10, config }), after = hub(t, true, { version: 10, config });
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web"); mkdirSync(dir, { recursive: true });
  const relink = server => writeFileSync(join(dir, "host.json"), JSON.stringify({ url: server.url, token: LINK_TOKEN, links: [{ url: server.url, token: LINK_TOKEN }] }));
  relink(before);
  const daemon = runHostDaemon({ allowHttp: false }); t.after(() => daemon.stop());
  await until(() => before.hellos.length === 1);
  assert.equal((await clusterConfigReq(before, "old-apply", { action: "apply", version })).result.owned, true);

  relink(after);
  await until(() => after.hellos.length === 1 && before.closed.length > 0 && after.states.length > 0);
  assert.equal(after.states.at(-1).owned, true, "the old address is no longer linked: the new one decides");
  assert.equal((await clusterConfigReq(after, "new-apply", { action: "apply", version })).result.owned, true);
  assert.equal(config.manifests, 1, "the version it holds is not downloaded again");
  assert.equal(JSON.parse(readFileSync(join(dir, "own-config", "server.json"), "utf8")), after.url);
  await restoreOver(after, "new-restore");
});

test("a member whose server revokes it gets its own configuration back before the daemon exits", async t => {
  const config = masterConfig("master rules nine\n"), version = config.build.manifest.version;
  const a = hub(t, true, { version: 10, config });
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
  rmSync(join(dir, "host.json"), { force: true });
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: a.url, token: LINK_TOKEN }] }); t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  assert.equal((await clusterConfigReq(a, "apply", { action: "apply", version })).result.owned, true);
  assert.equal(readFileSync(memberRules, "utf8"), "master rules nine\n");
  a.close(1000); // a revoke: the server closes the link plainly
  assert.equal(await daemon.done, 1);
  assert.equal(readFileSync(memberRules, "utf8"), "member rules\n");
  assert.equal(existsSync(join(dir, "own-config")), false);
});
