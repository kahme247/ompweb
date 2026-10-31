package io.github.kahme247.ompweb.data

import io.github.kahme247.ompweb.domain.ToolPreset
import kotlinx.coroutines.flow.StateFlow

/**
 * The preferences the workspace screens need, separated from the Android
 * DataStore implementation so view models stay JVM-testable.
 */
interface WorkspacePreferences {
    val snapshot: StateFlow<SettingsSnapshot>

    suspend fun setExpandedProjects(projects: Set<String>)

    suspend fun setUnreadSessionIds(ids: Set<String>)

    /** Pins for one server origin; an empty set removes that origin's entry. */
    suspend fun setPinnedSessions(origin: String, ids: Set<String>)

    suspend fun setToolPreset(preset: ToolPreset)

    /**
     * The new-session pane is the last view: its workspace is stored and the
     * session marker is cleared in one atomic DataStore edit, so a process
     * death can never leave both markers behind.
     */
    suspend fun setLastNewSessionView(cwd: String)

    /**
     * A session is the last view: the session marker is stored and the
     * new-session marker is cleared in one atomic DataStore edit. The shell
     * writes this when it *selects* the session, before the detail request
     * runs, so a dead link can always clear its own marker afterwards.
     */
    suspend fun setLastSessionView(sessionId: String)

    /** Drops the new-session marker only; the session marker is untouched. */
    suspend fun clearLastNewSessionView()

    /**
     * Drops the session marker only. The caller checks that it still names the
     * dead session: a link for one session must never forget the view the user
     * actually left.
     */
    suspend fun clearLastSession()
}
