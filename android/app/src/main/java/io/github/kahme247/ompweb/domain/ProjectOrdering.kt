package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary

/**
 * Pure ordering/grouping helpers shared by the sidebar.
 *
 * Kotlin port of `lib/project-ordering.ts` (plus `comparableProjectPath` from
 * `lib/comparable-path.ts` and `workspaceKeyOf` from
 * `lib/workspace-memory.ts`). All keys are canonical projectRoot paths
 * (worktrees collapse into their main repo via the server), so worktree
 * sessions group under their project.
 *
 * The project list is ordered by when each project was added (addedAt desc =
 * most recently added first), NOT by session activity: activity changes on
 * every session refresh and would make project rows jump around constantly.
 * Session-discovered projects (no addedAt) follow registered ones in path
 * order, which is also stable.
 */

private val WINDOWS_ABSOLUTE_RE = Regex("""^[a-zA-Z]:[\\/]""")
private val UNC_PREFIX_RE = Regex("^//")

/**
 * Case-insensitive comparable form on Windows-form paths (NTFS is
 * case-insensitive); case-sensitive for POSIX-form paths. Windows-ness is
 * decided by the path's own form, exactly like `lib/comparable-path.ts`.
 */
fun comparableProjectPath(value: String): String {
    val normalized = value.replace('\\', '/')
    val windowsForm = WINDOWS_ABSOLUTE_RE.containsMatchIn(normalized) || UNC_PREFIX_RE.containsMatchIn(normalized)
    val collapsed = Regex("/{2,}").replace(normalized, "/").trimEnd('/')
    return if (windowsForm) collapsed.lowercase() else collapsed
}

/** The bucket a session belongs to: projectKey, else projectRoot, else cwd. */
fun workspaceKeyOf(session: SessionSummary): String? =
    session.projectKey ?: session.projectRoot ?: session.cwd

/**
 * Sort projects by most-recently-added (addedAt desc), manual order first,
 * then by path for a deterministic order. Projects without addedAt
 * (session-discovered) always sort below registered ones. The order never
 * depends on session activity.
 */
fun sortManagedProjects(projects: List<ManagedProject>): List<ManagedProject> = projects.sortedWith { a, b ->
    val aManual = a.sortOrder != null
    val bManual = b.sortOrder != null
    when {
        aManual != bManual -> if (aManual) -1 else 1
        aManual && bManual && a.sortOrder != b.sortOrder -> a.sortOrder!! - b.sortOrder!!
        else -> {
            val aHas = a.addedAt != null
            val bHas = b.addedAt != null
            when {
                aHas != bHas -> if (aHas) -1 else 1
                aHas && bHas -> {
                    val byAdded = b.addedAt!!.compareTo(a.addedAt!!)
                    if (byAdded != 0) byAdded else a.path.compareTo(b.path)
                }
                else -> a.path.compareTo(b.path)
            }
        }
    }
}

/** Running/unread/exited session counts for one project row. */
data class ProjectActivity(
    val running: Int = 0,
    val unread: Int = 0,
    val exited: Int = 0,
)

/**
 * Running/unread/exit session counts per project. Keys are the case-folded
 * comparable form of the project root, so casing-only differences
 * (Windows/NTFS) still resolve — look up with
 * `comparableProjectPath(project.path)`.
 */
fun projectActivityCounts(
    sessions: List<SessionSummary>,
    runningIds: Collection<String>,
    unreadIds: Collection<String>,
    exitedIds: Collection<String> = emptyList(),
): Map<String, ProjectActivity> {
    val running = runningIds.toSet()
    val unread = unreadIds.toSet()
    val exited = exitedIds.toSet()
    val result = LinkedHashMap<String, ProjectActivity>()
    for (session in sessions) {
        val key = workspaceKeyOf(session) ?: continue
        val folded = comparableProjectPath(key)
        val current = result[folded] ?: ProjectActivity()
        result[folded] = current.copy(
            running = current.running + if (session.id in running) 1 else 0,
            unread = current.unread + if (session.id in unread) 1 else 0,
            exited = current.exited + if (session.id in exited) 1 else 0,
        )
    }
    return result
}

/**
 * Group sessions under their project. Every project in [projects] gets an
 * entry (possibly empty) so empty managed projects render their empty state.
 * Buckets are keyed by the exact project path for callers; sessions are
 * matched through a case-folded lookup so casing-only differences land in the
 * right bucket instead of silently dropping the session.
 */
fun groupSessionsByProject(
    projects: List<ManagedProject>,
    sessions: List<SessionSummary>,
): Map<String, List<SessionSummary>> {
    val grouped = LinkedHashMap<String, MutableList<SessionSummary>>()
    val bucketByKey = HashMap<String, MutableList<SessionSummary>>()
    for (project in projects) {
        val bucket = mutableListOf<SessionSummary>()
        grouped[project.path] = bucket
        bucketByKey[comparableProjectPath(project.path)] = bucket
    }
    for (session in sessions) {
        val key = workspaceKeyOf(session) ?: continue
        bucketByKey[comparableProjectPath(key)]?.add(session)
    }
    return grouped
}
