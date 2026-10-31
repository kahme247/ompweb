package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A13: the web's 100k-character guard. Only *above* the limit is a message
 * "large" (101k renders the reveal button, 100k still parses normally), and the
 * collapsed button names a human size.
 */
class MessageSizeTest {

    @Test
    fun theLimitMatchesTheWebConstant() {
        assertEquals(100_000, MAX_MARKDOWN_CHARS)
    }

    @Test
    fun exactlyTheLimitIsStillRendered() {
        assertFalse(isLargeMessage("x".repeat(MAX_MARKDOWN_CHARS)))
    }

    @Test
    fun oneCharacterPastTheLimitIsLarge() {
        assertTrue(isLargeMessage("x".repeat(MAX_MARKDOWN_CHARS + 1)))
    }

    @Test
    fun anEmptyMessageIsNeverLarge() {
        assertFalse(isLargeMessage(""))
    }

    @Test
    fun sizeLabelsStayBelowOneMegabyteInKilobytes() {
        assertEquals("100 KB", formatMessageSize(100_000))
        assertEquals("123 KB", formatMessageSize(123_456))
        assertEquals("1 KB", formatMessageSize(1_000))
    }

    @Test
    fun sizesFromAMegabyteUseOneDecimal() {
        assertEquals("1.0 MB", formatMessageSize(1_000_000))
        assertEquals("52.9 MB", formatMessageSize(52_900_000))
    }
}
