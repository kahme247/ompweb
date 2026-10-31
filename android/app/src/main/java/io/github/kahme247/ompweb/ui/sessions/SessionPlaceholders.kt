package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.domain.workspaceKeyOf
import io.github.kahme247.ompweb.net.ExitedSession
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary

/**
 * Adds a placeholder row for every live session that has no JSONL yet.
 *
 * `GET /api/sessions` only lists sessions with a file, but a session started
 * from the app is live for a moment before its first message is written. The
 * web keeps such rows (`SessionSidebar.tsx` placeholders from
 * `runningSessionIds` + `exitedSessions`), so the new session stays visible
 * instead of vanishing until the next file change.
 */
internal fun withLivePlaceholders(
    sessions: List<SessionSummary>,
    runningIds: Set<String>,
    runningCwds: Map<String, String>,
    exited: Map<String, ExitedSession>,
    projects: List<ManagedProject>,
    activeCwd: String?,
): List<SessionSummary> {
    val known = sessions.mapTo(HashSet()) { it.id }
    val live = LinkedHashSet<String>().apply {
        addAll(runningIds)
        addAll(exited.keys)
    }
    val placeholders = live.filterNot { it in known }.map { id ->
        val cwd = runningCwds[id] ?: exited[id]?.cwd ?: activeCwd.orEmpty()
        val registered = projects.firstOrNull {
            cwd.isNotBlank() && comparableProjectPath(it.path) == comparableProjectPath(cwd)
        }?.path
        val root = registered ?: cwd
        SessionSummary(
            id = id,
            cwd = cwd,
            projectRoot = root.takeIf { it.isNotBlank() },
            projectKey = comparableProjectPath(root).takeIf { root.isNotBlank() },
        )
    }
    return sessions + placeholders
}

/**
 * Projects for the list: the managed list plus a workspace for every session
 * directory it does not cover. `groupSessionsByProject` drops sessions whose
 * workspace is unknown, so a placeholder in an unregistered directory would
 * disappear without this.
 */
internal fun withWorkspaceProjects(
    projects: List<ManagedProject>,
    sessions: List<SessionSummary>,
): List<ManagedProject> {
    val known = projects.mapTo(HashSet()) { comparableProjectPath(it.path) }
    val extra = sessions.mapNotNull(::workspaceKeyOf)
        .distinct()
        .filter { comparableProjectPath(it) !in known }
        .map { path -> ManagedProject(path = path) }
    return projects + extra
}
