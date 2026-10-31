package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `lineStartOffset` maps the viewer's 1-based line onto the code string. */
class CodeBlockRevealTest {

    private val code = "one\ntwo\n\nfour"

    @Test
    fun `a line maps to its first character`() {
        assertEquals(0, lineStartOffset(code, 1))
        assertEquals("two", code.substring(lineStartOffset(code, 2)!!, lineStartOffset(code, 3)!! - 1))
        assertEquals(9, lineStartOffset(code, 4))
    }

    @Test
    fun `empty lines and the line after a trailing newline exist`() {
        assertEquals(8, lineStartOffset(code, 3))
        // `one\ntwo\n` has a real (empty) third line at the end of the string.
        assertEquals(8, lineStartOffset("one\ntwo\n", 3))
        assertEquals(2, lineStartOffset("a\n", 2))
    }

    @Test
    fun `out of range lines have no offset`() {
        assertNull(lineStartOffset(code, 0))
        assertNull(lineStartOffset(code, -3))
        assertNull(lineStartOffset(code, 5))
        assertNull(lineStartOffset("", 2))
        assertEquals(0, lineStartOffset("", 1))
    }
}
