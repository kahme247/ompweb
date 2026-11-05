import { realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getConfigAgentRoots, isFilePathAllowed, normalizeSlashes } from "../file-access";
import { authorizeFileAccess } from "../file-authorization";
import { filePathApiSegments } from "../file-paths";
import { loadProjectRegistry } from "../project-registry";
import { listAllSessions } from "../session-reader";
import { HostOpError } from "./link-protocol";

const grants = new Set<string>();
let cached: { roots: Set<string>; until: number } | null = null;

export function invalidateWorkspaceRoots(): void { cached = null; }

export function grantWorkspaceRoot(path: string): void {
  grants.add(normalizeSlashes(realpathSync(path)));
  grants.add(normalizeSlashes(resolve(path)));
  invalidateWorkspaceRoots();
}

export async function getWorkspaceRoots(): Promise<Set<string>> {
  if (cached && cached.until > Date.now()) return cached.roots;
  const roots = new Set<string>();
  for (const session of await listAllSessions()) {
    if (session.cwd) roots.add(normalizeSlashes(session.cwd));
    if (session.projectRoot) roots.add(normalizeSlashes(session.projectRoot));
  }
  for (const project of loadProjectRegistry().projects) {
    if (!project.hidden) roots.add(normalizeSlashes(project.path));
  }
  for (const grant of grants) roots.add(grant);
  try {
    for (const entry of readdirSync(homedir(), { withFileTypes: true })) {
      if (entry.isDirectory() && /^omp-cwd-\d{8}$/.test(entry.name)) roots.add(normalizeSlashes(join(homedir(), entry.name)));
    }
  } catch { /* A missing home does not authorize any scratch directory. */ }
  for (const root of getConfigAgentRoots()) roots.add(root);
  cached = { roots, until: Date.now() + 5_000 };
  return roots;
}

/** Writes require an explicit absolute directory, never read-path root fanout. */
export async function authorizeWorkspaceDirectory(directory: string): Promise<string> {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new HostOpError(400, "invalid_request", "An absolute directory is required");
  const roots = await getWorkspaceRoots();
  if (!isFilePathAllowed(directory, roots)) throw new HostOpError(403, "access_denied", "Access denied");
  const checked = await authorizeFileAccess(filePathApiSegments(directory), null, false, roots);
  if (!checked.ok) throw new HostOpError(checked.status, checked.code, checked.error);
  if (!checked.stat.isDirectory()) throw new HostOpError(400, "not_a_directory", "The destination is not a directory");
  return realpathSync(checked.filePath);
}
