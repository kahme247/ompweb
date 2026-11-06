import { randomUUID } from "node:crypto";
import type { SpawnRequest, SpawnResult } from "./host";
import type { RpcTransport } from "../omp/rpc-transport";
import { encodeRpcCommand, RpcFrameDecoder, type RpcFrameRecord } from "../omp/rpc-frame";
import { readSessionHeaderSync } from "../omp/session-files";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import type { DaemonLink } from "./daemon-link";
import { HostOpError, LINK_LIMITS, type HelloChannel, type OpenChannelRequest, type OpenChannelResult, type Unsequenced, type UpMessage } from "./link-protocol";
import { PendingRequests } from "./pending-requests";
import { StreamSnapshot } from "./stream-snapshot";
import { ChannelLifecycle } from "./channel-lifecycle";
import { SharedRequests } from "./shared-requests";
import { RESUME_PROMPT, type HostResumeEntry } from "./host-resume";

type Output = Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" | "exit" }>>;
type Member = { link: DaemonLink; paused: boolean; opens: number; queued: Output[]; bytes: number; resync: boolean };
type Channel = {
  ch: string; transport: RpcTransport; launch: SpawnRequest; cwd: string; fellBack: boolean; launchAdvisor: boolean;
  legacy: string | null; pending: PendingRequests; snapshot: StreamSnapshot; lifecycle?: ChannelLifecycle; shared?: SharedRequests;
  members: Map<string, Member>; aliases: Set<string>; files: Set<string>;
  decoder: RpcFrameDecoder; physical: string[]; commands: Map<string, DaemonLink | null>;
  internal: Map<string, { resolve(frame: RpcFrameRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  ready: Promise<RpcFrameRecord | null>; noteReady(frame: RpcFrameRecord | null): void; readyTimer: NodeJS.Timeout;
  startup: Promise<void>; exited: boolean; opened: boolean; fullFallback: boolean; forceTimer?: NodeJS.Timeout;
  identityRefresh?: Promise<void>;
};
type ChannelDeps = {
  spawn(launch: SpawnRequest): Promise<SpawnResult>;
  prepareLaunch(launch: SpawnRequest): SpawnRequest;
  sessionId?(file: string): string | null;
  autoApproveExtension?(): boolean;
  log(message: string): void;
  runningChanged?(): void;
  sessionsChanged?(): void;
  channelsChanged?(ch: string): void;
};
const collision = () => new HostOpError(409, "session_running_elsewhere", "This session is already running on another link");
const invalid = (message = "Invalid channel request") => new HostOpError(400, "invalid_request", message);

export class ChannelTable {
  private readonly channels = new Map<string, Channel>();
  private readonly spawning = new Map<string, Promise<Channel>>();
  private readonly pendingSpawns = new Set<Promise<Channel>>();
  private readonly reservedChannels = new Set<string>();
  private readonly mutating = new Map<string, Promise<void>>();
  private readonly goneLinks = new Set<string>();
  private spawningCount = 0;
  private commandId = 0;
  private stopped = false;
  constructor(private readonly deps: ChannelDeps) {}
  get size(): number { return this.channels.size; }
  get spawnsInFlight(): number { return this.spawningCount; }

  private identity(launch: SpawnRequest): string | null {
    return launch.sessionFile ? (this.deps.sessionId?.(launch.sessionFile) ?? readSessionHeaderSync(launch.sessionFile)?.id ?? null) : null;
  }
  private find(id: string | null, file: string): Channel | undefined {
    return [...this.channels.values()].find(channel => (id !== null && channel.aliases.has(id)) || (file !== "" && channel.files.has(file)));
  }

  async open(link: DaemonLink, args: OpenChannelRequest): Promise<OpenChannelResult> {
    if (this.goneLinks.has(link.id)) throw new HostOpError(503, "host_link_closed", "The host link closed during open");
    if (link.version < 7) throw invalid("open requires link protocol v7");
    if (!isRecord(args) || !(args.sessionId === null || typeof args.sessionId === "string" && isValidSessionId(args.sessionId)) || !isRecord(args.launch)) throw invalid();
    const channel = await this.ensure(args.sessionId, args.launch as unknown as SpawnRequest, null);
    if (this.goneLinks.has(link.id)) throw new HostOpError(503, "host_link_closed", "The host link closed during open");
    if (channel.exited || (args.sessionId !== null && this.mutating.has(args.sessionId)) || this.mutating.has(args.launch.sessionFile)) return this.open(link, args);
    const joined = channel.opened;
    channel.opened = true;
    this.join(channel, link);
    return this.snapshot(channel, link, joined);
  }

  private pendingFor(channel: Channel, link: DaemonLink): string[] | null {
    const pending = channel.shared?.pending(link.id) ?? channel.pending.lines();
    return pending && pending.reduce((sum, line) => sum + Buffer.byteLength(line), 0) <= LINK_LIMITS.pendingBytes ? pending : null;
  }
  private snapshot(channel: Channel, link: DaemonLink, joined: boolean): OpenChannelResult {
    return { ch: channel.ch, joined, pending: this.pendingFor(channel, link), streaming: channel.snapshot.whole(), cwd: channel.cwd,
      fellBack: channel.fellBack, launchAdvisor: channel.launchAdvisor, autoApproveExtension: this.deps.autoApproveExtension?.() ?? false };
  }

  async spawnLegacy(link: DaemonLink, args: SpawnRequest & { ch: string }): Promise<Omit<OpenChannelResult, "ch" | "joined" | "pending" | "streaming">> {
    if (this.goneLinks.has(link.id)) throw new HostOpError(503, "host_link_closed", "The host link is closed");
    if (typeof args.ch !== "string" || !args.ch || this.channels.has(args.ch) || this.reservedChannels.has(args.ch)) throw invalid("Invalid channel id");
    this.reservedChannels.add(args.ch);
    let channel: Channel;
    try { channel = await this.ensure(null, args, link.id, args.ch); }
    finally { this.reservedChannels.delete(args.ch); }
    if (this.goneLinks.has(link.id)) {
      this.stopChannel(channel);
      throw new HostOpError(503, "host_link_closed", "The host link closed during spawn");
    }
    if (channel.members.size > 0 && !channel.members.has(link.id)) throw collision();
    this.join(channel, link);
    this.release(link, channel.ch);
    return { cwd: channel.cwd, fellBack: channel.fellBack, launchAdvisor: channel.launchAdvisor, autoApproveExtension: this.deps.autoApproveExtension?.() ?? false };
  }

  private async ensure(id: string | null, requested: SpawnRequest, legacy: string | null, ch?: string): Promise<Channel> {
    const launch = this.deps.prepareLaunch(requested);
    const file = launch.sessionFile;
    const identity = id ?? this.identity(launch);
    const mutation = (identity === null ? undefined : this.mutating.get(identity)) ?? this.mutating.get(file);
    if (mutation) { await mutation; return this.ensure(id, requested, legacy, ch); }
    const existing = this.find(identity, file);
    if (existing) {
      if (legacy !== null || existing.legacy !== null) throw collision();
      await existing.startup;
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, legacy, ch);
      if (existing.exited) return this.ensure(id, requested, legacy, ch);
      return existing;
    }
    const key = identity ?? (file || null);
    const pending = key === null ? undefined : this.spawning.get(key);
    if (pending) {
      const channel = await pending;
      if (legacy !== null || channel.legacy !== null) throw collision();
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, legacy, ch);
      if (channel.exited) return this.ensure(id, requested, legacy, ch);
      return channel;
    }
    const refreshing = [...this.channels.values()].flatMap(channel => channel.identityRefresh ? [channel.identityRefresh] : []);
    if (refreshing.length > 0) { await Promise.all(refreshing); return this.ensure(id, requested, legacy, ch); }
    if (id !== null && file === "") throw new HostOpError(404, "session_not_running", "The session listed by the host is no longer running");
    // The header and requested identity must agree; aliases are accepted only for a running channel.
    const headerId = this.identity(launch);
    if (id !== null && headerId === null) throw new HostOpError(404, "session_not_found", "The session launch file no longer exists");
    if (id !== null && headerId !== null && headerId !== id) throw invalid("Session identity does not match its launch file");
    const spawn = this.create(launch, identity, legacy, ch);
    this.pendingSpawns.add(spawn);
    if (key !== null) this.spawning.set(key, spawn);
    try {
      const channel = await spawn;
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, legacy, ch);
      return channel;
    }
    finally {
      this.pendingSpawns.delete(spawn);
      if (key !== null && this.spawning.get(key) === spawn) this.spawning.delete(key);
    }
  }

  private async create(launch: SpawnRequest, identity: string | null, legacy: string | null, requestedCh?: string): Promise<Channel> {
    this.spawningCount++;
    try {
      if (this.stopped) throw new HostOpError(503, "host_stopping", "ompweb host is stopping");
      const spawned = await this.deps.spawn(launch);
      if (this.stopped) { spawned.transport.killTree(true); throw new HostOpError(503, "host_stopping", "ompweb host is stopping"); }
      const { promise: ready, resolve: noteReady } = Promise.withResolvers<RpcFrameRecord | null>();
      const readyTimer = setTimeout(() => noteReady(null), 5000); readyTimer.unref?.();
      const ch = requestedCh ?? randomUUID();
      const channel: Channel = { ...spawned, ch, launch, legacy, pending: new PendingRequests(LINK_LIMITS.pendingBytes, identity), snapshot: new StreamSnapshot(),
        members: new Map(), aliases: new Set(identity ? [identity] : []), files: new Set(launch.sessionFile ? [launch.sessionFile] : []),
        decoder: new RpcFrameDecoder(), physical: [], commands: new Map(), internal: new Map(), ready, noteReady, readyTimer,
        startup: Promise.resolve(), exited: false, opened: false, fullFallback: false };
      this.channels.set(ch, channel);
      if (legacy === null) {
        channel.lifecycle = new ChannelLifecycle({ stop: reason => { this.deps.log(`channel ${ch}: stopping (${reason})`); this.stopChannel(channel); }, onRunning: () => this.deps.runningChanged?.() });
        channel.shared = new SharedRequests({ members: () => [...channel.members.keys()], isUp: id => channel.members.get(id)?.link.isUp() ?? false,
          deliver: (id, lines) => { const member = channel.members.get(id); if (member) for (const line of lines) this.deliver(channel, member, { type: "stdout", ch, line }); },
          write: frame => { void this.command(channel, frame).catch(error => this.deps.log(`channel ${ch}: ${String(error)}`)); } });
      }
      spawned.transport.onLine(line => this.stdout(channel, line));
      spawned.transport.onStderr(chunk => this.broadcast(channel, { type: "stderr", ch, chunk }));
      spawned.transport.onExit((code, signal) => {
        channel.exited = true; clearTimeout(channel.readyTimer); channel.noteReady(null); clearTimeout(channel.forceTimer);
        channel.lifecycle?.dispose(); channel.snapshot.clear();
        for (const pending of channel.internal.values()) { clearTimeout(pending.timer); pending.reject(new Error("omp exited")); }
        channel.internal.clear(); channel.commands.clear(); this.channels.delete(ch);
        this.broadcast(channel, { type: "exit", ch, code, signal }); this.deps.runningChanged?.();
        this.deps.channelsChanged?.(ch);
      });
      if (legacy === null) channel.startup = this.configure(channel).finally(() => channel.lifecycle?.setStartup(false));
      else { clearTimeout(readyTimer); noteReady(null); }
      await channel.startup;
      if (channel.exited) throw new HostOpError(502, "host_process_exited", "omp exited during startup");
      this.deps.sessionsChanged?.();
      return channel;
    } finally { this.spawningCount--; }
  }

  private async configure(channel: Channel): Promise<void> {
    const ready = await channel.ready; clearTimeout(channel.readyTimer);
    if (channel.exited) return;
    const supported = ready?.supportedProtocolVersions;
    const supportsV2 = Array.isArray(supported) && supported.includes(2);
    let delta = false;
    if (supportsV2) {
      try { const reply = await this.command(channel, { type: "negotiate_protocol", protocolVersion: 2 }); delta = isRecord(reply.data) && reply.data.protocolVersion === 2; }
      catch { /* Older omp stays on full updates. */ }
    }
    try { await this.command(channel, { type: "set_event_filter", events: null, messageUpdates: delta ? "delta" : "full" }); }
    catch { if (delta) await this.command(channel, { type: "set_event_filter", events: null, messageUpdates: "full" }).catch(() => {}); }
    await this.command(channel, { type: "set_subagent_subscription", level: "events" }).catch(() => {});
    await this.command(channel, { type: "set_ask_dialog", enabled: true }).catch(() => {});
    await this.command(channel, { type: "get_state" }).catch(() => {});
  }

  private command(channel: Channel, frame: RpcFrameRecord): Promise<RpcFrameRecord> {
    if (channel.exited) return Promise.reject(new Error("omp exited"));
    const id = `d:${++this.commandId}`, command = { ...frame, id };
    let line: string;
    try { line = encodeRpcCommand(command); } catch (error) { return Promise.reject(error); }
    const { promise, resolve, reject } = Promise.withResolvers<RpcFrameRecord>();
    const timer = setTimeout(() => { channel.internal.delete(id); channel.lifecycle?.forgetCommand(id); reject(new Error(`omp ${frame.type} timed out`)); }, 5000); timer.unref?.();
    channel.internal.set(id, { resolve, reject, timer }); channel.lifecycle?.noteStdin(command);
    channel.transport.write(line, error => {
      if (error) { const pending = channel.internal.get(id); if (!pending) return; clearTimeout(pending.timer); channel.internal.delete(id); channel.lifecycle?.forgetCommand(id); reject(error); }
    });
    return promise;
  }

  private refreshIdentity(channel: Channel): void {
    if (channel.identityRefresh || channel.exited) return;
    const request = channel.opened ? this.command(channel, { type: "get_state" }) : channel.startup.then(() => this.command(channel, { type: "get_state" }));
    channel.identityRefresh = request.then(() => {})
      .catch(error => this.deps.log(`channel ${channel.ch}: could not refresh identity: ${String(error)}`))
      .finally(() => { channel.identityRefresh = undefined; });
  }

  private stdout(channel: Channel, line: string): void {
    if (channel.legacy !== null) {
      channel.pending.noteStdout(line);
      if (channel.pending.sessionId) channel.aliases.add(channel.pending.sessionId);
      this.broadcast(channel, { type: "stdout", ch: channel.ch, line }); return;
    }
    let frame: RpcFrameRecord | undefined;
    try { frame = channel.decoder.push(JSON.parse(line)); channel.physical.push(line); }
    catch {
      channel.decoder = new RpcFrameDecoder(); channel.physical = [];
      for (const member of channel.members.values()) member.link.queue({ type: "resync", ch: channel.ch }, channel.ch);
      return;
    }
    if (!frame) return;
    const physical = channel.physical; channel.physical = [];
    if (frame.type === "ready") channel.noteReady(frame);
    if (channel.shared?.isCompleted(frame)) return;
    channel.lifecycle?.noteStdout(frame);
    if (!channel.snapshot.note(frame) && !channel.fullFallback) {
      channel.fullFallback = true;
      void this.command(channel, { type: "set_event_filter", events: null, messageUpdates: "full" }).catch(() => {});
    }
    if (frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
      const id = frame.data.sessionId;
      if (typeof id === "string" && isValidSessionId(id) && id !== channel.pending.sessionId) {
        channel.pending.sessionId = id; channel.aliases.add(id); if (channel.opened) this.deps.channelsChanged?.(channel.ch);
      }
      if (typeof frame.data.sessionFile === "string") { try { const launch = this.deps.prepareLaunch({ ...channel.launch, sessionFile: frame.data.sessionFile }); channel.launch = launch; channel.files.add(launch.sessionFile); } catch { /* Never trust an out-of-root native path. */ } }
      this.deps.runningChanged?.();
    }
    if (frame.type === "agent_start" || (frame.type === "notice" && frame.source === "session-persistence")) this.refreshIdentity(channel);
    if (frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "session_info_update") this.deps.sessionsChanged?.();
    if (frame.type === "response" && typeof frame.id === "string") {
      if (frame.id.startsWith("d:")) {
        const pending = channel.internal.get(frame.id);
        if (pending) { clearTimeout(pending.timer); channel.internal.delete(frame.id); if (frame.success === false) pending.reject(new Error(String(frame.error ?? "omp command failed"))); else pending.resolve(frame); }
        return;
      }
      if (channel.commands.has(frame.id)) {
        const owner = channel.commands.get(frame.id); channel.commands.delete(frame.id);
        const member = owner && channel.members.get(owner.id);
        if (member) for (const line of physical) this.deliver(channel, member, { type: "stdout", ch: channel.ch, line });
        return;
      }
    }
    if (channel.shared?.note(frame, physical) === false) return;
    for (const line of physical) this.broadcast(channel, { type: "stdout", ch: channel.ch, line });
  }

  private join(channel: Channel, link: DaemonLink): void {
    const member = channel.members.get(link.id);
    link.discard(channel.ch);
    if (member) { member.paused = true; member.opens++; member.queued = []; member.bytes = 0; member.resync = false; }
    else {
      channel.members.set(link.id, { link, paused: true, opens: 1, queued: [], bytes: 0, resync: false });
      channel.lifecycle?.setInterest(link.id, false);
    }
  }

  /** Called only after the open result has been queued under this channel's key. */
  release(link: DaemonLink, ch: string): void {
    const channel = this.channels.get(ch), member = channel?.members.get(link.id);
    if (!channel || !member) return;
    member.opens = Math.max(0, member.opens - 1);
    if (member.opens > 0) return;
    member.paused = false;
    if (member.resync) link.queue({ type: "resync", ch }, ch);
    else for (const body of member.queued) this.deliver(channel, member, body);
    member.queued = []; member.bytes = 0; member.resync = false;
  }

  private deliver(channel: Channel, member: Member, body: Output): void {
    if (member.paused) {
      member.bytes += Buffer.byteLength(JSON.stringify(body));
      if (member.bytes > LINK_LIMITS.channelBufferBytes) { member.queued = []; member.resync = true; }
      else if (!member.resync) member.queued.push(body);
    } else if (body.type === "exit") member.link.queue(body, channel.ch);
    else member.link.output(body, channel.pending.sessionId);
  }
  private broadcast(channel: Channel, body: Output): void { for (const member of channel.members.values()) this.deliver(channel, member, body); }
  private member(link: DaemonLink, ch: string): Channel {
    const channel = this.channels.get(ch);
    if (!channel || !channel.members.has(link.id)) throw new HostOpError(403, "channel_not_joined", "This link has not joined the channel");
    return channel;
  }

  stdin(link: DaemonLink, ch: string, line: string): void {
    const channel = this.member(link, ch);
    if (channel.legacy !== null) { channel.pending.noteStdin(line); channel.transport.write(line, () => {}); return; }
    let parsed: unknown; try { parsed = JSON.parse(line); } catch { throw invalid("Invalid RPC command"); }
    if (!isRecord(parsed) || typeof parsed.type !== "string") throw invalid("Invalid RPC command");
    const frame = parsed as RpcFrameRecord;
    if (["set_event_filter", "negotiate_protocol", "set_subagent_subscription", "set_ask_dialog", "set_host_tools", "set_host_uri_schemes"].includes(frame.type)) throw invalid("This command is owned by the host daemon");
    if (["extension_ui_response", "host_tool_result", "host_uri_result"].includes(frame.type)) {
      if (!channel.shared?.answer(link.id, frame)) return;
    } else if (typeof frame.id === "string") {
      if (frame.id.startsWith("d:") || channel.commands.has(frame.id)) throw invalid("RPC command id is already outstanding or reserved");
      channel.commands.set(frame.id, link);
    }
    if (["prompt", "steer", "follow_up", "followUp"].includes(frame.type)) channel.shared?.prompt(link.id);
    channel.lifecycle?.noteStdin(frame);
    channel.transport.write(line.endsWith("\n") ? line : line + "\n", error => {
      if (!error || typeof frame.id !== "string") return;
      channel.commands.delete(frame.id); channel.lifecycle?.forgetCommand(frame.id);
      const member = channel.members.get(link.id);
      if (member) this.deliver(channel, member, { type: "stdout", ch, line: JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: false, error: error.message }) });
    });
  }
  setInterest(link: DaemonLink, ch: string, on: boolean, preparing: boolean): void {
    const channel = this.member(link, ch); channel.lifecycle?.setInterest(link.id, on); channel.lifecycle?.setPreparing(link.id, preparing);
  }
  setTools(link: DaemonLink, ch: string, tools: unknown[], schemes: string[]): void { this.member(link, ch).shared?.setTools(link.id, tools, schemes); }
  kill(link: DaemonLink, ch: string, force: boolean): void { const channel = this.member(link, ch); if (force) channel.transport.killTree(true); else this.stopChannel(channel); }
  close(link: DaemonLink, ch: string): void {
    const channel = this.member(link, ch); channel.members.delete(link.id); channel.lifecycle?.linkGone(link.id); channel.shared?.remove(link.id);
    link.discard(ch);
    for (const [id, owner] of channel.commands) if (owner?.id === link.id) channel.commands.set(id, null);
  }
  linkDown(link: DaemonLink): void { for (const channel of this.channels.values()) { channel.lifecycle?.linkDown(link.id); channel.shared?.linkChanged(); } }
  linkUp(link: DaemonLink): void { for (const channel of this.channels.values()) { channel.lifecycle?.linkUp(link.id); channel.shared?.linkChanged(); } }
  linkGone(link: DaemonLink): void {
    this.goneLinks.add(link.id);
    for (const channel of this.channels.values()) {
      if (channel.members.has(link.id)) this.close(link, channel.ch);
      // Legacy servers own their timers; an exclusive channel has no owner after permanent removal.
      if (channel.legacy === link.id) this.stopChannel(channel);
    }
  }
  members(ch: string): DaemonLink[] { return [...(this.channels.get(ch)?.members.values() ?? [])].map(member => member.link); }
  listing(link: DaemonLink, replay = true): HelloChannel[] {
    return [...this.channels.values()].filter(channel => link.version >= 7 ? channel.legacy === null || channel.legacy === link.id : channel.legacy === link.id)
      .map(channel => ({ ch: channel.ch, sessionId: channel.pending.sessionId, cwd: channel.cwd, pending: replay ? this.pendingFor(channel, link) : null }));
  }
  running(): HostResumeEntry[] {
    return [...this.channels.values()].filter(channel => channel.lifecycle?.isRunning && channel.pending.sessionId && channel.launch.sessionFile)
      .map(channel => ({ sessionId: channel.pending.sessionId!, launch: channel.launch }));
  }
  async recover(entries: HostResumeEntry[]): Promise<void> {
    await Promise.all(entries.map(async entry => {
      const channel = await this.ensure(entry.sessionId, entry.launch, null);
      channel.opened = true;
      this.deps.channelsChanged?.(channel.ch);
      await this.command(channel, { type: "prompt", message: RESUME_PROMPT });
    }));
  }
  async mutateSession<T>(id: string, action: (canonicalId: string, liveIds: string[]) => Promise<T>): Promise<T> {
    if (!isValidSessionId(id)) throw invalid("Invalid session id");
    while (this.mutating.has(id)) await this.mutating.get(id);
    const { promise, resolve } = Promise.withResolvers<void>();
    const keys = new Set([id]);
    const protect = (channel?: Channel) => {
      for (const key of [...(channel?.aliases ?? []), ...(channel?.files ?? [])]) keys.add(key);
      for (const key of keys) this.mutating.set(key, promise);
    };
    let channel = this.find(id, "");
    protect(channel);
    try {
      if (!channel) channel = await this.spawning.get(id)?.catch(() => undefined);
      if (!channel) {
        await Promise.all([...this.channels.values()].flatMap(live => live.identityRefresh ? [live.identityRefresh] : []));
        channel = this.find(id, "");
      }
      protect(channel);
      const canonicalId = channel?.pending.sessionId ?? id;
      if (channel && !channel.exited) {
        const exit = Promise.withResolvers<void>();
        channel.transport.onExit(() => exit.resolve()); this.stopChannel(channel); await exit.promise;
      }
      const liveIds = [...this.channels.values()].flatMap(live => [...live.aliases]);
      return await action(canonicalId, liveIds);
    } finally {
      for (const key of keys) if (this.mutating.get(key) === promise) this.mutating.delete(key);
      resolve();
    }
  }

  private stopChannel(channel: Channel): void {
    channel.transport.killTree(false); clearTimeout(channel.forceTimer);
    if (!channel.exited) { channel.forceTimer = setTimeout(() => channel.transport.killTree(true), 5000); channel.forceTimer.unref?.(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const exits = [...this.channels.values()].map(channel => {
      if (channel.exited) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      channel.transport.onExit(() => resolve()); this.stopChannel(channel);
      return promise;
    });
    await Promise.all([...exits, ...[...this.pendingSpawns].map(spawn => spawn.catch(() => {}))]);
  }
}
