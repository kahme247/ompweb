package io.github.kahme247.ompweb.domain

/**
 * In-app view history for navigate back/forward.
 *
 * Kotlin port of `lib/navigation-history.ts`. omp-web keeps its own stack
 * instead of the browser History API (it replaces, never pushes, `?session=`
 * URLs); on Android the system back stack already owns screen navigation, so
 * the session view history is kept here in memory. Entries are main views
 * only — a session, or the new-chat composer for a cwd.
 */
data class NavigationEntry(
    /** Session id, or null for the new-chat (composer) view. */
    val sessionId: String?,
    /** The view's cwd — the session's cwd, or the new-chat cwd. */
    val cwd: String?,
)

data class NavigationHistory(
    val entries: List<NavigationEntry> = emptyList(),
    /** Index of the currently displayed entry inside [entries]. */
    val index: Int = -1,
) {
    val current: NavigationEntry?
        get() = entries.getOrNull(index)

    val canBack: Boolean
        get() = index > 0

    val canForward: Boolean
        get() = index >= 0 && index < entries.size - 1

    /** Record a visited view; re-recording the current entry is a no-op. */
    fun push(entry: NavigationEntry): NavigationHistory {
        if (entries.isEmpty()) return NavigationHistory(listOf(entry), 0)
        val current = entries.getOrNull(index)
        if (current != null && navigationEntriesEqual(current, entry)) return this
        val kept = entries.take(index + 1).toMutableList()
        kept.add(entry)
        if (kept.size > NAVIGATION_HISTORY_MAX_ENTRIES) {
            kept.subList(0, kept.size - NAVIGATION_HISTORY_MAX_ENTRIES).clear()
        }
        return NavigationHistory(kept, kept.size - 1)
    }

    /** Move one entry; out-of-bounds steps return this same instance. */
    fun step(direction: Int): NavigationHistory {
        val next = index + direction
        if (next < 0 || next >= entries.size) return this
        return copy(index = next)
    }

    /**
     * Drop one entry (e.g. its session no longer exists). Used against the
     * neighbor about to be visited, never the current entry: removing an
     * entry before the cursor shifts the cursor down so it keeps pointing at
     * the same entry.
     */
    fun removeAt(target: Int): NavigationHistory {
        if (target < 0 || target >= entries.size) return this
        val remaining = entries.filterIndexed { i, _ -> i != target }
        var nextIndex = index
        if (target < index) nextIndex -= 1
        return NavigationHistory(remaining, nextIndex.coerceAtMost(remaining.size - 1))
    }
}

/** Match the browser's about:config history cap. Oldest entries drop first. */
const val NAVIGATION_HISTORY_MAX_ENTRIES = 50

/**
 * Session views compare by id (a session keeps its identity while its cwd
 * metadata refreshes); new-chat views compare by cwd.
 */
fun navigationEntriesEqual(a: NavigationEntry, b: NavigationEntry): Boolean {
    if (a.sessionId != b.sessionId) return false
    if (a.sessionId != null) return true
    return a.cwd == b.cwd
}

/** Minimal structural keyboard event, testable without a DOM. */
data class NavigationShortcutEvent(
    val metaKey: Boolean = false,
    val ctrlKey: Boolean = false,
    val altKey: Boolean = false,
    val shiftKey: Boolean = false,
    val key: String = "",
    val isComposing: Boolean = false,
)

/**
 * -1 = back, 1 = forward, 0 = no match. Mirrors
 * `navigateShortcutDirection` (`lib/navigation-history.ts`) for the keys an
 * Android hardware keyboard can produce: Alt+←/→ on Windows/Linux, Cmd+[/]
 * on macOS, Ctrl+[/] accepted as a non-macOS alias, shift chords excluded.
 * The web's BrowserBack/BrowserForward are browser mouse buttons; Compose
 * key events never carry them.
 */
fun navigateShortcutDirection(event: NavigationShortcutEvent, isMac: Boolean): Int {
    if (event.isComposing) return 0
    if ((event.metaKey || (!isMac && event.ctrlKey)) && !event.altKey && !event.shiftKey) {
        if (event.key == "[") return -1
        if (event.key == "]") return 1
    }
    if (!isMac && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        if (event.key == "ArrowLeft") return -1
        if (event.key == "ArrowRight") return 1
    }
    return 0
}
