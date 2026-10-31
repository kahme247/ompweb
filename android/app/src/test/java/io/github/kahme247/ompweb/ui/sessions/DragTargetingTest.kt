package io.github.kahme247.ompweb.ui.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DragTargetingTest {

    private val items = listOf(
        DragItemBounds("a", offset = 0, size = 120),
        DragItemBounds("b", offset = 120, size = 600),
        DragItemBounds("c", offset = 720, size = 80),
    )

    @Test
    fun `pointer inside a tall block targets that block`() {
        assertEquals("b", dropTargetKey(items, 121f))
        assertEquals("b", dropTargetKey(items, 400f))
        assertEquals("b", dropTargetKey(items, 719.9f))
    }

    @Test
    fun `pointer at a boundary belongs to the following row`() {
        assertEquals("a", dropTargetKey(items, 0f))
        assertEquals("a", dropTargetKey(items, 119.9f))
        assertEquals("b", dropTargetKey(items, 120f))
        assertEquals("c", dropTargetKey(items, 720f))
    }

    @Test
    fun `pointer outside every row targets nothing`() {
        assertNull(dropTargetKey(items, -1f))
        assertNull(dropTargetKey(items, 800f))
        assertNull(dropTargetKey(emptyList(), 10f))
    }

    private val projects = listOf("/w/a", "/w/b", "/w/c")

    @Test
    fun `a long press without dragging never moves the project`() {
        // dropIndex starts as the dragged row's own project index; the pinned
        // header above the list is a separate item and must not shift it.
        assertNull(dropTargetPath(projects, 0, "/w/a"))
        assertNull(dropTargetPath(projects, 1, "/w/b"))
        assertNull(dropTargetPath(projects, 2, "/w/c"))
    }

    @Test
    fun `a drop on another project resolves to that project`() {
        assertEquals("/w/a", dropTargetPath(projects, 0, "/w/c"))
        assertEquals("/w/c", dropTargetPath(projects, 2, "/w/a"))
        assertEquals("/w/b", dropTargetPath(projects, 1, "/w/a"))
    }

    @Test
    fun `an out of range drop index moves nothing`() {
        assertNull(dropTargetPath(projects, -1, "/w/a"))
        assertNull(dropTargetPath(projects, 3, "/w/a"))
        assertNull(dropTargetPath(emptyList(), 0, "/w/a"))
    }
}
