import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-outbox-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runAgentCommand } = await import("./agent-command.ts");
const outbox = await import("./message-outbox.ts");
const { EventStreamConnection } = await import("./event-stream-hub.ts");
const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
const { RpcCommandError } = await import("./omp/rpc-process.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const { isLinkUp } = await import("./hosts/host.ts");
const hub = await import("./hosts/hub.ts");
const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");

after(() => {
  hub.flushLinkSamples();
  closeNotificationStore();
  outbox.closeOutboxStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

// Every session in this file lives on one fake host whose link the tests switch.
let hostStatus = "online";
const host = {
  id: "outbox-test-host", label: "Test host", status: () => hostStatus,
  sessionOps: { readContext: async () => ({ ok: true, value: { entryIds: ["before-dispatch"] } }) },
};
globalThis.__ompSessions ??= new Map();
// As at boot: the hello hook and the late hand-off tap.
outbox.startOutbox();

/** A live wrapper in the registry: records what reaches omp (get_state aside); `reply` answers it. */
function wrapper(sessionId, { running = false, reply = null, getState = null } = {}) {
  const listeners = [];
  const self = {
    sessionId,
    advisorSpawned: false,
    host,
    sent: [],
    running,
    messageGeneration: 0,
    queue: { steering: [], followUp: [] },
    reply,
    withPendingCommand: (callback) => callback(),
    isAlive: () => true,
    isRunning: () => self.running,
    isEditingHistory: () => false,
    getStreamSnapshot: () => ({ cursor: { streamId: "outbox-test", sequence: 0 } }),
    getMessageCommandGeneration: () => self.messageGeneration,
    hasPendingMessageCommands: () => false,
    confirmMessageCommandGeneration() {},
    watchMessageReplacement(...args) { return AgentSessionWrapper.prototype.watchMessageReplacement.call(self, ...args); },
    onEvent(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    // As the wrapper's emit: its listeners, then the frame taps.
    emit(event) {
      if (event.type === "queue_update") self.queue = { steering: event.steering, followUp: event.followUp };
      for (const listener of [...listeners]) listener(event);
      for (const tap of globalThis.__ompFrameTaps ?? []) tap(self, event);
    },
    async send(command) {
      if (!isLinkUp(hostStatus)) throw new WebRpcError("Test host is offline", "host_offline", "refused");
      if (command.type === "get_state") return getState ? getState() : { queuedMessages: self.queue };
      self.messageGeneration += 1;
      // As sendNativeMessageCommand: the write is recorded before omp's answer, whatever that answer is.
      (globalThis.__ompNativeWrites ??= new WeakSet()).add(command);
      self.sent.push(command);
      if (self.reply) return self.reply(command);
      if (command.type !== "prompt" || command.streamingBehavior) {
        const key = command.type === "steer" || command.streamingBehavior === "steer" ? "steering" : "followUp";
        self.emit({ type: "queue_update", ...self.queue, [key]: [...self.queue[key], command.message] });
      }
      return null;
    },
    async destroyAndWait() {},
  };
  globalThis.__ompSessions.set(sessionId, self);
  return self;
}

const command = async (sessionId, body) => {
  const scopeResponse = await runAgentCommand(sessionId, { type: "outbox_scope" }, false, "owner");
  const scope = (await scopeResponse.json()).data?.scope;
  return runAgentCommand(sessionId, body.type === "outbox_add" ? { scope, ...body } : body, false, "owner");
};
const add = async (sessionId, id, message, mode = "prompt") => (await command(sessionId, { type: "outbox_add", id, mode, message })).json();
const states = (sessionId) => outbox.outboxEntries(sessionId).map((entry) => `${entry.message}:${entry.state}`);

/** The session channel's frames, as one connection's sink receives them. */
async function watchChannel(sessionId) {
  const frames = [];
  const sink = {
    heartbeatMs: 60_000,
    write(name, _at, data) {
      if (name === "s1") frames.push(JSON.parse(data));
      return true;
    },
    backpressured: () => false,
    heartbeat: () => true,
    close() {},
  };
  const connection = new EventStreamConnection(undefined, sink);
  assert.deepEqual(await connection.subscribe("s1", { kind: "session", sessionId }), { ok: true });
  const kinds = () => frames.map((frame) => frame.type === "outbox_update" ? `outbox:${frame.entries.map((entry) => entry.state).join(",")}` : frame.type);
  return { frames, kinds, close: () => connection.close() };
}

test("outbox_add stores an id once, across a restart; a removed id is answered as delivered, not added again", async () => {
  hostStatus = "offline";
  const sid = "s-idempotent";
  wrapper(sid);
  const first = await add(sid, "m1", "hello");
  const again = await add(sid, "m1", "hello");
  assert.equal(first.success, true);
  assert.equal(again.data.entry.id, "m1");
  assert.equal(again.data.entry.createdAt, first.data.entry.createdAt);
  await until(() => states(sid)[0] === "hello:waiting_host", "the offline host");
  assert.deepEqual(states(sid), ["hello:waiting_host"]);

  // A web-server restart: a new store handle and dispatcher.
  outbox.closeOutboxStore();
  globalThis.__ompOutbox = undefined;
  assert.deepEqual(states(sid), ["hello:waiting_host"]);

  assert.equal((await (await command(sid, { type: "outbox_remove", id: "m1" })).json()).data.removed, true);
  const late = await add(sid, "m1", "hello");
  assert.equal(late.data.entry.state, "delivered", "a late resend of a removed id is answered, not held again");
  assert.deepEqual(states(sid), []);
  assert.deepEqual((await (await command(sid, { type: "outbox_remove", id: "unknown" })).json()).data, { removed: false });

  const bad = await command(sid, { type: "outbox_add", id: "m2", mode: "shout", message: "x" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_outbox_entry");
});

for (const transient of [true, false]) {
  test(`Delete during initial preparation cannot revive an entry after a ${transient ? "transient" : "permanent"} refusal`, async () => {
    hostStatus = "online";
    const sid = `deleted-preparation-${transient}`;
    let refuse;
    const w = wrapper(sid, {
      getState: () => new Promise((_resolve, reject) => {
        refuse = () => reject(transient ? new WebRpcError("Still preparing", "session_busy") : new RpcCommandError("get_state", "Preparation refused"));
      }),
    });
    await add(sid, sid, "must stay deleted");
    await until(() => typeof refuse === "function", "initial get_state admission");
    const response = await command(sid, { type: "outbox_remove", id: sid });
    assert.equal((await response.json()).data.removed, true);
    refuse();
    await until(() => !globalThis.__ompOutbox.busy.has(sid), "deleted preparation settlement");
    assert.equal(globalThis.__ompOutboxStore.db.prepare("SELECT state, message FROM entries WHERE id = ?").get(sid).state, "delivered");
    assert.deepEqual(outbox.outboxEntries(sid), []);
    assert.ok(outbox.outboxSettledIds(sid).includes(sid));
    assert.equal(globalThis.__ompOutbox.retries?.size ?? 0, 0, "a deleted entry schedules no retry");
    outbox.pumpOutbox(sid);
    assert.deepEqual(w.sent, [], "neither the deleted message nor an empty tombstone reaches omp");
  });
}

test("entries go oldest first, one at a time; during a run a prompt goes as a follow-up and a slash command as a queued prompt", async () => {
  hostStatus = "online";
  const sid = "s-fifo";
  const replies = [];
  const w = wrapper(sid, { running: true, reply: () => new Promise((resolve) => replies.push(resolve)) });
  await add(sid, "f1", "one", "followUp");
  await add(sid, "f2", "two", "prompt");
  await add(sid, "f3", "three", "steer");
  await add(sid, "f4", "/review", "followUp");
  await until(() => replies.length === 1, "the first send");
  assert.deepEqual(states(sid), ["one:delivering", "two:held", "three:held", "/review:held"]);
  const dispatched = await command(sid, { type: "outbox_remove", id: "f1" });
  assert.equal(dispatched.status, 409);
  assert.equal((await dispatched.json()).code, "outbox_dispatched");
  for (let n = 1; n <= 4; n++) {
    await until(() => replies.length === n, `send ${n}`);
    assert.equal(w.sent.length, n, "one in flight");
    w.emit({ type: "queue_update", steering: [], followUp: w.sent.slice(0, n).map((sent) => sent.message) });
    replies[n - 1](null);
  }
  await until(() => states(sid).length === 0, "every hand-off");
  assert.deepEqual(w.sent.map(({ type, message, streamingBehavior }) => [type, message, streamingBehavior]), [
    ["follow_up", "one", undefined],
    ["follow_up", "two", undefined],
    ["steer", "three", undefined],
    ["prompt", "/review", "followUp"],
  ]);
});

test("with its host offline an entry waits, and goes on the next host link", async () => {
  outbox.startOutbox();
  hostStatus = "offline";
  const sid = "s-offline";
  const w = wrapper(sid, { running: true });
  await add(sid, "o1", "first", "followUp");
  await add(sid, "o2", "second", "followUp");
  await until(() => states(sid).join() === "first:waiting_host,second:waiting_host", "both waiting");
  assert.deepEqual(w.sent, []);

  hostStatus = "online";
  const link = await linkHost("Outbox test host");
  await until(() => states(sid).length === 0, "delivery after the hello");
  assert.deepEqual(w.sent.map((sent) => sent.message), ["first", "second"]);
  // Offline from here: later tests' session lookups must not wait for this host's answers.
  hub.closeHostLink(link.id);
});

test("an idle prompt leaves after omp's echo, on every channel after the echo frame", async () => {
  hostStatus = "online";
  const sid = "s-echo";
  const w = wrapper(sid);
  await add(sid, "e1", "hi");
  await until(() => w.sent.length === 1, "the prompt");
  // The watch was attached before this channel's listener: the removal must still follow the echo here.
  const channel = await watchChannel(sid);
  await sleep(20);
  assert.deepEqual(states(sid), ["hi:delivering"], "acknowledged but not shown yet");
  w.emit({ type: "message_start", message: { role: "user", content: "hi" } });
  w.emit({ type: "message_end", message: { role: "user", content: "hi" } });
  await until(() => states(sid).length === 0, "the hand-off");
  assert.deepEqual(channel.kinds(), ["connected", "outbox:delivering", "message_start", "message_end", "outbox:"]);
  assert.deepEqual(channel.frames.find((frame) => frame.type === "outbox_update" && frame.entries.length)?.entries[0].previousEntryIds, ["before-dispatch"]);
  assert.equal(globalThis.__ompOutboxStore.db.prepare("SELECT previous_entry_ids FROM entries WHERE id = ?").get("e1").previous_entry_ids, null, "baseline cleared on hand-off");
  assert.deepEqual(channel.frames.at(-1).settledIds, ["e1"]);
  assert.deepEqual(w.sent.map((sent) => sent.type), ["prompt"]);
  channel.close();
});

test("a follow-up leaves once omp answered, after the queue_update that shows it", async () => {
  hostStatus = "online";
  const sid = "s-queue";
  const w = wrapper(sid, {
    running: true,
    reply: (sent) => {
      w.emit({ type: "queue_update", steering: [], followUp: [sent.message] });
      return null;
    },
  });
  const channel = await watchChannel(sid);
  await add(sid, "q1", "later", "followUp");
  await until(() => states(sid).length === 0, "the hand-off");
  assert.deepEqual(channel.kinds(), ["connected", "outbox:", "outbox:held", "outbox:delivering", "queue_update", "outbox:"]);
  channel.close();
});

test("a lost reply fails as may-have-been-sent and is never resent, even on a host link; omp's refusal fails with its message; later entries still go", async () => {
  hostStatus = "online";
  const sid = "s-failures";
  const outcomes = [
    () => { throw new WebRpcError("Test host is offline", "host_offline", "unknown"); },
    () => { throw new RpcCommandError("follow_up", "Message too long"); },
    () => { w.emit({ type: "queue_update", steering: [], followUp: ["fine"] }); return null; },
  ];
  const w = wrapper(sid, { running: true, reply: () => outcomes[w.sent.length - 1]() });
  await add(sid, "x1", "lost", "followUp");
  await add(sid, "x2", "refused", "followUp");
  await add(sid, "x3", "fine", "followUp");
  await until(() => w.sent.length === 3 && states(sid).length === 2, "all three dispatched");
  const [lost, refused] = outbox.outboxEntries(sid);
  assert.equal(lost.state, "failed");
  assert.equal(lost.mayHaveBeenSent, true);
  assert.equal(refused.state, "failed");
  assert.equal(refused.error, "Message too long");
  assert.equal(refused.mayHaveBeenSent, undefined);
  // What a host's hello does: the host link replays an undelivered line itself, so the outbox never sends it again.
  outbox.pumpOutbox(sid);
  await sleep(20);
  assert.equal(w.sent.length, 3, "a failed entry is never resent by itself");
  assert.equal((await (await command(sid, { type: "outbox_remove", id: "x2" })).json()).data.removed, true);
});

test("uncertain failures never disappear on same-text snapshots, new echoes, or empty upload-only text", async () => {
  hostStatus = "online";
  const sid = "s-late";
  const w = wrapper(sid, { running: true, reply: () => { throw new WebRpcError("Test host is offline", "host_offline", "unknown"); } });
  await add(sid, "l1", "replayed", "followUp");
  await until(() => states(sid)[0] === "replayed:failed", "the lost reply");
  w.emit({ type: "queue_update", steering: [], followUp: ["replayed"] });
  w.emit({ type: "message_end", message: { role: "user", content: "replayed" } });
  assert.deepEqual(states(sid), ["replayed:failed"]);
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET message = '', uploads = ? WHERE id = ?")
    .run(JSON.stringify(["b2037f01-2565-4536-8ca7-c18b34e5cd53"]), "l1");
  w.emit({ type: "queue_update", steering: [], followUp: ["unrelated"] });
  w.emit({ type: "message_end", message: { role: "user", content: "anything" } });
  assert.deepEqual(states(sid), [":failed"], "empty prefix must not claim any unrelated message");
});

test("a prompt omp runs as a slash command (agentInvoked: false) leaves on the reply, with no echo", async () => {
  hostStatus = "online";
  const sid = "s-slash";
  const w = wrapper(sid);
  // A builtin's acknowledgement explicitly says no agent was invoked.
  w.reply = () => ({ agentInvoked: false });
  await add(sid, "s1", "/model");
  await until(() => states(sid).length === 0, "the hand-off");
  assert.deepEqual(w.sent.map(({ type, message }) => [type, message]), [["prompt", "/model"]]);
});

test("an idle prompt whose omp exits before showing it fails as may-have-been-sent", async () => {
  hostStatus = "online";
  const sid = "s-exit";
  const w = wrapper(sid);
  await add(sid, "k1", "boom");
  await until(() => w.sent.length === 1, "the prompt");
  await sleep(20);
  // As handleProcessExit does: a synthesized terminal agent_end from a wrapper whose child is gone.
  w.isAlive = () => false;
  w.emit({ type: "agent_end", isTerminal: true, messages: [] });
  await until(() => states(sid)[0] === "boom:failed", "the failure");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
});

test("an idle prompt that omp refuses before showing it fails with omp's message", async () => {
  hostStatus = "online";
  const sid = "s-prompt-error";
  const w = wrapper(sid);
  w.reply = () => {
    throw new RpcCommandError("prompt", "usage reserve is fail-closed");
  };
  await add(sid, "p1", "go");
  await until(() => states(sid)[0] === "go:failed", "the failure");
  assert.equal(outbox.outboxEntries(sid)[0].error, "usage reserve is fail-closed");
});

test("a session with held entries and no omp is watched, and the channel attaches to the wrapper once it starts", async () => {
  hostStatus = "online";
  const sid = "01a0e6b0-d916-7610-8343-f4a766ba0099";
  globalThis.__ompSessions.delete(sid);
  // No wrapper and no host has listed this machine's sessions yet: held anyway (resolve answers 503).
  await add(sid, "c1", "wake up");
  await until(() => states(sid)[0] === "wake up:waiting_host", "the unknown host");
  const channel = await watchChannel(sid);
  assert.deepEqual(channel.kinds(), ["outbox:waiting_host"]);
  const w = wrapper(sid);
  outbox.pumpOutbox(sid);
  await until(() => w.sent.length === 1, "the prompt");
  w.emit({ type: "message_end", message: { role: "user", content: "wake up" } });
  await until(() => states(sid).length === 0, "the hand-off");
  assert.deepEqual(channel.kinds(), ["outbox:waiting_host", "connected", "outbox:delivering", "message_end", "outbox:"]);
  channel.close();
});

test("scope is stable across cookie owners; missing, changed credentials and a changed installation refuse before storage", async () => {
  const scopeOf = async (owner) => (await (await runAgentCommand("scope-session", { type: "outbox_scope" }, false, owner)).json()).data?.scope;
  const first = await scopeOf("cookie1");
  assert.equal(typeof first, "string");
  assert.equal(await scopeOf("cookie2"), first, "same credentials, new cookie");
  const body = { type: "outbox_add", id: "scoped1", mode: "prompt", message: "do not leak" };
  const missing = await runAgentCommand("scope-session", body, false, "cookie1");
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, "outbox_scope_changed");
  const previousCredential = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  try {
    process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = "rotated";
    assert.notEqual(await scopeOf("cookie1"), first);
    assert.equal((await runAgentCommand("scope-session", { ...body, scope: first }, false, "cookie1")).status, 409);
  } finally {
    if (previousCredential === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
    else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previousCredential;
  }
  const { pinWebAuthSecretForTests, resolveWebAuthSecret } = await import("./web-auth-secret.ts");
  const secret = resolveWebAuthSecret();
  try {
    pinWebAuthSecretForTests({ ...secret, key: Buffer.alloc(32, 11).toString("base64url") });
    assert.notEqual(await scopeOf("cookie1"), first);
    assert.equal((await runAgentCommand("scope-session", { ...body, scope: first }, false, "cookie1")).status, 409);
  } finally {
    pinWebAuthSecretForTests();
  }
  assert.deepEqual(outbox.outboxEntries("scope-session"), []);
});

test("oversized outbox messages are refused before storage with the prompt request cap", async () => {
  hostStatus = "offline";
  wrapper("s-size");
  const response = await command("s-size", {
    type: "outbox_add", id: "oversized", mode: "prompt", message: "x".repeat(8 * 1024 * 1024),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(outbox.outboxEntries("s-size"), []);
});


test("upload completion precedes any outbox_add; its receipt and the held entry survive separate server restarts", async () => {
  hostStatus = "offline";
  const sid = "s-upload-restart";
  const uploadId = crypto.randomUUID();
  const link = await linkHost("Upload receipts");
  const attached = [];
  link.serve({
    uploadStart: () => ({ received: 4, done: true }),
    uploadAttach: (args) => {
      attached.push(args);
      return { path: "/session/local/uploads/file.txt", url: "local://uploads/file.txt" };
    },
  });
  const w = wrapper(sid, { running: true });
  w.host = { ...host, id: link.id };
  w.sessionFile = "/session.jsonl";
  w.withPendingCommand = (callback) => callback();
  const uploads = await import("./uploads.ts");
  await uploads.startUpload({
    id: uploadId, hostId: link.id, owner: "owner", name: "file.txt", size: 4, type: "text/plain",
    sink: { ack() {}, error() {} },
  });
  // The browser committed its upload ids, but /outbox_add never reached the server before it restarted.
  outbox.closeOutboxStore();
  globalThis.__ompUploads = undefined;
  await command(sid, { type: "outbox_add", id: "upload1", mode: "followUp", message: "read it", uploads: [uploadId] });
  await until(() => states(sid)[0] === "read it:waiting_host", "the offline host");
  outbox.closeOutboxStore();
  globalThis.__ompUploads = undefined;
  hostStatus = "online";
  outbox.pumpOutbox(sid);
  await until(() => states(sid).length === 0 || states(sid)[0] === "read it:failed", "the dispatch");
  assert.deepEqual(states(sid), [], "receipt metadata survives, not upload_missing after the restart");
  assert.equal(attached.length, 1);
  assert.match(w.sent[0].message, /read it\n\nAttached files[\s\S]*local:\/\/uploads\/file.txt/);
  assert.equal(globalThis.__ompUploads.has(uploadId), false, "existing successful send forgets the receipt");
  assert.equal(outbox.completedUpload(uploadId), null, "successful send removes the durable completion receipt too");
  hub.closeHostLink(link.id);
});

test("follow-up reply waits for a new queue occurrence, not a stale identical chip or unrelated echo", async () => {
  hostStatus = "online";
  const sid = "s-reply-before-queue";
  const w = wrapper(sid, { running: true, reply: () => null });
  w.queue = { steering: [], followUp: ["same"] };
  await add(sid, "q-late", "same", "followUp");
  await until(() => w.sent.length === 1, "acknowledged send");
  w.emit({ type: "queue_update", steering: [], followUp: ["same"] });
  w.emit({ type: "message_end", message: { role: "user", content: "unrelated" } });
  await sleep(20);
  assert.deepEqual(states(sid), ["same:delivering"]);
  w.emit({ type: "queue_update", steering: [], followUp: ["same", "same"] });
  await until(() => states(sid).length === 0, "new queue occurrence");
});

test("two aliases of one wrapper share FIFO dispatch, snapshots and settlement", async () => {
  hostStatus = "online";
  const oldId = "alias-old", newId = "alias-new";
  const w = wrapper(oldId, { running: true, reply: () => null });
  globalThis.__ompSessions.set(newId, w);
  await add(oldId, "alias1", "older", "followUp");
  await add(newId, "alias2", "newer", "followUp");
  await until(() => w.sent.length === 1, "first alias send");
  await sleep(20);
  assert.deepEqual(w.sent.map(({ message }) => message), ["older"], "aliases cannot dispatch concurrently");
  assert.deepEqual(outbox.outboxEntries(newId).map(({ message, sessionId }) => [message, sessionId]), [["older", newId], ["newer", newId]]);
  const channel = await watchChannel(newId);
  w.emit({ type: "queue_update", steering: [], followUp: ["older"] });
  await until(() => w.sent.length === 2, "second alias send");
  w.emit({ type: "queue_update", steering: [], followUp: ["older", "newer"] });
  await until(() => states(newId).length === 0, "both settlements");
  assert.deepEqual(w.sent.map(({ message }) => message), ["older", "newer"]);
  assert.deepEqual(new Set(channel.frames.at(-1).settledIds), new Set(["alias1", "alias2"]));
  channel.close();
});

test("an existing channel rebinds to a replacement wrapper across native aliases before its echo", async () => {
  hostStatus = "online";
  const oldId = "channel-old", newId = "channel-new";
  const a = wrapper(oldId);
  const channel = await watchChannel(oldId);
  a.isAlive = () => false;
  const b = wrapper(newId);
  globalThis.__ompSessions.set(oldId, b);
  await add(newId, "rebind1", "replacement");
  await until(() => b.sent.length === 1, "replacement wrapper send");
  const before = channel.frames.length;
  a.emit({ type: "message_end", message: { role: "user", content: "stale" } });
  assert.equal(channel.frames.length, before, "old listener detached");
  b.emit({ type: "message_end", message: { role: "user", content: "replacement" } });
  await until(() => states(oldId).length === 0, "replacement hand-off");
  const echo = channel.frames.findIndex((frame) => frame.type === "message_end");
  const removed = channel.frames.findIndex((frame, index) => index > echo && frame.type === "outbox_update" && frame.entries.length === 0);
  assert.ok(echo >= 0 && removed > echo);
  assert.equal(channel.frames.filter((frame) => frame.type === "connected").length, 2);
  channel.close();
});


test("the active outbox UTF-8 budget is atomic and shared by aliases; Delete frees capacity", async () => {
  hostStatus = "offline";
  const sid = "s-budget", alias = "s-budget-alias";
  const w = wrapper(sid);
  globalThis.__ompSessions.set(alias, w);
  const message = "é".repeat(2 * 1024 * 1024); // 4 MiB UTF-8, only 2 Mi UTF-16 code units
  for (let n = 0; n < 3; n++) assert.equal((await command(sid, { type: "outbox_add", id: `budget${n}`, mode: "prompt", message })).status, 200);
  const fourth = { type: "outbox_add", id: "budget3", mode: "prompt", message };
  const full = await command(alias, fourth);
  assert.equal(full.status, 429);
  assert.equal((await full.json()).code, "outbox_full");
  assert.equal(outbox.outboxEntries(alias).length, 3, "refusal did not store or truncate the payload");
  await command(alias, { type: "outbox_remove", id: "budget0" });
  assert.equal((await command(alias, fourth)).status, 200);
  assert.equal(outbox.outboxEntries(alias).length, 3);
});

test("starting a second instance leaves a live process's dispatch claim alone", async () => {
  hostStatus = "online";
  const sid = "s-other-process";
  const w = wrapper(sid, { running: true, reply: () => new Promise(() => {}) });
  await add(sid, "other1", "owned elsewhere", "followUp");
  await until(() => w.sent.length === 1, "the claim");
  // The parent really is alive, unlike an orphaned server's pid.
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET dispatch_pid = ? WHERE id = ?").run(process.ppid, "other1");
  globalThis.__ompOutbox = undefined;
  outbox.startOutbox();
  assert.deepEqual(states(sid), ["owned elsewhere:delivering"]);
  outbox.pumpOutbox(sid);
  assert.equal(w.sent.length, 1, "no second dispatch");
  // Let the next test's simulated restart recover this fixture too.
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET dispatch_pid = ? WHERE id = ?").run(process.pid, "other1");
});

test("native keepOldId migration survives restart and accepts the original old-session replay, not unrelated id reuse", async () => {
  hostStatus = "offline";
  const oldId = "native-old", newId = "native-new";
  const oldWrapper = wrapper(oldId, { running: true });
  await add(oldId, "native-entry", "moved message", "followUp");
  await until(() => states(oldId)[0] === "moved message:waiting_host", "held native message");
  oldWrapper.sessionId = newId;
  globalThis.__ompSessions.set(newId, oldWrapper); // native keepOldId, not a branch/switch
  await add(newId, "native-entry2", "second moved message", "followUp");
  assert.equal(globalThis.__ompOutboxStore.db.prepare("SELECT session_id FROM entries WHERE id = ?").get("native-entry").session_id, newId);
  outbox.closeOutboxStore();
  globalThis.__ompSessions.delete(oldId);
  globalThis.__ompSessions.delete(newId);
  const current = wrapper(newId, { running: true });
  const repeated = await (await command(oldId, { type: "outbox_add", id: "native-entry", mode: "followUp", message: "moved message" })).json();
  assert.equal(repeated.data.entry.sessionId, newId, "old target resolves the already-owned canonical entry after restart");
  assert.equal((await command("unrelated-session", { type: "outbox_add", id: "native-entry", mode: "prompt", message: "different" })).status, 409);
  hostStatus = "online";
  outbox.pumpOutbox(newId);
  await until(() => states(newId).length === 0, "canonical dispatch");
  assert.deepEqual(current.sent.map(({ message }) => message), ["moved message", "second moved message"]);
  assert.equal(oldWrapper.sent.length, 0);
});

test("ordinary branch/switch that drops the old registry key never migrates its held messages", async () => {
  hostStatus = "offline";
  const oldId = "branch-original", newId = "branch-new";
  const w = wrapper(oldId, { running: true });
  await add(oldId, "branch-old-entry", "stay in original", "followUp");
  await until(() => states(oldId)[0] === "stay in original:waiting_host", "held original");
  globalThis.__ompSessions.delete(oldId);
  w.sessionId = newId;
  globalThis.__ompSessions.set(newId, w);
  await add(newId, "branch-new-entry", "new branch", "followUp");
  assert.deepEqual(outbox.outboxEntries(newId).map(({ message }) => message), ["new branch"]);
  assert.equal(globalThis.__ompOutboxStore.db.prepare("SELECT session_id FROM entries WHERE id = ?").get("branch-old-entry").session_id, oldId);
});

test("an owner live at startup that dies later is recovered without another add or host hello", { timeout: 10_000 }, async () => {
  hostStatus = "online";
  const sid = "orphan-maintenance";
  const w = wrapper(sid, { running: true, reply: () => new Promise(() => {}) });
  await add(sid, "orphan1", "uncertain", "followUp");
  await until(() => w.sent.length === 1, "in-flight command");
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET dispatch_pid = ? WHERE id = ?").run(process.ppid, "orphan1");
  globalThis.__ompOutbox = undefined;
  outbox.startOutbox();
  assert.equal(outbox.outboxEntries(sid)[0].state, "delivering", "owner was live at startup");
  const channel = await watchChannel(sid);
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET dispatch_pid = ? WHERE id = ?").run(2147483647, "orphan1");
  for (let n = 0; n < 80 && outbox.outboxEntries(sid)[0].state !== "failed"; n++) await sleep(100);
  assert.equal(outbox.outboxEntries(sid)[0].state, "failed");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
  assert.equal(w.sent.length, 1, "maintenance never resends the unknown command");
  assert.equal(channel.frames.filter((frame) => frame.type === "outbox_update").at(-1).entries[0].state, "failed", "watchdog publishes the recovered state to existing observers");
  channel.close();
});

test("an entry in flight when the server stopped fails as may-have-been-sent at the next start", async () => {
  hostStatus = "online";
  const sid = "s-restart";
  const w = wrapper(sid, { running: true, reply: () => new Promise(() => {}) });
  await add(sid, "r1", "in flight", "followUp");
  await until(() => w.sent.length === 1, "the send");
  outbox.closeOutboxStore();
  globalThis.__ompOutbox = undefined;
  outbox.startOutbox();
  const [entry] = outbox.outboxEntries(sid);
  assert.equal(entry.state, "failed");
  assert.equal(entry.mayHaveBeenSent, true);
});

test("a host lost during the predispatch transcript read waits rather than failing or sending", async () => {
  for (const shape of ["throw", "response"]) {
    hostStatus = "online";
    const sid = `boundary-outage-${shape}`;
    const w = wrapper(sid);
    w.host = {
      ...host,
      sessionOps: { readContext: async () => {
        if (shape === "throw") throw new WebRpcError("Host dropped during boundary read", "host_offline", "refused");
        return { ok: false, status: 503, code: "host_offline", error: "Host dropped during boundary read" };
      } },
    };
    await add(sid, `boundary-${shape}`, "survive");
    await until(() => states(sid)[0] === "survive:waiting_host" || states(sid)[0] === "survive:failed", "the boundary outcome");
    assert.deepEqual(states(sid), ["survive:waiting_host"]);
    assert.equal(w.sent.length, 0);
    w.host.sessionOps.readContext = host.sessionOps.readContext;
    outbox.pumpOutbox(sid);
    await until(() => w.sent.length === 1, "delivery after link recovery");
    w.emit({ type: "message_end", message: { role: "user", content: "survive" } });
    await until(() => states(sid).length === 0, "echo hand-off");
  }
});

test("an active native skill expansion hands off its structured custom user echo", async () => {
  hostStatus = "online";
  const sid = "skill-expansion";
  const w = wrapper(sid, { reply: () => null });
  await add(sid, "skill-expanded1", "/skill:demo do it");
  await until(() => w.sent.length === 1, "native slash dispatch");
  w.emit({ type: "message_end", message: { role: "custom", attribution: "user", customType: "skill-prompt", details: { name: "other", args: "do it", prompt: "/skill:other do it" }, content: "<skill>Other instructions</skill>\nUser: do it" } });
  await sleep(10);
  assert.equal(states(sid)[0], "/skill:demo do it:delivering", "another invocation is not this command's replacement");
  w.emit({ type: "message_end", message: { role: "custom", attribution: "user", customType: "skill-prompt", details: { name: "demo", args: "do it", prompt: "/skill:demo do it" }, content: "User invoked the \"demo\" skill\n<skill>Expanded skill instructions</skill>\nUser: do it" } });
  await until(() => states(sid).length === 0, "expanded native replacement");
  await add(sid, "skill-legacy", "/skill:demo again");
  await until(() => w.sent.length === 2, "older native skill dispatch");
  w.emit({ type: "message_end", message: { role: "custom", attribution: "user", customType: "skill-prompt", content: "User invoked the \"demo\" skill\n<skill>Instructions</skill>\nUser: again" } });
  await until(() => states(sid).length === 0, "legacy native skill name and user arguments");
});

test("idle ordinary templates hand off beyond the saved boundary even when the file lags the native echo", async () => {
  hostStatus = "online";
  const sid = "ordinary-template";
  const expanded = "Template instructions expanded by omp: inspect the code";
  const w = wrapper(sid, { reply: () => null });
  let contextReads = 0;
  w.host = { ...host, sessionOps: { readContext: async (_id, _leaf, options) => {
    if (options.boundary) return { ok: true, value: { entryIds: ["saved-before"] } };
    if (contextReads++ === 0) return { ok: true, value: { entryIds: ["saved-before"], messages: [{ role: "assistant", content: "previous" }] } };
    return { ok: true, value: { entryIds: ["saved-before", "new-user"], messages: [{ role: "assistant", content: "previous" }, { role: "user", content: expanded }] } };
  } } };
  await add(sid, "template1", "/review inspect the code");
  await until(() => w.sent.length === 1, "template dispatch");
  w.emit({ type: "message_start", messageId: "template-native", message: { role: "user", content: expanded } });
  w.emit({ type: "message_end", messageId: "template-native", message: { role: "user", content: expanded } });
  await until(() => states(sid).length === 0, "persisted expanded template replacement");
  assert.ok(contextReads >= 2, "file catch-up is confirmed, not assumed from the early native frame");
});

test("a queued native template requires one new queue occurrence rather than a stale queue snapshot", async () => {
  hostStatus = "online";
  const sid = "queued-template";
  const w = wrapper(sid, { running: true, reply: () => null });
  w.queue = { steering: [], followUp: ["already queued"] };
  await add(sid, "template2", "/review inspect the code", "followUp");
  await until(() => w.sent.length === 1, "template admission");
  w.emit({ type: "queue_update", steering: [], followUp: ["already queued"] });
  await sleep(10);
  assert.equal(states(sid)[0], "/review inspect the code:delivering");
  w.emit({ type: "queue_update", steering: [], followUp: ["already queued", "Expanded native template: inspect the code"] });
  await until(() => states(sid).length === 0, "expanded native queue chip");
});

test("a dispatcher error before the claim retries on its own, without another add or host hello", { timeout: 15_000 }, async () => {
  hostStatus = "online";
  const sid = "pre-claim-error";
  const w = wrapper(sid, { running: true });
  hostStatus = "offline";
  await add(sid, "pre-claim", "retry me", "followUp");
  await until(() => states(sid)[0] === "retry me:waiting_host", "held while the host is down");
  // Unreadable stored receipts make preparation throw before the entry is claimed.
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET upload_receipts = '{' WHERE id = 'pre-claim'").run();
  hostStatus = "online";
  outbox.pumpOutbox(sid);
  await sleep(50);
  assert.deepEqual(w.sent, []);
  assert.notEqual(outbox.outboxEntries(sid)[0].state, "failed");
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET upload_receipts = NULL WHERE id = 'pre-claim'").run();
  await sleep(outbox.RETRY_MS);
  await until(() => states(sid).length === 0, "the scheduled retry delivers it");
  assert.equal(w.sent.length, 1);
});

test("omp exiting before this message's native write retries it instead of marking it possibly sent", { timeout: 15_000 }, async () => {
  hostStatus = "online";
  const sid = "exit-before-write";
  const w = wrapper(sid);
  let release;
  let reads = 0;
  const readContext = host.sessionOps.readContext;
  host.sessionOps.readContext = async () => {
    reads += 1;
    if (reads === 1) await new Promise((resolve) => { release = resolve; });
    return { ok: true, value: { entryIds: ["before-dispatch"] } };
  };
  try {
    await add(sid, "exit-first", "never written");
    await until(() => release, "claimed, reading the transcript boundary");
    assert.equal(states(sid)[0], "never written:delivering");
    w.isAlive = () => false;
    w.emit({ type: "process_exit", code: 1, signal: null });
    release();
    await until(() => states(sid)[0] === "never written:held", "not sent: held for a retry");
    assert.deepEqual(w.sent, []);
    assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, undefined);
    w.isAlive = () => true;
    await sleep(outbox.RETRY_MS);
    await until(() => w.sent.length === 1, "the retry sends it once");
    w.emit({ type: "message_end", message: { role: "user", content: "never written" } });
    await until(() => states(sid).length === 0, "delivered");
  } finally {
    host.sessionOps.readContext = readContext;
  }
});

test("omp exiting inside the command path, before the native write, still retries instead of marking it possibly sent", { timeout: 15_000 }, async () => {
  hostStatus = "online";
  const sid = "exit-in-command-path";
  const w = wrapper(sid);
  // A send fence, installed once the entry is claimed, holds the command inside runAgentCommand before the wrapper's
  // write, as attachment preparation does for an upload.
  let release;
  globalThis.__ompSendFences ??= new Map();
  const readContext = host.sessionOps.readContext;
  host.sessionOps.readContext = async () => {
    host.sessionOps.readContext = readContext;
    globalThis.__ompSendFences.set(sid, new Promise((resolve) => { release = resolve; }));
    return { ok: true, value: { entryIds: ["before-dispatch"] } };
  };
  try {
    await add(sid, "in-command", "still unsent");
    await until(() => release, "claimed and handed to the command path");
    await sleep(20);
    assert.equal(states(sid)[0], "still unsent:delivering");
    assert.deepEqual(w.sent, [], "held at the fence, before any native write");
    w.isAlive = () => false;
    w.emit({ type: "process_exit", code: 1, signal: null });
    globalThis.__ompSendFences.delete(sid);
    release();
    await until(() => states(sid)[0] === "still unsent:held", "not sent: held for a retry");
    assert.deepEqual(w.sent, []);
    assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, undefined);
    w.isAlive = () => true;
    await sleep(outbox.RETRY_MS);
    await until(() => w.sent.length === 1, "the retry sends it once");
    w.emit({ type: "message_end", message: { role: "user", content: "still unsent" } });
    await until(() => states(sid).length === 0, "delivered");
  } finally {
    host.sessionOps.readContext = readContext;
    globalThis.__ompSendFences.delete(sid);
    release?.();
  }
});

test("a host outage inside the command path, before the native write, waits for the host instead of marking it possibly sent", async () => {
  const { HostOpError } = await import("./hosts/link-protocol.ts");
  hostStatus = "online";
  const sid = "outage-in-command-path";
  const w = wrapper(sid);
  let release;
  globalThis.__ompSendFences ??= new Map();
  const readContext = host.sessionOps.readContext;
  host.sessionOps.readContext = async () => {
    host.sessionOps.readContext = readContext;
    globalThis.__ompSendFences.set(sid, new Promise((resolve) => { release = resolve; }));
    return { ok: true, value: { entryIds: ["before-dispatch"] } };
  };
  const send = w.send;
  // As an attachment op whose link drops: the wrapper stays alive, nothing is written, no delivery is reported.
  w.send = async (command) => {
    if (command.type !== "get_state") throw new HostOpError(503, "host_offline", "Test host is offline");
    return send(command);
  };
  try {
    await add(sid, "outage", "never written");
    await until(() => release, "claimed and handed to the command path");
    globalThis.__ompSendFences.delete(sid);
    release();
    await until(() => states(sid)[0] === "never written:waiting_host", "waits for the host");
    assert.deepEqual(w.sent, []);
    assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, undefined);
  } finally {
    host.sessionOps.readContext = readContext;
    globalThis.__ompSendFences.delete(sid);
    release?.();
    w.send = send;
  }
});
