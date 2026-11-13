import { execFile } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import packageJson from "../../package.json";
import { createChildProcessEnvironment } from "../project-command-env";
import { getAgentDir } from "./paths";

/**
 * Locating and probing ompweb's own omp build (`ompweb-omp`, built from runner/). omp-web never
 * embeds the (Bun-only) @oh-my-pi SDK — every live-agent capability goes through that binary, so
 * its absence is a first-class, user-visible state.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: { fingerprint: string; value: string; expiresAt: number } | null = null;
let versionMiss: { fingerprint: string | null; retryAt: number } | null = null;
let versionProbe: Promise<string | null> | null = null;

const BIN_NAME = process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp";
/** This platform's runner: `runner/release/<name>` in a source checkout and the asset of that name on each release. */
export const OMP_RUNNER_ASSET = `ompweb-omp-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
// .cmd/.bat launchers (e.g. OMP_WEB_OMP_BIN pointing at a wrapper script) cannot
// be spawned directly by Node — spawning them requires a shell. Route them
// through `cmd.exe /c`; every other platform and binary passes through.
const WINDOWS_SCRIPT_RE = /\.cmd$|\.bat$/i;

/** Spawn target for `bin args`, routing Windows script launchers through cmd.exe. */
export function wrapWindowsScript(bin: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && WINDOWS_SCRIPT_RE.test(bin)) {
    return { file: "cmd.exe", args: ["/c", bin, ...args] };
  }
  return { file: bin, args };
}
// Retry missing binaries and failed version probes after a short backoff so
// a later install or repair is picked up without a web server restart.
const MISS_TTL_MS = 30_000;
// Launchers can stay unchanged while their underlying package is updated.
const VERSION_TTL_MS = 5 * 60_000;

/** Where this install keeps the runner it fetches from its own release (lib/omp/runner-fetch.ts): beside a compiled
 * ompweb, else in a per-version cache under the agent dir (an npm install's package dir may not be writable). */
export function fetchedOmpBin(): string {
  return typeof Bun !== "undefined" && Bun.isStandaloneExecutable
    ? join(dirname(process.execPath), BIN_NAME)
    : join(getAgentDir(), "omp-web", "omp", packageJson.version, BIN_NAME);
}

/** A source checkout builds its runner (`bun runner/scripts/build-binary.ts`) instead of fetching one. */
export function sourceCheckoutOmpBin(): string | null {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  return existsSync(join(packageDir, "runner", "package.json")) ? join(packageDir, "runner", "release", OMP_RUNNER_ASSET) : null;
}

function probeOmpBin(): string | null {
  const override = process.env.OMP_WEB_OMP_BIN;
  if (override) return existsSync(override) ? override : null;
  const path = sourceCheckoutOmpBin() ?? fetchedOmpBin();
  return existsSync(path) ? path : null;
}

/** What every caller that needs omp reports when resolveOmpBin finds none. */
export const OMP_NOT_FOUND = "ompweb's omp binary (ompweb-omp) not found. Reinstall ompweb or set OMP_WEB_OMP_BIN.";

/** Resolve ompweb's omp binary: OMP_WEB_OMP_BIN override, else the source checkout's build or the fetched runner
 * (see probeOmpBin). Returns null when none exists. A hit is cached while the file exists; a miss is re-probed after
 * MISS_TTL_MS, or at once with `fresh` (after a fetch). */
export function resolveOmpBin(fresh = false): string | null {
  if (fresh) binMissAt = 0;
  // A global Bun/npm update can replace or remove its launcher while this
  // server process is still alive. Never keep returning a stale cache entry.
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  cachedBin = null;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeOmpBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** Return the installed CLI version, using file metadata to invalidate cached
 * results without launching omp on every visit. An expiry covers opaque
 * launchers; concurrent callers share a probe. */
export function getOmpVersion(): Promise<string | null> {
  versionProbe ??= probeOmpVersion().finally(() => {
    versionProbe = null;
  });
  return versionProbe;
}

/** Identity of the binary on disk; changes when it is replaced or updated. */
export function versionFingerprint(bin: string): string | null {
  try {
    const target = realpathSync(bin);
    const stat = statSync(target, { bigint: true });
    return [target, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}

async function probeOmpVersion(): Promise<string | null> {
  const bin = resolveOmpBin();
  const fingerprint = bin ? versionFingerprint(bin) : null;
  const now = Date.now();
  if (fingerprint && cachedVersion?.fingerprint === fingerprint && now < cachedVersion.expiresAt) {
    return cachedVersion.value;
  }
  if (versionMiss?.fingerprint === fingerprint && now < versionMiss.retryAt) return null;
  cachedVersion = null;
  if (!bin) {
    versionMiss = { fingerprint, retryAt: now + MISS_TTL_MS };
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const target = wrapWindowsScript(bin, ["--version"]);
      // Without an explicit env this probe would inherit the server's full
      // environment, including omp-web's own secrets, into the child.
      // 30 s: a fresh ~120 MB runner binary's first start on Windows waits on the antivirus scan.
      execFile(target.file, target.args, { timeout: 30_000, windowsHide: true, env: createChildProcessEnvironment() }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = output.trim();
    if (version) {
      versionMiss = null;
      // Do not cache a probe across an executable replacement.
      if (fingerprint && versionFingerprint(bin) === fingerprint) {
        cachedVersion = { fingerprint, value: version, expiresAt: Date.now() + VERSION_TTL_MS };
      }
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMiss = { fingerprint, retryAt: Date.now() + MISS_TTL_MS };
  return null;
}
