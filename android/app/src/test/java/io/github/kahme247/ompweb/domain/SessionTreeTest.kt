package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTreeTest {

    private fun session(id: String, modified: String = "2026-01-01T00:00:00.000Z", parent: String? = null) =
        SessionSummary(id = id, modified = modified, parentSessionId = parent)

    @Test
    fun `forks nest under their parent and levels sort by modified descending`() {
        val tree = buildSessionTree(
            listOf(
                session("root", "2026-01-01T00:00:00.000Z"),
                session("older-child", "2026-02-01T00:00:00.000Z", parent = "root"),
                session("newer-child", "2026-03-01T00:00:00.000Z", parent = "root"),
                session("grandchild", "2026-04-01T00:00:00.000Z", parent = "newer-child"),
            ),
        )
        assertEquals(listOf("root"), tree.map { it.session.id })
        assertEquals(listOf("newer-child", "older-child"), tree.single().children.map { it.session.id })
        assertEquals(listOf("grandchild"), tree.single().children.first().children.map { it.session.id })
    }

    @Test
    fun `an orphaned fork whose parent is not in the list becomes a root`() {
        // Same as the web helper: the ancestor chain is only walkable through
        // sessions present in the list, so a missing parent leaves a root.
        val tree = buildSessionTree(
            listOf(
                session("grandparent"),
                session("child", parent = "missing-parent"),
            ),
        )
        assertEquals(setOf("grandparent", "child"), tree.map { it.session.id }.toSet())
    }

    @Test
    fun `a parentSessionId cycle terminates without crashing`() {
        val tree = buildSessionTree(
            listOf(
                session("a", parent = "b"),
                session("b", parent = "a"),
            ),
        )
        // Guarded like the web: every node finds an ancestor, so no roots.
        assertTrue(tree.isEmpty())
    }

    @Test
    fun `the project cap is five top-level rows`() {
        assertEquals(5, MAX_PROJECT_SESSIONS)
    }
}
