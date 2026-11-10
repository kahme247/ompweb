import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { isValidOmpProfile } from "@/lib/omp-profile";
import { allowFileRoot } from "@/lib/file-access";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { isValidPoolOrigin, loadPools, poolManagedProject, savePools } from "@/lib/hosts/pools";
import { listProjectsAllHosts } from "@/lib/hosts/session-index";
import type { ProjectUpdate } from "@/lib/hosts/session-ops";
import { applyProjectPresentation, isReservedLaunchArg, ProjectPathError, type ProjectPresentationUpdate } from "@/lib/project-registry";
import { cloneDirectoryName } from "@/lib/git-clone";
import { isRecord } from "@/lib/type-guards";
import type { ProjectLaunchConfig } from "@/lib/types";
const MAX_EXTRA_ARGS = 32;
const MAX_EXTRA_ARG_LENGTH = 256;

/** Validate the workspace-level omp launch config; reject overrides of web-managed session-boundary args. */
function parseLaunchConfig(value: unknown): ProjectLaunchConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectPathError("invalid_launch_config", "Launch config must be an object");
  const raw = value as Record<string, unknown>;
  const profile = raw.profile === undefined ? undefined : typeof raw.profile === "string" && raw.profile.trim() ? raw.profile.trim() : undefined;
  if (raw.profile !== undefined && !profile) throw new ProjectPathError("invalid_profile", "Profile must be a non-empty string");
  if (profile !== undefined && !isValidOmpProfile(profile)) throw new ProjectPathError("invalid_profile", "Profile names must match ^[a-z0-9][a-z0-9._-]{0,63}$, cannot end with '.', and cannot be a Windows reserved device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension)");
  const advisor = raw.advisor === undefined ? undefined : raw.advisor;
  if (advisor !== undefined && typeof advisor !== "boolean") throw new ProjectPathError("invalid_advisor", "Advisor must be a boolean");
  if (raw.extraArgs !== undefined && (!Array.isArray(raw.extraArgs) || raw.extraArgs.length > MAX_EXTRA_ARGS)) throw new ProjectPathError("invalid_extra_args", "Extra args must contain at most 32 arguments");
  const extraArgs = raw.extraArgs === undefined ? undefined : (raw.extraArgs as unknown[]).map((arg) => {
    if (typeof arg !== "string" || !arg || arg.length > MAX_EXTRA_ARG_LENGTH || isReservedLaunchArg(arg)) throw new ProjectPathError("invalid_extra_args", "Extra args contain an invalid or reserved argument");
    return arg;
  });
  if (!profile && advisor === undefined && (!extraArgs || extraArgs.length === 0)) return undefined;
  return { profile, advisor, extraArgs };
}

function parsePresentation(entry: Record<string, unknown>): ProjectPresentationUpdate {
  const alias = entry.alias === null ? null : typeof entry.alias === "string" ? entry.alias : undefined;
  const sortOrder = entry.sortOrder === null ? null : typeof entry.sortOrder === "number" && Number.isFinite(entry.sortOrder) ? entry.sortOrder : undefined;
  const pinOrder = entry.pinOrder === null ? null : typeof entry.pinOrder === "number" && Number.isFinite(entry.pinOrder) ? entry.pinOrder : undefined;
  if (entry.alias !== undefined && alias === undefined) throw new ProjectPathError("invalid_alias", "Alias must be a string");
  if (entry.sortOrder !== undefined && sortOrder === undefined) throw new ProjectPathError("invalid_sort_order", "Sort order must be a number");
  if (entry.pinOrder !== undefined && pinOrder === undefined) throw new ProjectPathError("invalid_pin_order", "Pin order must be a number");
  return { alias, sortOrder, pinOrder, launchConfig: entry.launchConfig === null ? null : parseLaunchConfig(entry.launchConfig) };
}

function poolTarget(body: Record<string, unknown>) {
  if (body.hostId !== undefined || body.cwd !== undefined) throw new ProjectPathError("invalid_target", "Pool and host/path targets cannot be mixed");
  if (typeof body.poolId !== "string") throw new ProjectPathError("pool_required", "Pool ID is required");
  const pools = loadPools();
  const pool = pools.find((item) => item.id === body.poolId);
  if (!pool) throw new ProjectPathError("pool_not_found", "Pool not found");
  return { pools, pool };
}

function pooledPatch(body: Record<string, unknown>) {
  const { pools, pool } = poolTarget(body);
  const batch = body.updates !== undefined;
  if (batch && (!Array.isArray(body.updates) || body.projectId !== undefined)) throw new ProjectPathError("invalid_target", "Invalid pool batch target");
  const rawUpdates = batch ? body.updates as unknown[] : [body];
  if (!rawUpdates.length || rawUpdates.length > MAX_PRESENTATION_UPDATES) throw new ProjectPathError("invalid_updates", "Invalid number of updates");
  const updates = new Map<string, ProjectPresentationUpdate>();
  for (const entry of rawUpdates) {
    if (!isRecord(entry) || entry.cwd !== undefined || entry.hostId !== undefined || (batch && entry.poolId !== undefined)) {
      throw new ProjectPathError("invalid_target", "Pool and host/path targets cannot be mixed");
    }
    if (typeof entry.projectId !== "string" || !pool.projects.some((project) => project.id === entry.projectId)) throw new ProjectPathError("project_not_found", "Registered project not found");
    if (updates.has(entry.projectId)) throw new ProjectPathError("duplicate_project", "Duplicate project ID");
    updates.set(entry.projectId, parsePresentation(entry));
  }
  pool.projects = pool.projects.map((project) => {
    const update = updates.get(project.id);
    return update ? applyProjectPresentation(project, update) : project;
  });
  savePools(pools);
  return Response.json({ projects: pool.projects.filter((project) => !project.hidden).map((project) => poolManagedProject(pool, project)) });
}

// GET /api/projects  →  { projects: ManagedProject[] }
// Registered (non-hidden) projects plus session-discovered projects, excluding
// hidden entries, for this machine and then each linked host; each carries its
// hostId. Session-discovered paths get no addedAt; the client applies
// the ordering (manual / most-recently-added by default, or the user's chosen
// sort with pins first — see lib/project-ordering.ts).
export async function GET() {
  try {
    const projects = await listProjectsAllHosts();
    // Keep the in-memory browse allowlist warm for registered projects that
    // have no sessions (the in-memory list does not survive restarts, and an
    // empty managed project derives no root from sessions). Only this
    // machine's: another host's paths do not exist here.
    for (const project of projects) if (!project.poolId && project.hostId === LOCAL_HOST_ID) allowFileRoot(project.path);
    return Response.json({ projects });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/projects  body: { cwd }  →  { project: ManagedProject }
// Validates the directory, resolves Git worktrees to their main projectRoot,
// registers and authorizes it, and unhides it if it was previously hidden.
// Pool shape: { poolId, origin, name?, defaultRef?, launchConfig? }; registers an origin, never a checkout.
export async function POST(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) throw new ProjectPathError("invalid_target", "Project target must be an object");
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const launchConfig = parseLaunchConfig(body.launchConfig);
    if (body.poolId !== undefined || body.projectId !== undefined || body.origin !== undefined) {
      const { pools, pool } = poolTarget(body);
      if (body.projectId !== undefined) throw new ProjectPathError("invalid_target", "Registration generates the project ID");
      if (!isValidPoolOrigin(body.origin)) throw new ProjectPathError("invalid_origin", "Invalid repository origin");
      if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) throw new ProjectPathError("invalid_name", "Name must be a non-empty string");
      if (body.defaultRef !== undefined && typeof body.defaultRef !== "string") throw new ProjectPathError("invalid_ref", "Default ref must be a string");
      const matches = pool.projects.filter((project) => project.origin === body.origin);
      if (matches.length > 1) throw new Error("Ambiguous pool project origin");
      let project = matches[0];
      if (!project) {
        project = {
          id: randomUUID(), name: typeof body.name === "string" ? body.name.trim() : cloneDirectoryName(body.origin)!,
          origin: body.origin, clonePaths: {}, addedAt: new Date().toISOString(), hidden: false,
        };
        pool.projects.push(project);
      }
      project.hidden = false;
      project.addedAt = new Date().toISOString();
      if (typeof body.name === "string") project.name = body.name.trim();
      if (typeof body.defaultRef === "string") project.defaultRef = body.defaultRef;
      if (launchConfig !== undefined) project.launchConfig = launchConfig;
      for (const member of pool.members) project.clonePaths[member.hostId] ??= join(member.projectsRoot, project.id);
      savePools(pools);
      return Response.json({ project: poolManagedProject(pool, project) });
    }
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const { host } = target;
    const result = await host.sessionOps.addProject(cwd, launchConfig);
    if (!result.ok) return opErrorResponse(result);
    if (host.id !== LOCAL_HOST_ID) return Response.json({ project: { ...result.value, hostId: host.id } });
    allowFileRoot(result.value.path);
    return Response.json({ project: result.value });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// PATCH /api/projects
// Single shape: { cwd, alias?, sortOrder?, pinOrder? }   Batch shape: { updates: [{ cwd, alias?, sortOrder?, pinOrder? }, ...] }
// Applied atomically in one registry load/save so a drag reorder (one request,
// many entries) can never interleave with another writer and lose updates.
// Renaming or ordering a project is an explicit act of managing it: paths that
// were only session-discovered get registered and their root authorized in the
// same cycle instead of silently no-oping.
const MAX_PRESENTATION_UPDATES = 500;

// Pool mutations use { poolId, projectId, ...settings } or { poolId, updates: [{ projectId, ...settings }] }.
export async function PATCH(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) throw new ProjectPathError("invalid_target", "Project target must be an object");
    if (body.poolId !== undefined || body.projectId !== undefined) return pooledPatch(body);
    const rawUpdates: unknown[] = Array.isArray(body.updates)
      ? body.updates
      : body.cwd !== undefined || body.alias !== undefined || body.sortOrder !== undefined || body.pinOrder !== undefined || body.launchConfig !== undefined
        ? [{ cwd: body.cwd, alias: body.alias, sortOrder: body.sortOrder, pinOrder: body.pinOrder, launchConfig: body.launchConfig }]
        : [];
    if (rawUpdates.length === 0) {
      return Response.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    if (rawUpdates.length > MAX_PRESENTATION_UPDATES) {
      return Response.json({ error: "Too many updates", code: "too_many_updates" }, { status: 400 });
    }

    const parsed: ProjectUpdate[] = [];
    for (const item of rawUpdates) {
      if (!isRecord(item)) throw new ProjectPathError("invalid_target", "Project update must be an object");
      const entry = item;
      if (entry.poolId !== undefined || entry.projectId !== undefined) throw new ProjectPathError("invalid_target", "Pool and host/path targets cannot be mixed");
      const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
      if (!cwd) return Response.json({ error: "Path is required", code: "path_required" }, { status: 400 });
      parsed.push({ cwd, ...parsePresentation(entry) });
    }

    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.sessionOps.updateProject(parsed);
    if (!result.ok) return opErrorResponse(result);
    // Only after a successful save: a failed write must not leave an orphaned
    // in-memory browse authorization behind. Never for another host's paths.
    if (target.host.id === LOCAL_HOST_ID) for (const root of result.value.newRoots) allowFileRoot(root);
    const { projects } = result.value;
    return Response.json({ projects: target.host.id === LOCAL_HOST_ID ? projects : projects.map((project) => ({ ...project, hostId: target.host.id })) });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// DELETE /api/projects  body: { cwd }  →  { success: true }
// Hides the project from the sidebar without touching its directory or
// sessions. Re-adding the directory (POST) restores it.
// Pool shape: { poolId, projectId }; hides presentation only, retaining all clone bindings and data.
export async function DELETE(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) throw new ProjectPathError("invalid_target", "Project target must be an object");
    if (body.poolId !== undefined || body.projectId !== undefined) {
      const { pools, pool } = poolTarget(body);
      const project = pool.projects.find((item) => item.id === body.projectId);
      if (!project) throw new ProjectPathError("project_not_found", "Registered project not found");
      project.hidden = true;
      savePools(pools);
      return Response.json({ success: true });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return Response.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.sessionOps.hideProject(cwd);
    if (!result.ok) return opErrorResponse(result);
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectPathError) return Response.json({ error: error.message, code: error.code }, { status: 400 });
    return apiErrorResponse(error);
  }
}
