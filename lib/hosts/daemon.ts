// Node-safe coordinator: one daemon/process table, independent server links.
import { lstatSync, realpathSync, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getOmpVersion } from "../omp/omp-cli";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import { ProjectPathError } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import { readHostLinks, readHostLogin, type HostLink } from "./host-login";
import { DaemonLink, dialable, nextRedialDelay } from "./daemon-link";
import { ChannelTable } from "./daemon-channels";
import { HostResumeTracker, type HostResumeEntry } from "./host-resume";
import type { SpawnRequest } from "./host";
import { encodeLine, HostOpError, isHostOp, LINK_LIMITS, SESSION_OP_PARAMS, type DownMessage, type OpenChannelRequest, type UnknownMessage } from "./link-protocol";
import { localHost, resolveSpawnCwdResult } from "./local-host";
import { sessionOps } from "./session-ops";
import packageJson from "../../package.json";
import { checkHostUpdates, configureHostUpdateSafety, getHostUpdateOperation, HostUpdateError, startHostUpdate } from "./updates";
import type { HostUpdateCompatibility, HostUpdateOperation } from "./update-types";
import { UploadRetention } from "./upload-retention";
import { StagedUploads, UPLOAD_SWEEP_INTERVAL_MS } from "./uploads";
import { isWorkspaceOp, WORKSPACE_OP_PARAMS, type WorkspaceOps } from "../workspace-types";
import { createWorkspaceService } from "./workspace-ops";
import { grantWorkspaceRoot, invalidateWorkspaceRoots } from "./workspace-roots";
export { nextRedialDelay };
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const log = (message: string) => console.error("[ompweb host] " + message);
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

function updateCompatibility(value: unknown): HostUpdateCompatibility {
  if (!isRecord(value) || !Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max)
    || Number(value.min) < 1 || Number(value.max) < Number(value.min)) {
    throw new HostOpError(400, "invalid_request", "Invalid web-server protocol range");
  }
  return { min: Number(value.min), max: Number(value.max) };
}

type DaemonOptions = { allowHttp: boolean; url?: string; token?: string; links?: HostLink[] };
export function runHostDaemon(options: DaemonOptions): { stop(): Promise<void>; done: Promise<number> } {
  const explicit = options.url !== undefined && options.token !== undefined ? [{ url: options.url, token: options.token }] : options.links;
  const initial = explicit ?? readHostLinks();
  for (const link of initial) if (!dialable(link.url, options.allowHttp)) throw new Error("ompweb host needs an https:// server URL (http:// only for loopback, or with --allow-http)");
  const primaryUrl = (explicit?.[0]?.url ?? readHostLogin()?.url ?? initial[0]?.url)?.replace(/\/+$/, "");
  const links = new Map<string, DaemonLink>();
  const ended = new Map<string, string>();
  const services = new Map<string, { ops: WorkspaceOps; onDisconnect(): void; stop(): Promise<void> }>();
  const uploadOwners = new Map<string, { link: DaemonLink; attempt: string }>();
  const uploadAttempts = new Map<string, DaemonLink>();
  const stops = new Set<Promise<void>>();
  const { promise: done, resolve: finish } = Promise.withResolvers<number>();
  let stopped = false, linkId = 0, notifierId: string | null = null, ompVersion: string | null = null;
  let stopping: Promise<void> | undefined;
  let updateStateWarningLogged = false;
  let reloadTimer: NodeJS.Timeout | undefined;
  const resume = new HostResumeTracker();
  const channels = new ChannelTable({
    spawn: async launch => {
      let operation: HostUpdateOperation | null = null;
      try { operation = getHostUpdateOperation(); }
      catch (error) { if (!updateStateWarningLogged) log("could not read host update status: " + reason(error)); updateStateWarningLogged = true; }
      if (operation?.target === "ompweb" && operation.state === "running") throw new HostOpError(409, "host_updating", "This host is updating its daemon; new sessions must wait");
      const resolved = resolveSpawnCwdResult(launch.recordedCwd ?? launch.cwd);
      const spawned = await localHost.spawnRpc({ ...launch, cwd: resolved.cwd });
      return { ...spawned, fellBack: resolved.fellBack || spawned.fellBack };
    },
    prepareLaunch: launch => {
      if (!isRecord(launch) || typeof launch.cwd !== "string"
        || !(launch.recordedCwd === null || launch.recordedCwd === undefined || typeof launch.recordedCwd === "string")
        || typeof launch.sessionFile !== "string" || typeof launch.advisor !== "boolean"
        || !(launch.toolNames === undefined || Array.isArray(launch.toolNames) && launch.toolNames.every(name => typeof name === "string"))
        || !(launch.spawnModel === undefined || typeof launch.spawnModel === "string")) throw new HostOpError(400, "invalid_request", "Invalid spawn request");
      return { ...launch, recordedCwd: launch.recordedCwd ?? null, sessionFile: launch.sessionFile ? sessionsPath(launch.sessionFile) : "" };
    },
    autoApproveExtension: () => localHost.autoApproveExtension(), log,
    runningChanged: () => { try { resume.recordRunning(channels.running()); } catch (error) { log("could not save interrupted sessions: " + reason(error)); } },
    sessionsChanged,
    channelsChanged,
  });
  configureHostUpdateSafety(() => channels.size > 0 || channels.spawnsInFlight > 0
    ? "Close this host's sessions before updating its daemon; sessions and subagents must not be interrupted." : null);
  const uploads = new StagedUploads(ack => {
    const link = uploadAttempts.get(ack.id + ":" + ack.attempt);
    link?.queue({ type: "upload_ack", ...ack }, "up:" + ack.id);
  });
  const uploadRetention = new UploadRetention(); void uploadRetention.start(); void uploads.sweep();
  const sweepTimer = setInterval(() => void uploads.sweep(), UPLOAD_SWEEP_INTERVAL_MS); sweepTimer.unref?.();
  const configDir = join(getAgentDir(), "omp-web"); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const watcher = watch(configDir, (_event, name) => {
    if (name !== null && String(name) !== "host.json") return;
    clearTimeout(reloadTimer); reloadTimer = setTimeout(() => reconcile(), 200); reloadTimer.unref?.();
  }); watcher.unref();
  watcher.on("error", error => log("host.json watch: " + reason(error)));

  function sessionsChanged(): void {
    localHost.invalidateSessionLists(); invalidateWorkspaceRoots();
    if (!stopped) for (const link of links.values()) if (link.version >= 7) link.queue({ type: "sessions_changed" }, "sessions");
  }
  function channelsChanged(ch: string): void {
    if (stopped) return;
    for (const link of links.values()) if (link.version >= 7 && link.isUp()) {
      link.queue({ type: "channels_changed", channels: channels.listing(link) }, ch);
    }
  }
  function electNotifier(): void {
    const next = [...links.values()].find(link => link.version >= 7 && link.isUp())?.id ?? null;
    if (next === notifierId) return;
    const old = notifierId; notifierId = next;
    for (const link of links.values()) if (link.version >= 7 && (link.id === old || link.id === next)) link.queue({ type: "notifier", on: link.id === next }, "notifier");
  }
  /** Stops a removed link's workspace service (tracked so shutdown awaits it) and frees its upload ownership so other servers can take those uploads. */
  function dropLink(link: DaemonLink): void {
    const service = services.get(link.id); services.delete(link.id);
    if (service) { const stop: Promise<void> = service.stop().catch(error => log("could not stop a workspace service: " + reason(error))).finally(() => stops.delete(stop)); stops.add(stop); }
    for (const [id, owner] of uploadOwners) if (owner.link === link) uploadOwners.delete(id);
    for (const [key, owner] of uploadAttempts) if (owner === link) uploadAttempts.delete(key);
  }
  function makeLink(login: HostLink, primary: boolean): DaemonLink {
    const link = new DaemonLink(login, "l" + ++linkId, { allowHttp: options.allowHttp, primary, log,
      hello: (link, replay) => encodeLine({ type: "hello", v: link.version, ompVersion, ompwebVersion: packageJson.version,
        workspaceOps: Object.keys(WORKSPACE_OP_PARAMS), platform: process.platform, home: homedir(), autoApproveExtension: localHost.autoApproveExtension(),
        ack: link.ackedDown, channels: channels.listing(link, replay),
        ...(link.version >= 7 ? { link: { id: link.id, notifier: notifierId === link.id } } : {}) }),
      handleDown,
      onState: (link, up) => {
        if (up) {
          channels.linkUp(link);
          if (link.version >= 7) link.queue({ type: "channels_changed", channels: channels.listing(link, false) }, "channels");
        } else {
          services.get(link.id)?.onDisconnect();
          channels.linkDown(link);
        }
        electNotifier();
      },
      onBlob: (link, id, bytes) => { if (uploadOwners.get(id)?.link === link) uploads.write(id, bytes); },
      reload: (source, unauthorized) => reconcile(source, unauthorized),
      onEnd: (link, why) => {
        if (links.get(login.url) !== link) return;
        links.delete(login.url); ended.set(login.url, login.token); channels.linkGone(link);
        dropLink(link); electNotifier();
        if (links.size === 0) { log(why === "revoked" ? "the server rejected this host's token (revoked?); stopping its omp sessions" : "the last host link ended"); void shutdown(why === "replaced" ? 0 : 1); }
      },
    });
    services.set(link.id, createWorkspaceService(uploads, (id, epoch, event) => link.queue({ type: "workspace_file", id, epoch, event }, "watch:" + id)));
    links.set(login.url, link); return link;
  }

  function reconcile(source?: DaemonLink, unauthorized = false): boolean {
    if (stopped) return false;
    const previousToken = source?.login.token;
    let saved: HostLink[];
    try { saved = readHostLinks(); } catch (error) { log("could not reload host.json: " + reason(error)); return false; }
    if (unauthorized) {
      if (!source) return false;
      const fresh = saved.find(login => login.url === source.login.url && login.token !== source.login.token);
      if (!fresh || !dialable(fresh.url, options.allowHttp)) return false;
      log("the server rejected this host's token; using the new one from host.json");
      saved = [...links.values()].map(link => link === source ? fresh : link.login);
    } else if (explicit && saved.length === 0) return false;
    if (saved.some(login => !dialable(login.url, options.allowHttp))) return false;
    const wanted = new Map(saved.map(login => [login.url.replace(/\/+$/, ""), login]));
    for (const [url, link] of links) {
      const login = wanted.get(url);
      if (login?.token === link.login.token) continue;
      if (login) { link.rekey(login.token); continue; }
      links.delete(url); channels.linkGone(link); dropLink(link); void link.stop();
    }
    for (const login of wanted.values()) {
      if (links.has(login.url) || ended.get(login.url) === login.token) continue;
      log("host.json changed; dialing " + login.url);
      const link = makeLink(login, login.url === (readHostLogin()?.url.replace(/\/+$/, "") ?? saved[0]?.url)); link.start();
    }
    electNotifier(); return source ? links.get(source.login.url) !== source || source.login.token !== previousToken : true;
  }

  function handleDown(link: DaemonLink, message: DownMessage | UnknownMessage): void {
    try {
      switch (message.type) {
        case "stdin": channels.stdin(link, message.ch, message.line); return;
        case "kill": channels.kill(link, message.ch, message.force); return;
        case "interest": channels.setInterest(link, message.ch, message.on, message.preparing); return;
        case "host_tools": channels.setTools(link, message.ch, message.tools, message.schemes); return;
        case "req": void answer(link, message.id, message.op, message.args); return;
      }
    } catch (error) { log("ignored a channel command: " + reason(error)); }
  }
  async function answer(link: DaemonLink, id: string, op: string, args: unknown): Promise<void> {
    const session = isRecord(args) && typeof args.id === "string" && isValidSessionId(args.id) ? args.id : null;
    let opened: string | undefined;
    try {
      const result = await runOp(link, op, args);
      if (op === "open" && isRecord(result) && typeof result.ch === "string") opened = result.ch;
      const media = (op === "readMedia" || op === "readFileChunk") && isRecord(result) && result.ok === true && result.value instanceof Uint8Array ? result.value : null;
      if (media && media.byteLength > LINK_LIMITS.blobBytes) throw new HostOpError(413, "result_too_large", "The result is too large for the host link");
      link.result(id, result, { session, key: opened, media });
      if (opened) { channelsChanged(opened); channels.release(link, opened); }
    } catch (error) {
      if (opened) channels.close(link, opened);
      const failure = error instanceof HostOpError ? { status: error.status, code: error.code, message: error.message }
        : error instanceof HostUpdateError ? { status: error.httpStatus, code: error.code, message: error.message }
        : error instanceof ProjectPathError ? { status: 400, code: error.code, message: error.message }
        : { status: 500, code: "host_op_failed", message: reason(error) };
      link.queue({ type: "res", id, ok: false, error: failure }, id, { session });
    }
  }
  function requireUploadOwner(link: DaemonLink, id: unknown): void {
    const owner = typeof id === "string" ? uploadOwners.get(id) : undefined;
    if (owner && owner.link !== link) throw new HostOpError(409, "upload_running_elsewhere", "Another server owns this upload attempt");
  }
  async function runOp(link: DaemonLink, op: string, args: unknown): Promise<unknown> {
    if (!isHostOp(op)) throw new HostOpError(501, "unknown_op", "Unknown host op: " + op);
    if (!isRecord(args)) throw new HostOpError(400, "invalid_request", "Host op arguments must be an object");
    if (isWorkspaceOp(op)) {
      if (op === "publishUpload") requireUploadOwner(link, args.id);
      const run = services.get(link.id)!.ops[op] as (...values: unknown[]) => Promise<unknown>;
      return run(...WORKSPACE_OP_PARAMS[op].map(name => args[name]));
    }
    switch (op) {
      case "spawn": return channels.spawnLegacy(link, args as unknown as SpawnRequest & { ch: string });
      case "open": return channels.open(link, args as unknown as OpenChannelRequest);
      case "close": if (typeof args.ch !== "string") throw new HostOpError(400, "invalid_request", "Invalid channel id"); channels.close(link, args.ch); return {};
      case "editLease": if (typeof args.ch !== "string" || typeof args.on !== "boolean") throw new HostOpError(400, "invalid_request", "Invalid edit lease"); channels.editLease(link, args.ch, args.on); return {};
      case "deleteSession":
      case "archiveSession": {
        if (typeof args.id !== "string") throw new HostOpError(400, "invalid_request", "Invalid session id");
        const result = await channels.mutateSession<unknown>(args.id, (id, liveIds) => op === "deleteSession"
          ? sessionOps.deleteSession(id, [...new Set([...(Array.isArray(args.liveSessionIds) ? args.liveSessionIds.filter((value): value is string => typeof value === "string") : []), ...liveIds])])
          : sessionOps.archiveSession(id));
        if (!(isRecord(result) && result.ok === false)) sessionsChanged();
        return result;
      }
      case "sessionFileExists": return localHost.sessionFileExists(sessionsPath(args.path));
      case "invalidateSessionLists": invalidateWorkspaceRoots(); localHost.invalidateSessionLists(args.path === undefined ? undefined : sessionsPath(args.path)); sessionsChanged(); return;
      case "checkUpdates":
        if (args.force !== undefined && typeof args.force !== "boolean") throw new HostOpError(400, "invalid_request", "force must be a boolean");
        return checkHostUpdates(updateCompatibility(args.compatibility), args.force === true);
      case "updateSoftware":
        if ((args.target !== "ompweb" && args.target !== "omp") || typeof args.version !== "string") throw new HostOpError(400, "invalid_request", "Invalid host update");
        return startHostUpdate(args.target, args.version, updateCompatibility(args.compatibility));
      case "validateCwd": {
        if (typeof args.path !== "string") throw new HostOpError(400, "invalid_request", "Invalid workspace path");
        const selected = await sessionOps.validateCwd(args.path); if (selected.ok) grantWorkspaceRoot(selected.value.cwd); return selected;
      }
      case "uploadStart": {
        requireUploadOwner(link, args.id);
        const old = typeof args.id === "string" ? uploadOwners.get(args.id) : undefined;
        if (typeof args.id === "string" && typeof args.attempt === "string") { uploadOwners.set(args.id, { link, attempt: args.attempt }); uploadAttempts.set(args.id + ":" + args.attempt, link); }
        try { return await uploads.start(args); }
        catch (error) {
          if (typeof args.id === "string" && uploadOwners.get(args.id)?.attempt === args.attempt) {
            if (old) uploadOwners.set(args.id, old); else uploadOwners.delete(args.id);
          }
          throw error;
        }
      }
      case "uploadAbort": requireUploadOwner(link, args.id); return uploads.abort(args.id);
      case "uploadAttach": requireUploadOwner(link, args.id); return uploads.attach(args.id, sessionsPath(args.sessionFile), args.sessionId);
      case "setUploadRetention": return uploadRetention.set(args.days);
      default: {
        const run = sessionOps[op] as (...params: unknown[]) => Promise<unknown>;
        const result = await run.apply(sessionOps, SESSION_OP_PARAMS[op].map(name => args[name]));
        if (op === "addProject" || op === "updateProject" || op === "hideProject") invalidateWorkspaceRoots();
        if (["renameSessionFile", "deleteSession", "archiveSession"].includes(op) && !(isRecord(result) && result.ok === false)) sessionsChanged();
        return result;
      }
    }
  }
  function shutdown(code: number): Promise<void> {
    if (stopping) return stopping;
    stopped = true; watcher.close(); clearTimeout(reloadTimer); clearInterval(sweepTimer); uploadRetention.stop();
    // Freeze before exit handlers observe children stopping.
    resume.freeze();
    stopping = (async () => { await Promise.all([...links.values()].map(link => link.stop())); await Promise.all([...stops, ...[...services.values()].map(service => service.stop())]); await channels.stop(); resume.dispose(); finish(code); })();
    return stopping;
  }
  let interrupted: HostResumeEntry[] = [];
  try { interrupted = resume.takeRunning(); } catch (error) { log("could not recover interrupted sessions: " + reason(error)); }
  // Retire only once every resume settled; failed ones stay claimed for the next daemon start.
  void channels.recover(interrupted).then(failed => resume.retireClaim(channels.running(), failed))
    .catch(error => log("could not retire recovered sessions: " + reason(error)));
  for (const saved of initial) makeLink({ ...saved, url: saved.url.replace(/\/+$/, "") }, saved.url.replace(/\/+$/, "") === primaryUrl);
  void getOmpVersion().then(version => { ompVersion = version; }).catch(error => log("could not read omp version: " + reason(error)))
    .finally(() => { if (!stopped) for (const link of links.values()) link.start(); });
  return { stop: () => shutdown(0), done };
}
