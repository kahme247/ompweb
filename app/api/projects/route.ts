import { NextResponse } from "next/server";
import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { allowFileRoot } from "@/lib/file-access";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { listProjectsAllHosts } from "@/lib/hosts/session-index";
import type { ProjectUpdate } from "@/lib/hosts/session-ops";
import { isReservedLaunchArg, ProjectPathError } from "@/lib/project-registry";
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
  if (profile?.startsWith("-")) throw new ProjectPathError("invalid_profile", "Profile must not start with '-'");
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
    for (const project of projects) if (project.hostId === LOCAL_HOST_ID) allowFileRoot(project.path);
    return NextResponse.json({ projects });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/projects  body: { cwd }  →  { project: ManagedProject }
// Validates the directory, resolves Git worktrees to their main projectRoot,
// registers and authorizes it, and unhides it if it was previously hidden.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; launchConfig?: unknown; hostId?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const launchConfig = parseLaunchConfig(body.launchConfig);
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const { host } = target;
    const result = await host.sessionOps.addProject(cwd, launchConfig);
    if (!result.ok) return opErrorResponse(result);
    if (host.id !== LOCAL_HOST_ID) return NextResponse.json({ project: { ...result.value, hostId: host.id } });
    allowFileRoot(result.value.path);
    return NextResponse.json({ project: result.value });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
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

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: unknown;
      alias?: unknown;
      sortOrder?: unknown;
      pinOrder?: unknown;
      launchConfig?: unknown;
      updates?: unknown;
      hostId?: unknown;
    };
    const rawUpdates: unknown[] = Array.isArray(body.updates)
      ? body.updates
      : body.cwd !== undefined || body.alias !== undefined || body.sortOrder !== undefined || body.pinOrder !== undefined || body.launchConfig !== undefined
        ? [{ cwd: body.cwd, alias: body.alias, sortOrder: body.sortOrder, pinOrder: body.pinOrder, launchConfig: body.launchConfig }]
        : [];
    if (rawUpdates.length === 0) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    if (rawUpdates.length > MAX_PRESENTATION_UPDATES) {
      return NextResponse.json({ error: "Too many updates", code: "too_many_updates" }, { status: 400 });
    }

    const parsed: ProjectUpdate[] = [];
    for (const item of rawUpdates) {
      const entry = item as { cwd?: unknown; alias?: unknown; sortOrder?: unknown; pinOrder?: unknown; launchConfig?: unknown };
      const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
      if (!cwd) return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
      const alias = entry.alias === null ? null : typeof entry.alias === "string" ? entry.alias : undefined;
      const sortOrder = entry.sortOrder === null ? null : typeof entry.sortOrder === "number" && Number.isFinite(entry.sortOrder) ? entry.sortOrder : undefined;
      const pinOrder = entry.pinOrder === null ? null : typeof entry.pinOrder === "number" && Number.isFinite(entry.pinOrder) ? entry.pinOrder : undefined;
      if (entry.alias !== undefined && alias === undefined) return NextResponse.json({ error: "Alias must be a string", code: "invalid_alias" }, { status: 400 });
      if (entry.sortOrder !== undefined && sortOrder === undefined) return NextResponse.json({ error: "Sort order must be a number", code: "invalid_sort_order" }, { status: 400 });
      if (entry.pinOrder !== undefined && pinOrder === undefined) return NextResponse.json({ error: "Pin order must be a number", code: "invalid_pin_order" }, { status: 400 });
      const launchConfig = entry.launchConfig === null ? null : parseLaunchConfig(entry.launchConfig);
      parsed.push({ cwd, alias, sortOrder, pinOrder, launchConfig });
    }

    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.sessionOps.updateProject(parsed);
    if (!result.ok) return opErrorResponse(result);
    // Only after a successful save: a failed write must not leave an orphaned
    // in-memory browse authorization behind. Never for another host's paths.
    if (target.host.id === LOCAL_HOST_ID) for (const root of result.value.newRoots) allowFileRoot(root);
    const { projects } = result.value;
    return NextResponse.json({ projects: target.host.id === LOCAL_HOST_ID ? projects : projects.map((project) => ({ ...project, hostId: target.host.id })) });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// DELETE /api/projects  body: { cwd }  →  { success: true }
// Hides the project from the sidebar without touching its directory or
// sessions. Re-adding the directory (POST) restores it.
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; hostId?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.sessionOps.hideProject(cwd);
    if (!result.ok) return opErrorResponse(result);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
