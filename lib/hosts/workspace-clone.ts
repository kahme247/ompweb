import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { cloneDirectoryName, type CloneFrame, type CloneProgress } from "../git-clone";
import { createChildProcessEnvironment } from "../project-command-env";
import { HostOpError } from "./link-protocol";
import { authorizeWorkspaceDirectory, grantWorkspaceRoot } from "./workspace-roots";

const ID = /^[A-Za-z0-9-]{1,64}$/;
const IDLE_MS = 120_000;
const PROGRESS_BYTES = 256 * 1024;
type Identity = { dev: bigint; ino: bigint };
type Job = {
  id: string; parent: string; url: string; target: string; canonical: string; parentIdentity?: Identity; identity?: Identity;
  controller: AbortController; ready: Promise<void>; task: Promise<void>; timer?: NodeJS.Timeout;
  output: Array<{ start: number; end: number; bytes: number; frame: Extract<CloneFrame, {type: "output"}> }>;
  cursor: number; bytes: number; terminal?: CloneFrame; changed: Set<() => void>;
};
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

/** A clone leads its own process group so cancellation also terminates SSH/helpers holding its pipes. */
function runGitClone(url: string, target: string, signal: AbortSignal, output: (text: string) => void): Promise<number | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn("git", ["clone", "--progress", "--", url, target], {
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      env: createChildProcessEnvironment({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https:ssh" }),
    });
    let escalation: NodeJS.Timeout | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* Group already exited. */ }
      }
    };
    const abort = () => { kill(false); escalation = setTimeout(() => kill(true), 5_000); escalation.unref?.(); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", output);
    child.stderr.setEncoding("utf8").on("data", output);
    let failed = false;
    child.on("error", () => { failed = true; });
    child.on("close", (code) => { signal.removeEventListener("abort", abort); clearTimeout(escalation); resolve(failed ? null : code); });
    if (signal.aborted) abort();
  });
}

/** Jobs survive a web/link restart; only an unobserved job or daemon stop cancels them. */
export class WorkspaceClones {
  private readonly jobs = new Map<string, Job>();

  async start(id: string, parent: string, url: string): Promise<{id: string}> {
    if (typeof id !== "string" || !ID.test(id) || typeof parent !== "string" || typeof url !== "string") throw new HostOpError(400, "invalid_request", "Invalid clone request");
    const name = cloneDirectoryName(url);
    if (!name) throw new HostOpError(400, "invalid_git_url", "Enter an https:// or ssh Git URL");
    const known = this.jobs.get(id);
    if (known) {
      if (known.parent !== parent || known.url !== url) throw new HostOpError(409, "clone_id_conflict", "The clone id has another destination");
      this.touch(known); await known.ready; return { id };
    }
    let ready!: () => void, reject!: (error: unknown) => void;
    const started = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail; });
    const job: Job = { id, parent, url, target: "", canonical: "", controller: new AbortController(), ready: started, task: Promise.resolve(), output: [], cursor: 0, bytes: 0, changed: new Set() };
    this.jobs.set(id, job); this.touch(job);
    job.task = this.run(job, name, ready, reject);
    await started;
    return { id };
  }

  private async run(job: Job, name: string, ready: () => void, reject: (error: unknown) => void): Promise<void> {
    let announced = false;
    let cleanupAttempted = false;
    try {
      job.canonical = await authorizeWorkspaceDirectory(job.parent);
      job.parentIdentity = await lstat(job.canonical, { bigint: true });
      job.target = join(job.canonical, name);
      if (job.controller.signal.aborted) { ready(); announced = true; job.terminal = { type: "cancelled", path: job.target }; return; }
      try { await mkdir(job.target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HostOpError(409, "clone_target_exists", `Already exists: ${job.target}`); throw error; }
      job.identity = await lstat(job.target, { bigint: true });
      if (await authorizeWorkspaceDirectory(job.parent) !== job.canonical || !same(await lstat(job.canonical, { bigint: true }), job.parentIdentity)) throw new HostOpError(409, "clone_target_changed", "The clone parent changed");
      ready(); announced = true;
      const code = await runGitClone(job.url, job.target, job.controller.signal, (text) => this.output(job, text));
      if (code === 0 && !job.controller.signal.aborted) {
        if (!await this.owns(job)) throw new HostOpError(409, "clone_cleanup_failed", "The clone destination was replaced");
        grantWorkspaceRoot(job.target);
        job.terminal = { type: "done", path: job.target };
      } else {
        cleanupAttempted = true;
        await this.cleanup(job);
        job.terminal = job.controller.signal.aborted ? { type: "cancelled", path: job.target }
          : { type: "error", code: code === null ? "git_not_found" : "clone_failed", error: code === null ? "Could not run git — is it installed?" : `git clone exited with code ${code}` };
      }
    } catch (error) {
      if (!announced) reject(error);
      let failure = error;
      if (job.identity && !cleanupAttempted) { try { await this.cleanup(job); } catch (cleanupError) { failure = cleanupError; } }
      job.terminal = { type: "error", code: failure instanceof HostOpError ? failure.code : "clone_failed", error: failure instanceof Error ? failure.message : String(failure) };
    } finally { this.wake(job); this.touch(job); }
  }

  private async owns(job: Job): Promise<boolean> {
    try {
      return !!job.identity && !!job.parentIdentity && same(await lstat(job.canonical, { bigint: true }), job.parentIdentity)
        && same(await lstat(job.target, { bigint: true }), job.identity);
    } catch { return false; }
  }

  private async cleanup(job: Job): Promise<void> {
    if (!await this.owns(job)) throw new HostOpError(409, "clone_cleanup_failed", `Could not safely remove ${job.target}: its identity changed`);
    // Capture before deleting: a replacement racing the old pathname is preserved, not recursively removed.
    const quarantine = await mkdtemp(join(job.canonical, ".omp-clone-cleanup-"));
    const quarantineIdentity = await lstat(quarantine, { bigint: true });
    const captured = join(quarantine, "clone");
    try { await rename(job.target, captured); }
    catch {
      await rmdir(quarantine).catch(() => {});
      throw new HostOpError(409, "clone_cleanup_failed", `Could not capture ${job.target} for safe cleanup`);
    }
    if (!job.identity || !job.parentIdentity || !same(await lstat(captured, { bigint: true }), job.identity)
      || !same(await lstat(quarantine, { bigint: true }), quarantineIdentity)
      || !same(await lstat(job.canonical, { bigint: true }), job.parentIdentity)) {
      throw new HostOpError(409, "clone_cleanup_failed", `The destination changed during cleanup; captured data is preserved at ${captured}`);
    }
    try {
      await rm(captured, { recursive: true });
      job.identity = undefined;
      await rmdir(quarantine);
    } catch { throw new HostOpError(500, "clone_cleanup_failed", `Could not remove the captured clone at ${captured}`); }
  }

  private output(job: Job, text: string): void {
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length;) {
      let end = Math.min(at + 64 * 1024, bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const frame = { type: "output" as const, text: bytes.subarray(at, end).toString("utf8") };
      const size = end - at;
      const encodedBytes = Buffer.byteLength(JSON.stringify(frame));
      job.output.push({ start: job.cursor, end: job.cursor + size, bytes: encodedBytes, frame }); job.cursor += size; job.bytes += encodedBytes;
      while (job.bytes > PROGRESS_BYTES) job.bytes -= job.output.shift()!.bytes;
      at = end;
    }
    this.wake(job);
  }

  private wake(job: Job): void { for (const wake of job.changed) wake(); }
  private touch(job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (job.terminal) this.jobs.delete(job.id);
      else job.controller.abort();
    }, IDLE_MS);
    job.timer.unref?.();
  }
  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new HostOpError(404, "clone_not_found", "No clone job is known on this daemon; its outcome is unknown");
    this.touch(job); return job;
  }
  private page(job: Job, cursor: number): CloneProgress {
    return { cursor: job.cursor, reset: cursor < (job.output[0]?.start ?? job.cursor),
      frames: [...job.output.filter((entry) => entry.end > cursor).map((entry) => entry.frame), ...(job.terminal ? [job.terminal] : [])], terminal: !!job.terminal };
  }
  async read(id: string, cursor: number): Promise<CloneProgress> {
    const job = this.require(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.cursor) throw new HostOpError(400, "invalid_request", "Invalid clone cursor");
    if (!job.terminal && cursor === job.cursor) await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); job.changed.delete(done); resolve(); };
      const timer = setTimeout(done, 1_000); job.changed.add(done);
    });
    return this.page(job, cursor);
  }
  async cancel(id: string): Promise<CloneProgress> {
    const job = this.require(id);
    if (!job.terminal) job.controller.abort();
    await job.task;
    return this.page(job, 0);
  }
  async stop(): Promise<void> {
    for (const job of this.jobs.values()) if (!job.terminal) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.task));
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }
}
