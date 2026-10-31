package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Test

/** Unread semantics used by the running-frame monitor. */
class UnreadSessionsTest {

    @Test
    fun `a session that starts running loses its unread badge`() {
        assertEquals(
            emptySet<String>(),
            applyRunningTransition(
                previousRunning = emptySet(),
                running = setOf("a"),
                selectedSessionId = null,
                unread = setOf("a"),
            ),
        )
    }

    @Test
    fun `a session that stops running while unselected becomes unread`() {
        assertEquals(
            setOf("a"),
            applyRunningTransition(
                previousRunning = setOf("a"),
                running = emptySet(),
                selectedSessionId = null,
                unread = emptySet(),
            ),
        )
    }

    @Test
    fun `a session that stops while selected stays read`() {
        assertEquals(
            emptySet<String>(),
            applyRunningTransition(
                previousRunning = setOf("a"),
                running = emptySet(),
                selectedSessionId = "a",
                unread = emptySet(),
            ),
        )
    }

    @Test
    fun `unrelated transitions keep the existing badges`() {
        val unread = setOf("old")
        assertEquals(
            setOf("old"),
            applyRunningTransition(
                previousRunning = setOf("a"),
                running = setOf("a"),
                selectedSessionId = null,
                unread = unread,
            ),
        )
    }

    @Test
    fun `pruning drops ids that no longer exist and keeps order`() {
        assertEquals(
            listOf("b", "c"),
            pruneUnread(setOf("zombie", "b", "c"), listOf("a", "b", "c")).toList(),
        )
    }
}
