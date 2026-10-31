package io.github.kahme247.ompweb.data

import io.github.kahme247.ompweb.domain.ActiveGoal
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.ToolPreset
import kotlinx.coroutines.flow.StateFlow

/**
 * The settings the chat view model reads and writes, separated from the
 * Android DataStore implementation so the view model stays JVM-testable.
 */
interface ChatSettings {

    val snapshot: StateFlow<SettingsSnapshot>

    suspend fun setChatScrollPosition(sessionId: String, rowIndex: Int)

    /**
     * Persists a scroll position from a non-coroutine context (`onCleared`).
     * The implementation updates its snapshot synchronously and dispatches
     * the DataStore write itself.
     */
    fun persistChatScrollPosition(sessionId: String, rowIndex: Int)

    /** `omp-web:submit-during-run`: what Enter does while the agent runs. */
    suspend fun setSubmitDuringRun(behavior: SubmitDuringRunBehavior)

    /** `omp-web:word-completion` wire value: `auto`, `on` or `off`. */
    suspend fun setWordCompletion(mode: String)

    /** `omp-sound-enabled`: the completion tone. */
    suspend fun setSoundEnabled(enabled: Boolean)

    /** The session's active `/goal`, or null to clear it. */
    suspend fun setActiveGoal(sessionId: String, goal: ActiveGoal?)

    /** `omp-web:composer-todo-collapsed`: the attached todo panel's body. */
    suspend fun setComposerTodoCollapsed(collapsed: Boolean)

    /** `omp-web:composer-subagents-collapsed`: the attached roster's body. */
    suspend fun setComposerSubagentsCollapsed(collapsed: Boolean)

    /** `omp-web:open-url-automatically`: open the viewed session's links directly. */
    suspend fun setOpenUrlAutomatically(enabled: Boolean)

    /** Spawn-time tool preset (shared with the new-session pane). */
    suspend fun setToolPreset(preset: ToolPreset)

    /** `omp-advisor-enabled:<sid>` for an existing session. */
    suspend fun setAdvisorEnabled(sessionId: String, enabled: Boolean)

    /**
     * A session this process just created, with the advisor choice it was
     * spawned with. The snapshot must carry the choice *synchronously*: the
     * chat composer binds the new id right after creation, and the prefilled
     * store (cold start) is the only source that can tell it the truth then.
     */
    fun markSessionCreated(sessionId: String, advisor: Boolean)

    /**
     * `omp-composer-models`: the models the composer offers. `null` clears the
     * stored selection, which means every model is offered.
     */
    suspend fun setComposerModels(models: Set<String>?)
}
