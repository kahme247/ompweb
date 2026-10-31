import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// sendAgentCommand over both transports. The shared worker is faked: it reports
// ws-session mode when the tab starts it and answers each `cmd` with `answerWith(message)`
// (null: never), and keeps the transport samples the tab posts. HTTP goes to the `respond` fetch fake.
const commands = [];
const samples = [];
let answerWith = () => null;
const port = {
  onmessage: null,
  start() {
    port.onmessage({ data: { transport: "ws-session" } });
  },
  postMessage(message) {
    if (message.op === "metric") samples.push(message.sample);
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
const { HostOfflineError, TransportLostError, sendAgentCommand, setSessionAdvisorSpawn } = await import("./agent-client.ts");

// The tab's transport exists once any stream opened (AppShell's do at start).
openEventStream({ kind: "running" });

const viaSocket = (status, body) => () => ({
  status, body, recvAt: 1, repliedAt: 2, attempts: 1, deduped: false, behindBytes: 0, socket: "session:s1", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
});
const LOST = "The connection to omp-web dropped before the answer arrived. The command may have run; check before sending it again.";
/** transport_lost: the localized message, and the command may have run (the composer must not offer it again). */
const isLost = (error) => error instanceof TransportLostError && error.mayHaveRun === true && error.message === LOST;

test("each ws-* mode goes through the worker and maps errors like HTTP", async () => {
  assert.equal(transportMode(), "ws-session");
  for (const mode of ["ws-client", "ws-pool", "ws-session"]) {
    port.onmessage({ data: { transport: mode } });
    answerWith = viaSocket(200, { success: true, data: mode });
    assert.equal(await sendAgentCommand("s0", { type: "get_state" }), mode);
  }
  commands.length = 0;
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
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), isLost);
  answerWith = viaSocket(503, { error: "unavailable", code: "transport_unavailable" });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), (error) =>
    !(error instanceof TransportLostError) && !(error instanceof HostOfflineError) && error.message === "Not sent: no connection to omp-web. Try again.");
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
  port.onmessage({ data: { transport: "ws-session" } });
});

const pick = (sample, keys) => Object.fromEntries(keys.map((key) => [key, sample[key]]));
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A fetch fake whose responses the test releases: `release(i, response)` answers the i-th request. */
function heldFetch() {
  const held = [];
  respond = () => new Promise((resolve) => held.push(resolve));
  return (index, response) => held[index](response);
}
const answered = (headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => ({ success: true, data: null }) });

test("an HTTP action sample uses the timing headers and splits in-flight POSTs by session", async () => {
  port.onmessage({ data: { transport: "sse" } });
  const release = heldFetch();
  const prompt = { type: "prompt", message: "first" };
  const other = { type: "prompt", message: "other session" };
  const pending = [sendAgentCommand("s1", prompt), sendAgentCommand("s2", other)];
  samples.length = 0;
  const before = Date.now();
  const third = sendAgentCommand("s1", { type: "abort" });
  await settle();
  release(2, answered({ "x-omp-received-at": "5", "x-omp-replied-at": "6" }));
  await third;
  const [sample] = samples;
  assert.equal(samples.length, 1);
  assert.deepEqual(
    pick(sample, ["metric", "type", "session", "via", "socket", "status", "outcome", "attempts", "deduped", "bytes", "behindBytes", "behindSameBytes", "behindOtherBytes", "replyBehindOtherBytes", "recvAt", "repliedAt"]),
    {
      metric: "action", type: "abort", session: "s1", via: "http", socket: "http", status: 200, outcome: "ok", attempts: 1, deduped: false, bytes: 16,
      behindBytes: JSON.stringify(prompt).length, behindSameBytes: JSON.stringify(prompt).length, behindOtherBytes: JSON.stringify(other).length, replyBehindOtherBytes: null, recvAt: 5, repliedAt: 6,
    },
  );
  assert.match(sample.req, /^[a-z0-9]{8,64}$/);
  assert.ok(sample.sentAt >= before && sample.gotAt >= sample.sentAt);
  release(0, answered());
  release(1, answered());
  await Promise.all(pending);

  respond = () => Promise.reject(new TypeError("Failed to fetch"));
  await assert.rejects(sendAgentCommand("s1", { type: "get_state" }), TypeError);
  assert.deepEqual(pick(samples.at(-1), ["metric", "type", "via", "socket", "status", "outcome"]), { metric: "action", type: "get_state", via: "http", socket: "http", status: 0, outcome: "error" });
  port.onmessage({ data: { transport: "ws-session" } });
});

test("an HTTP command slower than the ack formula records one hang, then its action", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  port.onmessage({ data: { transport: "sse" } });
  const release = heldFetch();
  const command = { type: "compact", customInstructions: "x".repeat(3_170) };
  const bytes = JSON.stringify(command).length;
  samples.length = 0;
  const pending = sendAgentCommand("s1", command);
  await settle();
  t.mock.timers.tick(10_000 + Math.ceil(bytes / 32) - 1);
  assert.deepEqual(samples, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(samples.map((sample) => pick(sample, ["metric", "socket", "type", "via", "bytes", "waitedMs"])), [
    { metric: "hang", socket: "http", type: "compact", via: "http", bytes, waitedMs: 10_000 + Math.ceil(bytes / 32) },
  ]);
  release(0, answered());
  await pending;
  assert.deepEqual(samples.map((sample) => sample.metric), ["hang", "action"], "the fetch was not aborted");
  assert.equal(samples[0].req, samples[1].req);
  port.onmessage({ data: { transport: "ws-session" } });
});

test("a socket action sample carries socket, attempts, deduped, recvAt, repliedAt and the isolation bytes", async () => {
  samples.length = 0;
  answerWith = () => ({
    status: 200, body: { success: true, data: 1 }, recvAt: 10, repliedAt: 20, attempts: 2, deduped: true, behindBytes: 5,
    socket: "pool:1", behindSameBytes: 3, behindOtherBytes: 2, replyBehindOtherBytes: 70_000,
  });
  await sendAgentCommand("s1", { type: "get_state" });
  assert.deepEqual(
    pick(samples[0], ["metric", "via", "socket", "outcome", "attempts", "deduped", "recvAt", "repliedAt", "bytes", "behindBytes", "behindSameBytes", "behindOtherBytes", "replyBehindOtherBytes"]),
    { metric: "action", via: "ws", socket: "pool:1", outcome: "ok", attempts: 2, deduped: true, recvAt: 10, repliedAt: 20, bytes: 20, behindBytes: 5, behindSameBytes: 3, behindOtherBytes: 2, replyBehindOtherBytes: 70_000 },
  );
  for (const [status, body, outcome] of [[503, { error: "lost", code: "transport_lost" }, "lost"], [503, { error: "unavailable", code: "transport_unavailable" }, "unavailable"], [500, { error: "boom" }, "error"]]) {
    answerWith = viaSocket(status, body);
    await sendAgentCommand("s1", { type: "prompt", message: "hi" }).catch(() => {});
    assert.equal(samples.at(-1).outcome, outcome, body.error);
  }
});

test("a worker that fails answers its unanswered commands transport_lost", async () => {
  answerWith = () => null;
  const pending = sendAgentCommand("s1", { type: "prompt", message: "hi" });
  worker.onerror();
  await assert.rejects(pending, isLost);
  assert.equal(transportMode(), "sse", "the next stream starts a fresh worker");
});
