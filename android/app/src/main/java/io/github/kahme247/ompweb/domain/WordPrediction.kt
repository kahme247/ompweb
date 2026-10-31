package io.github.kahme247.ompweb.domain

/**
 * Pure draft/ghost-text arithmetic for composer word prediction, ported from
 * `lib/word-prediction.ts` and `hooks/useWordPrediction.ts` (omp's
 * `predict_word` RPC). The engine answers with the suffix to paint after the
 * word at the cursor; everything here decides where that suffix still applies.
 */

/** Ghost-text word completion preference (`omp-web:word-completion`). */
enum class WordCompletionMode(val wireName: String) {
    /** Only with a hardware keyboard or a fine pointer — see [wordCompletionActive]. */
    AUTO("auto"),
    ON("on"),
    OFF("off");

    companion object {
        val DEFAULT = AUTO

        fun fromWire(value: String?): WordCompletionMode =
            entries.firstOrNull { it.wireName == value } ?: DEFAULT
    }
}

/** A ghost-text suffix and the draft state (text + caret) it was predicted for. */
data class WordGhost(val text: String, val caret: Int, val suffix: String)

/**
 * The result of carrying a ghost to a new draft state: the ghost that still
 * applies (if any) and whether the user typed past the suggestion.
 */
data class GhostAdvance(val ghost: WordGhost?, val typedPast: Boolean)

/** Where an accepted ghost lands when inserted into the draft. */
data class GhostInsertion(val text: String, val caret: Int, val insert: String)

/** Wait this long after the last keystroke before asking omp; a burst of typing sends one request. */
const val WORD_PREDICTION_DEBOUNCE_MS: Long = 60

/** omp's prose gate answers nothing past this draft length, so don't ship bigger drafts per keystroke. */
const val WORD_PREDICTION_MAX_DRAFT_LENGTH: Int = 20_000

/**
 * After an omp without a command (`predict_word`, `btw`), check again this
 * much later (it may have been updated and restarted).
 */
const val WORD_PREDICTION_UNSUPPORTED_RETRY_MS: Long = 60_000

/**
 * `auto` enables ghost text only with a hardware keyboard (`Configuration.keyboard
 * != KEYBOARD_NOKEYS`) or a connected mouse — the Android equivalent of the
 * web's `(pointer: fine)` check, which cannot detect an on-screen keyboard.
 */
fun wordCompletionActive(
    mode: WordCompletionMode,
    hasHardwareKeyboard: Boolean,
    hasFinePointer: Boolean,
): Boolean = when (mode) {
    WordCompletionMode.ON -> true
    WordCompletionMode.OFF -> false
    WordCompletionMode.AUTO -> hasHardwareKeyboard || hasFinePointer
}

/** Ghost text only paints where the rest of the line is empty, so it never overlaps typed text. */
fun atLineEnd(text: String, cursor: Int): Boolean {
    val next = text.getOrNull(cursor)?.toString() ?: ""
    return next.isEmpty() || next == "\n"
}

/** JS `String.prototype.slice` bounds (negative indexes and out-of-range ends clamp, end < start is empty). */
private fun slice(text: String, start: Int, end: Int): String {
    val from = start.coerceIn(0, text.length)
    val to = end.coerceIn(0, text.length)
    return if (to <= from) "" else text.substring(from, to)
}

/**
 * Carry [ghost] to a new draft state. Typing that matches the ghost keeps its
 * remainder (so it doesn't flicker while the engine re-answers); typing that
 * diverges reports `typedPast` so the engine can learn the rejection; any
 * other edit or caret move just drops it.
 */
fun advanceGhost(ghost: WordGhost, text: String, cursor: Int): GhostAdvance {
    if (text == ghost.text && cursor == ghost.caret) return GhostAdvance(ghost, typedPast = false)
    val head = slice(ghost.text, 0, ghost.caret)
    val tail = slice(ghost.text, ghost.caret, ghost.text.length)
    val typed = slice(text, ghost.caret, cursor)
    if (cursor <= ghost.caret || text != head + typed + tail) return GhostAdvance(null, typedPast = false)
    if (ghost.suffix.lowercase().startsWith(typed.lowercase())) {
        val suffix = ghost.suffix.drop(typed.length)
        return GhostAdvance(
            ghost = if (suffix.isNotEmpty()) WordGhost(text, cursor, suffix) else null,
            typedPast = false,
        )
    }
    return GhostAdvance(null, typedPast = true)
}

/** Whitespace or punctuation that already separates the word, so accepting adds no space. */
private val WORD_TERMINATED = Regex("^[\\s.,;:!?\"\\])}]")

/**
 * Insert the ghost at its caret, plus the trailing space omp's editor adds
 * unless whitespace/punctuation follows. [GhostInsertion.insert] is the exact
 * string a composer has to splice at the caret.
 */
fun acceptGhost(ghost: WordGhost): GhostInsertion {
    val after = slice(ghost.text, ghost.caret, ghost.text.length)
    val insert = ghost.suffix + if (WORD_TERMINATED.containsMatchIn(after)) "" else " "
    return GhostInsertion(
        text = slice(ghost.text, 0, ghost.caret) + insert + after,
        caret = ghost.caret + insert.length,
        insert = insert,
    )
}

/** An omp without `predict_word` answers "Unknown command"; the predictor pauses asking it. */
fun isUnsupportedPredictionError(message: String?): Boolean =
    message?.contains("Unknown command", ignoreCase = true) == true
