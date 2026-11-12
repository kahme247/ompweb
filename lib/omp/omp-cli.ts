import { execFile } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { createChildProcessEnvironment } from "../project-command-env";

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
const PLATFORM = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
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

function probeOmpBin(): string | null {
  const override = process.env.OMP_WEB_OMP_BIN;
  if (override) return existsSync(override) ? override : null;
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const candidates = [
    // Compiled release: beside the ompweb binary.
    join(dirname(process.execPath), BIN_NAME),
    // npm install: the platform's optional dependency.
    () => join(dirname(createRequire(join(packageDir, "package.json")).resolve(`@kahme247/ompweb-omp-${PLATFORM}/package.json`)), BIN_NAME),
    // Source checkout: what `bun runner/scripts/build-binary.ts` writes.
    join(packageDir, "runner", "release", `ompweb-omp-${PLATFORM}${process.platform === "win32" ? ".exe" : ""}`),
  ];
  for (const candidate of candidates) {
    let path: string;
    try {
      path = typeof candidate === "string" ? candidate : candidate();
    } catch {
      continue; // optional dependency not installed
    }
    if (existsSync(path)) return path;
  }
  return null;
}

/** Resolve ompweb's omp binary: OMP_WEB_OMP_BIN override, else the release, npm or source-checkout
 * copy (see probeOmpBin). Returns null when none exists. A hit is cached while the file exists; a
 * miss is re-probed after MISS_TTL_MS. */
export function resolveOmpBin(): string | null {
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
      execFile(target.file, target.args, { timeout: 10_000, windowsHide: true, env: createChildProcessEnvironment() }, (error, stdout) => {
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
