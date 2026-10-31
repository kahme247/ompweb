package io.github.kahme247.ompweb.ui.files

import io.github.kahme247.ompweb.domain.FileTreeRow

/** The hardware keys the explorer tree and the files tab strip handle. */
enum class FileTreeKey { Up, Down, Home, End, Left, Right, Activate }

enum class FileTabKey { Left, Right, Home, End }

/** What one tree key press does; no state is touched here. */
sealed interface FileTreeAction {
    /** Move the keyboard cursor to this row index. */
    data class Focus(val index: Int) : FileTreeAction

    /** Open or close the focused directory (web `handleActivateRow`). */
    data object ToggleDirectory : FileTreeAction

    /** Open the focused file. */
    data object OpenFile : FileTreeAction
}

/**
 * Keyboard navigation of the files tree and the tab strip, ported from the
 * web (`components/FileExplorer.tsx` `handleRowKeyDown`,
 * `components/TabBar.tsx` `handleTabKeyDown`).
 *
 * The tree is the flattened row list the pane renders; `empty` placeholder
 * rows are not focusable, so Up/Down/Home/End skip them exactly like the web
 * skips non-node rows. Compose keeps the focus on one row and this object only
 * decides where the keyboard cursor goes, which makes every rule JVM-testable.
 */
object FileKeyNav {

    /** First focusable row (web `rows.findIndex(kind === "node")`). */
    fun firstNodeIndex(rows: List<FileTreeRow>): Int? =
        rows.indexOfFirst { !it.empty }.takeIf { it >= 0 }

    fun lastNodeIndex(rows: List<FileTreeRow>): Int? =
        rows.indexOfLast { !it.empty }.takeIf { it >= 0 }

    /** The previous focusable row before [from], or null at the top. */
    fun previousNodeIndex(rows: List<FileTreeRow>, from: Int): Int? {
        for (index in from - 1 downTo 0) {
            if (index in rows.indices && !rows[index].empty) return index
        }
        return null
    }

    /** The next focusable row after [from], or null at the bottom. */
    fun nextNodeIndex(rows: List<FileTreeRow>, from: Int): Int? {
        for (index in from + 1 until rows.size) {
            if (!rows[index].empty) return index
        }
        return null
    }

    /**
     * The parent directory of [from]: the closest preceding row one level up.
     * The flat order puts every parent before its children, so a collapsed
     * folder's own parent precedes it too (web `ArrowLeft` branch).
     */
    fun parentNodeIndex(rows: List<FileTreeRow>, from: Int): Int? {
        val depth = rows.getOrNull(from)?.depth ?: return null
        if (depth <= 0) return null
        for (index in from - 1 downTo 0) {
            val candidate = rows[index]
            if (!candidate.empty && candidate.depth == depth - 1) return index
        }
        return null
    }

    fun treeAction(rows: List<FileTreeRow>, focusedIndex: Int?, key: FileTreeKey): FileTreeAction? {
        val current = focusedIndex?.takeIf { index -> index in rows.indices && !rows[index].empty }
        return when (key) {
            FileTreeKey.Up -> (if (current == null) firstNodeIndex(rows) else previousNodeIndex(rows, current))
                ?.let(FileTreeAction::Focus)

            FileTreeKey.Down -> (if (current == null) firstNodeIndex(rows) else nextNodeIndex(rows, current))
                ?.let(FileTreeAction::Focus)

            FileTreeKey.Home -> firstNodeIndex(rows)?.let(FileTreeAction::Focus)
            FileTreeKey.End -> lastNodeIndex(rows)?.let(FileTreeAction::Focus)

            FileTreeKey.Right -> current?.let { index ->
                val row = rows[index]
                when {
                    !row.isDir -> null
                    // Expanded: the first child follows its parent in flat order.
                    // An empty folder renders a placeholder row instead, which a
                    // reader cannot put the cursor on.
                    row.expanded -> (index + 1)
                        .takeIf { it in rows.indices && !rows[it].empty }
                        ?.let(FileTreeAction::Focus)

                    else -> FileTreeAction.ToggleDirectory
                }
            }

            FileTreeKey.Left -> current?.let { index ->
                val row = rows[index]
                when {
                    row.isDir && row.expanded -> FileTreeAction.ToggleDirectory
                    else -> parentNodeIndex(rows, index)?.let(FileTreeAction::Focus)
                }
            }

            FileTreeKey.Activate -> current?.let { index ->
                if (rows[index].isDir) FileTreeAction.ToggleDirectory else FileTreeAction.OpenFile
            }
        }
    }

    /**
     * The tab strip's target index: Left/Right wrap like the web's tablist,
     * Home/End jump to the edges. Null when there is no tab to move to.
     */
    fun tabIndex(count: Int, current: Int, key: FileTabKey): Int? {
        if (count <= 0) return null
        if (current !in 0 until count) {
            // No active entry (e.g. a closed tab): any horizontal key starts at an edge.
            return when (key) {
                FileTabKey.Home, FileTabKey.Left -> 0
                FileTabKey.End, FileTabKey.Right -> count - 1
            }
        }
        return when (key) {
            FileTabKey.Left -> (current - 1 + count) % count
            FileTabKey.Right -> (current + 1) % count
            FileTabKey.Home -> 0
            FileTabKey.End -> count - 1
        }
    }
}
