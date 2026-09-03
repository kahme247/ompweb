import { existsSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";

/**
 * Node port of oh-my-pi's directory resolution (packages/utils/src/dirs.ts).
 * omp-web cannot import the Bun-only @oh-my-pi packages, so the layout rules
 * are replicated here. Covered: PI_CODING_AGENT_DIR override, PI_CONFIG_DIR
 * rename, OMP_PROFILE/PI_PROFILE profiles, and the XDG data layout (used only
 * when $XDG_DATA_HOME/omp already exists, mirroring omp's opt-in migration).
 */

const APP_NAME = "omp";
const CONFIG_DIR_NAME = ".omp";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Windows reserves these basenames and any `BASENAME.<ext>` form of them,
// case-insensitively (NTFS treats CON and con alike).
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Faithful port of omp's normalizeProfileName (packages/utils/src/dirs.ts).
 * Returns undefined for the implicit default (empty, whitespace, or the
 * explicit "default" sentinel) and throws for invalid names — omp refuses to
 * start on those, so silently falling back would make omp-web read a different
 * agent dir than the omp child it spawns.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
  const normalized = profile?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    !PROFILE_NAME_RE.test(normalized) ||
    WINDOWS_RESERVED_BASENAME_RE.test(normalized)
  ) {
    throw new Error(
      `Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
        `cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
        `(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
    );
  }
  return normalized;
}

/** OMP_PROFILE is canonical; PI_PROFILE is the legacy fallback. An explicitly
 * empty OMP_PROFILE selects the default profile rather than inheriting. */
export function getActiveProfile(): string | undefined {
  if (process.env.OMP_PROFILE !== undefined) {
    return normalizeProfileName(process.env.OMP_PROFILE);
  }
  return normalizeProfileName(process.env.PI_PROFILE);
}

export function getConfigDirName(): string {
  return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Config root: ~/.omp, or ~/.omp/profiles/<name> for a named profile. */
export function getConfigRoot(profileOverride?: string): string {
  const base = path.join(homedir(), getConfigDirName());
  const profile = profileOverride === undefined ? getActiveProfile() : normalizeProfileName(profileOverride);
  return profile ? path.join(base, "profiles", profile) : base;
}

/** The agent state directory (~/.omp/agent). PI_CODING_AGENT_DIR overrides it,
 * but a named profile takes precedence over the override (matching omp, where
 * profile activation rewrites PI_CODING_AGENT_DIR itself). */
export function getAgentDir(profileOverride?: string): string {
  const profile = profileOverride === undefined ? getActiveProfile() : normalizeProfileName(profileOverride);
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && !profile) return path.resolve(override);
  return path.join(getConfigRoot(profileOverride), "agent");
}

function isDefaultAgentDir(): boolean {
  const profile = getActiveProfile();
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && !profile) {
    return path.resolve(override) === path.join(getConfigRoot(), "agent");
  }
  return true;
}

/** XDG data root for the default agent dir: only honored on linux/darwin when
 * $XDG_DATA_HOME/omp (or its profile subdir) already exists — omp treats the
 * XDG layout as opt-in via `omp config init-xdg`. XDG flattens the `agent/`
 * prefix: ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions. */
function xdgDataAgentRoot(): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  if (!isDefaultAgentDir()) return undefined;
  const value = process.env.XDG_DATA_HOME;
  if (!value) return undefined;
  try {
    const appRoot = path.join(value, APP_NAME);
    const profile = getActiveProfile();
    if (profile) {
      const profilePath = path.join(appRoot, "profiles", profile);
      return existsSync(profilePath) ? profilePath : undefined;
    }
    return existsSync(appRoot) ? appRoot : undefined;
  } catch {
    return undefined;
  }
}

function agentDataSubdir(subdir: string, profileOverride?: string): string {
  const xdg = profileOverride === undefined ? xdgDataAgentRoot() : undefined;
  return path.join(xdg ?? getAgentDir(profileOverride), subdir);
}

/** ~/.omp/agent/sessions，支持读取指定 profile 的会话目录。 */
export function getSessionsDir(profileOverride?: string): string {
  return agentDataSubdir("sessions", profileOverride);
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

/** User-level skills directory (~/.omp/agent/skills). */
export function getUserSkillsDir(): string {
  return path.join(getAgentDir(), "skills");
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
