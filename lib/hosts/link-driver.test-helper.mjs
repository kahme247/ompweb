// The daemon end of a host link, driven by hand, for main-server tests that
// need a linked host without running `ompweb host`. Not a test file itself.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const hub = await jiti.import("./hub.ts");
const { HostOpError, LINK_ACK_HEADER, LINK_HELLO_HEADER, LINK_NONCE_HEADER, LINK_PROTOCOL_VERSION, SESSION_OP_PARAMS } = await jiti.import("./link-protocol.ts");
const { ProjectPathError } = await jiti.import("../project-registry.ts");
const { createHost, rotateLocalHostToken } = await jiti.import("./registry.ts");

const URL_BASE = "http://main.test/api/hosts/link";

/** Register a host and link it. `channels`: the hello's still-running children. */
export async function linkHost(label, { channels = [] } = {}) {
  const { host, token } = createHost(label);
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels });
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
  const { localHost } = await jiti.import("./local-host.ts");
  const { sessionOps } = await jiti.import("./session-ops.ts");
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
    this.reader = null;
    this.buffer = "";
  }

  /** POST a hello, then GET the downlink with its id; resolves after its welcome. */
  async dial({ channels = [], ack = this.ack } = {}) {
    const hello = { type: "hello", v: LINK_PROTOCOL_VERSION, ompVersion: "14.0.0", platform: "linux", home: "/home/u", autoApproveExtension: false, ack, channels };
    const offered = await hub.handleLinkPost(new Request(URL_BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, [LINK_HELLO_HEADER]: "1" },
      body: JSON.stringify(hello),
    }));
    assert.equal(offered.status, 200);
    const response = await hub.handleLinkGet(new Request(URL_BASE, {
      headers: { authorization: `Bearer ${this.token}`, [LINK_HELLO_HEADER]: (await offered.json()).helloId },
    }));
    assert.equal(response.status, 200);
    this.reader = response.body.getReader();
    this.buffer = "";
    const welcome = await this.next();
    assert.equal(welcome.type, "welcome");
    this.nonce = welcome.nonce;
  }

  /** Next downlink message that is not a ping; null once the stream ended. */
  async next() {
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index !== -1) {
        const message = JSON.parse(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        if (message.type === "ping") continue;
        if (typeof message.seq === "number") this.ack = Math.max(this.ack, message.seq);
        return message;
      }
      const { done, value } = await this.reader.read();
      if (done) return null;
      this.buffer += new TextDecoder().decode(value);
    }
  }

  headers() {
    return { authorization: `Bearer ${this.token}`, [LINK_ACK_HEADER]: String(this.ack), [LINK_NONCE_HEADER]: this.nonce };
  }

  /** POST uplink messages; each gets the next uplink seq. */
  async post(...messages) {
    const body = messages.map((message) => `${JSON.stringify({ ...message, seq: ++this.upSeq })}\n`).join("");
    const response = await hub.handleLinkPost(new Request(URL_BASE, { method: "POST", headers: this.headers(), body }));
    assert.equal(response.status, 200);
  }

  /** Answer one `req` with `value`: bytes go through the blob leg, anything else inline. */
  async answer(req, value) {
    if (value instanceof Uint8Array) {
      const blob = await hub.handleLinkBlob(new Request(`${URL_BASE}/blob/${req.id}`, { method: "POST", headers: this.headers(), body: value }), req.id);
      assert.equal(blob.status, 200);
      return this.post({ type: "res", id: req.id, ok: true, blob: { bytes: value.byteLength } });
    }
    return this.post({ type: "res", id: req.id, ok: true, result: value });
  }

  /** Answer every `req` from `ops[op](args)` (a throw answers failed, as the daemon does) until the downlink ends; other messages go to `onMessage`. */
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

  /** The daemon's side of the downlink goes away (network drop, daemon stop). */
  drop() {
    return this.reader.cancel();
  }
}
