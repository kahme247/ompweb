import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Real POST /api/notifications/answer with fake live wrappers: no omp spawn,
// no notification store writes beyond the throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-answer-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { closeNotificationStore } = await import("./notification-store.ts");
after(() => {
  globalThis.__ompSessions = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  // The live wrapper publishes notifications, which opens the store in this dir;
  // Windows cannot delete a directory while that database is open.
  closeNotificationStore();
  rmSync(agentDir, { recursive: true, force: true });
});

const route = await import("../app/api/notifications/answer/route.ts");
const { WebRpcError } = await import("./rpc-manager.ts");

const URL_ = "http://localhost/api/notifications/answer";
const post = (body, headers = {}) => route.POST(new Request(URL_, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

function fakeSession({ alive = true, result = "answered", error = null } = {}) {
  const calls = [];
  return {
    calls,
    session: {
      isAlive: () => alive,
      answerExtensionUiRequest(id, response) {
        calls.push([id, response]);
        if (error) throw error;
        return result;
      },
    },
  };
}

test("a valid answer reaches the live wrapper exactly once", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req-1", response: { confirmed: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(calls, [["req-1", { confirmed: true }]]);
});

test("all four response variants are accepted", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  for (const answer of [{ value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] }]) {
    assert.equal((await post({ sessionId: "s1", requestId: "req", response: answer })).status, 200);
  }
  assert.deepEqual(calls.map(([, answer]) => answer), [
    { value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] },
  ]);
});

test("alreadySettled and sessionGone are reported, not treated as errors", async () => {
  globalThis.__ompSessions = new Map([["s1", fakeSession({ result: "alreadySettled" }).session]]);
  const settled = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await settled.json(), { status: "alreadySettled" });

  const dead = await post({ sessionId: "s2", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await dead.json(), { status: "sessionGone" });

  globalThis.__ompSessions = new Map([["s3", fakeSession({ alive: false }).session]]);
  const exited = await post({ sessionId: "s3", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await exited.json(), { status: "sessionGone" });
});

test("a moved conversation answers through its old id", async () => {
  // registerSession keeps the old ids routable after omp moves the file, so
  // one registry entry under both keys is what the route sees.
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session], ["s0", session]]);
  const response = await post({ sessionId: "s0", requestId: "req-1", response: { value: "yes" } });
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(calls, [["req-1", { value: "yes" }]]);
});

test("malformed requests are rejected before touching any session", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  const cases = [
    null,
    [],
    "text",
    { sessionId: "s1", requestId: "req" },
    { sessionId: "", requestId: "req", response: { value: "x" } },
    { sessionId: "s1", requestId: "r".repeat(257), response: { value: "x" } },
    { sessionId: "s1", requestId: "req", response: {} },
    { sessionId: "s1", requestId: "req", response: { value: 1 } },
    { sessionId: "s1", requestId: "req", response: { cancelled: false } },
    { sessionId: "s1", requestId: "req", response: { value: "x", confirmed: true } },
    { sessionId: "s1", requestId: "req", response: { answers: "yes" } },
    { sessionId: "s1", requestId: "req", response: { answers: [{ id: 1, selectedOptions: [] }] } },
  ];
  for (const body of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_answer_request");
  }
  assert.deepEqual(calls, []);
});

test("invalid JSON and an oversized body get distinct statuses", async () => {
  assert.equal((await post("{not json")).status, 400);
  const huge = JSON.stringify({ sessionId: "s1", requestId: "req", response: { value: "x".repeat(70_000) } });
  const response = await post(huge, { "content-length": String(Buffer.byteLength(huge)) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "request_too_large");
});

test("a wrapper validation error becomes a 400 with its own code", async () => {
  const { session } = fakeSession({ error: new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers") });
  globalThis.__ompSessions = new Map([["s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid ask dialog answers", code: "invalid_ask_answers" });
});

test("an answer that cannot be delivered is not reported as answered", async () => {
  // The wrapper's send() applies the offline/restarting gate; the route must
  // surface it instead of claiming the question was answered.
  for (const [error, status, body] of [
    [new WebRpcError("Laptop is offline. The run continues there; it reconnects automatically.", "host_offline", "refused"), 503, { hostOffline: true, delivery: "refused" }],
    [new WebRpcError("This session is restarting — retry in a moment.", "session_restarting"), 400, { code: "session_restarting" }],
  ]) {
    const { session } = fakeSession({ error });
    globalThis.__ompSessions = new Map([["s1", session]]);
    const response = await post({ sessionId: "s1", requestId: "req", response: { confirmed: true } });
    assert.equal(response.status, status, error.code);
    const payload = await response.json();
    assert.equal(payload.status, undefined, "a failed delivery is never answered");
    for (const [key, value] of Object.entries(body)) assert.equal(payload[key], value, `${error.code} ${key}`);
  }
});

// The real wrapper and the real route: this is the boundary the ask
// validation has to hold at, not a fake session that only echoes.
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { localHost } = await import("./hosts/local-host.ts");

/** A live wrapper whose omp frames the test drives; `sent` collects what reached the child. */
function liveAskSession(t) {
  // Earlier tests left fake sessions in the registry; a running-change broadcast
  // walks it, and those fakes are not wrappers.
  globalThis.__ompSessions = new Map();
  let feed;
  const sent = [];
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame(handler) { feed = handler; return () => {}; },
    sendCommand: async (command) => command.type === "get_state"
      ? { sessionId: "ask-live", sessionFile: "/tmp/ask-live.jsonl", isStreaming: false, isCompacting: false }
      : {},
    sendFrame(frame) { sent.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sent, emit: (frame) => feed(frame) };
}

test("the real wrapper refuses ask answers omp would reject, and keeps the question answerable", async (t) => {
  const { wrapper, sent, emit } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__ompSessions = new Map([["ask-live", wrapper]]);
  const ask = () => emit({
    type: "extension_ui_request", id: "ask-live-1", method: "ask",
    questions: [
      { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Pick many", multi: true, options: [{ label: "X" }, { label: "Y" }] },
    ],
  });
  ask();
  const rejected = [
    [[], "answers:[] for a nonempty ask"],
    [[{ id: "q1", selectedOptions: ["A"] }], "one answer short"],
    [[{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [] }, { id: "q2", selectedOptions: [] }], "one answer too many"],
    [[{ id: "unknown", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [] }], "unknown question id"],
    [[{ id: "q1", selectedOptions: ["nope"] }, { id: "q2", selectedOptions: [] }], "unknown option label"],
    [[{ id: "q1", selectedOptions: ["A", "B"] }, { id: "q2", selectedOptions: [] }], "two labels on a single-select question"],
  ];
  for (const [answers, why] of rejected) {
    const response = await post({ sessionId: "ask-live", requestId: "ask-live-1", response: { answers } });
    assert.equal(response.status, 400, why);
    assert.equal((await response.json()).code, "invalid_ask_answers", why);
    assert.deepEqual(sent, [], `${why}: nothing reaches omp`);
    // Still answerable: the next request for it is not alreadySettled.
    const replay = [];
    wrapper.onEvent((event) => replay.push(event));
    assert.equal(replay[0]?.id, "ask-live-1", `${why}: the dialog stays pending for reconnects`);
  }

  // The legitimate answers the same dialog accepts.
  for (const answers of [
    [{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: ["X", "Y"] }],
    [{ id: "q1", selectedOptions: [], customInput: "typed" }, { id: "q2", selectedOptions: [] }],
  ]) {
    ask();
    const response = await post({ sessionId: "ask-live", requestId: "ask-live-1", response: { answers } });
    assert.deepEqual(await response.json(), { status: "answered" }, JSON.stringify(answers));
    assert.deepEqual(sent.at(-1), { type: "extension_ui_response", id: "ask-live-1", answers });
  }

  // A cancel is always accepted, and a second answer is already settled.
  ask();
  assert.deepEqual(await (await post({ sessionId: "ask-live", requestId: "ask-live-1", response: { cancelled: true } })).json(), { status: "answered" });
  assert.deepEqual(await (await post({ sessionId: "ask-live", requestId: "ask-live-1", response: { cancelled: true } })).json(), { status: "alreadySettled" });
});
