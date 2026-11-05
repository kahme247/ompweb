import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir, getConfigRoot } from "./omp/paths";
import { isWindowsAbsolutePath } from "./paths";
import { hostSessions } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";

export { isWindowsAbsolutePath } from "./paths";

// Allowed roots — in-memory plus session-derived, globalThis for hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return stripLongPathPrefix(filePath.replace(/\\/g, "/"));
}

/** Windows device paths (\\?\C:\... , \\?\UNC\server\share\...) come back from
 *  realpathSync and defeat plain startsWith prefix checks against ordinary
 *  drive/UNC roots, producing false 403s on long paths and junctions. */
function stripLongPathPrefix(filePath: string): string {
  if (filePath.startsWith("//?/UNC/")) return "//" + filePath.slice(8);
  if (filePath.startsWith("//?/")) return filePath.slice(4);
  if (filePath.startsWith("\\\\?\\UNC\\")) return "\\\\" + filePath.slice(8);
  if (filePath.startsWith("\\\\?\\")) return filePath.slice(4);
  return filePath;
}

function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) globalThis.__piAdditionalAllowedRoots = new Set();
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const n = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(n);
  globalThis.__piAllowedRootsCache?.roots.add(n);
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

/**
 * omp's own config/agent roots: the config root (`~/.omp`, or whatever
 * `PI_CONFIG_DIR` renamed it to), the agent state dir (`~/.omp/agent`, or
 * `PI_CODING_AGENT_DIR`), and the ecosystem-standard agent rule/skill provider
 * dirs `~/.agents` and `~/.agent`. Global instruction files omp loads itself
 * (`~/.agents/AGENTS.md`, `~/.omp/agent/...`) used to 403 in the file viewer
 * because only workspaces were allowed roots (#135).
 *
 * Derived from lib/omp/paths.ts rather than re-implemented, so the
 * PI_CONFIG_DIR / PI_CODING_AGENT_DIR / XDG rules stay in one place.
 * A directory that does not exist is harmless: isPathWithinRoots is a pure
 * string-prefix check and existingPathWithinRootsChecker() already swallows
 * realpathSync failures for stale roots.
 */
export function getConfigAgentRoots(): string[] {
  return [
    getConfigRoot(),
    getAgentDir(),
    path.join(homedir(), ".agents"),
    path.join(homedir(), ".agent"),
  ].map(normalizeSlashes);
}

/**
 * omp's own secret files, which must stay unreadable through the generic file
 * API even though their directory is an allowed root (#135).
 *
 * `agent.db` is omp's credential store (API keys; its SQLite sidecars and
 * backups hold the same) and `models.yml` can carry an `apiKey` for custom
 * models (`models.yaml` / `models.json` are its other names). Both are already
 * reachable through their purpose-built routes (`app/api/auth/api-key/*`,
 * `app/api/models-config/route.ts`), which redact or scope what they return.
 *
 * Only direct files in an agent dir are denied, including credential copies
 * and editor swaps. `.env` files are also protected at the config root: omp's
 * packages/utils/src/env.ts loads that root and getAgentDir(), including profiles.
 * Independent session uploads and package assets remain readable. Resolve both
 * the owned directories and their protected files: either can be symlinked.
 * Hard links retain distinct paths, so compare their device/inode identity too.
 */
const OMP_ENV_NAME = /^\.env(?:\.|$)/i;
const OMP_SECRET_NAME = /^(?:\.?agent\.db(?:[-.~].*)?|\.?models\.(?:yml|yaml|json)(?:[.~].*|-(?:backup|bak|old)(?:[.~-].*)?)?|\.env(?:\..*)?)$/i;

export function isOmpSecretFile(filePath: string): boolean {
  // Follow the original path before any lexical normalization: link/.. is
  // resolved by the filesystem, not necessarily by path.resolve's string rules.
  const requested = resolvedOrSelf(filePath);
  const target = comparablePath(requested);
  const name = path.basename(requested);
  const protectedName = OMP_SECRET_NAME.test(name);
  const parents = new Set([path.dirname(requested), resolvedOrSelf(path.dirname(filePath))].map(comparablePath));
  const profiles = comparablePath(path.join(getConfigRoot(), "profiles"));
  if (protectedName) {
    for (const parent of parents) {
      if (path.posix.basename(parent) === "agent" && path.posix.dirname(path.posix.dirname(parent)) === profiles) return true;
    }
  }
  const configDirs = ompConfigDirs();
  const agentDirs = [getAgentDir(), ...configDirs.map((dir) => path.join(dir, "agent"))];
  const identity = linkedFileIdentity(filePath);
  for (const dir of new Set([...agentDirs, ...configDirs])) {
    const agentDir = agentDirs.includes(dir);
    const namePattern = agentDir ? OMP_SECRET_NAME : OMP_ENV_NAME;
    if (namePattern.test(name) && (parents.has(comparablePath(dir)) || parents.has(comparablePath(resolvedOrSelf(dir))))) return true;
    const names = new Set(agentDir ? ["agent.db", "models.yml", "models.yaml", "models.json", ".env"] : [".env"]);
    try {
      for (const name of readdirSync(dir)) if (namePattern.test(name)) names.add(name);
    } catch { /* missing directory: the fixed names still cover dangling credential links */ }
    const files = [...names].map((name) => path.join(dir, name));
    if (agentDir) {
      // SQLite sidecars/backups may live beside the canonical database and may
      // themselves be symlinks. Compare exact resolved files, never a path prefix.
      const database = resolvedOrSelf(path.join(dir, "agent.db"));
      const databaseDir = path.dirname(database);
      const databaseName = path.basename(database);
      const sidecars = new Set(["-wal", "-shm", "-journal"].map((suffix) => `${databaseName}${suffix}`));
      const basename = process.platform === "win32" ? databaseName.toLowerCase() : databaseName;
      try {
        for (const name of readdirSync(databaseDir)) {
          const candidate = process.platform === "win32" ? name.toLowerCase() : name;
          const suffix = candidate.startsWith(basename) ? candidate.slice(basename.length)
            : candidate.startsWith(`.${basename}`) ? candidate.slice(basename.length + 1) : null;
          // Apply the same agent.db copy/editor rule to a renamed canonical database.
          if (suffix !== null && OMP_SECRET_NAME.test(`agent.db${suffix}`)) sidecars.add(name);
        }
      } catch { /* absent database directory */ }
      for (const name of sidecars) files.push(path.join(databaseDir, name));
    }
    for (const file of files) {
      if (target === comparablePath(resolvedOrSelf(file))) return true;
      if (identity) {
        const other = linkedFileIdentity(file);
        if (other && identity.dev === other.dev && identity.ino === other.ino) return true;
      }
    }
  }
  return false;
}

/** Default and genuine named-profile config roots, both loaded by omp's env.ts. */
function ompConfigDirs(): string[] {
  const configRoot = getConfigRoot();
  const dirs = [configRoot];
  try {
    for (const profile of readdirSync(path.join(configRoot, "profiles"))) dirs.push(path.join(configRoot, "profiles", profile));
  } catch { /* no profiles */ }
  return dirs;
}

function linkedFileIdentity(filePath: string) {
  try {
    const stat = statSync(filePath, { bigint: true });
    // Only multiply linked files can alias a different credential path.
    return stat.isFile() && stat.nlink > 1 && stat.ino > 0 ? stat : null;
  } catch {
    return null;
  }
}

function resolvedOrSelf(dir: string): string {
  try { return realpathSync.native(dir); } catch { return dir; }
}

/** Canonical comparison keys preserve literal POSIX backslashes and fold Windows path spelling only. */
function comparablePath(filePath: string): string {
  const normalized = (process.platform === "win32" ? normalizeSlashes(filePath) : filePath).replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;
  // This machine's sessions, as its daemon lists them (the last list while it is offline).
  const sessions = await hostSessions(LOCAL_HOST_ID);
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }
  for (const root of getAdditionalAllowedRoots()) roots.add(root);
  // Config roots are appended LAST: a relative request must fan out over real
  // workspaces (session cwds, project roots, allowFileRoot() roots) before it
  // can land in ~/.omp or ~/.agents.
  for (const root of getConfigAgentRoots()) roots.add(root);
  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const n = resolver.resolve(target);
    const nr = resolver.resolve(root);
    const c = useWindowsRules ? n.toLowerCase() : n;
    const cr = useWindowsRules ? nr.toLowerCase() : nr;
    const withSep = cr.endsWith(sep) ? cr : cr + sep;
    if (c === cr || c.startsWith(withSep)) return true;
  }
  return false;
}

export const isFilePathAllowed = isPathWithinRoots;

/** An /api/files request path is absolute when it is a posix `/…` root, a
 *  Windows drive `C:/…` path, or a UNC `//server/share…` path. Everything else
 *  is relative and only becomes meaningful once resolved against a root. */
export function isAbsoluteFileRequestPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath);
  return normalized.startsWith("/") || isWindowsAbsolutePath(normalized);
}

/**
 * Resolve a *relative* /api/files request path against the allowed roots.
 *
 * `components/MarkdownBody.tsx` linkifies bare workspace paths (`package.json`,
 * `src/foo.ts`) into `/api/files/<encoded>?type=read`, but the catch-all param
 * carries no leading slash, so the route read those as `/package.json` — a path
 * at the filesystem root, in no allowed root, and a 403 (#135).
 *
 * Candidates are tried in allowed-roots Set order (session cwds, then project
 * roots, then allowFileRoot() roots, then the config roots) and the first one
 * that (a) stays inside the root that produced it and (b) exists on disk wins.
 * A `../..` escape resolves out of its root and fails the same prefix check
 * that guards absolute requests, so traversal is rejected identically.
 *
 * Returns null for an absolute request (nothing to resolve) and for a relative
 * one that matches no in-root candidate. Callers must keep their absolute
 * authorization in place — this only ever widens *which in-root path* a
 * relative name maps to, never past a root.
 */
export function resolveRequestedFilePath(requestPath: string, roots: Set<string>): string | null {
  const request = normalizeSlashes(requestPath);
  // Checked before any trimming: a UNC `//server/share` request is absolute,
  // not a relative path with a doubled slash.
  if (!request || isAbsoluteFileRequestPath(request)) return null;
  const relative = request.replace(/^\/+/, "");
  if (!relative) return null;
  for (const root of roots) {
    // Mirror isPathWithinRoots' resolver choice so a Windows-style root stays
    // Windows-style even when the strings are built on another platform.
    const useWindowsRules = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(relative);
    const resolver = useWindowsRules ? path.win32 : path;
    const candidate = resolver.resolve(root, relative);
    // The candidate is checked against the ONE root that produced it, never
    // against the whole set: `path.resolve(root, "../..")` escapes that root.
    if (!isPathWithinRoots(candidate, new Set([root]))) continue;
    if (!existsSync(candidate)) continue;
    return normalizeSlashes(candidate);
  }
  return null;
}

/** isExistingPathWithinRoots for many targets: realpaths the roots once. */
export function existingPathWithinRootsChecker(roots: Set<string>): (target: string) => boolean {
  const realRoots = new Set<string>();
  for (const root of roots) { try { realRoots.add(stripLongPathPrefix(realpathSync(root))); } catch { /* stale */ } }
  return (target) => {
    let realTarget: string;
    try { realTarget = stripLongPathPrefix(realpathSync(target)); } catch { return false; }
    return isPathWithinRoots(realTarget, realRoots);
  };
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  return existingPathWithinRootsChecker(roots)(target);
}

export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
