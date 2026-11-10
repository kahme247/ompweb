import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omp-pool-starts-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(scratch, "main-agent");
const hub = await import("./hub.ts");
const { linkHost } = await import("./link-driver.test-helper.mjs");
const { savePools } = await import("./pools.ts");
const { HostOpError } = await import("./link-protocol.ts");
const journalPath = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pool-starts.json");
let serial = 0;
const GiB = 1024 ** 3;
const sample = (overrides = {}) => ({ effectiveCpus: 4, load1: 0, busyFraction: 0, stealFraction: 0, availableMemoryBytes: 3 * GiB, activeSessions: 0, ...overrides });
const intent = { type: "prompt", message: "first prompt", provider: "test", modelId: "model-a", thinkingLevel: "high", toolNames: ["read"], advisor: false };
const records = () => JSON.stringify(JSON.parse(readFileSync(journalPath, "utf8")));
const input = (fixture, suffix, overrides = {}) => ({ creationId: `${fixture.id}-${suffix}`, poolId: fixture.id, projectId: "project", intent, ...overrides });
const preparedFor = (request) => ({ cwd: join(dirname(request.cloneRoot), `.${basename(request.cloneRoot)}_worktrees`, "session", request.creationId), projectRoot: request.cloneRoot, baseCommit: "a".repeat(40) });

async function fixture(t, { members = 1, memory = 3 * GiB, prepare } = {}) {
  const id = `pool-${++serial}`;
  const links = [];
  const preparations = [];
  const updates = [];
  for (let i = 0; i < members; i++) {
    const link = await linkHost(`${id}-worker-${i}`);
    links.push(link);
    link.serve({
      async preparePoolProject({ input }) {
        preparations.push({ hostId: link.id, ...input });
        return prepare ? prepare(link, input) : { ok: true, value: preparedFor(input) };
      },
      addProject: async () => ({ ok: true, value: {} }),
      updateProject: async ({ updates: changes }) => { updates.push({ hostId: link.id, changes }); return { ok: true, value: { projects: [], newRoots: [] } }; },
      listSessions: async () => [],
    });
    await link.post({ type: "capacity", sample: sample({ availableMemoryBytes: memory }) });
  }
  const pool = { id, label: id, enabled: true, members: links.map((link, i) => ({ hostId: link.id, projectsRoot: `/workers/${i}`, provisioned: true, draining: false })), projects: [{ id: "project", name: "Project", origin: "https://example.invalid/project.git", clonePaths: {}, addedAt: "2026-01-01T00:00:00.000Z", hidden: false }] };
  savePools([pool]);
  t.after(() => { for (const link of links) hub.closeHostLink(link.id); });
  return { id, pool, links, preparations, updates };
}

async function starts() {
  return (await import("./pool-starts.ts")).startPooledSession;
}

const failureStatus = (status) => (error) => error?.status === status;

test.after(async () => {
  hub.flushLinkSamples();
  (await import("../notification-store.ts")).closeNotificationStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});

test("concurrent starts persist and consume the last slot before preparation can await", async (t) => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { prepare: async (_link, request) => {
    await gate.promise;
    return { ok: true, value: preparedFor(request) };
  } });
  const start = await starts();
  const firstInput = input(f, "one");
  let callbacks = 0;
  const first = start(firstInput, async (_host, _prepared, _id, onStarted) => { callbacks++; await onStarted("11111111-2222-4333-8444-000000000701"); return { sessionId: "11111111-2222-4333-8444-000000000701" }; });
  const admitted = records();
  assert.ok(admitted.includes(firstInput.creationId), "reservation must already be durable when start returns its promise");
  assert.ok(admitted.includes(f.links[0].id));
  try {
    await assert.rejects(start(input(f, "two"), async () => assert.fail("no capacity must not reach spawn")), failureStatus(503));
    assert.equal(callbacks, 0);
  } finally { gate.resolve(); }
  const result = await first;
  assert.equal(result.hostId, f.links[0].id);
  assert.equal(callbacks, 1);
});

test("same complete intent joins through initialization and persists real identity before any command", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  const request = input(f, "duplicate");
  const initializing = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const id = "11111111-2222-4333-8444-000000000702";
  let runs = 0;
  const callback = async (_host, prepared, creationId, onStarted) => {
    runs++;
    assert.equal(creationId, request.creationId);
    await onStarted(id);
    assert.ok(records().includes(id), "model/prompt work cannot precede persisted real identity");
    assert.ok(records().includes(prepared.cwd));
    initializing.resolve();
    await finish.promise;
    return { sessionId: id, data: { accepted: true } };
  };
  const first = start(request, callback);
  await initializing.promise;
  const duplicate = start({ ...request, intent: { advisor: false, toolNames: ["read"], thinkingLevel: "high", modelId: "model-a", provider: "test", message: "first prompt", type: "prompt" } }, callback);
  let duplicateFinished = false;
  void duplicate.then(() => { duplicateFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(duplicateFinished, false, "the admission lock extends beyond spawn through initialization");
  finish.resolve();
  assert.deepEqual(await duplicate, await first);
  assert.equal(runs, 1);
  assert.equal(f.preparations.length, 1);
  const replay = await start(request, async () => assert.fail("completed retry must replay"));
  assert.equal(replay.sessionId, id);
  assert.deepEqual(replay.data, { accepted: true });
});

test("trusted authorization holds one durable reservation before preparation and is not repeated by joins or completed replay", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  const request = input(f, "authorize");
  const approval = Promise.withResolvers();
  let authorizations = 0;
  const authorize = async (host) => {
    authorizations++;
    assert.equal(host.id, f.links[0].id);
    assert.ok(records().includes(request.creationId), "confirmation cannot precede durable admission");
    await approval.promise;
    return true;
  };
  const callback = async (_host, _prepared, _id, onStarted) => {
    await onStarted("11111111-2222-4333-8444-000000000729");
    return { sessionId: "11111111-2222-4333-8444-000000000729" };
  };
  const first = start(request, callback, authorize);
  const duplicate = start(request, callback, authorize);
  try {
    assert.equal(authorizations, 1);
    assert.equal(f.preparations.length, 0);
    await assert.rejects(start(input(f, "blocked-during-confirmation"), async () => assert.fail("reserved capacity must remain occupied")), failureStatus(503));
  } finally { approval.resolve(); }
  assert.deepEqual(await first, await duplicate);
  const replay = await start(request, async () => assert.fail("completed retry cannot spawn"), async () => assert.fail("completed retry cannot reauthorize"));
  assert.equal(replay.sessionId, "11111111-2222-4333-8444-000000000729");
  assert.equal(authorizations, 1);
  assert.equal(f.preparations.length, 1);
});

test("every effectful field conflicts while identical retries retain the original logical launch settings", async (t) => {
  const f = await fixture(t, { memory: 32 * GiB });
  const start = await starts();
  const variants = [{ message: "changed" }, { modelId: "model-b" }, { provider: "other" }, { thinkingLevel: "low" }, { toolNames: [] }, { advisor: true }, { name: "renamed" }, { images: [{ type: "image", data: "YWJj", mimeType: "image/png" }] }, { futureCommandOption: { nested: true } }, { launchConfig: { profile: "different" } }];
  for (let i = 0; i < variants.length; i++) {
    const request = input(f, `intent-${i}`);
    await start(request, async (_host, _prepared, _id, onStarted) => { const sessionId = `11111111-2222-4333-8444-${String(710 + i).padStart(12, "0")}`; await onStarted(sessionId); return { sessionId }; });
    await assert.rejects(start({ ...request, intent: { ...intent, ...variants[i] } }, async () => assert.fail("changed intent must not run")), failureStatus(409));
  }
  const request = input(f, "launch-config");
  await start(request, async (_host, _prepared, _id, onStarted) => { await onStarted("11111111-2222-4333-8444-000000000720"); return { sessionId: "11111111-2222-4333-8444-000000000720" }; });
  f.pool.projects[0].launchConfig = { profile: "changed-profile", extraArgs: ["--verbose"], advisor: true };
  savePools([f.pool]);
  const replay = await start(request, async () => assert.fail("a retry cannot acquire newly configured launch settings"));
  assert.equal(replay.sessionId, "11111111-2222-4333-8444-000000000720");
  for (const changed of [{ ref: "main" }, { poolId: "different-pool" }, { projectId: "different-project" }]) {
    await assert.rejects(start({ ...request, ...changed }, async () => assert.fail("different target intent must not run")), failureStatus(409));
  }
});

test("definite preparation and pre-spawn refusals release admission without changing an uncertain owner", async (t) => {
  let failed = false;
  const f = await fixture(t, { prepare: async (_host, request) => {
    if (!failed) { failed = true; return { ok: false, status: 409, code: "pool_origin_mismatch", error: "different repository" }; }
    return { ok: true, value: preparedFor(request) };
  } });
  const start = await starts();
  await assert.rejects(start(input(f, "bad-prep"), async () => assert.fail("failed prep must not spawn")), failureStatus(409));
  await assert.rejects(start(input(f, "refused"), async () => { throw new HostOpError(409, "host_updating", "updating"); }), failureStatus(409));
  const result = await start(input(f, "after-refusal"), async (_host, _prepared, _id, onStarted) => { await onStarted("11111111-2222-4333-8444-000000000721"); return { sessionId: "11111111-2222-4333-8444-000000000721" }; });
  assert.equal(result.hostId, f.links[0].id);
});

test("a fresh post-start capacity sample releases only confirmed resource reservations, before initialization finishes", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  const confirmed = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = start(input(f, "busy"), async (_host, _prepared, _id, onStarted) => {
    await onStarted("11111111-2222-4333-8444-000000000722");
    confirmed.resolve();
    await finish.promise;
    return { sessionId: "11111111-2222-4333-8444-000000000722" };
  });
  await confirmed.promise;
  try {
    await assert.rejects(start(input(f, "before-report"), async () => assert.fail("old sample still needs reservation")), failureStatus(503));
    await f.links[0].post({ type: "capacity", sample: sample({ activeSessions: 1 }) });
    const second = await start(input(f, "after-report"), async (_host, _prepared, _id, onStarted) => { await onStarted("11111111-2222-4333-8444-000000000723"); return { sessionId: "11111111-2222-4333-8444-000000000723" }; });
    assert.equal(second.hostId, f.links[0].id, "confirmed active turn must not also retain the pending-start GiB");
  } finally { finish.resolve(); await first; }
});

test("unknown spawn never expires, releases capacity or migrates after membership changes", async (t) => {
  const f = await fixture(t, { members: 2 });
  const start = await starts();
  const request = input(f, "unknown");
  let owner;
  await assert.rejects(start(request, async (host) => { owner = host.id; throw new HostOpError(503, "host_offline", "spawn may have reached worker"); }));
  f.pool.members = f.pool.members.filter((member) => member.hostId !== owner);
  savePools([f.pool]);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 365 * 24 * 60 * 60 * 1000;
  try {
    const retry = start(request, async (host) => { assert.equal(host.id, owner); throw new HostOpError(503, "host_offline", "still uncertain"); });
    await assert.rejects(retry);
    assert.ok(records().includes(owner), "elapsed wall time cannot erase the retained owner");
    assert.equal(f.preparations.filter((preparation) => preparation.creationId === request.creationId).length, 1);
  } finally { Date.now = originalNow; }
});

test("completed creation reloads from the real journal in a fresh process without registry membership or a spawn", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  const request = input(f, "reload");
  const expected = await start(request, async (_host, _prepared, _id, onStarted) => { await onStarted("11111111-2222-4333-8444-000000000724"); return { sessionId: "11111111-2222-4333-8444-000000000724", data: { accepted: true } }; });
  savePools([]);
  const script = `const {startPooledSession}=await import('./lib/hosts/pool-starts.ts'); const result=await startPooledSession(${JSON.stringify(request)},async()=>{throw new Error('journal replay attempted another spawn')}); console.log(JSON.stringify(result));`;
  const child = spawn(process.execPath, ["--eval", script], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const status = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(status, 0, err);
  assert.deepEqual(JSON.parse(out.trim()), expected);
});

test("all-ineligible and corrupt or unreadable journals fail closed without preparation or local fallback", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  f.pool.members[0].draining = true;
  savePools([f.pool]);
  await assert.rejects(start(input(f, "draining"), async () => assert.fail("no fallback")), failureStatus(503));
  const backup = existsSync(journalPath) ? readFileSync(journalPath) : null;
  try {
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web"), { recursive: true });
    writeFileSync(journalPath, "{damaged");
    f.pool.members[0].draining = false;
    savePools([f.pool]);
    await assert.rejects(start(input(f, "corrupt"), async () => assert.fail("corrupt state must not launch")), failureStatus(503));
    rmSync(journalPath);
    mkdirSync(journalPath);
    await assert.rejects(start(input(f, "unreadable"), async () => assert.fail("unreadable state must not launch")), failureStatus(503));
    assert.equal(f.preparations.length, 0);
  } finally {
    rmSync(journalPath, { recursive: true, force: true });
    if (backup) writeFileSync(journalPath, backup);
  }
});

// Restarting the real API loses every in-memory map while the real daemon and
// its fake OMP process survive, as in the existing link-integration harness.
async function durableDaemonFixture(t, hold) {
  const dir = join(scratch, `daemon-${++serial}`);
  const mainDir = join(dir, "main-agent");
  const workerHome = join(dir, "worker");
  const workerDir = join(workerHome, ".omp", "agent");
  const projectsRoot = join(workerHome, "projects");
  for (const path of [mainDir, workerDir, projectsRoot]) mkdirSync(path, { recursive: true });
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(gitEnv, { HOME: workerHome, USERPROFILE: workerHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_TERMINAL_PROMPT: "0" });
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
  const remote = join(dir, "remote.git");
  const source = join(dir, "source");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(dir, "init", "--bare", remote);
  git(dir, "init", source);
  git(source, "config", "user.name", "Pool fixture");
  git(source, "config", "user.email", "pool-fixture@example.invalid");
  writeFileSync(join(source, "tracked.txt"), "fixture commit\n");
  git(source, "add", "tracked.txt");
  git(source, "commit", "-m", "fixture");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "HEAD:refs/heads/main");
  git(dir, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${remote.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  gitEnv.GIT_SSH_COMMAND = ssh;
  const logFile = join(dir, "omp.jsonl");
  const killsFile = join(dir, "kills.jsonl");
  const eventsFile = join(dir, "events.jsonl");
  const holdFile = join(dir, hold);
  writeFileSync(holdFile, "");
  const fakeOmp = join(dir, "fake-omp");
  writeFileSync(fakeOmp, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
if (process.argv.includes("update")) { console.log("Current version: 14.0.0-fake"); process.exit(0); }
const fs = require("node:fs"), path = require("node:path");
const id = require("node:crypto").randomUUID();
const file = path.join(${JSON.stringify(workerDir)}, "sessions", "fixture", id + ".jsonl");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({pid:process.pid, sessionId:id, ...entry}) + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
log({kind:"start", cwd:process.cwd(), argv:process.argv.slice(2)});
out({type:"ready", supportedProtocolVersions:[1,2]});
if(fs.existsSync(${JSON.stringify(join(dir, "open-ask"))}))out({type:"extension_ui_request",id:"retained-question",method:"ask",questions:[{id:"q",question:"Recover this question",options:[{label:"A"}]}]});
require("node:readline").createInterface({input:process.stdin}).on("line", (line) => {
  const command=JSON.parse(line);
  log({kind:"command", command});
  const reply=(data)=>out({type:"response", id:command.id, command:command.type, success:true, data});
  if(command.type==="negotiate_protocol") return reply({protocolVersion:2});
  if(command.type==="get_state") {
    const answer=()=>{reply({sessionId:id, sessionFile:file, isStreaming:false, isCompacting:false, isSettled:true, queuedMessageCount:0});if(fs.existsSync(${JSON.stringify(join(dir, "emit-live"))}))out({type:"message_update",message:{role:"assistant",content:[{type:"text",text:"live after adoption"}]}});};
    if(!fs.existsSync(${JSON.stringify(join(dir, "hold-handshake"))})) return answer();
    const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(join(dir, "hold-handshake"))})){clearInterval(timer);answer();}},10);
    return;
  }
  if(command.type==="get_subagents"&&fs.existsSync(${JSON.stringify(join(dir, "hold-adoption"))})){
    out({type:"message_update",message:{role:"assistant",content:[{type:"text",text:"held during adoption"}]}});
    return;
  }
  if(command.type==="prompt") {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({type:"session",version:3,id,cwd:process.cwd(),timestamp:"2026-01-01T00:00:00.000Z"})+"\\n"+JSON.stringify({type:"message",id:"m1",parentId:null,timestamp:"2026-01-01T00:00:01.000Z",message:{role:"user",content:command.message}})+"\\n");
    if(fs.existsSync(${JSON.stringify(join(dir, "hold-prompt"))})) return;
  }
  reply({});
});
process.stdin.on("end",()=>process.exit(0));
`, { mode: 0o700 });
  const mainScript = `
import {appendFileSync,existsSync,readFileSync,rmSync,writeFileSync} from "node:fs";
const hub=await import("./lib/hosts/hub.ts");
const {createHost}=await import("./lib/hosts/registry.ts");
const {savePools}=await import("./lib/hosts/pools.ts");
const {POST}=await import("./app/api/agent/new/route.ts");
const {GET:agentGet,POST:agentPost}=await import("./app/api/agent/[id]/route.ts");
const {getRpcSession}=await import("./lib/rpc-manager.ts");
const observed=new Set();
const bootstrap=${JSON.stringify(join(dir, "bootstrap.json"))};
let identity;
if(existsSync(bootstrap)) identity=JSON.parse(readFileSync(bootstrap,"utf8"));
else {
  const {host,token}=createHost("Durable daemon worker");
  identity={hostId:host.id,token};
  writeFileSync(bootstrap,JSON.stringify(identity));
  savePools([{id:"durable",label:"Durable",enabled:true,members:[{hostId:host.id,projectsRoot:${JSON.stringify(projectsRoot)},provisioned:true,draining:false}],projects:[{id:"project",name:"Project",origin:"git@example.invalid:project.git",clonePaths:{},addedAt:"2026-01-01T00:00:00.000Z",hidden:false,launchConfig:{profile:"central-profile",extraArgs:["--verbose"],advisor:true}}]}]);
}
const wrapped=new WeakMap();
const spawnRequestIds=new Set();
const wrap=(ws)=>{let value=wrapped.get(ws);if(!value){value={data:ws.data,send(data){
  if(typeof data==="string")for(const line of data.split("\\n").filter(Boolean)){
    const message=JSON.parse(line);
    if(message.type==="req"&&message.op==="spawn")spawnRequestIds.add(message.id);
    if(message.type==="kill")appendFileSync(${JSON.stringify(killsFile)},JSON.stringify(message)+"\\n");
    if(message.type==="req"&&message.op==="spawn"&&message.args.creationId&&existsSync(${JSON.stringify(join(dir, "remove-cwd"))})){
      if(!message.args.cwd.startsWith(${JSON.stringify(`${projectsRoot}/`)}))throw new Error("fixture refused deleting outside its projects root");
      rmSync(message.args.cwd,{recursive:true,force:true});
      writeFileSync(${JSON.stringify(join(dir, "cwd-removed"))},"");
    }
  }
  return ws.send(data);
},close:(...args)=>ws.close(...args),terminate:()=>ws.terminate()};wrapped.set(ws,value);}return value;};
const server=Bun.serve({hostname:"127.0.0.1",port:Number(process.env.FIXTURE_PORT??0),fetch(req,server){
  const path=new URL(req.url).pathname;
  if(path==="/api/hosts/link")return hub.handleLinkUpgrade(req,(data)=>server.upgrade(req,{data}));
  if(path==="/api/agent/new")return POST(req);
  if(path.startsWith("/api/agent/")){const params=Promise.resolve({id:decodeURIComponent(path.slice("/api/agent/".length))});return req.method==="GET"?agentGet(req,{params}):agentPost(req,{params});}
  if(path==="/observe"){
    const id=new URL(req.url).searchParams.get("sessionId"),session=getRpcSession(id);
    if(!session)return Response.json({registered:false},{status:404});
    if(!observed.has(id)){observed.add(id);session.onEvent(event=>appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(event)+"\\n"));}
    return Response.json({registered:true,snapshot:session.getStreamSnapshot()});
  }
  if(path==="/health")return Response.json({status:hub.getHost(identity.hostId).status(),capacity:hub.getHostCapacity(identity.hostId)});
  return new Response("Not found",{status:404});
},websocket:{message(ws,data){
  if(typeof data==="string"&&existsSync(${JSON.stringify(join(dir, "lose-spawn-ack"))})&&data.split("\\n").filter(Boolean).map(JSON.parse).some(message=>message.type==="res"&&spawnRequestIds.has(message.id)))return;
  hub.hostLinkSocket.message(wrap(ws),data);
},close(ws){hub.hostLinkSocket.close(wrap(ws))},drain(ws){hub.hostLinkSocket.drain(wrap(ws))}}});
console.log(JSON.stringify({port:server.port,...identity}));
`;
  let api, daemon, info, apiOutput = "", daemonOutput = "";
  const children = new Set();
  const launch = (script, env) => {
    const child = spawn(process.execPath, ["--eval", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    child.on("error", () => {});
    return child;
  };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 10_000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, `${message}\nAPI: ${apiOutput}\nDaemon: ${daemonOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const startApi = async () => {
    apiOutput = "";
    api = launch(mainScript, { ...gitEnv, PI_CODING_AGENT_DIR: mainDir, ...(info ? { FIXTURE_PORT: String(info.port) } : {}) });
    api.stdout.on("data", (chunk) => { apiOutput += chunk; });
    api.stderr.on("data", (chunk) => { apiOutput += chunk; });
    await waitFor(() => apiOutput.split("\n").some((line) => line.startsWith('{"port":')) || api.exitCode !== null, "API fixture did not boot");
    assert.equal(api.exitCode, null, apiOutput);
    info = JSON.parse(apiOutput.split("\n").find((line) => line.startsWith('{"port":')));
  };
  const crashApi = async () => {
    const exited = new Promise((resolve) => api.once("exit", resolve));
    api.kill("SIGKILL");
    await exited;
  };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill(child === daemon ? "SIGTERM" : "SIGKILL");
      await exited;
    }
  });
  await startApi();
  // The real collector is Linux-only. Replace just that machine input in this isolated
  // daemon subprocess; admission still consumes its actual authenticated wire reports.
  const daemonScript = `const {mock}=await import("bun:test");const capacity=await import("./lib/hosts/capacity.ts");mock.module("./lib/hosts/capacity.ts",()=>({...capacity,sampleHostCapacity(activeSessions){return {effectiveCpus:4,load1:0,busyFraction:0,stealFraction:0,availableMemoryBytes:16*1024**3,activeSessions}}}));const {runHostDaemon}=await import("./lib/hosts/daemon.ts");const daemon=runHostDaemon({url:"http://127.0.0.1:${info.port}",token:${JSON.stringify(info.token)},allowHttp:false});process.on("SIGTERM",async()=>{await daemon.stop();process.exit(0)});await daemon.done;`;
  daemon = launch(daemonScript, { ...gitEnv, PI_CODING_AGENT_DIR: workerDir, OMP_WEB_OMP_BIN: fakeOmp });
  daemon.stdout.on("data", (chunk) => { daemonOutput += chunk; });
  daemon.stderr.on("data", (chunk) => { daemonOutput += chunk; });
  const online = async () => {
    await waitFor(async () => { try { const health = await (await fetch(`http://127.0.0.1:${info.port}/health`)).json(); return health.status === "online" && health.capacity !== null; } catch { return false; } }, "daemon did not provide fresh capacity");
  };
  await online();
  const log = () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const request = { creationId: `durable-${hold}`, poolId: "durable", projectId: "project", type: "prompt", message: "exactly once" };
  const post = (body = request) => fetch(`http://127.0.0.1:${info.port}/api/agent/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events = () => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { dir, mainDir, workerDir, projectsRoot, info, holdFile, log, events, apiLog: () => apiOutput, waitFor, online, startApi, crashApi, post, request, kills: () => existsSync(killsFile) ? readFileSync(killsFile, "utf8") : "" };
}

test("lost spawn acknowledgement and API restart reconcile a sessionless journal-owned child before orphan cleanup, even with a damaged journal", async (t) => {
  const f = await durableDaemonFixture(t, "lose-spawn-ack");
  let early;
  const first = f.post().then((response) => { early = response; return response; }).catch(() => null);
  await f.waitFor(async () => {
    if (early) assert.fail(`creation returned ${early.status} before spawn dispatch: ${await early.text()}`);
    return f.log().some((entry) => entry.kind === "start");
  }, "initial child was not spawned");
  const child = f.log().find((entry) => entry.kind === "start");
  assert.ok(child.argv.includes("central-profile"), "logical project launch config must reach the worker's actual process");
  assert.ok(child.argv.includes("--verbose"));
  assert.ok(child.argv.includes("--advisor"));
  writeFileSync(join(child.cwd, "private.txt"), "unpublished work survives API restart\n");
  const file = join(f.mainDir, "omp-web", "pool-starts.json");
  const durable = readFileSync(file);
  assert.ok(durable.includes(Buffer.from(f.request.creationId)));
  await f.crashApi();
  await first;
  writeFileSync(file, "{damaged");
  await f.startApi();
  await f.online();
  const refused = await f.post();
  assert.equal(refused.status, 503);
  assert.equal(f.kills(), "", "unreadable ownership cannot justify killing a possibly owned child");
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  await f.crashApi();
  writeFileSync(file, durable);
  rmSync(f.holdFile);
  await f.startApi();
  await f.online();
  const retried = await f.post();
  assert.equal(retried.status, 200, await retried.clone().text());
  const body = await retried.json();
  assert.equal(body.sessionId, child.sessionId);
  assert.equal(body.hostId, f.info.hostId);
  assert.equal(body.cwd, child.cwd);
  assert.equal(readFileSync(join(child.cwd, "private.txt"), "utf8"), "unpublished work survives API restart\n");
  assert.equal(f.log().filter((entry) => entry.kind === "start").length, 1);
  assert.equal(f.log().filter((entry) => entry.command?.type === "prompt").length, 1);
  assert.equal(f.kills(), "");
});

test("API process restart after a delivered initial prompt returns durable uncertainty and never prompts twice", async (t) => {
  const f = await durableDaemonFixture(t, "hold-prompt");
  let early;
  const first = f.post().then((response) => { early = response; return response; }).catch(() => null);
  await f.waitFor(async () => {
    if (early) assert.fail(`creation returned ${early.status} before prompt dispatch: ${await early.text()}`);
    return f.log().some((entry) => entry.command?.type === "prompt");
  }, "initial prompt was not delivered");
  const child = f.log().find((entry) => entry.kind === "start");
  assert.ok(readFileSync(join(f.mainDir, "omp-web", "pool-starts.json"), "utf8").includes(child.sessionId));
  await f.crashApi();
  await first;
  await f.startApi();
  await f.online();
  for (let i = 0; i < 2; i++) {
    const retry = await f.post();
    assert.equal(retry.status, 503);
    const body = await retry.json();
    assert.equal(body.sessionId, child.sessionId);
    assert.equal(body.delivery, "unknown");
  }
  assert.equal(f.log().filter((entry) => entry.kind === "start").length, 1);
  assert.equal(f.log().filter((entry) => entry.command?.type === "prompt").length, 1);
  assert.equal(f.kills(), "");
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test("a prepared worktree deleted before real daemon spawn never falls back to another directory", async (t) => {
  const f = await durableDaemonFixture(t, "remove-cwd");
  const response = await f.post();
  assert.ok(existsSync(join(f.dir, "cwd-removed")), "the request must reach the real prepared spawn boundary");
  assert.ok(response.status >= 400, await response.clone().text());
  assert.equal(f.log().filter((entry) => entry.kind === "start").length, 0, "creation-ID spawn must not run in daemon HOME or cwd");
});

test("logical launch config reaches the worker and clearing it removes stale spawn flags", async (t) => {
  const f = await durableDaemonFixture(t, "no-hold");
  const first = await f.post();
  assert.equal(first.status, 200, await first.clone().text());
  const file = join(f.mainDir, "omp-web", "pools.json");
  const registry = JSON.parse(readFileSync(file, "utf8"));
  delete registry.pools[0].projects[0].launchConfig;
  writeFileSync(file, JSON.stringify(registry));
  const second = await f.post({ ...f.request, creationId: "without-launch-config" });
  assert.equal(second.status, 200, await second.clone().text());
  const children = f.log().filter((entry) => entry.kind === "start");
  assert.equal(children.length, 2);
  assert.ok(children[0].argv.includes("--profile"));
  assert.ok(children[0].argv.includes("central-profile"));
  assert.ok(children[0].argv.includes("--verbose"));
  assert.ok(children[0].argv.includes("--advisor"));
  assert.equal(children[1].argv.includes("--profile"), false);
  assert.equal(children[1].argv.includes("central-profile"), false);
  assert.equal(children[1].argv.includes("--verbose"), false);
  assert.equal(children[1].argv.includes("--advisor"), false);
  assert.notEqual(children[0].cwd, children[1].cwd);
  assert.equal(f.log().filter((entry) => entry.command?.type === "prompt").length, 2);
});

test("the journal retains identity and bounded replay metadata without copying the initial API payload", async (t) => {
  const f = await fixture(t);
  const start = await starts();
  const secretPrompt = `private-initial-prompt-${f.id}`;
  const request = input(f, "bounded", { intent: { ...intent, message: secretPrompt, images: [{ type: "image", mimeType: "image/png", data: "cHJpdmF0ZS1hdHRhY2htZW50" }] } });
  const id = "11111111-2222-4333-8444-000000000725";
  await start(request, async (_host, _prepared, _id, onStarted) => {
    await onStarted(id);
    return { sessionId: id, data: { accepted: true, diagnostic: "x".repeat(4 * 1024 * 1024), apiKey: "private-fixture-result-key" } };
  });
  const persisted = readFileSync(journalPath, "utf8");
  assert.equal(persisted.includes(secretPrompt), false);
  assert.equal(persisted.includes("cHJpdmF0ZS1hdHRhY2htZW50"), false);
  assert.equal(persisted.includes("private-fixture-result-key"), false);
  assert.ok(Buffer.byteLength(persisted) < 1024 * 1024, "arbitrary RPC result bodies must not become an unbounded creation journal");
  const replay = await start(request, async () => assert.fail("bounded result retention must not lose the session's durable identity"));
  assert.equal(replay.sessionId, id);
});

test("a partially adopted pooled child retries its native adoption, pending replay and live release on the same process", async (t) => {
  const f = await durableDaemonFixture(t, "lose-spawn-ack");
  f.request.type = "ensure_session";
  writeFileSync(join(f.dir, "open-ask"), "");
  let early;
  const first = f.post().then((response) => { early = response; return response; }).catch(() => null);
  await f.waitFor(async () => {
    if (early) assert.fail(`creation returned ${early.status} before the original spawn`);
    return f.log().some((entry) => entry.kind === "start");
  }, "the original child was not started");
  const child = f.log().find((entry) => entry.kind === "start");
  await f.crashApi();
  await first;
  rmSync(f.holdFile);
  writeFileSync(join(f.dir, "hold-adoption"), "");
  await f.startApi();
  await f.online();
  await f.waitFor(() => f.apiLog().includes("retained creation") && f.apiLog().includes("get_subagents"), "adoption did not fail after the child reported its real ID");
  assert.ok(f.log().some((entry) => entry.command?.type === "get_state"));
  rmSync(join(f.dir, "hold-adoption"));
  const retry = await f.post();
  assert.equal(retry.status, 200, await retry.clone().text());
  const created = await retry.json();
  assert.equal(created.sessionId, child.sessionId);
  assert.equal(created.cwd, child.cwd);
  const observe = await fetch(`http://127.0.0.1:${f.info.port}/observe?sessionId=${child.sessionId}`);
  assert.equal(observe.status, 200, "a successful retry must register its ready wrapper under the real session ID");
  const observed = await observe.json();
  assert.equal(observed.registered, true);
  assert.ok(JSON.stringify(observed.snapshot).includes("held during adoption"), "native held frames must be released, not stranded after get_state");
  await f.waitFor(() => f.events().some((event) => event.type === "extension_ui_request" && event.id === "retained-question"), "the original hello pending request was not replayed to the subscriber");
  writeFileSync(join(f.dir, "emit-live"), "");
  const command = await fetch(`http://127.0.0.1:${f.info.port}/api/agent/${child.sessionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "get_state" }) });
  assert.equal(command.status, 200, await command.clone().text());
  await f.waitFor(() => f.events().some((event) => event.type === "message_update" && JSON.stringify(event).includes("live after adoption")), "the registered real-ID subscriber did not receive live output");
  assert.equal(f.log().filter((entry) => entry.kind === "start").length, 1);
  assert.ok(existsSync(join(child.cwd, ".git")));
  assert.equal(f.kills(), "");
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});
