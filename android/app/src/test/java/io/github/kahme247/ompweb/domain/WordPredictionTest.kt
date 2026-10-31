package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors `lib/word-prediction.test.mjs`, plus the Android preference gates. */
class WordPredictionTest {

    private val ghost = WordGhost(text = "Check the weath\nnext", caret = 15, suffix = "er")

    @Test
    fun `typing that matches the ghost keeps its remainder`() {
        assertEquals(
            GhostAdvance(
                ghost = WordGhost("Check the weathe\nnext", 16, "r"),
                typedPast = false,
            ),
            advanceGhost(ghost, "Check the weathe\nnext", 16),
        )
        // Case-insensitive, like omp's projection.
        assertEquals("r", advanceGhost(ghost, "Check the weathE\nnext", 16).ghost?.suffix)
    }

    @Test
    fun `typing the whole suggestion retires the ghost without a rejection`() {
        assertEquals(
            GhostAdvance(ghost = null, typedPast = false),
            advanceGhost(ghost, "Check the weather\nnext", 17),
        )
    }

    @Test
    fun `typing past the ghost reports a rejection while other edits just drop it`() {
        assertEquals(GhostAdvance(null, true), advanceGhost(ghost, "Check the weathx\nnext", 16))
        assertEquals(GhostAdvance(null, false), advanceGhost(ghost, "Check the weat\nnext", 14))
        assertEquals(GhostAdvance(null, false), advanceGhost(ghost, ghost.text, 3))
        assertEquals(GhostAdvance(null, false), advanceGhost(ghost, "Check the weathe\nnexts", 16))
    }

    @Test
    fun `an unchanged draft keeps the same ghost`() {
        assertEquals(GhostAdvance(ghost, false), advanceGhost(ghost, ghost.text, ghost.caret))
    }

    @Test
    fun `accepting adds omp's trailing space unless whitespace or punctuation follows`() {
        assertEquals(
            GhostInsertion(text = "the weather ", caret = 12, insert = "er "),
            acceptGhost(WordGhost("the weath", 9, "er")),
        )
        assertEquals(
            GhostInsertion(text = "Check the weather\nnext", caret = 17, insert = "er"),
            acceptGhost(ghost),
        )
        assertEquals(
            GhostInsertion(text = "the weather.", caret = 11, insert = "er"),
            acceptGhost(WordGhost("the weath.", 9, "er")),
        )
    }

    @Test
    fun `ghost text only paints at the end of a line`() {
        assertTrue(atLineEnd("abc", 3))
        assertTrue(atLineEnd("abc\ndef", 3))
        assertFalse(atLineEnd("abc def", 3))
        // Beyond the end is the same as the end of the line.
        assertTrue(atLineEnd("", 5))
    }

    @Test
    fun `auto mode needs a hardware keyboard or a fine pointer`() {
        assertTrue(wordCompletionActive(WordCompletionMode.AUTO, hasHardwareKeyboard = true, hasFinePointer = false))
        assertTrue(wordCompletionActive(WordCompletionMode.AUTO, hasHardwareKeyboard = false, hasFinePointer = true))
        assertFalse(wordCompletionActive(WordCompletionMode.AUTO, hasHardwareKeyboard = false, hasFinePointer = false))
        assertTrue(wordCompletionActive(WordCompletionMode.ON, hasHardwareKeyboard = false, hasFinePointer = false))
        assertFalse(wordCompletionActive(WordCompletionMode.OFF, hasHardwareKeyboard = true, hasFinePointer = true))
    }

    @Test
    fun `the stored preference falls back to auto`() {
        assertEquals(WordCompletionMode.AUTO, WordCompletionMode.fromWire(null))
        assertEquals(WordCompletionMode.AUTO, WordCompletionMode.fromWire(""))
        assertEquals(WordCompletionMode.AUTO, WordCompletionMode.fromWire("sometimes"))
        assertEquals(WordCompletionMode.ON, WordCompletionMode.fromWire("on"))
        assertEquals(WordCompletionMode.OFF, WordCompletionMode.fromWire("off"))
    }

    @Test
    fun `an omp without predict_word answers Unknown command`() {
        assertTrue(isUnsupportedPredictionError("Unknown command: predict_word"))
        assertTrue(isUnsupportedPredictionError("unknown command"))
        assertFalse(isUnsupportedPredictionError(null))
        assertFalse(isUnsupportedPredictionError("The command failed"))
    }

    @Test
    fun `the debounce, cap and retry constants match the web hook`() {
        assertEquals(60L, WORD_PREDICTION_DEBOUNCE_MS)
        assertEquals(20_000, WORD_PREDICTION_MAX_DRAFT_LENGTH)
        assertEquals(60_000L, WORD_PREDICTION_UNSUPPORTED_RETRY_MS)
    }

    @Test
    fun `accepting at the end of a multi-line draft keeps the caret on the line`() {
        val insertion = acceptGhost(WordGhost("line one\nline tw", 16, "o"))
        // Nothing follows the caret, so omp's trailing space is part of the insert.
        assertEquals("line one\nline two ", insertion.text)
        assertEquals(18, insertion.caret)
        assertEquals("o ", insertion.insert)
        assertEquals(ghost, advanceGhost(ghost, "Check the weath\nnext", 15).ghost)
    }
}
