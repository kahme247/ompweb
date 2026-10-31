import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalHost, listedSession } from "./hosts/link-driver.test-helper.mjs";

const { runAgentCommand } = await import("./agent-command.ts");
const route = await import("../app/api/agent/[id]/route.ts");
const hub = await import("./hosts/hub.ts");
const { MAX_AGENT_COMMAND_REQUEST_BYTES } = await import("./image-attachments.ts");
const { RpcCommandError } = await import("./omp/rpc-process.ts");
const { WebRpcError } = await import("./rpc-manager.ts");

// A saved session on this machine whose daemon is driven by hand: a `spawn`
// request is the observable proof that an omp child was created, and every
// command the child received is kept in `stdin`.
const SAVED_ID = "01a0e6b0-d916-7610-8343-f4a766ba0052";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-agent-command-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const spawns = [];
const stdin = [];
/** Per-test child behaviour: `state` merges into get_state; `setModelFails` refuses set_model. */
let child = {};
const daemon = await linkLocalHost();

async function respond(message) {
  if (message.type !== "stdin") return;
  const command = JSON.parse(message.line);
  stdin.push(command);
  let outcome = { success: true, data: {} };
  if (command.type === "negotiate_protocol") outcome = { success: true, data: { protocolVersion: 2 } };
  else if (command.type === "get_state") {
    outcome = {
      success: true,
      data: { sessionId: SAVED_ID, sessionFile: `/remote/sessions/${SAVED_ID}.jsonl`, isStreaming: false, isCompacting: false, ...child.state },
    };
  } else if (command.type === "set_model") {
    outcome = child.setModelFails
      ? { success: false, error: "Model not found" }
      : { success: true, data: { id: command.modelId, provider: command.provider } };
  }
  await daemon.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", id: command.id, command: command.type, ...outcome }) });
}

daemon.serve({
  async spawn(args) {
    spawns.push(args);
    await daemon.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
    return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
  },
  listSessions: () => [listedSession(SAVED_ID)],
  sessionFileExists: () => true,
  invalidateSessionLists: () => null,
}, (message) => (message.type === "kill" ? daemon.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" }) : respond(message)));

after(() => {
  hub.closeHostLink("local");
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

/** Fresh wrapper registry and launch record for one test; wrappers it started are stopped afterwards. */
function useRegistry(t, wrappers = {}) {
  spawns.length = 0;
  stdin.length = 0;
  child = {};
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  globalThis.__ompSessions = new Map(Object.entries(wrappers));
  globalThis.__ompStartLocks = new Map();
  t.after(async () => {
    await globalThis.__ompSessions?.get(SAVED_ID)?.destroyAndWait();
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
  });
}

const launches = () => spawns.length;

/** A live fake wrapper that records what it was sent. */
function fake({ advisorSpawned = false, running = false, send } = {}) {
  const self = {
    advisorSpawned,
    host: hub.getHost("local"),
    sent: [],
    destroyed: 0,
    isAlive: () => true,
    isRunning: () => running,
    isEditingHistory: () => false,
    async send(command) {
      self.sent.push(command);
      return send ? send(command) : { ok: true };
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

/** Parsed JSON body; a wrong status fails with the body in the message. */
async function jsonOf(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const post = (id, body, raw = JSON.stringify(body), query = "") =>
  route.POST(new Request(`http://omp.test/api/agent/${id}${query}`, { method: "POST", body: raw }), ctx(id));

test("runAgentCommand answers a live session exactly as the route", async (t) => {
  const live = fake({ send: async () => ({ model: "m" }) });
  useRegistry(t, { s1: live });
  const body = { type: "get_state" };
  const direct = await runAgentCommand("s1", body, false);
  const viaRoute = await post("s1", body);
  assert.equal(direct.status, viaRoute.status);
  assert.deepEqual(await direct.json(), { success: true, data: { model: "m" } });
  assert.deepEqual(await viaRoute.json(), { success: true, data: { model: "m" } });
  assert.deepEqual(live.sent, [body, body]);
});

test("a missing type is 400 command_type_required; a no-spawn command without a wrapper gets its canned reply", async (t) => {
  useRegistry(t);
  const missing = await runAgentCommand("nobody", {}, false);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "command_type_required");

  const canned = await runAgentCommand("nobody", { type: "predict_word" }, false);
  assert.equal(canned.status, 200);
  assert.deepEqual(await canned.json(), { success: true, data: { suffix: null } });
});

test("a JSON null body is 400 command_type_required, not a server error", async (t) => {
  useRegistry(t);
  for (const response of [await runAgentCommand("nobody", null, false), await post("nobody", null)]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "command_type_required");
  }
  assert.equal(launches(), 0);
});

test("POST and GET answers carry received/replied times", async (t) => {
  useRegistry(t, { s2: fake() });
  const answers = [];
  for (const call of [
    () => post("s2", { type: "get_state" }),
    () => post("s2", null, "{not json"),
    () => route.GET(new Request("http://omp.test/api/agent/s2"), ctx("s2")),
  ]) {
    const before = Date.now();
    const res = await call();
    answers.push({ res, before, after: Date.now() });
  }
  assert.equal(answers[1].res.status, 400);
  for (const { res, before, after } of answers) {
    const received = res.headers.get("x-omp-received-at");
    const replied = res.headers.get("x-omp-replied-at");
    assert.match(received, /^\d+$/);
    assert.match(replied, /^\d+$/);
    assert.ok(before <= Number(received) && Number(received) <= Number(replied) && Number(replied) <= after);
  }
});

// Background commands never spawn or replace an omp child: every SSE open
// fires get_btw_history, so a regression here starts omp on each reconnect.
const CANNED = [
  [{ type: "predict_word" }, { suffix: null }],
  [{ type: "predict_word_feedback" }, null],
  [{ type: "get_btw_history" }, { records: [] }],
  [{ type: "btw_cancel" }, { cancelled: false }],
];

for (const [command, data] of CANNED) {
  test(`${command.type} without a wrapper gets its canned reply and never starts omp`, async (t) => {
    useRegistry(t);
    const response = await post(SAVED_ID, command);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data });
    assert.equal(launches(), 0);
    assert.equal(globalThis.__ompSessions.size, 0, "no wrapper was registered");
  });

  test(`${command.type} reaches a live wrapper even when the advisor flag differs, without replacing it`, async (t) => {
    const live = fake({ advisorSpawned: false, send: async () => ({ live: true }) });
    useRegistry(t, { [SAVED_ID]: live });
    const response = await post(SAVED_ID, command, undefined, "?advisor=1");
    assert.deepEqual(await response.json(), { success: true, data: { live: true } });
    assert.deepEqual(live.sent, [command]);
    assert.equal(live.destroyed, 0);
    assert.equal(launches(), 0);
  });
}

test("asking a side question (btw) without a wrapper starts omp", async (t) => {
  useRegistry(t);
  await post(SAVED_ID, { type: "btw", question: "why?" });
  assert.equal(launches(), 1);
});

test("an oversized body is 413 request_too_large; a malformed body is 400 invalid_json", async (t) => {
  useRegistry(t, { s3: fake() });
  const big = JSON.stringify({ type: "prompt", message: "a".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES + 1) });
  const tooLarge = await post("s3", null, big);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "request_too_large");

  const malformed = await post("s3", null, "{not json");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_json");
  assert.deepEqual(globalThis.__ompSessions.get("s3").sent, [], "neither body reached the session");
});

test("an RPC failure from the session is 400 with its code; an omp-web failure keeps its own code", async (t) => {
  const failing = fake({
    send: async (command) => {
      throw command.type === "a" ? new RpcCommandError("a", "omp said no", "omp_code") : new WebRpcError("stuck", "session_unresponsive");
    },
  });
  useRegistry(t, { s4: failing });
  const rpc = await runAgentCommand("s4", { type: "a" }, false);
  assert.equal(rpc.status, 400);
  assert.deepEqual(await rpc.json(), { error: "omp said no", code: "omp_code" });
  const web = await runAgentCommand("s4", { type: "b" }, false);
  assert.equal(web.status, 400);
  assert.deepEqual(await web.json(), { error: "stuck", code: "session_unresponsive" });
});

test("an advisor mismatch replaces an idle child and spawns with the advisor; the body never carries the flag", async (t) => {
  const idle = fake({ advisorSpawned: false });
  useRegistry(t, { [SAVED_ID]: idle });
  const response = await post(SAVED_ID, { type: "get_state" }, undefined, "?advisor=1");
  await jsonOf(response);
  assert.ok(idle.destroyed >= 1, "the idle child was replaced");
  assert.equal(launches(), 1);
  assert.equal(spawns[0].advisor, true);
  assert.deepEqual(idle.sent, []);
  assert.ok(stdin.length > 0 && stdin.every((command) => !("advisor" in command)), "no command to omp carries advisor");
});

test("a busy child is not replaced for an advisor mismatch and gets the body verbatim", async (t) => {
  const busy = fake({ advisorSpawned: false, running: true });
  useRegistry(t, { [SAVED_ID]: busy });
  const body = { type: "steer", message: "x" };
  const response = await post(SAVED_ID, body, undefined, "?advisor=1");
  assert.equal(response.status, 200);
  assert.deepEqual(busy.sent, [body]);
  assert.equal(busy.destroyed, 0);
  assert.equal(launches(), 0);
});

// Cold set_model (#277): omp must see the requested model at spawn time, or it
// can exit on an unrestorable saved model before the RPC ever runs.
const SET_MODEL = { type: "set_model", provider: "p1", modelId: "m1" };

test("a cold set_model spawns with --model provider/modelId and answers the switch", async (t) => {
  useRegistry(t);
  const response = await post(SAVED_ID, SET_MODEL);
  assert.deepEqual(await jsonOf(response), { success: true, data: { id: "m1", provider: "p1" } });
  assert.equal(spawns[0].spawnModel, "p1/m1");
  assert.deepEqual(stdin.filter((c) => c.type === "set_model").map(({ provider, modelId }) => ({ provider, modelId })), [{ provider: "p1", modelId: "m1" }]);
});

test("a cold set_model that omp refuses still succeeds when the live state already has the model", async (t) => {
  useRegistry(t);
  child = { setModelFails: true, state: { model: { id: "m1", provider: "p1", name: "M1" } } };
  const response = await post(SAVED_ID, SET_MODEL);
  assert.deepEqual(await jsonOf(response), { success: true, data: { id: "m1", provider: "p1" } });
});

test("a cold set_model that omp refuses with a different live model surfaces the omp error", async (t) => {
  useRegistry(t);
  child = { setModelFails: true, state: { model: { id: "other", provider: "p1", name: "Other" } } };
  const response = await post(SAVED_ID, SET_MODEL);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Model not found/);
});

for (const bad of [{ type: "set_model", provider: "-p", modelId: "m1" }, { type: "set_model", provider: "p1", modelId: "m 1" }]) {
test(`a set_model with ${JSON.stringify(bad.provider + "/" + bad.modelId)} binds no spawn model`, async (t) => {
  useRegistry(t);
  await jsonOf(await post(SAVED_ID, bad));
  assert.equal(launches(), 1);
  assert.equal(spawns[0].spawnModel, undefined);
});
}
