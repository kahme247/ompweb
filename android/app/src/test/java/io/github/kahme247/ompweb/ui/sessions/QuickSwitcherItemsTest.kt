package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.net.ArchiveEntry
import io.github.kahme247.ompweb.net.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A7: the palette's row order, filter and disabled model line. */
class QuickSwitcherItemsTest {

    private val sessions = listOf(
        SessionSummary(id = "s1", cwd = "/work/ompweb", name = "Fix the drawer"),
        SessionSummary(id = "s2", cwd = "/work/other", name = null),
        SessionSummary(id = "s3", cwd = "/home/dev/notes", name = "Journal note"),
    )

    private fun items(query: String = "", running: Set<String> = emptySet(), model: String? = "claude-sonnet") =
        quickSwitcherItems(
            query = query,
            sessions = sessions,
            runningIds = running,
            currentModel = model,
            untitledLabel = "Untitled",
            newSessionLabel = "New session",
            themeLabel = "Theme",
            modelLabel = "Current model",
            home = "/home/dev",
        )

    @Test
    fun `sessions come first, then the actions, then the model line`() {
        val rows = items()

        assertEquals(
            listOf(
                QuickSwitcherKind.Session,
                QuickSwitcherKind.Session,
                QuickSwitcherKind.Session,
                QuickSwitcherKind.NewSession,
                QuickSwitcherKind.Theme,
                QuickSwitcherKind.Model,
            ),
            rows.map { it.kind },
        )
        assertEquals("Fix the drawer", rows[0].label)
        assertEquals("Untitled", rows[1].label)
        assertEquals("~/notes", rows[2].detail)
        assertFalse("the model line is information, not an action", rows.last().enabled)
        assertEquals("claude-sonnet", rows.last().detail)
    }

    @Test
    fun `a running session carries its running flag`() {
        assertTrue(items(running = setOf("s1"))[0].running)
        assertFalse(items(running = setOf("s2"))[0].running)
    }

    @Test
    fun `the query filters sessions by title, cwd and id`() {
        assertEquals(listOf("Fix the drawer"), items("drawer").map { it.label })
        assertEquals(listOf("Fix the drawer"), items("ompweb").map { it.label })
        assertEquals(listOf("Journal note"), items("s3").map { it.label })
        assertEquals("matching is case insensitive", listOf("Journal note"), items("JOURNAL").map { it.label })
    }

    @Test
    fun `the query filters the actions and the model line by their own labels`() {
        val theme = items("theme")
        assertEquals(listOf(QuickSwitcherKind.Theme), theme.map { it.kind })

        val model = items("model")
        assertEquals(listOf(QuickSwitcherKind.Model), model.map { it.kind })

        assertTrue("no row matches a nonsense query", items("zzz").isEmpty())
    }

    @Test
    fun `a missing model still names the row with a dash`() {
        val rows = items(query = "current model", model = null)
        assertEquals("—", rows.single().detail)
        assertFalse(rows.single().enabled)
    }

    @Test
    fun `arrows wrap and skip the disabled model line`() {
        val rows = items()
        assertEquals(1, quickSwitcherMove(rows, 0, 1))
        assertEquals(0, quickSwitcherMove(rows, 1, -1))
        // From the last enabled row, down wraps to the first.
        assertEquals(0, quickSwitcherMove(rows, 4, 1))
        assertEquals(4, quickSwitcherMove(rows, 0, -1))
        assertEquals("the first enabled row starts the selection", 0, quickSwitcherFirst(rows))
        assertEquals("the last enabled row ends it", 4, quickSwitcherLast(rows))
        assertEquals("nothing enabled means no selection", -1, quickSwitcherMove(rows.filter { !it.enabled }, 0, 1))
    }

    @Test
    fun `the archive filter matches every field and ignores case`() {
        val entries = listOf(
            ArchiveEntry(
                key = "k1",
                id = "s-1",
                cwd = "/work/ompweb",
                name = "Old drawer work",
                firstMessage = "Why is the bar hidden?",
                status = "archived",
            ),
            ArchiveEntry(
                key = "k2",
                id = "s-2",
                cwd = "/work/other",
                name = null,
                firstMessage = "Hello",
                status = "restored",
            ),
        )

        assertEquals(2, visibleArchiveEntries(entries, "").size)
        assertEquals("k1", visibleArchiveEntries(entries, "DRAWER").single().key)
        assertEquals("k1", visibleArchiveEntries(entries, "s-1").single().key)
        assertEquals("k1", visibleArchiveEntries(entries, "/work/omp").single().key)
        assertEquals("k1", visibleArchiveEntries(entries, "bar hidden").single().key)
        assertEquals("k2", visibleArchiveEntries(entries, "RESTORED").single().key)
        assertTrue(visibleArchiveEntries(entries, "  nope  ").isEmpty())
    }
}
