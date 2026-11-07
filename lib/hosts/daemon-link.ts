// One server's delivery window; channel/process ownership lives in daemon-channels.
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "../type-guards";
import { isLoopbackHost } from "./host-login";
import type { HostLink } from "./host-login";
import { acknowledgeHostUpdateHealth } from "./updates";
import { decodeBlobFrame, decodeDown, encodeLine, encodeQueued, HostOpError, LINK_CLOSE, LINK_LIMITS, LINK_PROTOCOL_VERSION, MIN_LINK_PROTOCOL_VERSION, LinkLimitError, LinkProtocolError, LinkSender, Outbox, PartJoiner, SeqWindow, UnknownMessageLog, type DownMessage, type UpMessage, type Unsequenced, type UnknownMessage, type LinkStatSample, type SendItem } from "./link-protocol";

const FIRST_RETRY_MS = 1000;
const PONG_LINE = encodeLine({ type: "pong" });
const SEND_BUFFER_BYTES = 2 * LINK_LIMITS.pieceBytes;
/** An uplink line sent and not acked yet. */
interface Queued {
  seq: number;
  line: string;
  /** The `LinkSender` key it went out under: its channel, or the request id of a `res`. */
  key: string;
  /** Child output bytes this ack releases from its channel's buffer (on a message's last part). */
  bytes: number;
  output: boolean;
  /** Bytes this ack takes out of `unackedBytes`: the line's own, plus on a `res` the result bytes sent ahead of it. */
  unacked: number;
  /** Its link sample, set on the line that completes a message (a whole line, or its last part), with `t`, its queue
   * time on the monotonic clock. Null for a `stats` message and for a part before the last. */
  sample: (Omit<LinkStatSample, "ackMs"> & { t: number }) | null;
}

/** A message's link sample as taken when it is queued: the time (wall and monotonic), the bytes of a result queued ahead of this `res`
 * (else 0), the bytes queued or unacked ahead of it, and the session it serves. */
type UpSample = { at: number; t: number; blob: number; bytesAhead: number; session: string | null };

/** `counted`: child output, held against its channel's buffer until acked. */
type Pending = Extract<SendItem, { line: string }> & { counted: boolean; sample: UpSample | null } | Extract<SendItem, { blob: Uint8Array }>;

/** How a socket closed; `opened` is false for a dial the server refused or never answered. A string instead: why
 * the daemon gave the socket up itself. */
interface SocketEnd {
  opened: boolean;
  code: number;
  reason: string;
}

const trimUrl = (url: string) => url.replace(/\/+$/, "");
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Each wait varies ±20% so many hosts do not redial in step.
const withJitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

export function nextRedialDelay(delay: number, url: string, primary = true): number {
  return Math.min(delay * 2, primary && isLoopbackHost(new URL(url).hostname) ? 3000 : 30000);
}
export function dialable(url: string, allowHttp: boolean): boolean {
  try { const { protocol, hostname } = new URL(url); return protocol === "https:" || protocol === "http:" && (allowHttp || isLoopbackHost(hostname)); } catch { return false; }
}
export type LinkDeps = {
  allowHttp: boolean; primary: boolean;
  hello(link: DaemonLink, replay: boolean): string;
  handleDown(link: DaemonLink, message: DownMessage | UnknownMessage): void;
  onEnd(link: DaemonLink, reason: "revoked" | "replaced" | "version"): void;
  log(message: string): void;
  onState?(link: DaemonLink, up: boolean): void;
  onBlob?(link: DaemonLink, id: string, bytes: Uint8Array): void;
  reload?(source?: DaemonLink, unauthorized?: boolean): boolean | void;
};
export class DaemonLink {
  version = LINK_PROTOCOL_VERSION;
  private readonly runtime;
  constructor(readonly login: HostLink, readonly id: string, deps: LinkDeps) {
    if (!dialable(login.url, deps.allowHttp)) throw new Error("ompweb host needs an https:// server URL (http:// only for loopback, or with --allow-http)");
    this.runtime = linkRuntime(this, deps);
  }
  get ackedDown(): number { return this.runtime.ackedDown(); }
  start(): void { this.runtime.start(); }
  stop(): Promise<void> { return this.runtime.stop(); }
  rekey(token: string): void { this.runtime.rekey(token); }
  isUp(): boolean { return this.runtime.isUp(); }
  queue(body: Unsequenced<UpMessage>, key: string, options?: { counted?: boolean; session?: string | null; blob?: number; ahead?: number }): number | null { return this.runtime.queue(body, key, options); }
  output(body: Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" }>>, session: string | null): void { this.runtime.output(body.ch, body, session); }
  discard(ch: string): void { this.runtime.discard(ch); }
  result(id: string, result: unknown, options: { session?: string | null; key?: string; media?: Uint8Array | null } = {}): void { this.runtime.result(id, result, options); }
}

function linkRuntime(owner: DaemonLink, deps: LinkDeps) {
  const serverUrl = trimUrl(owner.login.url);
  const linkUrl = serverUrl + "/api/hosts/link";
  let authorization = "Bearer " + owner.login.token;
  const log = deps.log;
  const channels = new Map<string, { buffered: number }>();
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
  /** Bytes of the messages sent and not acked (lines as sent, and result bytes until their `res` is acked): with
   * `sender.queuedBytes`, the bytes ahead of a new message in its link sample. */
  let unackedBytes = 0;
  /** Result bytes sent per request id, until its `res` goes out and takes them over. */
  const sentResult = new Map<string, number>();
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
  const stopSignal = new AbortController();
  let started = false;
  let loop: Promise<void> = Promise.resolve();
  /** Link samples of acked messages, waiting for their `stats` message. */
  const samples: LinkStatSample[] = [];
  let statsTimer: NodeJS.Timeout | undefined;

  /** Queue an uplink message under `key` (its channel, the request id of a `res`, or "stats"); its byte size, or null
   * when it exceeds the line limit. `counted`: child output, held against its channel's buffer. `session`, `blob` (the
   * bytes of a result queued ahead of this `res`) and `ahead` (the bytes ahead of it, measured before that result was
   * queued) go into its link sample. */
  function queue(
    body: Unsequenced<UpMessage>,
    key: string,
    { counted = false, session = null, blob = 0, ahead }: { counted?: boolean; session?: string | null; blob?: number; ahead?: number } = {},
  ): number | null {
    let line: string;
    try {
      line = encodeQueued(body);
    } catch (error) {
      if (error instanceof LinkLimitError) return null;
      throw error;
    }
    const size = Buffer.byteLength(line);
    // Ahead of it: what is unacked and what is queued to go (counters, no scan; a queued line counts at its size before
    // its seq is filled in). A `stats` message is not measured itself: its sample would need another one.
    const sample = body.type === "stats" ? null : { at: Date.now(), t: performance.now(), blob, bytesAhead: Math.max(0, ahead ?? unackedBytes + sender.queuedBytes), session };
    sender.push(key, { line, size, counted, sample });
    unsentBytes += size;
    scheduleFlush();
    return size;
  }

  function discard(ch: string, overflow = false): void {
    sender.dropWhere(ch, item => "line" in item && item.counted);
    let retained = 0;
    for (const item of outbox.pending()) {
      if (item.key !== ch) continue;
      if (overflow && item.output) {
        // Keep the sequence position, not its discarded payload; the welcome snapshot shares this record.
        item.line = encodeLine({ type: "stats", seq: item.seq, samples: [] });
        item.output = false;
        item.bytes = 0;
        item.sample = null;
        // unacked still represents bytes already written; its original ack releases them exactly once.
      }
      retained += item.bytes;
    }
    channels.set(ch, { buffered: retained });
  }
  function output(ch: string, body: Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" }>>, session: string | null): void {
    const channel = channels.get(ch) ?? { buffered: 0 };
    channels.set(ch, channel);
    const bytes = queue(body, ch, { counted: true, session });
    if (bytes === null) { discard(ch, true); queue({ type: "resync", ch }, ch); return; }
    channel.buffered += bytes;
    if (channel.buffered > LINK_LIMITS.channelBufferBytes) {
      log("channel " + ch + ": dropped " + channel.buffered + " bytes of output the server has not taken; resync");
      discard(ch, true);
      queue({ type: "resync", ch }, ch);
    }
  }

  function acked(ack: number): void {
    ackedUp = Math.max(ackedUp, ack);
    // Monotonic: a wall-clock step (time sync, a VM resuming) never makes a negative or inflated ackMs.
    const now = performance.now();
    for (const item of outbox.ack(ack)) {
      const channel = channels.get(item.key);
      if (channel) channel.buffered -= item.bytes;
      unackedBytes -= item.unacked;
      // One sample per message: a split one carries it on its last part, acked with the whole message.
      if (item.sample) {
        const { t, ...sample } = item.sample;
        samples.push({ ...sample, ackMs: Math.max(0, Math.round(now - t)) });
      }
    }
    if (samples.length >= LINK_LIMITS.statsSamples) sendStats();
    else if (samples.length > 0 && !statsTimer) {
      statsTimer = setTimeout(sendStats, LINK_LIMITS.statsFlushMs);
      statsTimer.unref?.();
    }
  }

  /** The samples so far, as `stats` messages of at most statsSamples each (one ack can cover more), queued under their
   * own key: about 40 KB each, sent in turn with the channels and inside the unacked window like any message. */
  function sendStats(): void {
    clearTimeout(statsTimer);
    statsTimer = undefined;
    while (samples.length > 0 && !stopped) queue({ type: "stats", samples: samples.splice(0, LINK_LIMITS.statsSamples) }, "stats");
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
    if ("frame" in unit) {
      // Result bytes stay unacked until their `res` is (it takes them over in `unacked`).
      const piece = unit.frame.byteLength - 1 - Buffer.byteLength((unit.item as Extract<SendItem, { blob: Uint8Array }>).id);
      sentResult.set(unit.key, (sentResult.get(unit.key) ?? 0) + piece);
      unackedBytes += piece;
      return unit.frame;
    }
    // A unit carrying a line is a line item's.
    const item = unit.item as Extract<Pending, { line: string }>;
    const bytes = unit.done && item.counted ? item.size : 0;
    const size = Buffer.byteLength(unit.line);
    const sentBlob = unit.done ? sentResult.get(unit.key) ?? 0 : 0;
    if (sentBlob) sentResult.delete(unit.key);
    const sample = unit.done && item.sample
      ? { session: item.sample.session, bytes: unit.messageBytes + item.sample.blob, bytesAhead: item.sample.bytesAhead, at: item.sample.at, t: item.sample.t }
      : null;
    outbox.push({ seq: unit.seq, line: unit.line, key: unit.key, bytes, output: item.counted, unacked: size + sentBlob, sample });
    unackedBytes += size;
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

  const unknownLog = new UnknownMessageLog("server");
  function handleDown(line: string, joined = false): void {
    let message: DownMessage | UnknownMessage;
    try { message = decodeDown(line); }
    catch (error) { if (!(error instanceof LinkProtocolError || error instanceof LinkLimitError)) throw error; refuse(line, error.message, joined); return; }
    switch (message.type) {
      case "welcome":
        if (message.v < MIN_LINK_PROTOCOL_VERSION || message.v > owner.version) throw new LinkProtocolError("Invalid welcome protocol version");
        owner.version = message.v;
        sender.parts = owner.version >= 5;
        log("linked to " + serverUrl);
        acknowledgeHostUpdateHealth(); unknownLog.reset(); linked = socket; redialDelay = FIRST_RETRY_MS;
        resend = outbox.pending(); resendAt = 0; sender.dropBlobs();
        deps.onState?.(owner, true); flush(); return;
      case "ping": pongOwed = true; scheduleFlush(); return;
      case "pong": return;
      case "ack": inFlightBytes -= inFlight.shift() ?? 0; acked(message.ack); flush(); return;
      case "unknown": if (message.seq !== null) down.applied(message.seq); { const note = unknownLog.note(message); if (note) log(note); } return;
    }
    if (!joined && !down.applied(message.seq)) return;
    if (message.type === "part") { const whole = joined ? null : parts.add(message); if (whole !== null) handleDown(whole, true); return; }
    deps.handleDown(owner, message);
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

  function result(id: string, value: unknown, { session = null, key = id, media = null }: { session?: string | null; key?: string; media?: Uint8Array | null }): void {
    const json = media ? undefined : JSON.stringify(value);
    const blob = media ?? (json !== undefined && Buffer.byteLength(json) > LINK_LIMITS.inlineResultBytes ? Buffer.from(json) : null);
    if (!blob) { queue({ type: "res", id, ok: true, result: value }, key, { session }); return; }
    if (blob.byteLength > LINK_LIMITS.blobBytes) throw new HostOpError(413, "result_too_large", "The result is too large for the host link");
    const ahead = unackedBytes + sender.queuedBytes;
    // Binary payload identifies the op, but shares the channel's ordering key for open.
    sender.push(key, { id, blob });
    queue({ type: "res", id, ok: true, blob: { bytes: blob.byteLength } }, key, { session, blob: blob.byteLength, ahead });
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
      deps.onState?.(owner, false);
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
        // A binary frame carries upload bytes (v6), written in order. One message per text frame; an applied one is
        // acked soon, at once past a piece, so main's unacked window moves (spec D7).
        if (typeof data !== "string") {
          const { id, bytes } = decodeBlobFrame(new Uint8Array(data as ArrayBuffer));
          deps.onBlob?.(owner, id, bytes);
          return;
        }
        const applied = down.acked;
        for (const line of data.split("\n")) if (line) handleDown(line);
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
      try {
        const sent = authorization;
        let hello: string;
        try { hello = deps.hello(owner, true); } catch (error) { if (!(error instanceof LinkLimitError)) throw error; hello = deps.hello(owner, false); }
        if (stopped) return;
        const closed = await connect(sent, hello);
        if (stopped) return;
        if (typeof closed !== "string" && closed.code === LINK_CLOSE.versionMismatch) {
          let newest: unknown; try { newest = JSON.parse(closed.reason)?.serverVersion; } catch {}
          if (typeof newest === "number" && Number.isInteger(newest) && newest >= MIN_LINK_PROTOCOL_VERSION && newest < owner.version) {
            owner.version = newest; sender.parts = newest >= 5; continue;
          }
          log(typeof newest === "number" && newest < LINK_PROTOCOL_VERSION
            ? "this host's ompweb is newer than the server's: update ompweb on the server"
            : "the server speaks a different link protocol: update ompweb on this host");
          endLink("version"); return;
        }
        if (typeof closed !== "string" && closed.code === LINK_CLOSE.replaced) { log("another ompweb host linked with this token; exiting this link"); endLink("replaced"); return; }
        if (typeof closed !== "string" && closed.code === 1000) { endLink("revoked"); return; }
        if (typeof closed !== "string" && !closed.opened) {
          const { status, body } = await fetch(linkUrl, { headers: { authorization: sent }, signal: AbortSignal.any([stopSignal.signal, AbortSignal.timeout(LINK_LIMITS.offlineMs)]) });
          void body?.cancel().catch(() => {});
          if (status === 401) { if (deps.reload?.(owner, true)) continue; endLink("revoked"); return; }
          log(status === 503 ? "the server is unavailable (503); redialing" : "the server did not accept the WebSocket upgrade (HTTP " + status + "): check that a reverse proxy forwards Upgrade and Connection, and that the server runs an ompweb at least as new as this host's");
        } else log(typeof closed === "string" ? "link lost (" + closed + "); redialing" : "link lost (code " + closed.code + "); redialing");
      } catch (error) { if (stopped) return; log("link lost (" + reason(error) + "); redialing"); }
      deps.reload?.(owner);
      if (stopped) return;
      await sleep(withJitter(redialDelay), undefined, { signal: stopSignal.signal }).catch(() => {});
      redialDelay = nextRedialDelay(redialDelay, serverUrl, deps.primary);
    }
  }
  function endLink(reason: "revoked" | "replaced" | "version"): void { stopped = true; stopSignal.abort(); deps.onEnd(owner, reason); }
  async function stop(): Promise<void> {
    if (!stopped && linked && samples.length > 0) { sendStats(); flush(); }
    stopped = true; stopSignal.abort(); socket?.close(); clearTimeout(flushTimer); clearTimeout(statsTimer);
    await loop;
  }
  return { queue, output, discard, result, ackedDown: () => down.acked, isUp: () => linked !== null && !stopped,
    rekey: (token: string) => { owner.login.token = token; authorization = "Bearer " + token; socket?.close(1001, "credentials changed"); },
    start: () => { if (!started && !stopped) { started = true; loop = keepLinked(); } }, stop };
}
