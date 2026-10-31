package io.github.kahme247.ompweb.ui.files

import io.github.kahme247.ompweb.domain.FileTreeRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A19: the tree/tab-strip keyboard rules of the web (`FileExplorer.tsx`
 * `handleRowKeyDown`, `TabBar.tsx` `handleTabKeyDown`). Rows are the same
 * flattened list the pane renders, including the placeholder row of an empty
 * folder.
 */
class FileKeyNavTest {

    private fun dir(
        name: String,
        depth: Int,
        expanded: Boolean = false,
        empty: Boolean = false,
    ) = FileTreeRow(
        name = name,
        path = "/root/$name",
        isDir = !empty,
        size = 0,
        depth = depth,
        expanded = expanded,
        loading = false,
        empty = empty,
    )

    private fun file(name: String, depth: Int) = FileTreeRow(
        name = name,
        path = "/root/$name",
        isDir = false,
        size = 10,
        depth = depth,
        expanded = false,
        loading = false,
    )

    // 0 src/ (expanded), 1 a.kt, 2 empty/ (expanded), 3 placeholder, 4 b.kt,
    // 5 nested/ (collapsed)
    private val rows = listOf(
        dir("src", depth = 0, expanded = true),
        file("a.kt", depth = 1),
        dir("empty", depth = 1, expanded = true),
        dir("empty", depth = 2, expanded = false, empty = true),
        file("b.kt", depth = 1),
        dir("nested", depth = 1, expanded = false),
    )

    private fun focus(key: FileTreeKey, from: Int?): Int? =
        (FileKeyNav.treeAction(rows, from, key) as? FileTreeAction.Focus)?.index

    @Test
    fun `down and up move between rows and skip the empty-folder placeholder`() {
        assertEquals(1, focus(FileTreeKey.Down, 0))
        assertEquals(0, focus(FileTreeKey.Up, 1))
        // 2 is the empty folder, 3 its placeholder, 4 the next real row.
        assertEquals(4, focus(FileTreeKey.Down, 2))
        assertEquals(2, focus(FileTreeKey.Up, 4))
        assertNull(focus(FileTreeKey.Up, 0))
        assertNull(focus(FileTreeKey.Down, 5))
    }

    @Test
    fun `home and end jump to the first and last row`() {
        assertEquals(0, focus(FileTreeKey.Home, 4))
        assertEquals(5, focus(FileTreeKey.End, 0))
        // Without a cursor the first arrow starts at the top.
        assertEquals(0, focus(FileTreeKey.Down, null))
        assertEquals(5, focus(FileTreeKey.End, null))
    }

    @Test
    fun `right expands a collapsed folder and enters an expanded one`() {
        assertEquals(FileTreeAction.ToggleDirectory, FileKeyNav.treeAction(rows, 5, FileTreeKey.Right))
        assertEquals(1, focus(FileTreeKey.Right, 0))
        // A file cannot be entered; an expanded empty folder has no child row.
        assertNull(FileKeyNav.treeAction(rows, 1, FileTreeKey.Right))
        assertNull(FileKeyNav.treeAction(rows, 2, FileTreeKey.Right))
    }

    @Test
    fun `left collapses an expanded folder and otherwise jumps to the parent`() {
        assertEquals(FileTreeAction.ToggleDirectory, FileKeyNav.treeAction(rows, 0, FileTreeKey.Left))
        assertEquals(FileTreeAction.ToggleDirectory, FileKeyNav.treeAction(rows, 2, FileTreeKey.Left))
        assertEquals(0, focus(FileTreeKey.Left, 1))
        assertEquals(0, focus(FileTreeKey.Left, 4))
        // A collapsed folder has no child to leave, so the cursor goes up too.
        assertEquals(0, focus(FileTreeKey.Left, 5))
        // A top-level row has no parent.
        assertNull(FileKeyNav.parentNodeIndex(rows, 0))
    }

    @Test
    fun `enter opens a file and toggles a folder`() {
        assertEquals(FileTreeAction.ToggleDirectory, FileKeyNav.treeAction(rows, 0, FileTreeKey.Activate))
        assertEquals(FileTreeAction.OpenFile, FileKeyNav.treeAction(rows, 1, FileTreeKey.Activate))
        assertNull(FileKeyNav.treeAction(rows, null, FileTreeKey.Activate))
    }

    @Test
    fun `tab strip cycles with wrap-around and honours home and end`() {
        assertEquals(1, FileKeyNav.tabIndex(4, 0, FileTabKey.Right))
        assertEquals(3, FileKeyNav.tabIndex(4, 0, FileTabKey.Left))
        assertEquals(3, FileKeyNav.tabIndex(4, 2, FileTabKey.End))
        assertEquals(0, FileKeyNav.tabIndex(4, 2, FileTabKey.Home))
        // No active entry: a horizontal key starts at one edge.
        assertEquals(2, FileKeyNav.tabIndex(3, -1, FileTabKey.Right))
        assertEquals(2, FileKeyNav.tabIndex(3, 7, FileTabKey.Right))
        assertNull(FileKeyNav.tabIndex(0, 0, FileTabKey.Right))
    }
}
