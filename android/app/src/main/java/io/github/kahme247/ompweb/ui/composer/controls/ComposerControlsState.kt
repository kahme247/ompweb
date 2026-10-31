package io.github.kahme247.ompweb.ui.composer.controls

import io.github.kahme247.ompweb.domain.CompactResult
import io.github.kahme247.ompweb.domain.ContextUsageInfo
import io.github.kahme247.ompweb.domain.ModelCapacity
import io.github.kahme247.ompweb.domain.ModelKey
import io.github.kahme247.ompweb.domain.ModelOption
import io.github.kahme247.ompweb.domain.SessionStats
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.domain.UsageLimit
import io.github.kahme247.ompweb.domain.selectableThinkingLevels
import io.github.kahme247.ompweb.net.ElsewhereSession

/** What a pending new chat hands to `POST /api/agent/new` (`ensure_session`). */
data class SpawnOptions(
    val provider: String?,
    val modelId: String?,
    /** null means "auto": leave omp's own setting untouched. */
    val thinkingLevel: String?,
    /** null omits the field (full toolset); an empty list is `none`. */
    val toolNames: List<String>?,
    val advisor: Boolean,
)

/**
 * A `409 session_running_elsewhere` refused a composer control command: another
 * omp process owns this chat. The chat turns this into its ownership banner and
 * a command-specific message (the send wording would be wrong here).
 */
data class ForeignCommandRefusal(val elsewhere: ElsewhereSession? = null)

/**
 * Everything the composer controls row and the context sheet render. The view
 * model owns it; the app's composer only reads it (plus [ComposerControlsRow]).
 */
data class ComposerControlsState(
    /** null while the chat is still an unsent new session. */
    val sessionId: String? = null,
    val cwd: String = "",
    /** The visible, name-sorted catalog rows (`omp-composer-models` applied). */
    val models: List<ModelOption> = emptyList(),
    val modelsLoading: Boolean = false,
    val modelsError: String? = null,
    /** The model the composer shows: user pick, live `get_state.model`, session file entry. */
    val model: ModelKey? = null,
    /** Display name of [model] (live name, catalog name, else the id). */
    val modelName: String? = null,
    val thinkingLevel: String = "auto",
    /** null = neither the catalog nor the live model knows the ladder (generic fallback). */
    val availableThinkingLevels: List<String>? = null,
    val fastModeSupported: Boolean = false,
    val fastModeEnabled: Boolean = false,
    /** omp's per-family tier: false means enabled but inert for this model. */
    val fastModeActive: Boolean? = null,
    val slowModeSupported: Boolean = false,
    val slowModeEnabled: Boolean = false,
    /** `global` = persisted omp setting shared by every session; `session` = this chat's flex tier. */
    val slowModeScope: String? = null,
    val advisorEnabled: Boolean = false,
    val toolPreset: ToolPreset = ToolPreset.FULL,
    val usageLimit: UsageLimit? = null,
    /** Live context totals; the sheet falls back to [sessionStats]' value. */
    val contextUsage: ContextUsageInfo? = null,
    val modelCapacity: ModelCapacity? = null,
    /** omp's reported output throughput; null while not generating. */
    val tokensPerSecond: Double? = null,
    /** Rolling average of the reported throughput (`ContextDetailPanel` speed line). */
    val speedAverage: Double? = null,
    val isCompacting: Boolean = false,
    val compactResult: CompactResult? = null,
    val compactError: String? = null,
    val sessionStats: SessionStats? = null,
    val statsLoading: Boolean = false,
    /** True while the context sheet is open; the chat renders it on this flag. */
    val contextSheetOpen: Boolean = false,
    /** Last command failure, for the chat's notice surface; [ComposerControlsViewModel.clearError]. */
    val error: String? = null,
    /**
     * A command was refused because another omp process owns the chat (409
     * `session_running_elsewhere`). The chat shows its ownership banner and a
     * command-specific message instead of the send wording; it clears the field
     * via [ComposerControlsViewModel.clearForeignRefusal].
     */
    val foreignRefusal: ForeignCommandRefusal? = null,
) {
    /** The picker trigger label (web `currentName` / "Select model"). */
    val modelLabel: String?
        get() = model?.let { key ->
            modelName?.takeIf { it.isNotBlank() }
                ?: models.firstOrNull { it.provider == key.provider && it.modelId == key.modelId }?.displayName
                ?: key.modelId
        }

    /** The reasoning dropdown's options (web `selectableThinkingLevels`). */
    val thinkingLevelOptions: List<String>
        get() = selectableThinkingLevels(availableThinkingLevels)

    /** A model that cannot think has nothing to choose — the row hides the control. */
    val thinkingSupported: Boolean
        get() = thinkingLevelOptions.any { it != "auto" && it != "off" }

    /** The context panel's totals: live `contextUsage`, else the on-disk snapshot. */
    val shownContextUsage: ContextUsageInfo?
        get() = contextUsage ?: sessionStats?.contextUsage
}
