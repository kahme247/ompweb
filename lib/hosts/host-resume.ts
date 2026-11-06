import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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

  takeRunning(): HostResumeEntry[] {
    if (this.claimed) return [];
    this.claimed = true;
    const claim = `${this.path}.claimed-${process.pid}-${randomUUID()}`;
    try { renameSync(this.path, claim); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    try {
      if (lstatSync(claim).isSymbolicLink()) throw new Error("Recovery manifest must not be a symlink");
      const raw: unknown = JSON.parse(readFileSync(claim, "utf8"));
      if (!Array.isArray(raw)) throw new Error("Invalid host-running manifest");
      const seen = new Set<string>();
      const entries = raw.map((entry): HostResumeEntry => {
        if (!isRecord(entry) || typeof entry.sessionId !== "string" || !isValidSessionId(entry.sessionId) || !isRecord(entry.launch)) throw new Error("Invalid recovery session");
        const launch = entry.launch;
        if (typeof launch.cwd !== "string" || !isAbsolute(launch.cwd)
          || !(launch.recordedCwd === null || typeof launch.recordedCwd === "string")
          || typeof launch.sessionFile !== "string" || !isAbsolute(launch.sessionFile) || typeof launch.advisor !== "boolean"
          || !(launch.toolNames === undefined || Array.isArray(launch.toolNames) && launch.toolNames.every(name => typeof name === "string"))
          || !(launch.spawnModel === undefined || typeof launch.spawnModel === "string")) throw new Error("Invalid recovery launch");
        const root = realpathSync(this.root), file = realpathSync(resolve(launch.sessionFile));
        if (!file.startsWith(root + sep) || readSessionHeaderSync(file)?.id !== entry.sessionId || seen.has(entry.sessionId)) throw new Error("Recovery session is outside its owning session root or duplicated");
        seen.add(entry.sessionId);
        return { sessionId: entry.sessionId, launch: { cwd: launch.cwd, recordedCwd: launch.recordedCwd, sessionFile: file, advisor: launch.advisor, ...(launch.toolNames === undefined ? {} : { toolNames: launch.toolNames as string[] }), ...(launch.spawnModel === undefined ? {} : { spawnModel: launch.spawnModel }) } };
      });
      rmSync(claim);
      return this.enabled ? entries : [];
    } catch (error) {
      this.invalid = true;
      // Preserve the original evidence, never replace a newer manifest.
      if (!existsSync(this.path)) renameSync(claim, this.path);
      throw error;
    }
  }

  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }
}
