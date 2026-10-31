package io.github.kahme247.ompweb.domain

/**
 * What the shell does once on a fresh process: reopen the last session (or the
 * new-session pane) from the persisted marker.
 *
 * The restore runs from a Compose effect whose keys change while the session
 * list loads. Deciding the step from a plain snapshot keeps the two rules that
 * the live run broke in one testable place:
 *
 * - `pending` is only settled by a step that actually resolved the marker; an
 *   empty list is not proof that the saved session is gone, so the effect waits
 *   instead of burning its one attempt, and
 * - a re-run (rotation, a key change) never opens a second pane: as soon as
 *   something is on screen the step is [Done].
 */
sealed interface ColdStartRestoreStep {
    /**
     * The process-level cold-start marker is settled after this step: the
     * restore either ran or found nothing left to restore.
     */
    val consumes: Boolean

    /** The list is not loaded yet (or is empty): keep the marker and wait. */
    data object Wait : ColdStartRestoreStep {
        override val consumes: Boolean = false
    }

    /** Nothing to restore (already on screen, or no marker stored). */
    data object Done : ColdStartRestoreStep {
        override val consumes: Boolean = true
    }

    /** Open the saved session; the list contains it. */
    data class OpenSession(val id: String) : ColdStartRestoreStep {
        override val consumes: Boolean = true
    }

    /** Reopen the new-session pane in its saved workspace. */
    data class OpenNewSession(val cwd: String) : ColdStartRestoreStep {
        override val consumes: Boolean = true
    }

    /**
     * The saved session is gone from a list that *is* loaded and non-empty:
     * consume the marker so the next start opens the list, and forget it.
     */
    data class ForgetSession(val id: String) : ColdStartRestoreStep {
        override val consumes: Boolean = true
    }
}

/**
 * The one cold-start decision (see [ColdStartRestoreStep]).
 *
 * @param pending the process-level "restore not decided yet" flag.
 * @param listLoaded `GET /api/sessions` answered successfully (not merely
 *   "no request in flight"): only such a list can resolve the target.
 * @param sessionIds the loaded session ids.
 * @param selectedSessionId the session the shell already shows.
 * @param newSessionCwd the new-session pane the shell already shows.
 * @param lastSessionId the persisted session marker (`last_session_id`).
 * @param lastNewSessionCwd the persisted new-session marker.
 */
fun coldStartRestoreStep(
    pending: Boolean,
    listLoaded: Boolean,
    sessionIds: List<String>,
    selectedSessionId: String?,
    newSessionCwd: String?,
    lastSessionId: String?,
    lastNewSessionCwd: String?,
): ColdStartRestoreStep {
    if (!pending) return ColdStartRestoreStep.Done
    // A re-run after the restore already navigated (rotation, recomposition):
    // the marker is settled, but never open a second pane.
    if (selectedSessionId != null || newSessionCwd != null) return ColdStartRestoreStep.Done
    if (lastSessionId != null) {
        if (sessionIds.contains(lastSessionId)) return ColdStartRestoreStep.OpenSession(lastSessionId)
        // An empty list is what a cold start shows before (and without) its
        // first answer — it must not decide that the saved session is gone.
        return if (listLoaded && sessionIds.isNotEmpty()) {
            ColdStartRestoreStep.ForgetSession(lastSessionId)
        } else {
            ColdStartRestoreStep.Wait
        }
    }
    if (lastNewSessionCwd != null) return ColdStartRestoreStep.OpenNewSession(lastNewSessionCwd)
    return ColdStartRestoreStep.Done
}
