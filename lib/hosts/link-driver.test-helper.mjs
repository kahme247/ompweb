// The daemon end of a host link, driven by hand, for main-server tests that
// need a linked host without running `ompweb host`. Not a test file itself.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const hub = await import("./hub.ts");
const { encodeBlobFrame, HostOpError, LINK_PROTOCOL_VERSION, SESSION_OP_PARAMS } = await import("./link-protocol.ts");
const { ProjectPathError } = await import("../project-registry.ts");
const { createHost, rotateLocalHostToken } = await import("./registry.ts");

const URL_BASE = "http://main.test/api/hosts/link";

/** One link WebSocket: its server end as Bun hands it to the hub (`LinkSocket`), and the daemon's view of it (what the
 * hub sent, in order, and `closed` once either side closed it). A close reaches the hub's `close` in a microtask. */
class TestSocket {
  constructor(data) {
    this.data = data;
    /** Text frames the hub sent that the daemon has not read yet. */
    this.frames = [];
    /** `{ code, reason }` once closed. */
    this.closed = null;
    this.waiters = [];
  }

  send(data) {
    if (this.closed) return 0;
    this.frames.push(data);
    this.wake();
    return data.length;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.wake();
    queueMicrotask(() => hub.hostLinkSocket.close(this, code, reason));
  }

  terminate() {
    this.close(1006);
  }

  wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** The daemon sends one frame: a string, or bytes for a binary frame. */
  frame(data) {
    hub.hostLinkSocket.message(this, data);
  }

  /** The hub's next message; null once the socket is closed and every frame before the close was read. */
  async next() {
    for (;;) {
      if (this.frames.length > 0) return JSON.parse(this.frames.shift());
      if (this.closed) return null;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Upgrade a link with `token`, as Bun's route would: `response` is the hub's refusal (no socket), else undefined. */
export function upgradeSocket(token) {
  let socket = null;
  const request = new Request(URL_BASE, { headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } });
  const response = hub.handleLinkUpgrade(request, (data) => {
    socket = new TestSocket(data);
    return true;
  });
  return { response, socket };
}

/** Register a host and link it. `channels`: the hello's still-running children; `hello`: fields to override. */
export async function linkHost(label, { channels = [], hello = {} } = {}) {
  const { host, token } = createHost(label);
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels, hello });
  return link;
}

/** Link this machine's daemon: the reserved `local` record. */
export async function linkLocalHost({ channels = [] } = {}) {
  const link = new LinkDriver("local", rotateLocalHostToken());
  await link.dial({ channels });
  return link;
}

/** Link this machine's daemon and run its real session ops on the current agent dir in this
 * process, as `ompweb host` does; `ops` adds or replaces ops (spawn, say). readMedia bytes do not go as a blob. */
export async function linkLocalDaemon(ops = {}, onMessage = undefined) {
  const { localHost } = await import("./local-host.ts");
  const { sessionOps } = await import("./session-ops.ts");
  const link = await linkLocalHost();
  link.serve({
    ...Object.fromEntries(Object.entries(SESSION_OP_PARAMS).map(([op, params]) => [op, (args) => sessionOps[op](...params.map((name) => args[name]))])),
    sessionFileExists: ({ path }) => localHost.sessionFileExists(path),
    invalidateSessionLists: ({ path }) => localHost.invalidateSessionLists(path) ?? null,
    ...ops,
  }, onMessage);
  return link;
}

/** The `res` error `ompweb host` sends for an op that threw (daemon.ts `answer`). */
function opFailure(error) {
  if (error instanceof HostOpError) return { status: error.status, code: error.code, message: error.message };
  // A rejected project path is a bad request.
  if (error instanceof ProjectPathError) return { status: 400, code: error.code, message: error.message };
  return { status: 500, code: "host_op_failed", message: error instanceof Error ? error.message : String(error) };
}

/** Poll `predicate` until it holds; fails after 5 s instead of hanging the test. */
export async function until(predicate, what) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A linked host's `listSessions` entry for session `id`. */
export function listedSession(id, cwd = "/w") {
  return { path: `/remote/sessions/${id}.jsonl`, id, cwd, created: "c", modified: "m", messageCount: 1, firstMessage: "hi" };
}

/** An omp child behind `link` that is past its ready: answers each command on its channel
 * (protocol v2), get_state as session `sessionId` plus `state`; a command of type `fail` is refused. */
export function ompChild(link, sessionId, { state = {}, fail = null } = {}) {
  return async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 }
      : command.type === "get_state" ? { sessionId, sessionFile: `/remote/sessions/${sessionId}.jsonl`, isStreaming: false, isCompacting: false, ...state }
        : {};
    const outcome = command.type === fail ? { success: false, error: `${fail} failed` } : { success: true, data };
    await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", id: command.id, command: command.type, ...outcome }) });
  };
}

export class LinkDriver {
  constructor(id, token) {
    this.id = id;
    this.token = token;
    /** Highest downlink seq this side has applied. */
    this.ack = 0;
    this.upSeq = 0;
    /** The hub's last `ack`: the highest uplink seq it applied. */
    this.acked = 0;
    this.socket = null;
  }

  /** Open a socket and send its hello (`hello` overrides its fields); resolves after its welcome, kept as `welcome`. */
  async dial({ channels = [], ack = this.ack, hello: overrides = {} } = {}) {
    const { response, socket } = upgradeSocket(this.token);
    assert.equal(response, undefined);
    this.socket = socket;
    const hello = { type: "hello", v: LINK_PROTOCOL_VERSION, ompVersion: "14.0.0", platform: "linux", home: "/home/u", autoApproveExtension: false, ack, channels, ...overrides };
    socket.frame(`${JSON.stringify(hello)}\n`);
    const welcome = await this.next();
    assert.equal(welcome?.type, "welcome");
    this.welcome = welcome;
  }

  /** Next message from the hub that is not a ping or an ack; null once the socket closed. */
  async next() {
    for (;;) {
      const message = await this.socket.next();
      if (message?.type === "ping") continue;
      if (message?.type === "ack") {
        this.acked = message.ack;
        continue;
      }
      if (typeof message?.seq === "number") this.ack = Math.max(this.ack, message.seq);
      return message;
    }
  }

  /** Send uplink messages in one frame after its ack line, as the daemon does; each gets the next uplink seq. */
  async post(...messages) {
    const lines = [{ type: "ack", ack: this.ack }, ...messages.map((message) => ({ ...message, seq: ++this.upSeq }))];
    // Closed under the daemon (a drop, a freeze, a newer link): the frame never goes out. A real daemon would resend it
    // after its next welcome; this driver does not.
    if (this.socket.closed) return;
    const before = this.socket.frames.length;
    this.socket.frame(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    // The hub answers each frame it applied with exactly one ack, sent before message() returns.
    const acks = this.socket.frames.slice(before).filter((sent) => JSON.parse(sent).type === "ack");
    assert.equal(acks.length, 1, "the hub did not answer the frame with one ack");
  }

  /** Answer one `req` with `value`: bytes go in a binary frame ahead of the `res`, anything else inline. */
  async answer(req, value) {
    if (value instanceof Uint8Array) {
      this.socket.frame(encodeBlobFrame(req.id, value));
      return this.post({ type: "res", id: req.id, ok: true, blob: { bytes: value.byteLength } });
    }
    return this.post({ type: "res", id: req.id, ok: true, result: value });
  }

  /** Answer every `req` from `ops[op](args)` (a throw answers failed, as the daemon does) until the socket closes; other messages go to `onMessage`. */
  serve(ops, onMessage = () => {}) {
    return (async () => {
      for (let message = await this.next(); message; message = await this.next()) {
        if (message.type !== "req" || !ops[message.op]) {
          await onMessage(message);
          continue;
        }
        let value;
        try {
          value = await ops[message.op](message.args);
        } catch (error) {
          await this.post({ type: "res", id: message.id, ok: false, error: opFailure(error) });
          continue;
        }
        await this.answer(message, value);
      }
    })();
  }

  /** The daemon's socket goes away (network drop, daemon stop). */
  drop() {
    this.socket.close(1006);
  }
}
