// `ompweb host` (spec "Daemon"): links this machine to a main omp-web, runs
// the omp children it asks for and answers host ops with this machine's files.
// bin/omp-web-host.js loads it through jiti: no `next/*` or `@/` imports.
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getOmpVersion } from "../omp/omp-cli";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import type { RpcTransport } from "../omp/rpc-transport";
import { readSessionHeaderSync } from "../omp/session-files";
import { ProjectPathError } from "../project-registry";
import { isRecord } from "../type-guards";
import {
  decodeDown,
  encodeLine,
  HOST_OP_NAMES,
  HostOpError,
  LINK_ACK_HEADER,
  LINK_HELLO_HEADER,
  LINK_LIMITS,
  LINK_NONCE_HEADER,
  LINK_PROTOCOL_VERSION,
  LinkLimitError,
  LinkProtocolError,
  Outbox,
  SeqWindow,
  SESSION_OP_PARAMS,
  type DownMessage,
  type HostOpName,
  type UpMessage,
} from "./link-protocol";
import { localHost, resolveSpawnCwdResult } from "./local-host";
import { sessionOps } from "./session-ops";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** Children still running this long after SIGTERM get SIGKILL. */
const KILL_GRACE_MS = 5_000;
const PONG_LINE = encodeLine({ type: "pong" });

type Unsequenced<M> = M extends { seq: number } ? Omit<M, "seq"> : never;

interface Channel {
  transport: RpcTransport;
  sessionId: string | null;
  /** Bytes of this child's output waiting for an uplink ack. */
  buffered: number;
}

interface Queued {
  seq: number;
  line: string;
  bytes: number;
  /** Set for child output, which an overflow may drop. */
  ch: string | null;
}

const loginFile = () => join(getAgentDir(), "omp-web", "host.json");
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (message: string) => console.error(`[ompweb host] ${message}`);
// 1 s doubling to 60 s; each wait varies ±20% so many hosts do not redial in step.
const withJitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

/** Save the server URL and host token, owner-only. The token never goes through argv. */
export function loginHost(options: { url: string; token: string }): void {
  const { protocol } = new URL(options.url);
  if (protocol !== "https:" && protocol !== "http:") throw new Error("The server URL must start with https:// or http://");
  const token = options.token.trim();
  if (!token) throw new Error("The host token is empty");
  const file = loginFile();
  mkdirSync(dirname(file), { recursive: true });
  // A fresh 0600 file renamed into place: the token never sits in a wider-mode file.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ url: options.url.replace(/\/+$/, ""), token })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** What `loginHost` saved, or null before the first login. */
export function readHostLogin(): { url: string; token: string } | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(loginFile(), "utf8"));
    if (isRecord(saved) && typeof saved.url === "string" && typeof saved.token === "string") return { url: saved.url, token: saved.token };
  } catch {
    // Missing or unreadable: not logged in.
  }
  return null;
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

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
      }
      if (buffered.length > LINK_LIMITS.maxLineBytes) throw new LinkLimitError("A downlink line exceeds the link limit");
    }
  } finally {
    // Stops the request when the caller stops reading.
    void reader.cancel().catch(() => {});
  }
}

/** Dial the main server and keep the link up until stopped, revoked (exit 1),
 * outdated (426, exit 1) or replaced by a newer link with this token (exit 0). */
export function runHostDaemon(options: { url: string; token: string; allowHttp: boolean; fetch?: typeof fetch }): { stop(): Promise<void>; done: Promise<number> } {
  const { protocol, hostname } = new URL(options.url);
  if (protocol !== "https:" && !(protocol === "http:" && (options.allowHttp || isLoopbackHost(hostname)))) {
    throw new Error("ompweb host needs an https:// server URL (http:// only for loopback, or with --allow-http)");
  }
  const fetchLink = options.fetch ?? fetch;
  const linkUrl = `${options.url.replace(/\/+$/, "")}/api/hosts/link`;
  const authorization = `Bearer ${options.token}`;

  const channels = new Map<string, Channel>();
  // Uplink messages stay here until main acks them; a failed POST resends them.
  const outbox = new Outbox<Queued>();
  const down = new SeqWindow();
  let upSeq = 0;
  let unsentBytes = 0;
  let pongOwed = false;
  // The current link's `welcome.nonce`, sent with every POST. Null before the
  // first welcome and after main refused it as replaced; `welcome` settles
  // once the next one arrives.
  let nonce: string | null = null;
  let welcome = Promise.withResolvers<void>();
  let posting = false;
  let backingOff = false;
  let postDelay = FIRST_RETRY_MS;
  let redialDelay = FIRST_RETRY_MS;
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const stopSignal = new AbortController();
  const { promise: done, resolve: finish } = Promise.withResolvers<number>();

  /** Number and keep an uplink message; its byte size, or null when it exceeds the line limit. */
  function queue(body: Unsequenced<UpMessage>, ch: string | null = null): number | null {
    let line: string;
    try {
      line = encodeLine({ ...body, seq: upSeq + 1 } as UpMessage);
    } catch (error) {
      if (error instanceof LinkLimitError) return null;
      throw error;
    }
    upSeq += 1;
    const bytes = Buffer.byteLength(line);
    outbox.push({ seq: upSeq, line, bytes, ch });
    unsentBytes += bytes;
    scheduleFlush();
    return bytes;
  }

  function output(ch: string, body: Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" }>>): void {
    const channel = channels.get(ch);
    if (!channel) return;
    const bytes = queue(body, ch);
    if (bytes === null) {
      // One line over the link limit: drop it and let main reconcile.
      queue({ type: "resync", ch });
      return;
    }
    channel.buffered += bytes;
    if (channel.buffered > LINK_LIMITS.channelBufferBytes) {
      // The uplink lags too far: drop this child's backlog. The resync goes
      // out with the first POST that gets through, ahead of later output.
      outbox.drop((item) => item.ch === ch);
      channel.buffered = 0;
      queue({ type: "resync", ch });
    }
  }

  function acked(ack: number): void {
    for (const item of outbox.pending()) {
      if (item.seq > ack) break;
      const channel = item.ch ? channels.get(item.ch) : undefined;
      if (channel) channel.buffered -= item.bytes;
    }
    outbox.ack(ack);
  }

  function scheduleFlush(): void {
    if (!nonce || posting || backingOff || stopped) return;
    if (unsentBytes >= LINK_LIMITS.flushBytes) void flush();
    else flushTimer ??= setTimeout(() => void flush(), LINK_LIMITS.flushMs);
  }

  async function flush(): Promise<void> {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (posting || stopped || !nonce) return;
    const used = nonce;
    const batch: string[] = [];
    let size = pongOwed ? PONG_LINE.length : 0;
    for (const item of outbox.pending()) {
      if (batch.length > 0 && size + item.bytes > LINK_LIMITS.uplinkBytes) break;
      batch.push(item.line);
      size += item.bytes;
    }
    if (batch.length === 0 && !pongOwed) return;
    const body = (pongOwed ? PONG_LINE : "") + batch.join("");
    pongOwed = false;
    unsentBytes = 0;
    posting = true;
    try {
      const response = await fetchLink(linkUrl, {
        method: "POST",
        headers: { authorization, "content-type": "application/x-ndjson", [LINK_ACK_HEADER]: String(down.acked), [LINK_NONCE_HEADER]: used },
        body,
        signal: AbortSignal.any([stopSignal.signal, AbortSignal.timeout(LINK_LIMITS.offlineMs)]),
      });
      if (fatal(response.status)) return;
      if (response.status === 409) {
        // Sent on a link main has replaced: resend on the current one, now if
        // its welcome already arrived, else when it does.
        posting = false;
        if (nonce === used) forgetLink();
        else void flush();
        return;
      }
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const { ack } = (await response.json()) as { ack?: unknown };
      if (typeof ack !== "number" || !Number.isInteger(ack)) throw new Error("the server sent no ack");
      posting = false;
      backingOff = false;
      postDelay = FIRST_RETRY_MS;
      acked(ack);
      scheduleFlush();
    } catch (error) {
      posting = false;
      if (stopped) return;
      log(`uplink failed (${reason(error)}); resending`);
      backingOff = true;
      flushTimer = setTimeout(() => {
        backingOff = false;
        void flush();
      }, withJitter(postDelay));
      postDelay = Math.min(postDelay * 2, MAX_RETRY_MS);
    }
  }

  /** 401 (revoked) and 426 (outdated) end the daemon; true when it is stopping. */
  function fatal(status: number): boolean {
    if (status === 401) {
      log("the server rejected this host's token (revoked?); stopping its omp sessions");
      void shutdown(1);
    } else if (status === 426) {
      log("the server speaks a different link protocol: upgrade omp-web on this host");
      void shutdown(1);
    }
    return stopped;
  }

  function forgetLink(): void {
    nonce = null;
    welcome = Promise.withResolvers<void>();
  }

  function handleDown(line: string): void {
    let message: DownMessage;
    try {
      message = decodeDown(line);
    } catch (error) {
      if (!(error instanceof LinkProtocolError || error instanceof LinkLimitError)) throw error;
      refuse(line, error.message);
      return;
    }
    switch (message.type) {
      case "welcome":
        log(`linked to ${options.url}`);
        nonce = message.nonce;
        welcome.resolve();
        // A fresh link: resend what main has not acked now, not after the old backoff.
        backingOff = false;
        postDelay = FIRST_RETRY_MS;
        redialDelay = FIRST_RETRY_MS;
        void flush();
        return;
      case "ping":
        pongOwed = true;
        scheduleFlush();
        return;
      case "pong":
        return;
    }
    // Resent after a reconnect but already applied.
    if (!down.applied(message.seq)) return;
    switch (message.type) {
      case "stdin":
        channels.get(message.ch)?.transport.write(message.line, () => {});
        return;
      case "kill":
        channels.get(message.ch)?.transport.killTree(message.force);
        return;
      case "req":
        void answer(message.id, message.op, message.args);
        return;
      case "replaced":
        log("another ompweb host linked with this token; exiting");
        void shutdown(0);
        return;
    }
  }

  /** A line that does not decode (an op outside HOST_OP_NAMES, say) is never run. */
  function refuse(line: string, why: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // Not JSON at all.
    }
    if (isRecord(raw) && typeof raw.seq === "number" && Number.isInteger(raw.seq)) {
      if (!down.applied(raw.seq)) return;
      if (raw.type === "req" && typeof raw.id === "string") {
        queue({ type: "res", id: raw.id, ok: false, error: { status: 400, code: "invalid_request", message: why } });
        return;
      }
    }
    log(`ignored a malformed link message: ${why}`);
  }

  async function answer(id: string, op: HostOpName, args: unknown): Promise<void> {
    try {
      const result = await runOp(op, args);
      const media = op === "readMedia" && isRecord(result) && result.ok === true && result.value instanceof Uint8Array ? result.value : null;
      const json = media ? undefined : JSON.stringify(result);
      const blob = media ?? (json !== undefined && Buffer.byteLength(json) > LINK_LIMITS.inlineResultBytes ? Buffer.from(json) : null);
      if (!blob) {
        queue({ type: "res", id, ok: true, result });
        return;
      }
      await uploadBlob(id, blob);
      queue({ type: "res", id, ok: true, blob: { bytes: blob.byteLength } });
    } catch (error) {
      const failure = error instanceof HostOpError
        ? { status: error.status, code: error.code, message: error.message }
        // A rejected project path is a bad request, as the local projects route answers.
        : error instanceof ProjectPathError
          ? { status: 400, code: error.code, message: error.message }
          : { status: 500, code: "host_op_failed", message: reason(error) };
      queue({ type: "res", id, ok: false, error: failure });
    }
  }

  /** Large results and media go as raw bytes, before their `res` line. */
  async function uploadBlob(id: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > LINK_LIMITS.blobBytes) throw new HostOpError(413, "result_too_large", "The result is too large for the host link");
    const signal = AbortSignal.any([stopSignal.signal, AbortSignal.timeout(LINK_LIMITS.opTimeoutMs)]);
    const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
    signal.addEventListener("abort", () => onAbort(), { once: true });
    for (;;) {
      // Main refused the last link as replaced: upload on the next one.
      while (!nonce) {
        signal.throwIfAborted();
        await Promise.race([welcome.promise, aborted]);
      }
      const used = nonce;
      const response = await fetchLink(`${linkUrl}/blob/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/octet-stream", [LINK_NONCE_HEADER]: used },
        body: bytes as Uint8Array<ArrayBuffer>,
        signal,
      });
      if (fatal(response.status)) throw new HostOpError(503, "host_stopping", "ompweb host is stopping");
      if (response.status === 409) {
        if (nonce === used) forgetLink();
        continue;
      }
      if (!response.ok) throw new HostOpError(502, "blob_upload_failed", `Uploading the result failed (${response.status})`);
      return;
    }
  }

  async function runOp(op: HostOpName, args: unknown): Promise<unknown> {
    // decodeDown already refuses unknown names; checked again where ops run.
    if (!(HOST_OP_NAMES as readonly string[]).includes(op)) throw new HostOpError(400, "unknown_op", `Unknown host op: ${String(op)}`);
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
    channels.set(ch, { transport, sessionId: file ? readSessionHeaderSync(file)?.id ?? null : null, buffered: 0 });
    transport.onLine((line) => output(ch, { type: "stdout", ch, line }));
    transport.onStderr((chunk) => output(ch, { type: "stderr", ch, chunk }));
    transport.onExit((code, signal) => {
      channels.delete(ch);
      queue({ type: "exit", ch, code, signal });
    });
    // spawnRpc only compares a recorded cwd; a new session's missing cwd falls back too.
    return { cwd: spawned.cwd, fellBack: resolved.fellBack || spawned.fellBack, launchAdvisor: spawned.launchAdvisor, autoApproveExtension: localHost.autoApproveExtension() };
  }

  async function downlink(): Promise<void> {
    while (!stopped) {
      const abort = new AbortController();
      let watchdog: NodeJS.Timeout | undefined;
      // Main pings every pingMs: silence for offlineMs is a dead link.
      const alive = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => abort.abort(new Error("no traffic from the server")), LINK_LIMITS.offlineMs);
      };
      try {
        const hello = encodeLine({
          type: "hello",
          v: LINK_PROTOCOL_VERSION,
          ompVersion: await getOmpVersion(),
          platform: process.platform,
          home: homedir(),
          ack: down.acked,
          channels: [...channels].map(([ch, channel]) => ({ ch, sessionId: channel.sessionId })),
        });
        alive();
        const signal = AbortSignal.any([stopSignal.signal, abort.signal]);
        // The hello goes in a POST body: as a GET header, proxy header buffers (nginx: 8 KB) capped the channels it lists.
        const offered = await fetchLink(linkUrl, {
          method: "POST",
          headers: { authorization, "content-type": "application/x-ndjson", [LINK_HELLO_HEADER]: "1" },
          body: hello,
          signal,
        });
        if (fatal(offered.status)) return;
        const { helloId } = (offered.ok ? await offered.json().catch(() => ({})) : {}) as { helloId?: unknown };
        if (typeof helloId !== "string" || !helloId) {
          // A v1 main answers a nonce-less POST 409 and has no hello leg: redialing would loop forever.
          if (offered.ok || [400, 404, 405, 409].includes(offered.status)) {
            log("the server runs an older ompweb: upgrade it");
            void shutdown(1);
            return;
          }
          throw new Error(`the server answered the hello with ${offered.status}`);
        }
        const response = await fetchLink(linkUrl, { headers: { authorization, [LINK_HELLO_HEADER]: helloId }, signal });
        if (fatal(response.status)) return;
        if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
        for await (const line of readLines(response.body)) {
          alive();
          handleDown(line);
          if (stopped) return;
        }
        log("the server closed the link; redialing");
      } catch (error) {
        if (stopped) return;
        log(`link lost (${reason(error)}); redialing`);
      } finally {
        clearTimeout(watchdog);
      }
      await sleep(withJitter(redialDelay), undefined, { signal: stopSignal.signal }).catch(() => {});
      redialDelay = Math.min(redialDelay * 2, MAX_RETRY_MS);
    }
  }

  function shutdown(code: number): Promise<void> {
    stopped = true;
    stopping ??= (async () => {
      stopSignal.abort();
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

  void downlink();
  return { stop: () => shutdown(0), done };
}
