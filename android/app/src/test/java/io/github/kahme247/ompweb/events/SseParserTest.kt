package io.github.kahme247.ompweb.events

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseParserTest {

    private val parser = SseParser()

    private fun feed(vararg lines: String): SseFrame? {
        var frame: SseFrame? = null
        for (line in lines) {
            parser.consume(line)?.let { frame = it }
        }
        return frame
    }

    @Test
    fun `a blank line dispatches the frame`() {
        val frame = feed("event: s1", """data: {"type":"running"}""", "")

        assertEquals(SseFrame("s1", """{"type":"running"}"""), frame)
    }

    @Test
    fun `multi-line data is joined with a newline`() {
        val frame = feed("data: first", "data: second", "")

        assertEquals("first\nsecond", frame?.data)
    }

    @Test
    fun `a leading space after the colon is removed once`() {
        val frame = feed("data:  two spaces", "")

        assertEquals(" two spaces", frame?.data)
    }

    @Test
    fun `a field without a colon keeps an empty value`() {
        val frame = feed("data", "")

        assertEquals("", frame?.data)
    }

    @Test
    fun `comments and unknown fields are ignored`() {
        assertNull(feed(": heartbeat"))
        assertNull(feed("retry: 1000"))
        assertNull(feed("id: 7"))
        assertNull(feed(""))
    }

    @Test
    fun `the event name does not leak into the next frame`() {
        feed("event: s1", "data: one", "")

        val frame = feed("data: two", "")

        assertEquals(SseFrame(null, "two"), frame)
    }

    @Test
    fun `the mux control event parses as a mux frame`() {
        val frame = feed("event: mux", """data: {"type":"hello","connectionId":"c1"}""", "")

        assertEquals(EventMux.MUX_CONTROL_EVENT, frame?.event)
    }
}
