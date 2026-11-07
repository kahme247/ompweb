import { existsSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";

/**
 * Node port of oh-my-pi's directory resolution (packages/utils/src/dirs.ts).
 * omp-web cannot import the Bun-only @oh-my-pi packages, so the layout rules
 * are replicated here. Covered: PI_CODING_AGENT_DIR override, PI_CONFIG_DIR
 * rename, and the XDG data layout (used only when $XDG_DATA_HOME/omp already
 * exists, mirroring omp's opt-in migration). Named profiles
 * (OMP_PROFILE/PI_PROFILE) are intentionally unsupported: omp-web always
 * resolves the default profile location.
 */

const APP_NAME = "omp";
const CONFIG_DIR_NAME = ".omp";


export function getConfigDirName(): string {
  return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Config root: ~/.omp (plus PI_CONFIG_DIR rename). */
export function getConfigRoot(): string {
  return path.join(homedir(), getConfigDirName());
}

/** The agent state directory (~/.omp/agent). PI_CODING_AGENT_DIR overrides it. */
export function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return path.resolve(override);
  return path.join(getConfigRoot(), "agent");
}

function isDefaultAgentDir(): boolean {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) {
    return path.resolve(override) === path.join(getConfigRoot(), "agent");
  }
  return true;
}

/** omp-web's crash/stall journal directory: ~/.omp/omp-web, or
 * <agent dir>/omp-web when PI_CODING_AGENT_DIR points elsewhere, so isolated
 * runs (tests, dev servers) never write the real journal. */
export function getDiagnosticsDir(): string {
  return path.join(isDefaultAgentDir() ? getConfigRoot() : getAgentDir(), "omp-web");
}

/** XDG data root for the default agent dir: only honored on linux/darwin when
 * $XDG_DATA_HOME/omp already exists — omp treats the XDG layout as opt-in via
 * `omp config init-xdg`. XDG flattens the `agent/` prefix:
 * ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions. */
function xdgDataAgentRoot(): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  if (!isDefaultAgentDir()) return undefined;
  const value = process.env.XDG_DATA_HOME;
  if (!value) return undefined;
  try {
    const appRoot = path.join(value, APP_NAME);
    return existsSync(appRoot) ? appRoot : undefined;
  } catch {
    return undefined;
  }
}

function agentDataSubdir(subdir: string): string {
  const xdg = xdgDataAgentRoot();
  return path.join(xdg ?? getAgentDir(), subdir);
}

/** ~/.omp/agent/sessions (or $XDG_DATA_HOME/omp/sessions). */
export function getSessionsDir(): string {
  return agentDataSubdir("sessions");
}

/** OMP's gc archive root for compressed session JSONL files. */
export function getArchivedSessionsDir(): string {
  return path.join(path.dirname(getSessionsDir()), "archive", "sessions");
}

/** Content-addressed blob store referenced from session entries. */
export function getBlobsDir(): string {
  return agentDataSubdir("blobs");
}

/** Settings file (YAML). config.yml is canonical, config.yaml the fallback. */
export function getSettingsPath(): string {
  const dir = getAgentDir();
  const canonical = path.join(dir, "config.yml");
  if (existsSync(canonical)) return canonical;
  const fallback = path.join(dir, "config.yaml");
  if (existsSync(fallback)) return fallback;
  return canonical;
}

/** Custom models file (YAML). models.yml canonical, models.yaml fallback. */
export function getModelsConfigPath(): string {
  const dir = getAgentDir();
  const canonical = path.join(dir, "models.yml");
  if (existsSync(canonical)) return canonical;
  const fallback = path.join(dir, "models.yaml");
  if (existsSync(fallback)) return fallback;
  return canonical;
}

/** Best-effort canonicalization mirroring omp's resolveEquivalentPath: resolve
 * symlinks when the path exists, otherwise keep the resolved input. */
function canonicalize(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
  const encoded = relative.replace(/[/\\:]/g, "-");
  return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Session directory slug for a cwd — a faithful port of getDefaultSessionDirName
 * in packages/coding-agent/src/session/session-paths.ts:
 * - under $HOME: "-" + relative path with [/\:] replaced by dashes ("-" for $HOME itself)
 * - under tmpdir: "-tmp" (+ "-" + dashed relative path)
 * - otherwise: legacy absolute encoding "--abs-path-dashed--"
 */
export function getSessionDirNameForCwd(cwd: string): string {
  const canonicalCwd = canonicalize(path.resolve(cwd));
  const canonicalHome = canonicalize(homedir());
  const canonicalTmp = canonicalize(tmpdir());
  const homeRelative = path.relative(canonicalHome, canonicalCwd);
  const tempRelative = path.relative(canonicalTmp, canonicalCwd);
  if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
    return encodeRelativeSessionDirName("-", homeRelative);
  }
  if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
    return encodeRelativeSessionDirName("-tmp", tempRelative);
  }
  return encodeLegacyAbsoluteSessionDirName(canonicalCwd);
}

/** User-level agents directory (~/.omp/agent/agents). */
export function getUserAgentsDir(): string {
  return path.join(getAgentDir(), "agents");
}

/** Project-level agents directory (./.omp/agents at git root, or cwd fallback). */
export function getProjectAgentsDir(cwd: string): string {
  let current = path.resolve(cwd);
  const home = homedir();
  while (true) {
    const candidate = path.join(current, ".omp", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Keep walking until the nearest project boundary.
    }
    if (existsSync(path.join(current, ".git"))) return candidate;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(path.resolve(cwd), ".omp", "agents");
}

/** Cache directory for unpacked bundled agents (temp). */
export function getAgentsBundledCacheDir(): string {
  return path.join(tmpdir(), "omp-web-bundled-agents");
}

// omp's own rule (internal-urls/local-protocol.ts): long artifact paths move to the temp dir on Windows.
const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;

/** omp's `local://` root for a session (`resolveLocalRoot` in omp's local-protocol.ts). */
export function sessionLocalRoot(sessionFile: string, sessionId: string, platform: NodeJS.Platform = process.platform): string {
  const candidate = path.resolve(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "local");
  if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
    return path.join(tmpdir(), "omp-local", sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  }
  return candidate;
}
