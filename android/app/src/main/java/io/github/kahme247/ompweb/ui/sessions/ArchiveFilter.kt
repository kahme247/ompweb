package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.net.ArchiveEntry

/**
 * The archive browser's filter (`components/ArchiveBrowser.tsx`): a case
 * insensitive substring over the id, name, first message, cwd and status.
 * Pulled out of the dialog so B34 can test the rows the browser shows.
 */
fun visibleArchiveEntries(entries: List<ArchiveEntry>, query: String): List<ArchiveEntry> {
    val normalized = query.trim().lowercase()
    if (normalized.isEmpty()) return entries
    return entries.filter { entry ->
        entry.id.lowercase().contains(normalized) ||
            entry.name?.lowercase()?.contains(normalized) == true ||
            entry.firstMessage.lowercase().contains(normalized) ||
            entry.cwd.lowercase().contains(normalized) ||
            entry.status.lowercase().contains(normalized)
    }
}
