package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import java.util.Locale

/**
 * Sidebar search, ported from `components/SessionSidebar.tsx`
 * (`visibleProjectEntries`).
 *
 * A session matches on its stored title (`name`) or the **full** first user
 * message. Sessions without a stored title are therefore still findable, no
 * matter where in the first message the term appears. The path, cwd and id are
 * not searchable — the web does not match them either.
 */
fun sessionMatchesSearch(session: SessionSummary, query: String): Boolean {
    val q = query.trim().lowercase(Locale.ROOT)
    if (q.isEmpty()) return true
    return (session.name ?: "").lowercase(Locale.ROOT).contains(q) ||
        session.firstMessage.lowercase(Locale.ROOT).contains(q)
}

/**
 * A workspace with no matching sessions stays visible while its folder label
 * or alias matches the query (the web's "custom workspace name is findable"
 * clause).
 */
fun projectMatchesSearch(project: ManagedProject, query: String): Boolean {
    val q = query.trim().lowercase(Locale.ROOT)
    if (q.isEmpty()) return false
    return projectPathLabel(project.path).lowercase(Locale.ROOT).contains(q) ||
        (project.alias ?: "").lowercase(Locale.ROOT).contains(q)
}

/**
 * The sidebar's filtered project/session entries in project order.
 *
 * Mirrors the web filter exactly: `runningOnly` first, then the search term;
 * a project is dropped when it has no sessions left and either `runningOnly`
 * is active or the term matches neither its label nor its alias. Without any
 * filter every project stays visible, even without sessions.
 */
fun visibleSessionEntries(
    projects: List<ManagedProject>,
    sessionsByProject: Map<String, List<SessionSummary>>,
    runningOnly: Boolean,
    runningIds: Set<String>,
    query: String,
): List<Pair<ManagedProject, List<SessionSummary>>> {
    val q = query.trim()
    val entries = ArrayList<Pair<ManagedProject, List<SessionSummary>>>(projects.size)
    for (project in projects) {
        var list = sessionsByProject[project.path].orEmpty()
        if (runningOnly) list = list.filter { it.id in runningIds }
        if (q.isNotEmpty()) list = list.filter { sessionMatchesSearch(it, q) }
        if (list.isEmpty()) {
            if (runningOnly) continue
            if (q.isNotEmpty() && !projectMatchesSearch(project, q)) continue
        }
        entries += project to list
    }
    return entries
}
