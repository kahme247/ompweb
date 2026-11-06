import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import { readSessionHeaderSync } from "../omp/session-files";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import { loadWebServerSettings } from "../web-settings";
import type { SpawnRequest } from "./host";

export const RESUME_PROMPT = "Session interrupted and resumed. Continue as you would have done without the interruption.";
export type HostResumeEntry = { sessionId: string; launch: SpawnRequest };

/** Instance-local: a test host cannot freeze or claim another host's work. */
export class HostResumeTracker {
  private readonly path: string;
  private readonly root: string;
  private readonly enabled: boolean;
  private entries: HostResumeEntry[] = [];
  private timer?: NodeJS.Timeout;
  private frozen = false;
  private invalid = false;
  private lastWrite = 0;
  private claimed = false;
  private claims: string[] = [];

  constructor(options: { path?: string; sessionsRoot?: string; enabled?: boolean } = {}) {
    this.path = options.path ?? join(getAgentDir(), "omp-web", "host-running.json");
    this.root = options.sessionsRoot ?? getSessionsDir();
    this.enabled = options.enabled ?? loadWebServerSettings().autoResumeSessions;
  }

  recordRunning(entries: HostResumeEntry[]): void {
    if (this.invalid) throw new Error("Invalid host-running manifest retained; refusing to overwrite it");
    if (this.frozen) return;
    const firstRun = entries.length > 0 && this.entries.length === 0;
    this.entries = entries;
    if (firstRun || Date.now() - this.lastWrite >= 1000) this.flush();
    else this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 1000 - (Date.now() - this.lastWrite));
    this.timer?.unref?.();
  }

  private flush(): void {
    if (this.invalid) return;
    clearTimeout(this.timer); this.timer = undefined;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.entries), { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
      this.lastWrite = Date.now();
    } finally { rmSync(temp, { force: true }); }
  }

  freeze(): void {
    if (this.frozen) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.invalid) this.flush();
    this.frozen = true;
  }

  /** Claims the manifest plus claims left by dead daemons; keeps them until `retireClaim` so a crash cannot lose the sessions. */
  takeRunning(): HostResumeEntry[] {
    if (this.claimed) return [];
    this.claimed = true;
    const taken: { from: string; claim: string }[] = [];
    for (const from of [this.path, ...this.deadClaims()]) {
      const claim = `${this.path}.claimed-${process.pid}-${randomUUID()}`;
      // Rename is the exclusive step: ENOENT means another process took it.
      try { renameSync(from, claim); taken.push({ from, claim }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try {
      const merged = new Map<string, HostResumeEntry>();
      for (const { claim } of taken) for (const entry of this.validate(claim)) if (!merged.has(entry.sessionId)) merged.set(entry.sessionId, entry);
      if (!this.enabled) { for (const { claim } of taken) rmSync(claim, { force: true }); return []; }
      this.claims = taken.map(({ claim }) => claim);
      return [...merged.values()];
    } catch (error) {
      this.invalid = true;
      // Preserve the original evidence, never replace a newer manifest.
      for (const { from, claim } of taken) if (!existsSync(from)) renameSync(claim, from);
      throw error;
    }
  }

  /** Recovery settled: persist what runs again, then drop the claims. `unrecovered` stay in one claim so the next
   * daemon start retries them (this daemon's claims count as dead once it exits). A frozen tracker keeps all claims. */
  retireClaim(entries: HostResumeEntry[], unrecovered: HostResumeEntry[] = []): void {
    if (this.invalid || this.frozen) return;
    this.entries = entries; this.flush();
    const [keep, ...rest] = this.claims.splice(0);
    if (keep && unrecovered.length > 0) {
      const temp = `${keep}.${randomUUID()}.tmp`;
      try { writeFileSync(temp, JSON.stringify(unrecovered), { mode: 0o600, flag: "wx" }); renameSync(temp, keep); this.claims = [keep]; }
      finally { rmSync(temp, { force: true }); }
    } else if (keep) rmSync(keep, { force: true });
    for (const claim of rest) rmSync(claim, { force: true });
  }

  /** Claim files whose owning pid is gone; EPERM or success never means dead. */
  private deadClaims(): string[] {
    const prefix = `${basename(this.path)}.claimed-`;
    let names: string[];
    try { names = readdirSync(dirname(this.path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter(name => {
      const pid = name.startsWith(prefix) ? /^(\d+)-./.exec(name.slice(prefix.length))?.[1] : undefined;
      if (pid === undefined || !Number.isSafeInteger(+pid) || +pid <= 0) return false;
      try { process.kill(+pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).map(name => join(dirname(this.path), name));
  }

  private validate(claim: string): HostResumeEntry[] {
    if (lstatSync(claim).isSymbolicLink()) throw new Error("Recovery manifest must not be a symlink");
    const raw: unknown = JSON.parse(readFileSync(claim, "utf8"));
    if (!Array.isArray(raw)) throw new Error("Invalid host-running manifest");
    const seen = new Set<string>(), entries: HostResumeEntry[] = [];
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.sessionId !== "string" || !isValidSessionId(entry.sessionId) || !isRecord(entry.launch)) throw new Error("Invalid recovery session");
      const launch = entry.launch;
      if (typeof launch.cwd !== "string" || !isAbsolute(launch.cwd)
        || !(launch.recordedCwd === null || typeof launch.recordedCwd === "string")
        || typeof launch.sessionFile !== "string" || !isAbsolute(launch.sessionFile) || typeof launch.advisor !== "boolean"
        || !(launch.toolNames === undefined || Array.isArray(launch.toolNames) && launch.toolNames.every(name => typeof name === "string"))
        || !(launch.spawnModel === undefined || typeof launch.spawnModel === "string")) throw new Error("Invalid recovery launch");
      const root = realpathSync(this.root);
      let file: string;
      try { file = realpathSync(resolve(launch.sessionFile)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; } // A deleted session must not block the rest.
      if (!file.startsWith(root + sep) || readSessionHeaderSync(file)?.id !== entry.sessionId || seen.has(entry.sessionId)) throw new Error("Recovery session is outside its owning session root or duplicated");
      seen.add(entry.sessionId);
      entries.push({ sessionId: entry.sessionId, launch: { cwd: launch.cwd, recordedCwd: launch.recordedCwd, sessionFile: file, advisor: launch.advisor, ...(launch.toolNames === undefined ? {} : { toolNames: launch.toolNames as string[] }), ...(launch.spawnModel === undefined ? {} : { spawnModel: launch.spawnModel }) } });
    }
    return entries;
  }

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }
}
