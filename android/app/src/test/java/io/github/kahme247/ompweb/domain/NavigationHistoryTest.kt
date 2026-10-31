package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** Ports `lib/navigation-history.test.mjs` case by case. */
class NavigationHistoryTest {

    private fun session(id: String, cwd: String = "/repo") = NavigationEntry(sessionId = id, cwd = cwd)
    private fun newChat(cwd: String) = NavigationEntry(sessionId = null, cwd = cwd)

    @Test
    fun `pushing onto an empty history seeds the first entry`() {
        val seeded = NavigationHistory().push(session("a"))
        assertEquals("a", seeded.current?.sessionId)
        assertEquals(1, seeded.entries.size)
        assertEquals(0, seeded.index)
    }

    @Test
    fun `pushing the same session again is a no-op that keeps the identity`() {
        val seeded = NavigationHistory().push(session("a"))
        val same = seeded.push(session("a"))
        assertSame(seeded, same)
        assertEquals(1, same.entries.size)
    }

    @Test
    fun `session entries compare by id only, cwd changes do not fork history`() {
        val seeded = NavigationHistory().push(session("a", "/one"))
        assertSame(seeded, seeded.push(session("a", "/two")))
    }

    @Test
    fun `new-chat entries compare by cwd`() {
        val seeded = NavigationHistory().push(newChat("/one"))
        assertSame(seeded, seeded.push(newChat("/one")))
        val moved = seeded.push(newChat("/two"))
        assertEquals(2, moved.entries.size)
        assertEquals(1, moved.index)
    }

    @Test
    fun `pushing after stepping back truncates the forward branch`() {
        var h = NavigationHistory()
        h = h.push(session("a"))
        h = h.push(session("b"))
        h = h.push(session("c"))
        h = h.step(-1)
        h = h.push(session("d"))
        assertEquals(listOf("a", "b", "d"), h.entries.map { it.sessionId })
        assertEquals(2, h.index)
    }

    @Test
    fun `history is capped at the maximum entry count, dropping the oldest`() {
        var h = NavigationHistory()
        val total = NAVIGATION_HISTORY_MAX_ENTRIES + 10
        for (i in 0 until total) h = h.push(session("s$i"))
        assertEquals(NAVIGATION_HISTORY_MAX_ENTRIES, h.entries.size)
        assertEquals(h.entries.size - 1, h.index)
        assertEquals("s${total - NAVIGATION_HISTORY_MAX_ENTRIES}", h.entries.first().sessionId)
    }

    @Test
    fun `back and forward availability follows the index bounds`() {
        val empty = NavigationHistory()
        assertEquals(false, empty.canBack)
        assertEquals(false, empty.canForward)

        var h = empty.push(session("a"))
        assertEquals(false, h.canBack)
        assertEquals(false, h.canForward)

        h = h.push(session("b"))
        assertEquals(true, h.canBack)
        assertEquals(false, h.canForward)

        h = h.copy(index = 0)
        assertEquals("a", h.entries[0].sessionId)
        assertEquals(false, h.canBack)
        assertEquals(true, h.canForward)
    }

    @Test
    fun `stepping is clamped and never mutates the input history`() {
        var h = NavigationHistory()
        h = h.push(session("a"))
        h = h.push(session("b"))
        val frozen = h
        val before = h.current?.sessionId
        val clamped = h.step(1)
        assertSame(h, clamped)
        val stepped = h.step(-1)
        assertEquals("a", stepped.current?.sessionId)
        assertEquals(before, frozen.current?.sessionId)
        assertEquals(before, h.current?.sessionId)
    }

    @Test
    fun `removing an entry before the current one shifts the index onto the same entry`() {
        var h = NavigationHistory()
        h = h.push(session("a"))
        h = h.push(session("dead"))
        h = h.push(session("c"))
        h = h.removeAt(1)
        assertEquals(listOf("a", "c"), h.entries.map { it.sessionId })
        assertEquals(1, h.index)
    }

    @Test
    fun `removing an entry after the current one keeps the index`() {
        var h = NavigationHistory()
        h = h.push(session("a"))
        h = h.push(session("dead"))
        h = h.removeAt(1)
        assertEquals(listOf("a"), h.entries.map { it.sessionId })
        assertEquals(0, h.index)
    }

    @Test
    fun `removing out-of-range or from an empty history is a no-op`() {
        val empty = NavigationHistory()
        assertSame(empty, empty.removeAt(0))
        val h = empty.push(session("a"))
        assertSame(h, h.removeAt(5))
        assertSame(h, h.removeAt(-1))
    }

    @Test
    fun `shortcut matcher macOS uses Cmd bracket chords`() {
        fun ev(
            meta: Boolean = false,
            ctrl: Boolean = false,
            alt: Boolean = false,
            shift: Boolean = false,
            key: String = "",
            composing: Boolean = false,
        ) = NavigationShortcutEvent(meta, ctrl, alt, shift, key, composing)

        assertEquals(-1, navigateShortcutDirection(ev(meta = true, key = "["), true))
        assertEquals(1, navigateShortcutDirection(ev(meta = true, key = "]"), true))
        assertEquals(0, navigateShortcutDirection(ev(alt = true, key = "ArrowLeft"), true))
        assertEquals(0, navigateShortcutDirection(ev(alt = true, key = "ArrowRight"), true))
        assertEquals(0, navigateShortcutDirection(ev(ctrl = true, key = "["), true))
    }

    @Test
    fun `shortcut matcher Windows and Linux use Alt+Arrow and accept the Ctrl bracket alias`() {
        fun ev(
            meta: Boolean = false,
            ctrl: Boolean = false,
            alt: Boolean = false,
            shift: Boolean = false,
            key: String = "",
            composing: Boolean = false,
        ) = NavigationShortcutEvent(meta, ctrl, alt, shift, key, composing)

        assertEquals(-1, navigateShortcutDirection(ev(alt = true, key = "ArrowLeft"), false))
        assertEquals(1, navigateShortcutDirection(ev(alt = true, key = "ArrowRight"), false))
        assertEquals(-1, navigateShortcutDirection(ev(meta = true, key = "["), false))
        assertEquals(1, navigateShortcutDirection(ev(ctrl = true, key = "]"), false))
    }

    @Test
    fun `shortcut matcher rejects modified, plain, unrelated keys and composition`() {
        assertEquals(0, navigateShortcutDirection(NavigationShortcutEvent(key = "["), false))
        assertEquals(0, navigateShortcutDirection(NavigationShortcutEvent(key = "]"), true))
        assertEquals(0, navigateShortcutDirection(NavigationShortcutEvent(key = "ArrowLeft"), false))
        assertEquals(
            0,
            navigateShortcutDirection(NavigationShortcutEvent(metaKey = true, shiftKey = true, key = "["), true),
        )
        assertEquals(
            0,
            navigateShortcutDirection(NavigationShortcutEvent(altKey = true, shiftKey = true, key = "ArrowLeft"), false),
        )
        assertEquals(
            0,
            navigateShortcutDirection(NavigationShortcutEvent(metaKey = true, altKey = true, key = "["), true),
        )
        assertEquals(
            0,
            navigateShortcutDirection(NavigationShortcutEvent(altKey = true, ctrlKey = true, key = "ArrowLeft"), false),
        )
        assertEquals(
            0,
            navigateShortcutDirection(NavigationShortcutEvent(metaKey = true, key = "[", isComposing = true), true),
        )
    }
}
