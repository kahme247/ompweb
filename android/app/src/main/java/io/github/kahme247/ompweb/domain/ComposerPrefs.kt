package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Composer behaviors ported from `lib/composer-prefs.ts` plus the small pure
 * helpers the composer needs (bash mode, caret insertion, prompt history and
 * the per-session goal record of `lib/web-mode-state.ts`).
 */

/** How a submit during a run is delivered (`omp-web:submit-during-run`). */
enum class SubmitDuringRunBehavior(val wireName: String) {
    STEER("steer"),
    QUEUE("queue");

    companion object {
        /** Queuing stays resilient while a `!!` shell command owns the session. */
        val DEFAULT = QUEUE

        fun fromWire(value: String?): SubmitDuringRunBehavior =
            entries.firstOrNull { it.wireName == value } ?: DEFAULT
    }
}

/** Completion sound (`omp-sound-enabled`), on unless the user turned it off. */
const val DEFAULT_SOUND_ENABLED: Boolean = true

/**
 * What the filled composer button does while a run is live.
 *
 * `null` means Stop (nothing is waiting), otherwise the draft is submitted
 * exactly like Enter, through `omp-web:submit-during-run`. The web can leave
 * Steer to Enter because a desktop keyboard submits with it; an Android phone's
 * return key only inserts a newline, so the button is the only submit a phone
 * user has and must honour the same choice — otherwise "Steer the current run"
 * would silently mean "always queue" on the device.
 */
fun streamingSubmitBehavior(
    hasContent: Boolean,
    behavior: SubmitDuringRunBehavior,
): SubmitDuringRunBehavior? = if (hasContent) behavior else null

/** One `!`/`!!` shell invocation typed into the composer. */
data class BashInvocation(val command: String, val excludeFromContext: Boolean)

/**
 * `!command` runs in omp with its output in the context; `!!command` runs it
 * excluded from the context (web `bashExcluded`). Attachments never ride
 * along, exactly like `ChatInput`.
 */
fun parseBashInvocation(text: String, hasAttachments: Boolean): BashInvocation? {
    if (hasAttachments) return null
    val trimmed = text.trim()
    if (!trimmed.startsWith("!")) return null
    val excludeFromContext = trimmed.startsWith("!!")
    val command = (if (excludeFromContext) trimmed.drop(2) else trimmed.drop(1)).trim()
    if (command.isEmpty()) return null
    return BashInvocation(command, excludeFromContext)
}

/** A text edit at a caret, with the caret position that follows it. */
data class TextInsertion(val text: String, val caret: Int)

fun insertAtCursor(text: String, caret: Int, insert: String): TextInsertion {
    val position = caret.coerceIn(0, text.length)
    val next = text.substring(0, position) + insert + text.substring(position)
    return TextInsertion(next, position + insert.length)
}

/**
 * Up-arrow prompt history: newest first, de-duplicated, at most [limit]
 * entries, returned oldest → newest (web `ChatWindow` `inputHistory`).
 */
fun inputHistory(userTexts: List<String>, limit: Int = 50): List<String> {
    if (userTexts.isEmpty()) return emptyList()
    val seen = HashSet<String>()
    val history = ArrayList<String>(minOf(userTexts.size, limit))
    for (index in userTexts.indices.reversed()) {
        val text = userTexts[index].trim()
        if (text.isEmpty() || !seen.add(text)) continue
        history += text
        if (history.size >= limit) break
    }
    return history.asReversed()
}

/** The active `/goal` of one session (`sessionStorage omp-web:goal:<sid>`). */
data class ActiveGoal(val objective: String, val startedAt: Long)

fun createActiveGoal(objective: String, startedAt: Long): ActiveGoal =
    ActiveGoal(objective.trim(), startedAt)

private val goalJson = Json { ignoreUnknownKeys = true }

/** Parse a stored goal safely: user data and old versions never break chat. */
fun parseActiveGoal(raw: String?): ActiveGoal? {
    if (raw.isNullOrBlank()) return null
    return try {
        val root = goalJson.parseToJsonElement(raw) as? JsonObject ?: return null
        val objective = (root["objective"] as? JsonPrimitive)?.contentOrNull ?: return null
        val startedAt = (root["startedAt"] as? JsonPrimitive)?.longOrNull ?: return null
        if (objective.isBlank() || startedAt < 0) return null
        ActiveGoal(objective, startedAt)
    } catch (_: Exception) {
        null
    }
}

fun encodeActiveGoal(goal: ActiveGoal): String = buildString {
    append('{')
    append("\"objective\":")
    append(JsonPrimitive(goal.objective))
    append(",\"startedAt\":")
    append(goal.startedAt)
    append('}')
}

fun formatGoalElapsed(elapsedMs: Long): String {
    val minutes = (elapsedMs.coerceAtLeast(0) / 60_000)
    val hours = minutes / 60
    val rest = minutes % 60
    return if (hours > 0) "${hours}h ${rest}m" else "${rest}m"
}
