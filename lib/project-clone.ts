import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { lstat, mkdir, open, readFile, realpath, rm, unlink, type FileHandle } from "fs/promises";
import { basename, dirname, join } from "path";
import { cloneDirectoryName } from "./git-clone";
import { createGitEnvironment } from "./project-command-env";
import type { OpResult } from "./hosts/session-ops";

/** Shared across API/daemon processes. Abandoned reservations fail closed and
 * require manual inspection after a crash; never steal or reap another owner's file. */
export async function withProjectReservation<T>(
  target: string,
  operation: (ownsReservation: () => Promise<boolean>) => Promise<OpResult<T>>,
): Promise<OpResult<T>> {
  let handle: FileHandle;
  let path: string;
  try {
    path = join(await realpath(dirname(target)), `.${basename(target)}.ompweb-project.lock`);
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, status: 409, code: "project_target_busy", error: "Project target is reserved; an abandoned reservation requires manual inspection" };
    }
    return { ok: false, status: 500, code: "project_reservation_failed", error: "Could not reserve project target" };
  }
  try {
    const identity = await handle.stat();
    const token = randomUUID();
    await handle.writeFile(token);
    const ownsReservation = async () => {
      try {
        const current = await lstat(path);
        return current.isFile() && !current.isSymbolicLink()
          && current.dev === identity.dev && current.ino === identity.ino
          && await readFile(path, "utf8") === token;
      } catch {
        return false;
      }
    };
    try {
      const result = await operation(ownsReservation);
      if (!await ownsReservation()) {
        return { ok: false, status: 409, code: "project_reservation_lost", error: "Project reservation ownership changed" };
      }
      return result;
    } finally {
      if (await ownsReservation()) await unlink(path);
    }
  } finally {
    await handle.close();
  }
}

/** Server-only clone execution. Only a target acquired by this call is cleaned up. */
export async function cloneRepository(input: {
  origin: string;
  target: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}): Promise<OpResult<{ path: string }>> {
  const { origin, target, signal, onOutput } = input;
  if (!cloneDirectoryName(origin)) {
    return { ok: false, status: 400, code: "invalid_git_url", error: "Enter an https:// or ssh Git URL" };
  }
  try {
    return await withProjectReservation<{ path: string }>(target, async (ownsReservation) => {
      try {
        // Acquire the final root only while holding the cross-process reservation.
        await mkdir(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { ok: false, status: 409, code: "clone_target_exists", error: `Already exists: ${target}` };
        }
        return { ok: false, status: 500, code: "clone_target_failed", error: `Could not create ${target}` };
      }
      const identity = await lstat(target);
      let code: number | null;
      try {
        code = await runGitClone(origin, target, signal, onOutput);
      } catch {
        code = null;
      }
      const current = await lstat(target).catch(() => null);
      if (!await ownsReservation() || !current?.isDirectory() || current.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino) {
        return { ok: false, status: 500, code: "clone_cleanup_failed", error: `Clone target ownership changed: ${target}` };
      }
      // Publish success before releasing the reservation. Later aborts cannot enter cleanup.
      if (code === 0 && !signal?.aborted) return { ok: true, value: { path: target } };
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        return { ok: false, status: 500, code: "clone_cleanup_failed", error: `Could not remove ${target}` };
      }
      if (signal?.aborted) return { ok: false, status: 499, code: "clone_cancelled", error: "Clone cancelled" };
      if (code === null) return { ok: false, status: 500, code: "git_not_found", error: "Could not run git — is it installed?" };
      return { ok: false, status: 500, code: "clone_failed", error: `git clone exited with code ${code}` };
    });
  } catch {
    return { ok: false, status: 500, code: "clone_cleanup_failed", error: "Could not complete clone ownership cleanup" };
  }
}

/** No terminal or credential prompts. POSIX cancellation signals the whole session,
 * including SSH/remote helpers that otherwise keep Git's output pipes open. */
function runGitClone(origin: string, target: string, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<number | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const child = spawn("git", ["clone", "--progress", "--", origin, target], {
    stdio: ["ignore", "pipe", "pipe"],
    env: createGitEnvironment({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https:ssh" }),
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const kill = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Group already gone.
    }
  };
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  child.stdout.setEncoding("utf8").on("data", (text: string) => onOutput?.(text));
  child.stderr.setEncoding("utf8").on("data", (text: string) => onOutput?.(text));
  child.on("error", () => resolve(null));
  child.on("close", (code) => {
    signal?.removeEventListener("abort", kill);
    resolve(code);
  });
  return promise;
}
