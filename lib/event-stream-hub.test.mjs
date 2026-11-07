import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setImmediate } from "node:timers/promises";
import { mockBuiltin } from "../tests/mock-builtin.mjs";

// Hello reads the browserTransport setting; keep that read off the real agent dir.
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-hub-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(() => {
  closeOutboxStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { EventStreamConnection, getEventStreamConnection, broadcastBrowserTransport } = await import("./event-stream-hub.ts");
const route = await import("../app/api/events/route.ts");
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
const idleSnapshot = () => ({ cursor: { streamId: "test-stream", sequence: 0 } });

const decoder = new TextDecoder();

/** Next non-heartbeat SSE frame, with a watchdog so a missing flush fails
 * fast instead of hanging the test runner. */
async function readFrame(reader) {
  for (;;) {
    let watchdog;
    const r = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("read stalled: stream never delivered the expected frame")), 2000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    if (r.done) throw new Error("stream ended before all expected frames were read");
    const text = decoder.decode(r.value);
    if (text.startsWith(":")) continue;
    const event = /^event: (.*)$/m.exec(text)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(text)?.[1];
    return { event, data: JSON.parse(data) };
  }
}

/** Open a connection and consume its hello frame. */
async function connect(signal) {
  const connection = new EventStreamConnection(signal);
  const reader = connection.stream.getReader();
  const hello = await readFrame(reader);
  assert.equal(hello.event, "mux");
  assert.deepEqual(hello.data, { type: "hello", connectionId: connection.id, serverId: hello.data.serverId, transport: "ws" });
  return { connection, reader };
}

function withSession(id, session) {
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(id, session);
  return () => globalThis.__ompSessions.delete(id);
}

function emitterSession(onDetach = () => {}) {
  const session = {
    emit: null,
    isAlive: () => true,
    getStreamSnapshot: idleSnapshot,
    onEvent(fn) {
      session.emit = fn;
      return onDetach;
    },
  };
  return session;
}

/** Subscribe a session channel and consume its open + connected frames and its (empty) outbox snapshot. */
async function subscribeSession(connection, reader, sub, sessionId) {
  assert.deepEqual(await connection.subscribe(sub, { kind: "session", sessionId }), { ok: true });
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub } });
  const connected = await readFrame(reader);
  assert.equal(connected.event, sub);
  assert.equal(connected.data.type, "connected");
  assert.deepEqual(await readFrame(reader), { event: sub, data: { type: "outbox_update", entries: [], settledIds: [] } });
}

async function postEvents(body) {
  const res = await route.POST(new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

test("POST attaches subscriptions to a live connection and rejects unknown or malformed requests", async () => {
  const release = withSession("route-sess", emitterSession());
  const ac = new AbortController();
  const res = route.GET(new Request("http://localhost/api/events", { signal: ac.signal }), { disableIdleTimeout() {} });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  try {
    const hello = await readFrame(reader);
    const { connectionId } = hello.data;
    assert.ok(getEventStreamConnection(connectionId), "the stream registers its connection id");

    assert.deepEqual(
      await postEvents({ connectionId, subscribe: { id: "s1", channel: { kind: "session", sessionId: "route-sess" } } }),
      { status: 200, body: { ok: true } },
    );
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    assert.equal((await readFrame(reader)).data.type, "connected");

    const unmanaged = await postEvents({ connectionId, subscribe: { id: "s2", channel: { kind: "session", sessionId: "file-only" } } });
    assert.equal(unmanaged.status, 409);
    assert.equal(unmanaged.body.code, "session_not_managed");

    assert.equal((await postEvents({ connectionId, subscribe: { id: "mux", channel: { kind: "running" } } })).status, 400);
    assert.equal((await postEvents({ connectionId, subscribe: { id: "s3", channel: { kind: "bogus" } } })).status, 400);

    const unknown = await postEvents({ connectionId: "gone", subscribe: { id: "s4", channel: { kind: "running" } } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_connection");

    ac.abort();
    assert.equal(getEventStreamConnection(connectionId), undefined, "abort unregisters the connection");
    assert.equal((await postEvents({ connectionId, unsubscribe: "s1" })).body.code, "unknown_connection");
  } finally {
    await reader.cancel();
    release();
  }
});

test("session subscription unsubscribes exactly once across abort and cancel", async () => {
  let unsubscribeCount = 0;
  const release = withSession("test-sess-lifecycle", emitterSession(() => { unsubscribeCount += 1; }));
  try {
    const ac = new AbortController();
    const { connection, reader } = await connect(ac.signal);
    await subscribeSession(connection, reader, "s1", "test-sess-lifecycle");
    ac.abort();
    await reader.cancel();
    assert.equal(unsubscribeCount, 1, "RPC event listener must be unsubscribed exactly once");
    assert.equal(connection.isClosed, true);
  } finally {
    release();
  }
});

test("running subscription returns listener count to baseline on unsubscribe and on disconnect", async () => {
  globalThis.__ompRunningListeners ??= new Set();
  const baseline = globalThis.__ompRunningListeners.size;
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "running" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    assert.equal((await readFrame(reader)).data.type, "running");
    assert.equal(globalThis.__ompRunningListeners.size, baseline + 1);
    connection.unsubscribe("s1");
    assert.equal(globalThis.__ompRunningListeners.size, baseline);

    await connection.subscribe("s2", { kind: "running" });
    assert.equal(globalThis.__ompRunningListeners.size, baseline + 1);
  } finally {
    await reader.cancel();
  }
  assert.equal(globalThis.__ompRunningListeners.size, baseline, "running listeners must not leak past the connection");
});

test("a notifications subscription keeps its tab reachable until it ends; malformed client ids are refused", async () => {
  const streams = () => globalThis.__ompNotificationHub?.streams ?? new Map();
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "notifications", clientId: "tab-notify-01" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    const sends = [...streams().get("tab-notify-01") ?? []];
    assert.equal(sends.length, 1, "the tab must be reachable while its notifications subscription is open");
    const event = { type: "completed", sessionId: "s-done", sessionName: "Done" };
    sends[0]({ kind: "toast", event });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "notification", kind: "toast", event } });

    connection.unsubscribe("s1");
    assert.equal(streams().has("tab-notify-01"), false, "an ended subscription must not keep the tab reachable");

    // The id the notification hub routes by is validated before anything attaches.
    const bad = await postEvents({ connectionId: connection.id, subscribe: { id: "s2", channel: { kind: "notifications", clientId: "bad id" } } });
    assert.equal(bad.status, 400);
    assert.equal(streams().has("bad id"), false);

    await connection.subscribe("s3", { kind: "notifications", clientId: "tab-notify-02" });
    assert.equal(streams().has("tab-notify-02"), true);
  } finally {
    await reader.cancel();
  }
  assert.equal(streams().has("tab-notify-02"), false, "a dropped socket must detach its tabs");
});

test("host-tools subscription delivers cross-session calls and releases its listener", async () => {
  globalThis.__ompHostToolListeners ??= new Set();
  const listeners = globalThis.__ompHostToolListeners;
  const baseline = listeners.size;
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "host-tools" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    assert.equal(listeners.size, baseline + 1);
    const call = { sessionId: "bg-sess", id: "call-1", toolName: "open_url", arguments: { url: "https://example.com" } };
    for (const listener of listeners) listener(call);
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "host_tool_call", ...call } });

    connection.unsubscribe("s1");
    assert.equal(listeners.size, baseline);
    await connection.subscribe("s2", { kind: "host-tools" });
  } finally {
    await reader.cancel();
  }
  assert.equal(listeners.size, baseline, "host tool listeners must not leak past the connection");
});

test("subscriptions share one socket, stay separated by event name, and unsubscribe independently", async () => {
  const a = emitterSession();
  const b = emitterSession();
  const releaseA = withSession("mux-a", a);
  const releaseB = withSession("mux-b", b);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "mux-a");
    await subscribeSession(connection, reader, "s2", "mux-b");
    a.emit({ type: "agent_start" });
    b.emit({ type: "agent_end", isTerminal: true });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "agent_start" } });
    assert.deepEqual(await readFrame(reader), { event: "s2", data: { type: "agent_end", isTerminal: true } });

    connection.unsubscribe("s1");
    a.emit({ type: "message_update", message: { content: "dropped" } });
    b.emit({ type: "agent_start" });
    assert.deepEqual(await readFrame(reader), { event: "s2", data: { type: "agent_start" } });
    assert.equal(connection.subscriptionCount, 1);
  } finally {
    await reader.cancel();
    releaseA();
    releaseB();
  }
});

test("slow consumer receives a coalesced message_update on resume without a new event or heartbeat", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-resume", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-resume");
    // Consumer stalled: v1/v2 fill the queue, v3 is coalesced. Only a resumed
    // pull() can deliver it — no heartbeat yet, no new event.
    session.emit({ type: "message_update", message: { id: "m1", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m1", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m1", content: "v3" } });
    const contents = [];
    for (let i = 0; i < 3; i++) contents.push((await readFrame(reader)).data.message.content);
    assert.deepEqual(contents, ["v1", "v2", "v3"], "latest snapshot flushed exactly once on resume");
  } finally {
    await reader.cancel();
    release();
  }
});

test("multiple coalesced updates collapse to the latest snapshot (latest-wins)", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-latest", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-latest");
    for (const content of ["v1", "v2", "v3", "v4"]) {
      session.emit({ type: "message_update", message: { id: "m3", content } });
    }
    const contents = [];
    for (let i = 0; i < 3; i++) contents.push((await readFrame(reader)).data.message.content);
    assert.deepEqual(contents, ["v1", "v2", "v4"], "superseded snapshot must never reach the consumer");
  } finally {
    await reader.cancel();
    release();
  }
});

test("terminal event flushes the buffered update first and arrives last, in order", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-terminal", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-terminal");
    session.emit({ type: "message_update", message: { id: "m4", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m4", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m4", content: "v3" } });
    session.emit({ type: "agent_end", isTerminal: true });
    const order = [];
    for (let i = 0; i < 4; i++) order.push((await readFrame(reader)).data.type);
    assert.deepEqual(
      order,
      ["message_update", "message_update", "message_update", "agent_end"],
      "buffered snapshot must precede the terminal event, never the reverse",
    );
  } finally {
    await reader.cancel();
    release();
  }
});

test("backpressured disconnect with a pending update cleans up exactly once", async () => {
  let unsubscribeCount = 0;
  const session = emitterSession(() => { unsubscribeCount += 1; });
  const release = withSession("test-sess-disconnect", session);
  const ac = new AbortController();
  const { connection, reader } = await connect(ac.signal);
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-disconnect");
    session.emit({ type: "message_update", message: { id: "m2", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m2", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m2", content: "v3" } });
    ac.abort();
  } finally {
    await reader.cancel();
    release();
  }
  assert.equal(unsubscribeCount, 1, "unsubscribe must fire exactly once across abort+cancel");
});

test("session subscription captures events before sampling its connected cursor", async () => {
  let listener;
  let sequence = 0;
  let detachCount = 0;
  const release = withSession("subscribe-before-snapshot", {
    isAlive: () => true,
    onEvent(callback) {
      listener = callback;
      callback({ type: "extension_ui_request", id: "pending-dialog", method: "input", web: { streamId: "epoch", sequence: ++sequence } });
      return () => { detachCount += 1; };
    },
    getStreamSnapshot() {
      // A frame arriving exactly at the handoff is observable only if the
      // listener is already attached, rather than after connected is queued.
      listener?.({ type: "message_update", message: { role: "assistant", content: "handoff" }, web: { streamId: "epoch", sequence: ++sequence } });
      return { cursor: { streamId: "epoch", sequence } };
    },
  });
  const { connection, reader } = await connect();
  try {
    await connection.subscribe("s1", { kind: "session", sessionId: "subscribe-before-snapshot" });
    const frames = [];
    for (let i = 0; i < 4; i++) frames.push(await readFrame(reader));
    assert.deepEqual(frames[0], { event: "mux", data: { type: "open", sub: "s1" } });
    assert.deepEqual(frames.slice(1).map((frame) => frame.data.type), ["extension_ui_request", "message_update", "connected"]);
    assert.equal(frames[2].data.message.content, "handoff");
    assert.deepEqual(frames[3].data.web, { streamId: "epoch", sequence: 2 });
  } finally {
    await reader.cancel();
    release();
  }
  assert.equal(detachCount, 1);
});

test("an unserializable UI replay ends only its own subscription and releases it", async () => {
  let detachCount = 0;
  const releaseBroken = withSession("failed-ui-replay", {
    isAlive: () => true,
    getStreamSnapshot: idleSnapshot,
    onEvent(listener) {
      const circular = { type: "extension_ui_request" };
      circular.self = circular;
      listener(circular);
      return () => { detachCount += 1; };
    },
  });
  const healthy = emitterSession();
  const releaseHealthy = withSession("healthy", healthy);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "healthy");
    await connection.subscribe("s2", { kind: "session", sessionId: "failed-ui-replay" });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s2" } });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "end", sub: "s2" } });
    assert.equal(detachCount, 1);

    healthy.emit({ type: "agent_start" });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "agent_start" } }, "the shared socket survives");
  } finally {
    await reader.cancel();
    releaseBroken();
    releaseHealthy();
  }
});

test("session channel observes a quiet real wrapper and refuses file-only sessions", async () => {
  const id = "quiet-wrapper";
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame: () => () => {},
    sendFrame() {},
    sendCommand: async () => { throw new Error("an observer must not send RPC commands"); },
    dispose: async () => {},
  }, process.cwd());
  const release = withSession(id, wrapper);
  const { connection, reader } = await connect();
  try {
    await connection.subscribe("s1", { kind: "session", sessionId: id });
    await readFrame(reader); // open
    const connected = await readFrame(reader);
    assert.equal(connected.data.type, "connected");
    assert.deepEqual(connected.data.web, wrapper.getStreamSnapshot().cursor);
    const absent = await connection.subscribe("s2", { kind: "session", sessionId: "file-only" });
    assert.equal(absent.ok, false);
    assert.equal(absent.status, 409);
    assert.equal(connection.subscriptionCount, 1, "a refused subscription is not retained");
  } finally {
    await reader.cancel();
    await wrapper.destroyAndWait();
    release();
  }
});

test("file channel enforces the allow-list and reports content changes", { timeout: 10000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-event-stream-"));
  const previousRoots = globalThis.__piAllowedRootsCache;
  let reader;
  t.after(async () => {
    try {
      await reader?.cancel();
    } finally {
      globalThis.__piAllowedRootsCache = previousRoots;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const watched = path.join(allowed, "notes.txt");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(watched, "one");
  const initialMtime = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(watched, initialMtime, initialMtime);
  fs.writeFileSync(secret, "secret");
  globalThis.__piAllowedRootsCache = { roots: new Set([allowed]), expiresAt: Date.now() + 60_000 };
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());
  await getHost("local").sessionOps.validateCwd(allowed);
  const nativeWatch = fs.watch;
  let fileWatcher;
  await mockBuiltin(t, "node:fs", {
    watch: (...args) => {
      fileWatcher = nativeWatch(...args);
      return fileWatcher;
    },
  });
  const connected = await connect();
  const { connection } = connected;
  reader = connected.reader;

  const denied = await connection.subscribe("s1", { kind: "file", path: secret, sessionId: null });
  assert.deepEqual([denied.status, denied.code], [403, "access_denied"]);
  const missing = await connection.subscribe("s2", { kind: "file", path: path.join(allowed, "gone.txt"), sessionId: null });
  assert.deepEqual([missing.status, missing.code], [404, "file_not_found"]);
  const directory = await connection.subscribe("s3", { kind: "file", path: allowed, sessionId: null });
  assert.deepEqual([directory.status, directory.code], [400, "not_a_file"]);

  assert.deepEqual(await connection.subscribe("s4", { kind: "file", path: watched, sessionId: null }), { ok: true });
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s4" } });
  assert.equal((await readFrame(reader)).data.type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");

  // A connected frame means fs.watch was created, not that its native backend
  // has registered the file. Observe a real event before the content change.
  // These identical-content probes restore the exact stat key, so they cannot
  // enqueue viewer change frames or be mistaken for the assertion below.
  assert.ok(fileWatcher, "the allowed file has a native watcher");
  let nativeReady = false;
  const onNativeChange = () => { nativeReady = true; };
  fileWatcher.once("change", onNativeChange);
  try {
    while (!nativeReady) {
      fs.writeFileSync(watched, "one");
      fs.utimesSync(watched, initialMtime, initialMtime);
      await setImmediate(undefined, { signal: t.signal });
    }
  } finally {
    fileWatcher.removeListener("change", onNativeChange);
  }
  // Bun drops a native event that follows the previous one within a few milliseconds.
  await new Promise((resolve) => setTimeout(resolve, 50));

  fs.writeFileSync(watched, "one two");
  const change = await readFrame(reader);
  assert.equal(change.event, "s4");
  assert.equal(change.data.type, "change");
  assert.equal(change.data.size, 7);
});

test("file channel re-checks the file after a watch event, so a save whose event was dropped still reports", async (t) => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-event-stream-"));
  const previousRoots = globalThis.__piAllowedRootsCache;
  let reader;
  t.after(async () => {
    try {
      await reader?.cancel();
    } finally {
      globalThis.__piAllowedRootsCache = previousRoots;
      fs.rmSync(allowed, { recursive: true, force: true });
    }
  });
  const watched = path.join(allowed, "notes.txt");
  fs.writeFileSync(watched, "one");
  globalThis.__piAllowedRootsCache = { roots: new Set([allowed]), expiresAt: Date.now() + 60_000 };
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());
  await getHost("local").sessionOps.validateCwd(allowed);
  // Bun's fs.watch drops an event that follows the previous one within ~2 ms;
  // a fake watcher makes that drop deterministic.
  let emitWatchEvent;
  await mockBuiltin(t, "node:fs", {
    watch: (_file, listener) => {
      emitWatchEvent = listener;
      return { on() {}, close() {} };
    },
  });
  const connected = await connect();
  reader = connected.reader;
  assert.deepEqual(await connected.connection.subscribe("s1", { kind: "file", path: watched, sessionId: null }), { ok: true });
  assert.equal((await readFrame(reader)).data.type, "open");
  assert.equal((await readFrame(reader)).data.type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");

  fs.writeFileSync(watched, "one two");
  emitWatchEvent("change");
  fs.writeFileSync(watched, "one two three"); // its event is dropped
  assert.equal((await readFrame(reader)).data.size, 13);
});

test("file channel watches a session's own local:// artifact through its host's daemon and nobody else's", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-event-stream-local-")));
  const previousRoots = globalThis.__piAllowedRootsCache;
  const releases = [];
  let reader;
  t.after(async () => {
    try {
      await reader?.cancel();
    } finally {
      for (const release of releases) release();
      globalThis.__piAllowedRootsCache = previousRoots;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  // Three sessions of this machine with real session files; their local/ directories lie in no allowed root.
  const { sessionOps } = await import("./hosts/session-ops.ts");
  const { cacheSessionPath } = await import("./session-reader.ts");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const sessionIds = ["11111111-2222-4333-8444-5555555555a1", "11111111-2222-4333-8444-5555555555b2", "11111111-2222-4333-8444-5555555555c3"];
  const sessions = sessionIds.map((id, index) => {
    const dir = path.join(base, "custom-sessions", `2026-01-01_${index}`);
    const file = `${dir}.jsonl`;
    fs.mkdirSync(path.join(dir, "local"), { recursive: true });
    fs.writeFileSync(file, [
      { type: "session", version: 3, id, cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    // The daemon learned this file when omp resumed it from outside its sessions directory.
    cacheSessionPath(id, file);
    return { id, file, local: path.join(dir, "local"), entry: { path: file, id, cwd: workspace, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "hi" } };
  });
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon({ listSessions: async () => [...await sessionOps.listSessions(), ...sessions.map((session) => session.entry)] });
  t.after(() => daemon.drop());
  // Only the first two are running here: each wrapper names its own file, as omp reported it.
  for (const session of sessions.slice(0, 2)) {
    releases.push(withSession(session.id, { isAlive: () => true, host: getHost("local"), sessionFile: session.file, sessionId: session.id }));
  }
  const watched = path.join(sessions[0].local, "draft.md");
  const idle = path.join(sessions[2].local, "idle.md");
  const outside = path.join(base, "outside.txt");
  fs.writeFileSync(watched, "one");
  fs.writeFileSync(idle, "idle");
  fs.writeFileSync(outside, "outside secret");
  const outsideTime = new Date("2001-02-03T04:05:06.000Z");
  fs.utimesSync(outside, outsideTime, outsideTime);
  globalThis.__piAllowedRootsCache = { roots: new Set([workspace]), expiresAt: Date.now() + 60_000 };
  // A fake watcher keeps the change event deterministic (Bun drops an event within ~2 ms of the previous one).
  let emitWatchEvent;
  await mockBuiltin(t, "node:fs", {
    watch: (_file, listener) => {
      emitWatchEvent = listener;
      return { on() {}, close() {} };
    },
  });
  const connected = await connect();
  reader = connected.reader;

  // Another session's tab, no session, and a session no host has: nothing of the file is watched.
  for (const [index, sessionId, status, code] of [
    [1, sessionIds[1], 403, "access_denied"],
    [2, null, 403, "access_denied"],
    [3, "not-a-session-id", 404, "session_not_found"],
    [4, "11111111-2222-4333-8444-5555555555dd", 404, "session_not_found"],
  ]) {
    const denied = await connected.connection.subscribe(`d${index}`, { kind: "file", path: watched, sessionId });
    assert.deepEqual([denied.status, denied.code], [status, code], `session ${sessionId}`);
  }
  assert.deepEqual(await connected.connection.subscribe("s1", { kind: "file", path: watched, sessionId: sessionIds[0] }), { ok: true });
  assert.equal((await readFrame(reader)).data.type, "open");
  assert.equal((await readFrame(reader)).data.type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");
  fs.writeFileSync(watched, "one two");
  emitWatchEvent("change");
  const change = await readFrame(reader);
  assert.equal(change.event, "s1");
  assert.deepEqual([change.data.type, change.data.size], ["change", 7]);

  // The path swapped for a link out of the session's local directory: the daemon's gate refuses it again at the event.
  fs.unlinkSync(watched);
  fs.symlinkSync(outside, watched);
  emitWatchEvent("change");
  const swapped = await readFrame(reader);
  assert.deepEqual([swapped.event, swapped.data.type], ["s1", "error"]);
  assert.equal(JSON.stringify(swapped).includes(outsideTime.toISOString()), false, "nothing of the outside file is reported");
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "end", sub: "s1" } });

  // A session that is not running here is still found by the daemon's own index.
  assert.deepEqual(await connected.connection.subscribe("s3", { kind: "file", path: idle, sessionId: sessionIds[2] }), { ok: true });
  assert.equal((await readFrame(reader)).data.type, "open");
  assert.equal((await readFrame(reader)).data.type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");
  fs.writeFileSync(idle, "idle edit");
  emitWatchEvent("change");
  const idleChange = await readFrame(reader);
  assert.deepEqual([idleChange.event, idleChange.data.type, idleChange.data.size], ["s3", "change", 9]);
});

test("file channel never reports the stat of a path that was swapped for a link out of its authorized file", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-event-stream-swap-")));
  const previousRoots = globalThis.__piAllowedRootsCache;
  let reader;
  t.after(async () => {
    try {
      await reader?.cancel();
    } finally {
      globalThis.__piAllowedRootsCache = previousRoots;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const watched = path.join(allowed, "notes.txt");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(watched, "one");
  fs.writeFileSync(secret, "outside secret");
  const secretTime = new Date("2001-02-03T04:05:06.000Z");
  fs.utimesSync(secret, secretTime, secretTime);
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());
  assert.equal((await getHost("local").sessionOps.validateCwd(allowed)).ok, true);
  // A fake watcher keeps each event deterministic (Bun drops an event within ~2 ms of the previous one).
  let emitWatchEvent;
  await mockBuiltin(t, "node:fs", {
    watch: (_file, listener) => {
      emitWatchEvent = listener;
      return { on() {}, close() {} };
    },
  });
  const connected = await connect();
  reader = connected.reader;
  const watch = async (sub, file) => {
    assert.deepEqual(await connected.connection.subscribe(sub, { kind: "file", path: file, sessionId: null }), { ok: true });
    assert.equal((await readFrame(reader)).data.type, "open");
    return (await readFrame(reader)).data;
  };
  assert.equal((await watch("s1", watched)).type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");
  const next = async () => {
    emitWatchEvent("change");
    const frame = await readFrame(reader);
    assert.equal(frame.data.type, "change");
    return frame.data;
  };

  // An editor's save (a new file renamed over the path) is still the authorized file: it reports normally.
  fs.writeFileSync(`${watched}.tmp`, "one two three");
  fs.renameSync(`${watched}.tmp`, watched);
  assert.equal((await next()).size, 13);

  // The pathname swapped for a link to a file outside the allowed root: the daemon's gate refuses it at the event, so
  // nothing of that file is reported and the channel ends.
  fs.unlinkSync(watched);
  fs.symlinkSync(secret, watched);
  emitWatchEvent("change");
  const swapped = await readFrame(reader);
  assert.deepEqual([swapped.event, swapped.data.type], ["s1", "error"]);
  assert.equal(JSON.stringify(swapped).includes(secretTime.toISOString()), false, "the outside file's mtime is not reported");
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "end", sub: "s1" } });

  // Put the authorized file back: a new watch of it reports again.
  fs.unlinkSync(watched);
  fs.writeFileSync(watched, "back");
  const reopened = await watch("s2", watched);
  assert.deepEqual([reopened.type, reopened.size], ["change", 4]);
  assert.equal((await readFrame(reader)).data.type, "connected");
  connected.connection.unsubscribe("s2");
  const linked = path.join(allowed, "linked.txt");
  fs.symlinkSync(watched, linked);
  assert.equal((await watch("s3", linked)).type, "change");
  assert.equal((await readFrame(reader)).data.type, "connected");
  fs.writeFileSync(watched, "linked edit");
  assert.equal((await next()).size, 11, "an authorized in-root symlink still reports edits");
});

test("hosts subscription sends the host list on subscribe and after every change, then releases its listener", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-hosts-channel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const hub = await import("./hosts/hub.ts");
  const { createHost } = await import("./hosts/registry.ts");
  hub.onHostsChange(() => {})(); // creates the hub state on globalThis
  const listeners = () => globalThis.__ompHostHub.changeListeners;
  const baseline = listeners().size;
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "hosts" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    const initial = await readFrame(reader);
    assert.equal(initial.event, "s1");
    assert.deepEqual(initial.data.hosts.map((h) => h.id), ["local"]);
    assert.equal(listeners().size, baseline + 1);

    const { host } = createHost("laptop");
    hub.notifyHostsChange();
    const changed = await readFrame(reader);
    assert.deepEqual(changed.data.hosts.map((h) => h.id), ["local", host.id]);

    connection.unsubscribe("s1");
    assert.equal(listeners().size, baseline);
  } finally {
    await reader.cancel();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("hello names the connection, the same serverId for every connection, and the transport", async () => {
  const a = new EventStreamConnection();
  const b = new EventStreamConnection();
  try {
    const helloA = await readFrame(a.stream.getReader());
    const helloB = await readFrame(b.stream.getReader());
    assert.deepEqual(helloA.data, { type: "hello", connectionId: a.id, serverId: helloA.data.serverId, transport: "ws" });
    assert.equal(typeof helloA.data.serverId, "string");
    assert.equal(helloB.data.serverId, helloA.data.serverId);
    assert.notEqual(helloB.data.connectionId, helloA.data.connectionId);
  } finally {
    a.close();
    b.close();
  }
});

test("hello carries transport sse when sse is stored", async () => {
  const { saveWebServerSettings } = await import("./web-settings.ts");
  saveWebServerSettings({ browserTransport: "sse" });
  const connection = new EventStreamConnection();
  try {
    assert.equal((await readFrame(connection.stream.getReader())).data.transport, "sse");
  } finally {
    connection.close();
    saveWebServerSettings({ browserTransport: "ws" });
  }
});

test("every SSE frame carries its emit time as id", async () => {
  const { connection, reader } = await connect();
  try {
    const before = Date.now();
    assert.deepEqual(await connection.subscribe("s1", { kind: "hosts" }), { ok: true });
    const chunks = [];
    for (let i = 0; i < 2; i++) {
      const r = await reader.read();
      chunks.push(decoder.decode(r.value));
    }
    const after = Date.now();
    assert.match(chunks[0], /^event: mux\n/);
    assert.match(chunks[1], /^event: s1\n/);
    for (const chunk of chunks) {
      const id = Number(/^id: (\d+)$/m.exec(chunk)?.[1]);
      assert.ok(id >= before && id <= after, `id ${id} outside [${before}, ${after}]`);
    }
  } finally {
    await reader.cancel();
  }
});

test("broadcastBrowserTransport reaches every open connection", async () => {
  const a = await connect();
  const b = await connect();
  try {
    broadcastBrowserTransport({ transport: "ws" });
    for (const { reader } of [a, b]) {
      assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "transport", transport: "ws" } });
    }
  } finally {
    await a.reader.cancel();
    await b.reader.cancel();
  }
});

test("a sink connection writes name/at/data, coalesces while backpressured and flushes on resume", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const writes = [];
  let behind = false;
  let beats = 0;
  const sink = {
    heartbeatMs: 1000,
    write(name, at, data) { writes.push({ name, at, data: JSON.parse(data) }); return true; },
    backpressured: () => behind,
    heartbeat() { beats += 1; return true; },
    close() {},
  };
  const session = emitterSession();
  const release = withSession("sink-sess", session);
  const connection = new EventStreamConnection(undefined, sink);
  try {
    assert.equal(connection.stream, null);
    assert.equal(writes[0].name, "mux");
    assert.equal(writes[0].data.type, "hello");
    assert.equal(typeof writes[0].at, "number");
    assert.deepEqual(await connection.subscribe("s1", { kind: "session", sessionId: "sink-sess" }), { ok: true });
    writes.length = 0;

    behind = true;
    const emitTimes = [];
    for (const content of ["v1", "v2", "v3"]) {
      emitTimes.push(Date.now());
      session.emit({ type: "message_update", message: { id: "m1", content } });
      t.mock.timers.tick(10);
    }
    t.mock.timers.tick(10);
    assert.deepEqual(writes, [], "nothing is written while the peer is behind");
    behind = false;
    connection.resume();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].name, "s1");
    assert.equal(writes[0].data.message.content, "v3");
    assert.equal(writes[0].at, emitTimes[2], "a coalesced update keeps the emit time of the latest frame, not the flush time");
    connection.resume();
    assert.equal(writes.length, 1, "a flushed update is not written twice");

    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    assert.equal(beats, 2);
  } finally {
    connection.close();
    release();
  }
});

test("a sink that refuses a write closes the connection", async () => {
  let closed = 0;
  const sink = { heartbeatMs: 1000, write: () => false, backpressured: () => false, heartbeat: () => true, close() { closed += 1; } };
  const connection = new EventStreamConnection(undefined, sink);
  assert.equal(connection.isClosed, true);
  assert.equal(closed, 1);
});

/** A sink connection subscribed to `sessionId`, and what it writes. */
async function sinkSubscription(sessionId) {
  const writes = [];
  const sink = {
    behind: false,
    heartbeatMs: 60_000,
    write(name, at, data) { writes.push({ name, at, data: JSON.parse(data) }); return true; },
    backpressured: () => sink.behind,
    heartbeat: () => true,
    close() {},
  };
  const session = emitterSession();
  const release = withSession(sessionId, session);
  const connection = new EventStreamConnection(undefined, sink);
  assert.deepEqual(await connection.subscribe("s1", { kind: "session", sessionId }), { ok: true });
  writes.length = 0;
  return { sink, session, connection, writes, done: () => { connection.close(); release(); } };
}

const deltaFrame = (sequence, type, contentIndex, extra = {}, messageId = "msg-1") => ({
  type: "message_update", messageId, message: { role: "assistant" },
  assistantMessageEvent: { type, contentIndex, ...extra }, web: { streamId: "s", sequence },
});

test("while the peer is behind, deltas of one block merge and no delta is lost or reordered", async () => {
  const { sink, session, connection, writes, done } = await sinkSubscription("delta-sink");
  try {
    sink.behind = true;
    session.emit(deltaFrame(1, "text_start", 0, { block: { type: "text", text: "" } }));
    session.emit(deltaFrame(2, "text_delta", 0, { delta: "hel" }));
    session.emit(deltaFrame(3, "text_delta", 0, { delta: "lo" }));
    session.emit(deltaFrame(4, "text_end", 0, { content: "hello" }));
    session.emit(deltaFrame(5, "toolcall_start", 1, { block: { type: "toolCall", id: "c", name: "read", arguments: {} } }));
    session.emit(deltaFrame(6, "toolcall_delta", 1, { delta: '{"pa' }));
    session.emit(deltaFrame(7, "toolcall_delta", 1, { delta: 'th":"a"}' }));
    session.emit(deltaFrame(8, "text_delta", 2, { delta: "x" }));
    session.emit(deltaFrame(9, "text_delta", 3, { delta: "y" }));
    session.emit(deltaFrame(10, "text_delta", 2, { delta: "z" }));
    assert.deepEqual(writes, []);
    sink.behind = false;
    connection.resume();
    assert.deepEqual(writes.map(({ data }) => [data.web.sequence, data.assistantMessageEvent.type, data.assistantMessageEvent.delta]), [
      [1, "text_start", undefined],
      [3, "text_delta", "hello"],
      [4, "text_end", undefined],
      [5, "toolcall_start", undefined],
      [7, "toolcall_delta", '{"path":"a"}'],
      [8, "text_delta", "x"],
      [9, "text_delta", "y"],
      [10, "text_delta", "z"],
    ]);
  } finally {
    done();
  }
});

test("while the peer is behind, a whole message replaces the queued updates of that message only", async () => {
  const { sink, session, connection, writes, done } = await sinkSubscription("full-sink");
  try {
    sink.behind = true;
    session.emit(deltaFrame(1, "text_delta", 0, { delta: "other" }, "msg-0"));
    session.emit(deltaFrame(2, "text_delta", 0, { delta: "a" }));
    session.emit({ type: "message_update", messageId: "msg-1", message: { role: "assistant", content: [{ type: "text", text: "ab" }] }, web: { streamId: "s", sequence: 3 } });
    session.emit(deltaFrame(4, "text_delta", 0, { delta: "c" }));
    session.emit({ type: "message_end", messageId: "msg-1", message: { role: "assistant", content: [{ type: "text", text: "abc" }] }, web: { streamId: "s", sequence: 5 } });
    assert.deepEqual(writes.map(({ data }) => data.web.sequence), [1, 3, 4, 5], "a non-update frame writes the queue first, in order");
    sink.behind = false;
    connection.resume();
    assert.equal(writes.length, 4);
  } finally {
    done();
  }
});

test("outbox snapshots wait through backpressured heartbeats and resumes, keeping the latest settled ids", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const { sink, session, connection, writes, done } = await sinkSubscription("outbox-heartbeat");
  try {
    sink.behind = true;
    for (const id of ["old", "latest"]) {
      session.emit({ type: "outbox_update", entries: [{ id }], settledIds: [`settled-${id}`] });
      connection.resume();
      t.mock.timers.tick(60_000);
    }
    assert.deepEqual(writes, [], "heartbeat and premature resume must not hand snapshots to a still-behind sink");
    sink.behind = false;
    connection.resume();
    assert.deepEqual(writes.map(({ data }) => data), [
      { type: "outbox_update", entries: [{ id: "latest" }], settledIds: ["settled-latest"] },
    ]);
    assert.equal(writes[0].at, 1_060_000);
    connection.resume();
    assert.equal(writes.length, 1);
  } finally {
    done();
  }
});

test("outbox replacement never crosses native updates or hides held status before its echo", async () => {
  const { sink, session, connection, writes, done } = await sinkSubscription("outbox-fences");
  try {
    sink.behind = true;
    const held = { type: "outbox_update", entries: [{ id: "held" }], settledIds: [] };
    session.emit(held);
    session.emit({ type: "message_update", message: { content: "first" }, web: { streamId: "s", sequence: 1 } });
    session.emit({ type: "message_update", message: { content: "latest" }, web: { streamId: "s", sequence: 2 } });
    session.emit({ type: "outbox_update", entries: [{ id: "held" }, { id: "next" }], settledIds: ["older"] });
    session.emit({ type: "message_end", message: { role: "user", content: "echo" }, web: { streamId: "s", sequence: 3 } });
    session.emit({ type: "outbox_update", entries: [], settledIds: ["held", "next"] });
    assert.deepEqual(writes.map(({ data }) => data), [
      held,
      { type: "message_update", message: { content: "latest" }, web: { streamId: "s", sequence: 2 } },
      { type: "outbox_update", entries: [{ id: "held" }, { id: "next" }], settledIds: ["older"] },
      { type: "message_end", message: { role: "user", content: "echo" }, web: { streamId: "s", sequence: 3 } },
    ], "native frames fence replacement; held entries remain visible until the echo");
    sink.behind = false;
    connection.resume();
    assert.deepEqual(writes.at(-1).data, { type: "outbox_update", entries: [], settledIds: ["held", "next"] });
  } finally {
    done();
  }
});

test("a resume stops before serializing the next pending snapshot when its first write fills the sink", async () => {
  const { sink, session, connection, writes, done } = await sinkSubscription("outbox-partial-resume");
  try {
    sink.behind = true;
    session.emit({ type: "outbox_update", entries: [{ id: "before" }], settledIds: [] });
    session.emit(deltaFrame(1, "text_delta", 0, { delta: "fence" }));
    session.emit({ type: "outbox_update", entries: [{ id: "after" }], settledIds: ["settled"] });
    const write = sink.write;
    sink.write = (...args) => { const ok = write(...args); sink.behind = true; return ok; };
    for (let count = 1; count <= 3; count++) {
      sink.behind = false;
      connection.resume();
      assert.equal(writes.length, count, "each resume only fills the sink once");
    }
    assert.deepEqual(writes.map(({ data }) => data.type), ["outbox_update", "message_update", "outbox_update"]);
    assert.deepEqual(writes.at(-1).data.settledIds, ["settled"]);
  } finally {
    done();
  }
});

test("a fresh outbox snapshot replaces the pending one when capacity returns before resume", async () => {
  const { sink, session, writes, done } = await sinkSubscription("outbox-fresh-capacity");
  try {
    sink.behind = true;
    session.emit({ type: "outbox_update", entries: [{ id: "old" }], settledIds: [] });
    sink.behind = false;
    session.emit({ type: "outbox_update", entries: [{ id: "new" }], settledIds: ["old"] });
    assert.deepEqual(writes.map(({ data }) => data), [
      { type: "outbox_update", entries: [{ id: "new" }], settledIds: ["old"] },
    ], "capacity becoming available must not send an already-obsolete pending snapshot");
  } finally {
    done();
  }
});
