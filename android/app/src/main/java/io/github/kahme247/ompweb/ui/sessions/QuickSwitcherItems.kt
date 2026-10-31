package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.domain.displayCwd
import io.github.kahme247.ompweb.net.SessionSummary

/** What a palette row does when it is chosen. */
enum class QuickSwitcherKind { Session, NewSession, Theme, Model }

/**
 * One palette row. [enabled] is false for the informational current-model
 * line (web `CommandPalette` renders it as a disabled item).
 */
data class QuickSwitcherItem(
    val kind: QuickSwitcherKind,
    val label: String,
    val detail: String? = null,
    val sessionId: String? = null,
    val running: Boolean = false,
    val enabled: Boolean = true,
)

/**
 * The palette's entries (`components/CommandPalette.tsx`): the matching
 * sessions first, then the actions, then the current model as a disabled
 * information line. [query] filters sessions by title, cwd and id and the
 * actions by their own label; the model line matches its label or the model
 * name so "model" finds it.
 */
fun quickSwitcherItems(
    query: String,
    sessions: List<SessionSummary>,
    runningIds: Set<String>,
    currentModel: String?,
    untitledLabel: String,
    newSessionLabel: String,
    themeLabel: String,
    modelLabel: String,
    home: String? = null,
    limit: Int = 30,
): List<QuickSwitcherItem> {
    val normalized = query.trim().lowercase()
    fun matches(vararg fields: String?): Boolean =
        normalized.isEmpty() || fields.any { it?.lowercase()?.contains(normalized) == true }

    val sessionItems = sessions
        .asSequence()
        .filter { session ->
            matches(session.title() ?: untitledLabel, session.cwd, session.id)
        }
        .take(limit)
        .map { session ->
            QuickSwitcherItem(
                kind = QuickSwitcherKind.Session,
                label = session.title() ?: untitledLabel,
                detail = displayCwd(session.cwd, home),
                sessionId = session.id,
                running = session.id in runningIds,
            )
        }
        .toList()

    val actions = buildList {
        if (matches(newSessionLabel)) {
            add(QuickSwitcherItem(QuickSwitcherKind.NewSession, newSessionLabel))
        }
        if (matches(themeLabel)) {
            add(QuickSwitcherItem(QuickSwitcherKind.Theme, themeLabel))
        }
    }

    // The model line is information, never an action; the web disables it.
    val modelLine = if (matches(modelLabel, currentModel)) {
        listOf(
            QuickSwitcherItem(
                kind = QuickSwitcherKind.Model,
                label = modelLabel,
                detail = currentModel ?: "—",
                enabled = false,
            ),
        )
    } else {
        emptyList()
    }

    return sessionItems + actions + modelLine
}

/**
 * Roving index for the palette: only enabled rows can be selected, and the
 * edges wrap like a list of `cmdk` items.
 */
fun quickSwitcherMove(items: List<QuickSwitcherItem>, from: Int, delta: Int): Int {
    val enabled = items.indices.filter { items[it].enabled }
    if (enabled.isEmpty()) return -1
    val position = enabled.indexOf(from)
    if (position < 0) return if (delta >= 0) enabled.first() else enabled.last()
    val next = (position + delta).mod(enabled.size)
    return enabled[next]
}

fun quickSwitcherFirst(items: List<QuickSwitcherItem>): Int = items.indexOfFirst { it.enabled }

fun quickSwitcherLast(items: List<QuickSwitcherItem>): Int = items.indexOfLast { it.enabled }
