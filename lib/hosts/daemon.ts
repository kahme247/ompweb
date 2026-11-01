// `ompweb host` (spec "Daemon"): links this machine to a main omp-web, runs
// the omp children it asks for and answers host ops with this machine's files.
// bin/omp-web-host.js loads it through jiti: no `next/*` or `@/` imports.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getOmpVersion } from "../omp/omp-cli";
import { getSessionsDir } from "../omp/paths";
import type { RpcTransport } from "../omp/rpc-transport";
import { readSessionHeaderSync } from "../omp/session-files";
import { ProjectPathError } from "../project-registry";
import { isRecord } from "../type-guards";
import { isLoopbackHost, readHostLogin } from "./host-login";
import {
  decodeDown,
  encodeLine,
  encodeQueued,
  HostOpError,
  isHostOp,
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
  LinkLimitError,
  LinkProtocolError,
  LinkSender,
  Outbox,
  PartJoiner,
  SeqWindow,
  SESSION_OP_PARAMS,
  type DownMessage,
  type SendItem,
  type UnknownMessage,
  UnknownMessageLog,
  type Unsequenced,
  type UpMessage,
} from "./link-protocol";
import { localHost, resolveSpawnCwdResult } from "./local-host";
import { PendingRequests } from "./pending-requests";
import { sessionOps } from "./session-ops";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
// This machine's web server is back within seconds of a restart.
const LOOPBACK_MAX_RETRY_MS = 3_000;
/** Children still running this long after SIGTERM get SIGKILL. */
const KILL_GRACE_MS = 5_000;
const PONG_LINE = encodeLine({ type: "pong" });
/** Frames go to the socket only while it buffers less than this (spec D7): a small message waits behind little. */
const SEND_BUFFER_BYTES = 2 * LINK_LIMITS.pieceBytes;

interface Channel {
  transport: RpcTransport;
  /** Where the child was spawned: a restarted main adopts it there. */
  cwd: string;
  /** Bytes of this child's output waiting for an uplink ack. */
  buffered: number;
  /** Open blocking requests and the child's current session, both in the next hello. */
  pending: PendingRequests;
}

/** An uplink line sent and not acked yet. */
interface Queued {
  seq: number;
  line: string;
  /** The `LinkSender` key it went out under: its channel, or the request id of a `res`. */
  key: string;
  /** Child output bytes this ack releases from its channel's buffer (on a message's last part). */
  bytes: number;
}

/** `counted`: child output, held against its channel's buffer until acked. */
type Pending = Extract<SendItem, { line: string }> & { counted: boolean } | Extract<SendItem, { blob: Uint8Array }>;

/** How a socket closed; `opened` is false for a dial the server refused or never answered. A string instead: why
 * the daemon gave the socket up itself. */
interface SocketEnd {
  opened: boolean;
  code: number;
  reason: string;
}

const trimUrl = (url: string) => url.replace(/\/+$/, "");
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (message: string) => console.error(`[ompweb host] ${message}`);
// Each wait varies ±20% so many hosts do not redial in step.
const withJitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

/** The redial wait after `delay`: doubling to 60 s, or to 3 s for a server on this machine. */
export function nextRedialDelay(delay: number, url: string): number {
  return Math.min(delay * 2, isLoopbackHost(new URL(url).hostname) ? LOOPBACK_MAX_RETRY_MS : MAX_RETRY_MS);
}

/** A URL the daemon dials: https, or http on loopback or with --allow-http. */
function dialable(url: string, allowHttp: boolean): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && (allowHttp || isLoopbackHost(hostname)));
  } catch {
    return false;
  }
}

/** realpath of the longest existing prefix; null when a component is a dangling symlink. */
function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
    } catch {
      // Does not exist: resolve the parent instead.
    }
    const parent = dirname(path);
    if (parent === path) return path;
    const canonicalParent = canonicalPath(parent);
    return canonicalParent === null ? null : join(canonicalParent, basename(path));
  }
}

/** A path main names must resolve, symlinks and `..` included, inside this host's sessions directory. */
function sessionsPath(value: unknown): string {
  const root = canonicalPath(getSessionsDir());
  const target = typeof value === "string" && isAbsolute(value) ? canonicalPath(resolve(value)) : null;
  if (!root || !target || !target.startsWith(root + sep)) {
    throw new HostOpError(403, "path_outside_sessions", "The path is outside this host's sessions directory");
  }
  return target;
}

/** Dial the main server and keep the link up until stopped, revoked (exit 1),
 * outdated (close 4426, exit 1) or replaced by a newer link with this token (close 4409, exit 0). */
export function runHostDaemon(options: { url: string; token: string; allowHttp: boolean }): { stop(): Promise<void>; done: Promise<number> } {
  if (!dialable(options.url, options.allowHttp)) {
    throw new Error("ompweb host needs an https:// server URL (http:// only for loopback, or with --allow-http)");
  }
  // Both follow host.json: a 401 finds a newer token there (the web server re-keyed this host), a failed dial a new url or token.
  let serverUrl = trimUrl(options.url);
  let linkUrl = `${serverUrl}/api/hosts/link`;
  let authorization = `Bearer ${options.token}`;

  const channels = new Map<string, Channel>();
  // Uplink messages wait in `sender` until they go out, then here until main acks them; a dropped socket resends
  // them after the next welcome.
  const sender = new LinkSender<Pending>(true);
  const outbox = new Outbox<Queued>();
  const down = new SeqWindow();
  /** The downlink line main is sending in parts. */
  const parts = new PartJoiner();
  let upSeq = 0;
  /** Highest uplink seq main acked. */
  let ackedUp = 0;
  /** The outbox as it stood at the last welcome, resent in order from `resendAt` (spec D7). */
  let resend: Queued[] = [];
  let resendAt = 0;
  /** Byte sizes of the frames sent on this socket that main has not answered yet, oldest first: main answers every
   * frame, text or binary, with one `ack`. */
  let inFlight: number[] = [];
  let inFlightBytes = 0;
  let unsentBytes = 0;
  let pongOwed = false;
  /** A downlink message was applied since the last frame: the next frame carries its ack, an ack-only one if need be. */
  let ackOwed = false;
  /** Downlink characters applied since the last frame; past a piece the ack goes at once. */
  let appliedSince = 0;
  /** The current socket, from dial to close: every handler ignores events from any other. */
  let socket: WebSocket | null = null;
  /** `socket` once its welcome arrived: uplink frames go only here. */
  let linked: WebSocket | null = null;
  let redialDelay = FIRST_RETRY_MS;
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const stopSignal = new AbortController();
  const { promise: done, resolve: finish } = Promise.withResolvers<number>();

  /** Queue an uplink message under `key` (its channel, or the request id of a `res`); its byte size, or null when it
   * exceeds the line limit. */
  function queue(body: Unsequenced<UpMessage>, key: string, counted = false): number | null {
    let line: string;
    try {
      line = encodeQueued(body);
    } catch (error) {
      if (error instanceof LinkLimitError) return null;
      throw error;
    }
    const size = Buffer.byteLength(line);
    sender.push(key, { line, size, counted });
    unsentBytes += size;
    scheduleFlush();
    return size;
  }

  function output(ch: string, body: Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" }>>): void {
    const channel = channels.get(ch);
    if (!channel) return;
    const bytes = queue(body, ch, true);
    if (bytes === null) {
      // One line over the link limit: drop it and let main reconcile.
      queue({ type: "resync", ch }, ch);
      return;
    }
    channel.buffered += bytes;
    if (channel.buffered > LINK_LIMITS.channelBufferBytes) {
      // The uplink lags too far: drop this child's backlog, a line part-way out included (main drops that partial
      // line). The resync goes out ahead of the channel's later output.
      sender.drop(ch);
      outbox.drop((item) => item.key === ch);
      resend = resend.slice(resendAt).filter((item) => item.key !== ch);
      resendAt = 0;
      channel.buffered = 0;
      queue({ type: "resync", ch }, ch);
    }
  }

  function acked(ack: number): void {
    ackedUp = Math.max(ackedUp, ack);
    for (const item of outbox.ack(ack)) {
      const channel = channels.get(item.key);
      if (channel) channel.buffered -= item.bytes;
    }
  }

  function scheduleFlush(): void {
    if (!linked || stopped) return;
    if (unsentBytes >= LINK_LIMITS.pieceBytes) flush();
    else flushTimer ??= setTimeout(flush, LINK_LIMITS.flushMs);
  }

  /** The next thing to send: an unacked line from the last welcome's snapshot, else the sender's next unit. */
  function nextUnit(): string | Uint8Array | null {
    while (resendAt < resend.length) {
      const item = resend[resendAt++];
      if (item.seq > ackedUp) return item.line;
    }
    // Consumed: the snapshot holds no lines any longer.
    resend = [];
    resendAt = 0;
    const unit = sender.next(() => ++upSeq);
    if (!unit) return null;
    if ("frame" in unit) return unit.frame;
    const bytes = unit.done && "counted" in unit.item && unit.item.counted ? unit.item.size : 0;
    outbox.push({ seq: unit.seq, line: unit.line, key: unit.key, bytes });
    return unit.line;
  }

  /** Hand frames to the socket while it buffers under SEND_BUFFER_BYTES and the frames main has not answered hold
   * under unackedBytes (spec D7); poll every flushMs while the socket buffer is full, and send again on main's next
   * `ack` while the window is. A text frame batches lines up to one piece (UTF-8) behind the applied downlink's `ack`
   * and an owed pong; one with only those goes regardless of both bounds. */
  function flush(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    unsentBytes = 0;
    const ws = linked;
    if (!ws || stopped) return;
    let text = "";
    let textBytes = 0;
    const send = (data: string | Uint8Array, bytes: number) => {
      ws.send(data);
      inFlight.push(bytes);
      inFlightBytes += bytes;
    };
    const sendText = () => {
      const head = encodeLine({ type: "ack", ack: down.acked }) + (pongOwed ? PONG_LINE : "");
      send(head + text, head.length + textBytes);
      pongOwed = false;
      ackOwed = false;
      appliedSince = 0;
      text = "";
      textBytes = 0;
    };
    while (ws.bufferedAmount < SEND_BUFFER_BYTES && inFlightBytes + textBytes < LINK_LIMITS.unackedBytes) {
      const unit = nextUnit();
      if (unit === null) break;
      const bytes = typeof unit === "string" ? Buffer.byteLength(unit) : unit.byteLength;
      if (typeof unit === "string" && textBytes + bytes <= LINK_LIMITS.pieceBytes) {
        text += unit;
        textBytes += bytes;
        continue;
      }
      if (text) sendText();
      if (typeof unit !== "string") send(unit, bytes);
      else {
        text = unit;
        textBytes = bytes;
      }
    }
    if (text || pongOwed || ackOwed) sendText();
    if (ws.bufferedAmount >= SEND_BUFFER_BYTES) flushTimer = setTimeout(flush, LINK_LIMITS.flushMs);
  }

  /** A refused dial's 401: revoked (exit 1), unless host.json already holds a newer token for this server, which the
   * daemon then dials with. `sent` is the authorization the dial carried. */
  function unauthorized(sent: string): void {
    const saved = readHostLogin();
    // Only a host.json for this same server counts: one that names another server is not this daemon's link.
    if (saved && trimUrl(saved.url) === serverUrl && `Bearer ${saved.token}` !== sent) {
      authorization = `Bearer ${saved.token}`;
      log("the server rejected this host's token; using the new one from host.json");
    } else {
      log("the server rejected this host's token (revoked?); stopping its omp sessions");
      void shutdown(1);
    }
  }

  /** host.json names another url or token now (the web server came back on another port): dial with those. */
  function followLogin(): void {
    const saved = readHostLogin();
    if (!saved || !dialable(saved.url, options.allowHttp)) return;
    const url = trimUrl(saved.url);
    if (url === serverUrl && `Bearer ${saved.token}` === authorization) return;
    log(`host.json changed; dialing ${url}`);
    serverUrl = url;
    linkUrl = `${url}/api/hosts/link`;
    authorization = `Bearer ${saved.token}`;
  }

  /** What this link has already logged about messages it skipped. */
  const unknownLog = new UnknownMessageLog("server");

  /** `joined`: a line whose `part`s were applied, so it gets no dedup of its own. */
  function handleDown(line: string, joined = false): void {
    let message: DownMessage | UnknownMessage;
    try {
      message = decodeDown(line);
    } catch (error) {
      if (!(error instanceof LinkProtocolError || error instanceof LinkLimitError)) throw error;
      refuse(line, error.message, joined);
      return;
    }
    switch (message.type) {
      case "welcome":
        log(`linked to ${serverUrl}`);
        unknownLog.reset();
        linked = socket;
        redialDelay = FIRST_RETRY_MS;
        // A fresh link: resend what main has not acked, from one snapshot. Result bytes not sent yet are dropped: main
        // failed those ops when the socket closed (or their `res` now fails 502 host_blob_missing).
        resend = outbox.pending();
        resendAt = 0;
        sender.dropBlobs();
        flush();
        return;
      case "ping":
        pongOwed = true;
        scheduleFlush();
        return;
      case "pong":
        return;
      case "ack":
        // Main answers each frame once: the oldest one in flight has arrived, so the window may have room again.
        inFlightBytes -= inFlight.shift() ?? 0;
        acked(message.ack);
        flush();
        return;
      case "unknown":
        // A newer main's message, or one only the daemon sends: skipped, but its seq is applied so it is acked and never resent.
        if (message.seq !== null) down.applied(message.seq);
        {
          const note = unknownLog.note(message);
          if (note) log(note);
        }
        return;
    }
    // Resent after a reconnect but already applied.
    if (!joined && !down.applied(message.seq)) return;
    switch (message.type) {
      case "part": {
        const whole = joined ? null : parts.add(message);
        if (whole !== null) handleDown(whole, true);
        return;
      }
      case "stdin": {
        const channel = channels.get(message.ch);
        channel?.pending.noteStdin(message.line);
        channel?.transport.write(message.line, () => {});
        return;
      }
      case "kill":
        channels.get(message.ch)?.transport.killTree(message.force);
        return;
      case "req":
        void answer(message.id, message.op, message.args);
        return;
    }
  }

  /** A line that does not decode (a known type with a bad field, say) is never run. `joined`: joined from parts, whose
   * seqs were already applied. */
  function refuse(line: string, why: string, joined: boolean): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // Not JSON at all.
    }
    if (isRecord(raw) && typeof raw.seq === "number" && Number.isInteger(raw.seq)) {
      if (!joined && !down.applied(raw.seq)) return;
      if (raw.type === "req" && typeof raw.id === "string") {
        queue({ type: "res", id: raw.id, ok: false, error: { status: 400, code: "invalid_request", message: why } }, raw.id);
        return;
      }
    }
    log(`ignored a malformed link message: ${why}`);
  }

  async function answer(id: string, op: string, args: unknown): Promise<void> {
    try {
      const result = await runOp(op, args);
      const media = op === "readMedia" && isRecord(result) && result.ok === true && result.value instanceof Uint8Array ? result.value : null;
      const json = media ? undefined : JSON.stringify(result);
      const blob = media ?? (json !== undefined && Buffer.byteLength(json) > LINK_LIMITS.inlineResultBytes ? Buffer.from(json) : null);
      if (!blob) {
        queue({ type: "res", id, ok: true, result }, id);
        return;
      }
      if (blob.byteLength > LINK_LIMITS.blobBytes) throw new HostOpError(413, "result_too_large", "The result is too large for the host link");
      // The bytes go ahead of their `res`, in pieces. Pieces still go after a redial; the hub ignores those for an op it
      // no longer waits on (it failed its ops when the socket closed). A half-open socket the hub replaced keeps its
      // pending ops, so there a piece lost with the old socket makes the `res` fail 502 host_blob_missing.
      sender.push(id, { id, blob });
      queue({ type: "res", id, ok: true, blob: { bytes: blob.byteLength } }, id);
    } catch (error) {
      const failure = error instanceof HostOpError
        ? { status: error.status, code: error.code, message: error.message }
        // A rejected project path is a bad request, as the local projects route answers.
        : error instanceof ProjectPathError
          ? { status: 400, code: error.code, message: error.message }
          : { status: 500, code: "host_op_failed", message: reason(error) };
      queue({ type: "res", id, ok: false, error: failure }, id);
    }
  }

  async function runOp(op: string, args: unknown): Promise<unknown> {
    // An older daemon than main: callers fall back on the 501.
    if (!isHostOp(op)) throw new HostOpError(501, "unknown_op", `Unknown host op: ${op}`);
    if (!isRecord(args)) throw new HostOpError(400, "invalid_request", "Host op arguments must be an object");
    switch (op) {
      case "spawn":
        return spawnChannel(args);
      case "sessionFileExists":
        return localHost.sessionFileExists(sessionsPath(args.path));
      case "invalidateSessionLists":
        return localHost.invalidateSessionLists(args.path === undefined ? undefined : sessionsPath(args.path));
      default: {
        const run = sessionOps[op] as (...params: unknown[]) => Promise<unknown>;
        return run.apply(sessionOps, SESSION_OP_PARAMS[op].map((name) => args[name]));
      }
    }
  }

  async function spawnChannel(args: Record<string, unknown>): Promise<unknown> {
    const { ch, cwd, recordedCwd, sessionFile, toolNames, advisor, spawnModel } = args;
    if (typeof ch !== "string" || !ch || channels.has(ch)) throw new HostOpError(400, "invalid_request", "Invalid channel id");
    if (
      typeof cwd !== "string"
      || !(recordedCwd === null || recordedCwd === undefined || typeof recordedCwd === "string")
      || typeof sessionFile !== "string"
      || typeof advisor !== "boolean"
      || !(toolNames === undefined || (Array.isArray(toolNames) && toolNames.every((name) => typeof name === "string")))
      || !(spawnModel === undefined || typeof spawnModel === "string")
    ) {
      throw new HostOpError(400, "invalid_request", "Invalid spawn request");
    }
    const file = sessionFile ? sessionsPath(sessionFile) : "";
    // Only this machine knows which directories exist here.
    const resolved = resolveSpawnCwdResult(recordedCwd ?? cwd);
    const spawned = await localHost.spawnRpc({ cwd: resolved.cwd, recordedCwd: recordedCwd ?? null, sessionFile: file, toolNames, advisor, spawnModel });
    const { transport } = spawned;
    if (stopped) {
      transport.killTree(true);
      throw new HostOpError(503, "host_stopping", "ompweb host is stopping");
    }
    const pending = new PendingRequests(LINK_LIMITS.pendingBytes, file ? readSessionHeaderSync(file)?.id ?? null : null);
    channels.set(ch, { transport, cwd: spawned.cwd, buffered: 0, pending });
    transport.onLine((line) => {
      pending.noteStdout(line);
      output(ch, { type: "stdout", ch, line });
    });
    transport.onStderr((chunk) => output(ch, { type: "stderr", ch, chunk }));
    transport.onExit((code, signal) => {
      channels.delete(ch);
      queue({ type: "exit", ch, code, signal }, ch);
    });
    // spawnRpc only compares a recorded cwd; a new session's missing cwd falls back too.
    return { cwd: spawned.cwd, fellBack: resolved.fellBack || spawned.fellBack, launchAdvisor: spawned.launchAdvisor, autoApproveExtension: localHost.autoApproveExtension() };
  }

  /** One socket from dial to close. */
  function connect(sent: string, hello: string): Promise<SocketEnd | string> {
    const { promise, resolve } = Promise.withResolvers<SocketEnd | string>();
    // This repo's DOM typing has no init argument; Node's and Bun's WebSocket take `{ headers }`.
    const ws = new WebSocket(linkUrl.replace(/^http/, "ws"), { headers: { authorization: sent } } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    let watchdog: NodeJS.Timeout | undefined;
    // Once given up, a socket stays inert: a late 4409 on it never stops a daemon that already redialed.
    const end = (closed: SocketEnd | string) => {
      clearTimeout(watchdog);
      socket = null;
      linked = null;
      inFlight = [];
      inFlightBytes = 0;
      resolve(closed);
    };
    const giveUp = (why: string) => {
      end(why);
      ws.close();
    };
    // Main pings every pingMs: silence for offlineMs is a dead link (a laptop that slept, a NAT that forgot it).
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => giveUp("no traffic from the server"), LINK_LIMITS.offlineMs);
    };
    alive();
    ws.onopen = () => {
      if (socket !== ws) return;
      opened = true;
      ws.send(hello);
    };
    ws.onmessage = ({ data }: MessageEvent) => {
      if (socket !== ws) return;
      alive();
      try {
        // One message per text frame; the hub sends no binary frames. An applied one is acked soon, at once past a
        // piece, so main's unacked window moves (spec D7).
        if (typeof data !== "string") return;
        const applied = down.acked;
        handleDown(data);
        if (down.acked !== applied) {
          ackOwed = true;
          appliedSince += data.length;
          if (appliedSince >= LINK_LIMITS.pieceBytes) flush();
          else flushTimer ??= setTimeout(flush, LINK_LIMITS.flushMs);
        }
      } catch (error) {
        // A failure handling one message drops this socket, never the daemon: the redial resends what is unacked.
        giveUp(reason(error));
      }
    };
    ws.onclose = (event) => {
      if (socket === ws) end({ opened, code: event.code, reason: event.reason });
    };
    return promise;
  }

  async function keepLinked(): Promise<void> {
    while (!stopped) {
      const sent = authorization;
      try {
        const ompVersion = await getOmpVersion();
        const encodeHello = (replay: boolean) => encodeLine({
          type: "hello",
          v: LINK_PROTOCOL_VERSION,
          ompVersion,
          platform: process.platform,
          home: homedir(),
          autoApproveExtension: localHost.autoApproveExtension(),
          ack: down.acked,
          channels: [...channels].map(([ch, channel]) => ({ ch, sessionId: channel.pending.sessionId, cwd: channel.cwd, pending: replay ? channel.pending.lines() : null })),
        });
        let hello: string;
        try {
          hello = encodeHello(true);
        } catch (error) {
          if (!(error instanceof LinkLimitError)) throw error;
          // Too many channels near the pending cap for one line: none replays (all take the kill-and-resume path) rather than never relinking.
          hello = encodeHello(false);
        }
        // stop() may have come while the hello was being built.
        if (stopped) return;
        const closed = await connect(sent, hello);
        if (stopped) return;
        if (typeof closed === "string") log(`link lost (${closed}); redialing`);
        else if (closed.code === LINK_CLOSE.replaced) {
          log("another ompweb host linked with this token; exiting");
          void shutdown(0);
          return;
        } else if (closed.code === LINK_CLOSE.versionMismatch) {
          // The reason carries the server's newest version: below this daemon's, the server is the outdated side.
          let serverVersion: unknown;
          try {
            serverVersion = (JSON.parse(closed.reason) as { serverVersion?: unknown } | null)?.serverVersion;
          } catch {
            // No version: advise updating this host.
          }
          log(
            typeof serverVersion === "number" && serverVersion < LINK_PROTOCOL_VERSION
              ? "this host's ompweb is newer than the server's: update ompweb on the server"
              : "the server speaks a different link protocol: update ompweb on this host",
          );
          void shutdown(1);
          return;
        } else if (closed.opened) log(`link lost (code ${closed.code}${closed.reason ? `: ${closed.reason}` : ""}); redialing`);
        else {
          // Neither Node's nor Bun's WebSocket shows a refused upgrade's status: a plain GET with the same token does.
          const { status, body } = await fetch(linkUrl, {
            headers: { authorization: sent },
            signal: AbortSignal.any([stopSignal.signal, AbortSignal.timeout(LINK_LIMITS.offlineMs)]),
          });
          void body?.cancel().catch(() => {});
          if (status === 401) unauthorized(sent);
          else if (status === 503) log("the server is unavailable (503); redialing");
          else log(`the server did not accept the WebSocket upgrade (HTTP ${status}): check that a reverse proxy forwards Upgrade and Connection, and that the server runs an ompweb at least as new as this host's`);
        }
      } catch (error) {
        if (stopped) return;
        log(`link lost (${reason(error)}); redialing`);
      }
      if (stopped) return;
      followLogin();
      await sleep(withJitter(redialDelay), undefined, { signal: stopSignal.signal }).catch(() => {});
      redialDelay = nextRedialDelay(redialDelay, serverUrl);
    }
  }

  function shutdown(code: number): Promise<void> {
    stopped = true;
    stopping ??= (async () => {
      stopSignal.abort();
      socket?.close();
      clearTimeout(flushTimer);
      const live = [...channels.values()].map(({ transport }) => transport);
      const exits = live.map((transport) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        transport.onExit(() => resolve());
        return promise;
      });
      for (const transport of live) transport.killTree(false);
      const force = setTimeout(() => {
        for (const transport of live) transport.killTree(true);
      }, KILL_GRACE_MS);
      await Promise.all(exits);
      clearTimeout(force);
      finish(code);
    })();
    return stopping;
  }

  void keepLinked();
  return { stop: () => shutdown(0), done };
}
