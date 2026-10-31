import { comparableProjectPath } from "./comparable-path";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// ============================================================================
// Pure ordering/grouping helpers shared between the sidebar and unit tests.
// All keys are canonical projectRoot paths (worktrees collapse into their main
// repo via resolveProject), so worktree sessions group under their project.
//
// With sort "none" (the default) the project list is ordered manually, then by
// when each project was added (addedAt desc = most recently added first), NOT
// by session activity: activity changes on every session refresh and would
// make project rows jump around. Session-discovered projects (no addedAt)
// follow the registered ones in path order, which is also stable. Only the
// opt-in "updated" sort follows activity (see orderProjects).
// ============================================================================

/** Host id of this machine (see `HostRow` from the `hosts` channel). */
export const LOCAL_HOST_ID = "local";

/** `hostId` as requests and view state carry it: undefined for this machine. */
export function remoteHostId(hostId: string | null | undefined): string | undefined {
  return hostId && hostId !== LOCAL_HOST_ID ? hostId : undefined;
}

/** Identity of a project across hosts: the bare path on this machine, so keys
 *  stored before hosts existed (expanded set, last-open memory) stay valid,
 *  and `<hostId>:<path>` on a remote host. A missing hostId is this machine. */
export function hostProjectKey(hostId: string | undefined, path: string): string {
  return hostId === undefined || hostId === LOCAL_HOST_ID ? path : `${hostId}:${path}`;
}

/** Composer draft key of a fresh chat: `new:<cwd>` on this machine (drafts
 *  saved before hosts existed keep their key), `new:<hostId>:<cwd>` elsewhere. */
export function newChatDraftKey(cwd: string, hostId: string | undefined): string {
  return `new:${hostProjectKey(hostId, cwd)}`;
}

/** `hostProjectKey` over the case-folded comparable path (how sessions find their project). */
export function foldedHostProjectKey(hostId: string | undefined, path: string): string {
  return hostProjectKey(hostId, comparableProjectPath(path));
}

/** Projects per host for the sidebar: this machine first, then the other
 *  hosts by label. Every known host gets a group, empty or not, so it can
 *  still be added to; projects of a host that is not listed are dropped. */
export function groupProjectsByHost<T extends { hostId?: string }>(
  projects: T[],
  hosts: { id: string; label: string }[],
): { host: { id: string; label: string }; projects: T[] }[] {
  const ordered = [...hosts].sort((a, b) => {
    if ((a.id === LOCAL_HOST_ID) !== (b.id === LOCAL_HOST_ID)) return a.id === LOCAL_HOST_ID ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });
  });
  return ordered.map((host) => ({
    host,
    projects: projects.filter((project) => (project.hostId ?? LOCAL_HOST_ID) === host.id),
  }));
}

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

/** Sidebar workspace sort: "none" is the manual/registration order above. */
export type ProjectSortMode = "none" | "alphabetical" | "updated";

/** Order projects for a sort mode. In "none", pins are ignored and the manual
 *  order applies. Otherwise pinned projects come first in their pinOrder, then
 *  the rest by label (A→Z, case-insensitive, digits numerically) or by their
 *  newest session's last message time (`lastMessageAt`, else the file's
 *  `modified`; most recent first, projects without sessions last). Ties keep
 *  the manual order. */
export function orderProjects(
  projects: ManagedProject[],
  mode: ProjectSortMode,
  sessions: SessionInfo[],
  labelOf: (project: ManagedProject) => string,
): ManagedProject[] {
  const manual = sortManagedProjects(projects);
  if (mode === "none") return manual;
  const pinned = manual.filter((p) => p.pinOrder !== undefined).sort((a, b) => a.pinOrder! - b.pinOrder!);
  const rest = manual.filter((p) => p.pinOrder === undefined);
  if (mode === "alphabetical") {
    rest.sort((a, b) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base", numeric: true }));
  } else {
    const updated = new Map<string, number>();
    for (const session of sessions) {
      const key = workspaceKeyOf(session);
      if (!key) continue;
      const folded = foldedHostProjectKey(session.hostId, key);
      const time = Date.parse(session.lastMessageAt ?? session.modified);
      if (time > (updated.get(folded) ?? 0)) updated.set(folded, time);
    }
    rest.sort((a, b) => (updated.get(foldedHostProjectKey(b.hostId, b.path)) ?? 0) - (updated.get(foldedHostProjectKey(a.hostId, a.path)) ?? 0));
  }
  return [...pinned, ...rest];
}

/** pinOrder that places a newly pinned project last among the pinned ones. */
export function nextPinOrder(projects: ManagedProject[]): number {
  return Math.max(-1, ...projects.map((p) => p.pinOrder ?? -1)) + 1;
}

/** Running/unread/exit session counts per project, for the activity indicators
 *  on project rows. Keys are the case-folded comparable form of the projectRoot
 *  so casing-only differences (Windows/NTFS) still resolve — callers must
 *  look up with foldedHostProjectKey(project.hostId, project.path). */
export function projectActivityCounts(
  sessions: SessionInfo[],
  runningIds: Iterable<string>,
  unreadIds: Iterable<string>,
  exitedIds: Iterable<string> = [],
): Map<string, { running: number; unread: number; exited: number }> {
  const running = new Set(runningIds);
  const unread = new Set(unreadIds);
  const exited = new Set(exitedIds);
  const result = new Map<string, { running: number; unread: number; exited: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    const folded = foldedHostProjectKey(session.hostId, session.projectKey ?? key);
    const current = result.get(folded) ?? { running: 0, unread: 0, exited: 0 };
    if (running.has(session.id)) current.running += 1;
    if (unread.has(session.id)) current.unread += 1;
    if (exited.has(session.id)) current.exited += 1;
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
 *  dropping the session from the sidebar. Hosts are separate namespaces: the
 *  same path on two hosts is two projects, keyed by `hostProjectKey`. */
export function groupSessionsByProject(
  projects: ManagedProject[],
  sessions: SessionInfo[],
): Map<string, SessionInfo[]> {
  const grouped = new Map<string, SessionInfo[]>();
  const bucketByKey = new Map<string, SessionInfo[]>();
  for (const project of projects) {
    const bucket: SessionInfo[] = [];
    grouped.set(hostProjectKey(project.hostId, project.path), bucket);
    bucketByKey.set(foldedHostProjectKey(project.hostId, project.path), bucket);
  }
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    // workspaceKeyOf already prefers projectKey, so this IS the session's
    // key; bucketByKey covers every registered project under its case-folded
    // path, and an exact-case fallback here could only hit when the folded
    // lookup already did — otherwise it silently dropped the session.
    const bucket = bucketByKey.get(foldedHostProjectKey(session.hostId, key));
    if (bucket) bucket.push(session);
  }
  return grouped;
}
