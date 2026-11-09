import { execFile, spawn } from "child_process";
import { resolveOmpBin, wrapWindowsScript } from "./omp-cli";
import { createChildProcessEnvironment } from "../project-command-env";
import { isUpdateDisabled } from "../update-policy";

export interface OmpUpdateStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  updatesDisabled?: boolean;
}

// A cold `omp update --check` on Windows regularly needs ~20 s (Node CLI startup
// plus network); 15 s made the very first check after boot fail with update_failed.
export const OMP_UPDATE_CHECK_TIMEOUT_MS = 30_000;
export const OMP_UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;

// Scales the check deadline so a test can run the real subprocess boundary: a
// launcher that answers past the old 15 s bound and one that outlives the new
// 30 s bound, both in a fraction of the real time. Production never sets it.
let checkTimeoutScale = 1;

/** Test-only: scale the default check deadline (1 restores the real one). */
export function scaleOmpUpdateCheckTimeoutForTests(scale: number): void {
  checkTimeoutScale = scale;
}

/** Run a raw `omp update [args]` subcommand. Install durability
 * (lease/status/retry) lives in lib/self-update.ts. */
export function runOmpUpdate(args: string[], timeoutMs = OMP_UPDATE_CHECK_TIMEOUT_MS * checkTimeoutScale): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.reject(new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const target = wrapWindowsScript(bin, ["update", ...args]);
  // The deadline is handled here rather than by `execFile`'s `timeout`: that
  // option kills the direct child only, and on Windows the direct child is
  // cmd.exe — the launcher it started keeps running. By the time the callback
  // fires the parent is gone, so `taskkill /t` can no longer find the tree.
  // Killing the tree while the parent is still alive is the only reliable way
  // to leave no process behind.
  let timedOut = false;
  const child = execFile(target.file, target.args, {
    maxBuffer: 1024 * 1024,
    env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }),
    windowsHide: true,
  }, (error, stdout, stderr) => {
    clearTimeout(deadline);
    if (error) {
      if (timedOut) {
        reject(new Error(`Command failed: ${target.file} ${target.args.join(" ")} (timed out after ${timeoutMs} ms)`));
        return;
      }
      reject(new Error((stderr || stdout || error.message).trim().slice(-1000)));
    } else resolve(`${stdout}\n${stderr}`.trim());
  });
  // Not unref'd: a running check is real work, and the timer must not be
  // dropped just because nothing else holds the loop open.
  const deadline = setTimeout(() => {
    timedOut = true;
    // Kill the tree while the parent is still alive: `taskkill /t` walks the
    // parent's children, so it cannot work afterwards.
    killProcessTree(child.pid);
    // A launcher that ignores the kill still must not keep the check pending.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }, 1000).unref();
  }, timeoutMs);
  return promise;
}

/**
 * Terminate a child and everything it started.
 *
 * Windows has no portable negative-pid equivalent, so `taskkill /t /f` walks
 * the tree. It must run while the parent is still alive — once the parent has
 * exited, its children are no longer reachable through it. POSIX uses the
 * direct kill: this child is not detached, so it heads no process group of its
 * own, and the launcher is the process that holds the deadline.
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    const reaper = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    reaper.once("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function parseOmpUpdateStatus(output: string): OmpUpdateStatus {
  const currentVersion = output.match(/^Current version:\s*(\S+)/mi)?.[1] ?? null;
  const availableVersion = output.match(/^New version available:\s*(\S+)/mi)?.[1] ?? null;
  return {
    currentVersion,
    availableVersion,
    updateAvailable: availableVersion !== null,
    updateCommand: "omp update",
  };
}

export function createCachedOmpUpdateCheck(
  run: () => Promise<string> = () => runOmpUpdate(["--check"]),
  now: () => number = () => Date.now(),
) {
  let cached: { checkedAt: number; status: OmpUpdateStatus } | null = null;
  let inFlight: Promise<OmpUpdateStatus> | null = null;

  return async (force = false): Promise<OmpUpdateStatus> => {
    const currentTime = now();
    if (!force && cached && currentTime - cached.checkedAt < OMP_UPDATE_CHECK_TTL_MS) {
      return cached.status;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const output = await run();
        const status = parseOmpUpdateStatus(output);
        cached = { checkedAt: now(), status };
        return status;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };
}

const defaultCachedOmpUpdateCheck = createCachedOmpUpdateCheck();

export async function checkOmpUpdate(force = false): Promise<OmpUpdateStatus> {
  if (isUpdateDisabled()) {
    return { currentVersion: null, availableVersion: null, updateAvailable: false, updateCommand: "omp update", updatesDisabled: true };
  }
  return defaultCachedOmpUpdateCheck(force);
}

