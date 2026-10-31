package io.github.kahme247.ompweb.domain

/**
 * Unread badge bookkeeping for sidebar sessions.
 *
 * Semantics (web `components/SessionSidebar*.tsx` and `useSessions`): a
 * session that is running when the user is not reading it and then stops
 * becomes unread; starting to run again clears the badge. The set is pruned
 * to sessions that still exist so deleted files cannot leave permanent dots.
 */
fun applyRunningTransition(
    previousRunning: Set<String>,
    running: Set<String>,
    selectedSessionId: String?,
    unread: Set<String>,
): Set<String> {
    val completed = previousRunning.filterTo(mutableSetOf()) { it !in running && it != selectedSessionId }
    val newlyRunning = running.filter { it !in previousRunning }
    if (completed.isEmpty() && newlyRunning.isEmpty()) return unread
    val next = unread.toMutableSet()
    newlyRunning.forEach(next::remove)
    completed.forEach(next::add)
    return next
}

fun pruneUnread(unread: Set<String>, existingIds: Collection<String>): Set<String> {
    val existing = existingIds.toSet()
    return unread.filterTo(linkedSetOf()) { it in existing }
}
