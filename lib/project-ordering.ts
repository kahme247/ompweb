import { comparableProjectPath } from "./comparable-path";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// ============================================================================
// Pure ordering/grouping helpers shared between the sidebar and unit tests.
// All keys are canonical projectRoot paths (worktrees collapse into their main
// repo via resolveProject), so worktree sessions group under their project.
//
// The project list is ordered by when each project was added (addedAt desc =
// most recently added first), NOT by session activity: activity changes on
// every session refresh (agent runs, message edits, unread transitions) and
// would make project rows jump around constantly. Registration order is
// stable — it only changes when the user explicitly adds a project.
// Session-discovered projects (no addedAt) follow the registered ones in
// path order, which is also stable.
// ============================================================================

/** Sort projects by most-recently-added (addedAt desc), then by path for a
 *  deterministic order. Projects without addedAt (session-discovered) always
 *  sort below registered ones. The order never depends on session activity,
 *  so project rows stay put while sessions refresh. */
export function sortManagedProjects(projects: ManagedProject[]): ManagedProject[] {
  return [...projects].sort((a, b) => {
    const aManual = a.sortOrder !== undefined;
    const bManual = b.sortOrder !== undefined;
    if (aManual !== bManual) return aManual ? -1 : 1;
    if (aManual && bManual && a.sortOrder !== b.sortOrder) return a.sortOrder! - b.sortOrder!;
    const aHas = a.addedAt !== undefined;
    const bHas = b.addedAt !== undefined;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const byAdded = b.addedAt!.localeCompare(a.addedAt!);
      if (byAdded !== 0) return byAdded;
    }
    return a.path.localeCompare(b.path);
  });
}

/** Running/unread session counts per project, for the activity indicators on
 *  project rows. Keys are the case-folded comparable form of the projectRoot
 *  so casing-only differences (Windows/NTFS) still resolve — callers must
 *  look up with comparableProjectPath(project.path). */
export function projectActivityCounts(
  sessions: SessionInfo[],
  runningIds: Iterable<string>,
  unreadIds: Iterable<string>,
): Map<string, { running: number; unread: number }> {
  const running = new Set(runningIds);
  const unread = new Set(unreadIds);
  const result = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    const folded = comparableProjectPath(session.projectKey ?? key);
    const current = result.get(folded) ?? { running: 0, unread: 0 };
    if (running.has(session.id)) current.running += 1;
    if (unread.has(session.id)) current.unread += 1;
    result.set(folded, current);
  }
  return result;
}

/** Group sessions under their project. Every project in `projects` gets an
 *  entry (possibly empty) so empty managed projects render their empty state.
 *  Buckets are keyed by the exact project path for callers; sessions are
 *  matched through a case-folded lookup (Windows/NTFS is case-insensitive and
 *  session-file cwds can carry different casing than the registered path), so
 *  casing-only differences land in the right bucket instead of silently
 *  dropping the session from the sidebar. */
export function groupSessionsByProject(
  projects: ManagedProject[],
  sessions: SessionInfo[],
): Map<string, SessionInfo[]> {
  const grouped = new Map<string, SessionInfo[]>();
  const bucketByKey = new Map<string, SessionInfo[]>();
  for (const project of projects) {
    const bucket: SessionInfo[] = [];
    grouped.set(project.path, bucket);
    bucketByKey.set(comparableProjectPath(project.path), bucket);
  }
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    // workspaceKeyOf already prefers projectKey, so this IS the session's
    // key; bucketByKey covers every registered project under its case-folded
    // path, and an exact-case fallback here could only hit when the folded
    // lookup already did — otherwise it silently dropped the session.
    const bucket = bucketByKey.get(comparableProjectPath(key));
    if (bucket) bucket.push(session);
  }
  return grouped;
}
