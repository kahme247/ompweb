package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.SessionSummary

/** One node of the fork tree the sidebar renders (`buildSessionTree`). */
data class SessionTreeNode(
    val session: SessionSummary,
    val children: List<SessionTreeNode> = emptyList(),
)

/**
 * Nest forked sessions under the session they forked from.
 *
 * Kotlin port of `buildSessionTree` in `components/SessionSidebar-helpers.ts`:
 * a parentSessionId that no longer resolves (archived/deleted) attaches the
 * child to the nearest existing ancestor instead of losing it, cycles are
 * guarded, and every level sorts by modified descending.
 */
fun buildSessionTree(sessions: List<SessionSummary>): List<SessionTreeNode> {
    val byId = LinkedHashMap<String, MutableSessionNode>()
    for (session in sessions) byId[session.id] = MutableSessionNode(session)

    val parentOf = HashMap<String, String>()
    for (session in sessions) {
        session.parentSessionId?.takeIf { it.isNotBlank() }?.let { parentOf[session.id] = it }
    }

    fun resolveAncestor(id: String): String? {
        var current = parentOf[id]
        val visited = HashSet<String>()
        while (current != null) {
            if (!visited.add(current)) return null
            if (byId.containsKey(current)) return current
            current = parentOf[current]
        }
        return null
    }

    val roots = mutableListOf<MutableSessionNode>()
    for (node in byId.values) {
        val ancestor = resolveAncestor(node.session.id)
        if (ancestor != null) byId.getValue(ancestor).children.add(node) else roots.add(node)
    }

    fun freeze(nodes: List<MutableSessionNode>): List<SessionTreeNode> {
        val sorted = nodes.sortedWith { a, b -> b.session.modified.compareTo(a.session.modified) }
        return sorted.map { SessionTreeNode(it.session, freeze(it.children)) }
    }
    return freeze(roots)
}

private class MutableSessionNode(val session: SessionSummary) {
    val children = mutableListOf<MutableSessionNode>()
}

/** The sidebar shows only this many top-level (non-fork) rows per project. */
const val MAX_PROJECT_SESSIONS = 5
