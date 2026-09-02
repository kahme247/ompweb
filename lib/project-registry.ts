import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "fs";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { comparableProjectPath } from "./comparable-path";
import { getAgentDir } from "./omp/paths";
import type { ManagedProject, ProjectLaunchConfig } from "./types";

// ============================================================================
// Project registry: which directories the user explicitly manages, and which
// of them are hidden from the sidebar. Stored as ~/.omp/agent/projects.json
// (the same agent dir as sessions), written atomically so a crash can never
// leave a half-written registry. Hiding is reversible: the entry (and its
// sessions) is restored by adding the directory again.
//
// Paths are stored in their canonical (worktree-resolved) projectRoot form so
// worktrees always group under their main repository.
// ============================================================================

export interface ProjectRegistryEntry {
  /** Canonical project path (worktrees resolve to their main repo root). */
  path: string;
  /** ISO timestamp of the most recent explicit add. Used to order projects by
   *  most-recently-added (stable; never session activity). */
  addedAt: string;
  /** True when the user removed the project from the sidebar. Hidden entries
   *  suppress session re-discovery until the project is added again. */
  hidden: boolean;
  /** Optional display-only workspace name. */
  alias?: string;
  /** Explicit sidebar position; lower values appear first. */
  sortOrder?: number;
  /** 工作区级 omp 启动配置。 */
  launchConfig?: ProjectLaunchConfig;
}

export interface ProjectRegistryFile {
  version: 1;
  projects: ProjectRegistryEntry[];
}

/** Error carrying a stable code (errors.* key) for client localization. */
export class ProjectPathError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectPathError";
    this.code = code;
  }
}

const EMPTY_REGISTRY: ProjectRegistryFile = { version: 1, projects: [] };

function canonicalProjectPath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Launch args the web UI manages itself; a workspace config must never carry
 *  them (bare or `--flag=value`), or a stored config could hijack the session
 *  boundary (`--cwd`/`--resume`) or the rpc-ui mode. */
const RESERVED_LAUNCH_ARGS: Record<string, true> = { "--mode": true, "rpc-ui": true, "--cwd": true, "--resume": true };
const RESERVED_LAUNCH_ARG_PREFIXES = ["--mode=", "--cwd=", "--resume="];
export function isReservedLaunchArg(arg: string): boolean {
  return RESERVED_LAUNCH_ARGS[arg] === true || RESERVED_LAUNCH_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix));
}

/** 解析磁盘注册表中的启动配置；非法字段安全忽略。 */
function parseLaunchConfig(item: Record<string, unknown>): ProjectLaunchConfig | undefined {
  const raw = item.launchConfig;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const profile = typeof value.profile === "string" && value.profile.trim() && !value.profile.trim().startsWith("-") ? value.profile.trim() : undefined;
  const advisor = value.advisor === true ? true : undefined;
  const extraArgs = Array.isArray(value.extraArgs)
    ? value.extraArgs.filter((arg): arg is string => typeof arg === "string" && arg.length > 0 && arg.length <= 256 && !isReservedLaunchArg(arg)).slice(0, 32)
    : undefined;
  if (!profile && advisor === undefined && (!extraArgs || extraArgs.length === 0)) return undefined;
  return { profile, advisor, extraArgs };
}

/** Parse registry JSON; missing, corrupt, or foreign-shaped input yields an
 *  empty registry rather than failing the whole sidebar. */
export function parseProjectRegistry(raw: string): ProjectRegistryFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_REGISTRY;
    if (!("projects" in parsed) || !Array.isArray(parsed.projects)) return EMPTY_REGISTRY;
    const entries: ProjectRegistryEntry[] = [];
    for (const item of parsed.projects) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (!("path" in item) || typeof item.path !== "string" || !item.path.trim()) continue;
      entries.push({
        path: canonicalProjectPath(item.path.trim()),
        addedAt: "addedAt" in item && typeof item.addedAt === "string"
          ? item.addedAt
          : new Date(0).toISOString(),
        hidden: "hidden" in item && item.hidden === true,
        alias: "alias" in item && typeof item.alias === "string" && item.alias.trim() ? item.alias.trim() : undefined,
        sortOrder: "sortOrder" in item && typeof item.sortOrder === "number" && Number.isFinite(item.sortOrder) ? item.sortOrder : undefined,
        launchConfig: parseLaunchConfig(item as Record<string, unknown>),
      });
    }
    return { version: 1, projects: entries };
  } catch {
    return EMPTY_REGISTRY;
  }
}

export function loadProjectRegistry(): ProjectRegistryFile {
  const registryPath = resolve(getAgentDir(), "projects.json");
  if (!existsSync(registryPath)) return EMPTY_REGISTRY;
  try {
    return parseProjectRegistry(readFileSync(registryPath, "utf8"));
  } catch {
    return EMPTY_REGISTRY;
  }
}

/** Atomic persistence: write a temp file in the same directory, then rename
 *  over the registry. A crash mid-write leaves the previous registry intact. */
export function saveProjectRegistry(registry: ProjectRegistryFile): void {
  const registryPath = resolve(getAgentDir(), "projects.json");
  mkdirSync(resolve(registryPath, ".."), { recursive: true });
  const temp = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    renameSync(temp, registryPath);
  } finally {
    // Best-effort cleanup if the rename never happened (e.g. EACCES).
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Register a project (or restore a hidden one). Re-adding refreshes addedAt,
 *  which moves the project to the front of the most-recently-added ordering. */
export function upsertProject(
  registry: ProjectRegistryFile,
  path: string,
  now = new Date().toISOString(),
  launchConfig?: ProjectLaunchConfig,
): ProjectRegistryFile {
  const canonical = canonicalProjectPath(path);
  const key = comparableProjectPath(canonical);
  const existing = registry.projects.find((p) => comparableProjectPath(p.path) === key);
  const projects = registry.projects.filter((p) => comparableProjectPath(p.path) !== key);
  // An omitted launchConfig preserves the stored one: re-adding a workspace
  // (e.g. un-hiding) without config must not wipe it. Explicit clear goes
  // through PATCH with null.
  projects.push({ path: canonical, addedAt: now, hidden: false, launchConfig: launchConfig ?? existing?.launchConfig });
  return { version: 1, projects };
}

/** Apply display-only updates (alias, sortOrder) to any number of projects in
 *  ONE atomic operation — the caller persists the result once, so concurrent
 *  single-entry writes can never lose each other's changes. Paths that match
 *  no registry entry are ignored; callers wanting session-discovered projects
 *  managed must register them in the same cycle (see /api/projects PATCH). */
export function updateProjectsPresentation(
  registry: ProjectRegistryFile,
  updates: ReadonlyArray<{ path: string; alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }>,
): ProjectRegistryFile {
  const keyed = new Map(updates.map((update) =>
    [comparableProjectPath(canonicalProjectPath(update.path)), update] as const,
  ));
  return {
    version: 1,
    projects: registry.projects.map((project) => {
      const update = keyed.get(comparableProjectPath(project.path));
      if (!update) return project;
      const next = { ...project };
      if (update.alias !== undefined) {
        const alias = update.alias?.trim();
        if (alias) next.alias = alias;
        else delete next.alias;
      }
      if (update.sortOrder !== undefined) {
        if (update.sortOrder === null) delete next.sortOrder;
        else next.sortOrder = update.sortOrder;
      }
      if (update.launchConfig !== undefined) {
        if (update.launchConfig === null) delete next.launchConfig;
        else next.launchConfig = update.launchConfig;
      }
      return next;
    }),
  };
}

export function hideProject(registry: ProjectRegistryFile, path: string): ProjectRegistryFile {
  const canonical = canonicalProjectPath(path);
  const key = comparableProjectPath(canonical);
  const existing = registry.projects.some((p) => comparableProjectPath(p.path) === key);
  const projects = registry.projects.map((p) =>
    comparableProjectPath(p.path) === key ? { ...p, hidden: true } : p,
  );
  if (!existing) {
    projects.push({ path: canonical, addedAt: new Date().toISOString(), hidden: true });
  }
  return { version: 1, projects };
}

/** Merge registered projects with session-discovered ones, excluding hidden
 *  entries. A hidden registry entry suppresses re-discovery, so hiding a
 *  project keeps its sessions off the sidebar until it is added again.
 *  Registered projects come first in most-recently-added order; discovered
 *  projects follow sorted by path. */
export function mergeProjects(registry: ProjectRegistryFile, discovered: Iterable<string>): ManagedProject[] {
  const hidden = new Set(
    registry.projects.filter((p) => p.hidden).map((p) => comparableProjectPath(p.path)),
  );
  const registered: ManagedProject[] = [];
  const registeredSeen = new Set<string>();
  for (const p of registry.projects
    .filter((entry) => !entry.hidden)
    .sort((a, b) => {
      const aOrder = a.sortOrder ?? Number.POSITIVE_INFINITY;
      const bOrder = b.sortOrder ?? Number.POSITIVE_INFINITY;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return b.addedAt.localeCompare(a.addedAt);
    })) {
    const key = comparableProjectPath(p.path);
    if (registeredSeen.has(key)) continue; // tolerate hand-edited duplicates
    registeredSeen.add(key);
    registered.push({ path: p.path, addedAt: p.addedAt, alias: p.alias, sortOrder: p.sortOrder, launchConfig: p.launchConfig });
  }
  const extra: ManagedProject[] = [];
  const extraSeen = new Set<string>();
  for (const raw of new Set([...discovered].filter(Boolean).map(canonicalProjectPath))) {
    const key = comparableProjectPath(raw);
    if (hidden.has(key) || registeredSeen.has(key) || extraSeen.has(key)) continue;
    extraSeen.add(key);
    extra.push({ path: raw });
  }
  extra.sort((a, b) => a.path.localeCompare(b.path));
  return [...registered, ...extra];
}

/** Normalize a user-supplied path: ~ and ~/ expand to the home directory,
 *  relative paths resolve against the server cwd (mirrors /api/cwd/validate). */
function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

/** Validate and canonicalize a candidate project path. Throws ProjectPathError
 *  with a stable code on failure (path_required / directory_not_found /
 *  not_a_directory). */
export function validateProjectPath(cwd: string): string {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  if (!trimmed) throw new ProjectPathError("path_required", "Path is required");

  const normalized = normalizeCwd(trimmed);
  let stat: Stats;
  try {
    stat = statSync(normalized);
  } catch {
    throw new ProjectPathError("directory_not_found", `Directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new ProjectPathError("not_a_directory", `Path is not a directory: ${cwd}`);
  }
  return normalized;
}
