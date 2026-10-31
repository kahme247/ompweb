package io.github.kahme247.ompweb.domain

/**
 * Thinking-level resolution for the current composer model, ported from
 * `lib/thinking-levels.ts` and `hooks/useAgentSession-stream.ts`.
 *
 * `/api/models` carries each pickable model's baked effort ladder as
 * `["off", ...efforts]`. A running session's `get_state` resolves the model omp
 * is ACTUALLY using — which can differ from the session file's model entry (a
 * disabled/renamed provider falls back to the default model, and the catalog
 * only lists enabled providers). When the catalog misses the current model, the
 * live metadata is the authoritative fallback, so the dropdown never falls back
 * to the generic ladder and lists unsupported efforts.
 */

/** The composer's current model identity. */
data class ModelKey(val provider: String, val modelId: String)

/** Model-level thinking metadata read off the live session state (`get_state.model`). */
data class ThinkingModelMeta(
    val provider: String,
    val modelId: String,
    val name: String? = null,
    val reasoning: Boolean? = null,
    /** `model.thinking.efforts`; a missing object and an empty list both mean "no concrete efforts". */
    val efforts: List<String>? = null,
)

/** The familiar levels, in display order. */
val DEFAULT_THINKING_LEVELS: List<String> =
    listOf("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max")

/** Keep familiar levels ordered while preserving provider-defined additions. */
fun selectableThinkingLevels(available: List<String>?): List<String> {
    if (available == null) return DEFAULT_THINKING_LEVELS.toList()
    val remaining = LinkedHashSet(available.filter { it.isNotEmpty() && it != "auto" })
    val ordered = ArrayList<String>(DEFAULT_THINKING_LEVELS.size + remaining.size)
    for (level in DEFAULT_THINKING_LEVELS) {
        if (level == "auto" || remaining.remove(level)) ordered += level
    }
    ordered += remaining
    return ordered
}

/** "off" is always a valid selector; concrete efforts come from the model. */
fun thinkingLevelsForMeta(meta: ThinkingModelMeta): List<String> {
    if (meta.reasoning != true) return listOf("off")
    return listOf("off") + meta.efforts.orEmpty()
}

/**
 * Levels offered for the current model: the catalog's baked ladder wins; the
 * live session model backs non-catalog models. Returns null when neither source
 * knows the model — callers then fall back to the generic ladder.
 */
fun resolveAvailableThinkingLevels(
    catalogLevels: List<String>?,
    model: ModelKey?,
    liveModel: ThinkingModelMeta?,
): List<String>? {
    if (!catalogLevels.isNullOrEmpty()) return catalogLevels
    if (model != null && liveModel != null &&
        liveModel.provider == model.provider && liveModel.modelId == model.modelId
    ) {
        return thinkingLevelsForMeta(liveModel)
    }
    return null
}

/** omp's "inherit" sentinel means "no explicit selection" — show as auto. */
fun normalizeThinkingLevel(level: String?): String {
    if (level.isNullOrEmpty() || level == "inherit") return "auto"
    return level
}
