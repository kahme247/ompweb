import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The real worker (lib/event-stream-worker.ts, bundled as server/client-env.ts does) against the real server end
// (lib/browser-link.ts) through an in-process socket pair: each direction delivers in order on the next turn, and a
// drop loses whatever is still in flight, as a broken connection does.
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-browser-link-int-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
// No settings file: the server says ws, its default.
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { browserLink } = await import("./browser-link.ts");
const { MAX_AGENT_COMMAND_REQUEST_BYTES } = await import("./image-attachments.ts");
const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./event-stream-worker.ts", import.meta.url))], target: "browser", format: "esm" });
assert.ok(built.success, built.logs.join("\n"));
const workerSource = await built.outputs[0].text();

async function until(predicate, what, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const unref = (handle) => (handle?.unref?.(), handle);

function startWorker() {
  const sockets = [];
  class BridgeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      // Bun's ServerWebSocket for this socket: arrow functions, so `this` stays the browser's end.
      this.server = {
        data: { kind: "browser", owner: "open", link: null },
        send: (text) => {
          if (this.readyState !== 1) return 0;
          setImmediate(() => this.readyState === 1 && !this.silent && this.onmessage?.({ data: text }));
          return text.length;
        },
        close: (code, reason) => {
          if (this.readyState === 3) return;
          this.readyState = 3;
          setImmediate(() => {
            browserLink.close(this.server, code);
            this.onclose?.({ code, reason });
          });
        },
      };
      sockets.push(this);
      setImmediate(() => {
        this.readyState = 1;
        browserLink.open(this.server);
        this.onopen?.();
      });
    }
    send(text) {
      if (this.readyState === 1) setImmediate(() => this.readyState === 1 && !this.silent && browserLink.message(this.server, text));
    }
    close(code = 1005) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setImmediate(() => browserLink.close(this.server, code));
    }
    /** The network drops: what is in flight is lost and both ends see the socket close. */
    drop() {
      this.readyState = 3;
      browserLink.close(this.server, 1006);
      this.onclose?.({ code: 1006 });
    }
    /** The connection dies without a close (a phone that changed networks, a NAT that forgot it): both ends keep
     * sending into it and nothing arrives. */
    blackhole() {
      this.silent = true;
    }
  }
  class SseHello {
    constructor() {
      this.listeners = new Map();
      setImmediate(() => {
        for (const fn of this.listeners.get("mux") ?? []) fn({ data: JSON.stringify({ type: "hello", connectionId: "c0", transport: "ws" }), lastEventId: "" });
      });
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener() {}
    close() {}
  }
  const self = { onconnect: null, navigator: {}, location: { href: "http://omp.test/" } };
  vm.runInContext(workerSource, vm.createContext({
    self, EventSource: SseHello, WebSocket: BridgeSocket, URL, TextEncoder, TextDecoder, Date, JSON, Map, Set, Math, Promise,
    setTimeout: (...args) => unref(setTimeout(...args)),
    clearTimeout,
    setInterval: (...args) => unref(setInterval(...args)),
    clearInterval,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ now: Date.now() }) }),
  }));
  const received = [];
  const port = { onmessage: null, postMessage: (message) => received.push(structuredClone(message)) };
  self.onconnect({ ports: [port] });
  return { sockets, received, send: (message) => port.onmessage({ data: message }) };
}

function fakeWrapper() {
  const self = {
    advisorSpawned: false,
    sent: [],
    emit: null,
    isAlive: () => true,
    isRunning: () => false,
    isEditingHistory: () => false,
    getStreamSnapshot: () => ({ cursor: { streamId: "stream-1", sequence: 0 } }),
    onEvent(fn) {
      self.emit = fn;
      return () => (self.emit = null);
    },
    async send(command) {
      self.sent.push(command);
      return { accepted: command.type };
    },
  };
  return self;
}

test("the real worker over the real browser link: a drop resumes with every frame once and in order and no second open; an 8 MiB command goes in parts", { timeout: 20_000 }, async (t) => {
  const sessionId = "sess-integration";
  const wrapper = fakeWrapper();
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(sessionId, wrapper);
  t.after(() => globalThis.__ompSessions.delete(sessionId));
  const tab = startWorker();
  tab.send({ op: "open", id: 1, channel: { kind: "session", sessionId } });
  const frames = () => tab.received.filter((m) => m.id === 1 && m.type === "message").map((m) => JSON.parse(m.data));
  const numbers = () => frames().filter((data) => data.type === "message_end").map((data) => data.n);
  await until(() => frames().some((data) => data.type === "connected"), "the stream to open");

  for (let n = 1; n <= 50; n++) wrapper.emit({ type: "message_end", n });
  await until(() => numbers().length === 50, "the first 50 frames");
  // 51-100 are on the wire when it drops; 101-150 come while the link is down.
  for (let n = 51; n <= 100; n++) wrapper.emit({ type: "message_end", n });
  tab.sockets.at(-1).drop();
  for (let n = 101; n <= 150; n++) wrapper.emit({ type: "message_end", n });
  await until(() => numbers().length >= 150, "the resumed frames", 8000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tab.sockets.length, 2);
  assert.deepEqual(numbers(), Array.from({ length: 150 }, (_, i) => i + 1), "each frame once, in order");
  assert.deepEqual(tab.received.filter((m) => m.type === "open" || m.type === "error"), [{ id: 1, type: "open" }], "no reconnect seen by the tab");
  assert.equal(frames().filter((data) => data.type === "connected").length, 1, "no second snapshot");

  const message = "x".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES - 100);
  tab.send({ op: "cmd", n: 7, req: "big-1", sessionId, advisor: false, body: JSON.stringify({ type: "prompt", message }), type: "prompt" });
  await until(() => tab.received.some((m) => m.cmd === 7), "the 8 MiB command's reply", 15_000);
  assert.deepEqual(pick(tab.received.find((m) => m.cmd === 7), ["status", "body", "attempts"]), { status: 200, body: { success: true, data: { accepted: "prompt" } }, attempts: 1 });
  assert.equal(wrapper.sent.length, 1);
  assert.equal(wrapper.sent[0].message, message);

  tab.send({ op: "close", id: 1 });
  await until(() => wrapper.emit === null, "the subscription's release once the worker is done with the link");
});

test("the real worker over the real browser link: a command sent into a socket that died silently redials within seconds, runs once, and loses no frame", { timeout: 20_000 }, async (t) => {
  const sessionId = "sess-probe";
  const wrapper = fakeWrapper();
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(sessionId, wrapper);
  t.after(() => globalThis.__ompSessions.delete(sessionId));
  const tab = startWorker();
  tab.send({ op: "open", id: 1, channel: { kind: "session", sessionId } });
  const numbers = () => tab.received.filter((m) => m.id === 1 && m.type === "message").map((m) => JSON.parse(m.data)).filter((data) => data.type === "message_end").map((data) => data.n);
  await until(() => tab.received.some((m) => m.id === 1 && m.type === "message"), "the stream to open");
  for (let n = 1; n <= 10; n++) wrapper.emit({ type: "message_end", n });
  await until(() => numbers().length === 10, "the first 10 frames");

  tab.sockets.at(-1).blackhole();
  const sentAt = performance.now();
  tab.send({ op: "cmd", n: 1, req: "probe-1", sessionId, advisor: false, body: JSON.stringify({ type: "follow_up", message: "hi" }), type: "follow_up" });
  for (let n = 11; n <= 20; n++) wrapper.emit({ type: "message_end", n });
  await until(() => tab.received.some((m) => m.cmd === 1), "the command's reply", 10_000);
  const tookMs = performance.now() - sentAt;
  await until(() => numbers().length >= 20, "the frames sent into the dead socket");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(tab.sockets.length, 2, "one redial");
  assert.ok(tookMs >= 5_000 && tookMs < 8_000, `answered ${Math.round(tookMs)} ms after the send: the 5 s probe, not the 30 s silence check`);
  assert.deepEqual(wrapper.sent.map((command) => command.type), ["follow_up"], "omp got the command once");
  assert.deepEqual(pick(tab.received.find((m) => m.cmd === 1), ["status", "body"]), { status: 200, body: { success: true, data: { accepted: "follow_up" } } });
  assert.equal(tab.received.filter((m) => m.cmd === 1).length, 1, "answered once");
  assert.deepEqual(numbers(), Array.from({ length: 20 }, (_, i) => i + 1), "each frame once, in order");
  assert.deepEqual(tab.received.filter((m) => m.type === "open" || m.type === "error"), [{ id: 1, type: "open" }], "resumed: the tab saw no reconnect");

  tab.send({ op: "close", id: 1 });
  await until(() => wrapper.emit === null, "the subscription's release");
});

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
