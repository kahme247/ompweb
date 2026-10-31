import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// sendAgentCommand over both transports. The shared worker is faked: it reports
// websocket mode when the tab starts it and answers each `cmd` with `answerWith(message)`
// (null: never). HTTP goes to the `respond` fetch fake.
const commands = [];
let answerWith = () => null;
const port = {
  onmessage: null,
  start() {
    port.onmessage({ data: { transport: "websocket" } });
  },
  postMessage(message) {
    if (message.op !== "cmd") return;
    commands.push(message);
    const answer = answerWith(message);
    if (answer) queueMicrotask(() => port.onmessage({ data: { cmd: message.n, ...answer } }));
  },
};
const worker = { port, onerror: null };
globalThis.SharedWorker = function SharedWorker() {
  return worker;
};

const requests = [];
let respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: null }) });
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  return respond();
};

const { openEventStream, transportMode } = await import("./event-stream.ts");
const { HostOfflineError, sendAgentCommand, setSessionAdvisorSpawn } = await import("./agent-client.ts");

// The tab's transport exists once any stream opened (AppShell's do at start).
openEventStream({ kind: "running" });

const viaSocket = (status, body) => () => ({ status, body, recvAt: 1, repliedAt: 2, attempts: 1, deduped: false, behindBytes: 0 });
const LOST = "The connection to omp-web dropped before the answer arrived. The command may have run; check before sending it again.";

test("websocket mode goes through the worker and maps errors like HTTP", async () => {
  assert.equal(transportMode(), "websocket");
  setSessionAdvisorSpawn("s 1", true);
  answerWith = viaSocket(200, { success: true, data: { model: "m" } });
  assert.deepEqual(await sendAgentCommand("s 1", { type: "get_state" }), { model: "m" });
  setSessionAdvisorSpawn("s 1", false);
  const [sent] = commands;
  assert.match(sent.req, /^[a-z0-9]{8,64}$/);
  assert.deepEqual(sent, { op: "cmd", n: sent.n, req: sent.req, sessionId: "s 1", advisor: true, body: "{\"type\":\"get_state\"}" });

  answerWith = viaSocket(503, { error: "Host offline", hostOffline: true, delivery: "unknown" });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), (error) => error instanceof HostOfflineError && error.mayHaveRun === true);
  answerWith = viaSocket(503, { error: "lost", code: "transport_lost" });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), { message: LOST });
  answerWith = viaSocket(503, { error: "unavailable", code: "transport_unavailable" });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), { message: "Not sent: no connection to omp-web. Try again." });
  assert.equal(new Set(commands.map((command) => command.req)).size, 4, "every command has its own request id");
  assert.deepEqual(requests, []);
});

test("http: true falls back to POST /api/agent/<id>?advisor=1", async () => {
  setSessionAdvisorSpawn("s1", true);
  answerWith = () => ({ http: true });
  respond = () => ({ ok: true, status: 200, headers: new Headers({ "x-omp-received-at": "5", "x-omp-replied-at": "6" }), json: async () => ({ success: true, data: "over http" }) });
  assert.equal(await sendAgentCommand("s1", { type: "get_state" }), "over http");
  setSessionAdvisorSpawn("s1", false);
  assert.deepEqual(requests.map(({ url, init }) => [url, init.method, init.body]), [["/api/agent/s1?advisor=1", "POST", commands.at(-1).body]]);
});

test("sse mode uses fetch, and a fetch fake without headers works", async () => {
  port.onmessage({ data: { transport: "sse" } });
  const asked = commands.length;
  requests.length = 0;
  respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: 42 }) });
  assert.equal(await sendAgentCommand("s1", { type: "get_state" }), 42);
  respond = () => ({ ok: false, status: 503, json: async () => ({ error: "Host offline", hostOffline: true, delivery: "refused" }) });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), (error) => error instanceof HostOfflineError && error.mayHaveRun === false);
  assert.deepEqual(requests.map(({ url }) => url), ["/api/agent/s1", "/api/agent/s1"]);
  assert.equal(commands.length, asked, "the worker is not asked");
  port.onmessage({ data: { transport: "websocket" } });
});

test("a worker that fails answers its unanswered commands transport_lost", async () => {
  answerWith = () => null;
  const pending = sendAgentCommand("s1", { type: "prompt", message: "hi" });
  worker.onerror();
  await assert.rejects(pending, { message: LOST });
  assert.equal(transportMode(), "sse", "the next stream starts a fresh worker");
});
