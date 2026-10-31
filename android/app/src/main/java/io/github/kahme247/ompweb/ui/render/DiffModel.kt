package io.github.kahme247.ompweb.ui.render

/** One side of a split diff row. */
enum class DiffCellType { Context, Removed, Added, Empty }

data class SplitDiffCell(
    val lineNo: Int?,
    val text: String,
    val type: DiffCellType,
)

sealed interface SplitDiffRow {
    data class Hunk(val text: String) : SplitDiffRow
    data class Line(val left: SplitDiffCell, val right: SplitDiffCell) : SplitDiffRow
}

data class SplitDiffFile(
    val oldPath: String?,
    val newPath: String?,
    val rows: List<SplitDiffRow>,
)

/**
 * Exact port of `parseUnifiedPatch` from `lib/patch.ts`: pairs removed/added
 * lines into split cells, keeps `\ No newline` notes and path headers, and
 * returns null when the text contains no hunk lines (caller shows plain text).
 */
object UnifiedPatchParser {

    fun parse(text: String): List<SplitDiffFile>? {
        val files = ArrayList<SplitDiffFile>()
        var current: MutableFile? = null
        var pendingOldPath: String? = null
        var oldLineNo = 0
        var newLineNo = 0
        var removed = ArrayList<PendingLine>()
        var added = ArrayList<PendingLine>()

        fun emptyCell(): SplitDiffCell = SplitDiffCell(null, "", DiffCellType.Empty)

        fun flushChanges() {
            val file = current ?: run {
                removed = ArrayList()
                added = ArrayList()
                return
            }
            val count = maxOf(removed.size, added.size)
            for (i in 0 until count) {
                val left = removed.getOrNull(i)?.let {
                    SplitDiffCell(it.lineNo, it.text, DiffCellType.Removed)
                } ?: emptyCell()
                val right = added.getOrNull(i)?.let {
                    SplitDiffCell(it.lineNo, it.text, DiffCellType.Added)
                } ?: emptyCell()
                file.rows.add(SplitDiffRow.Line(left, right))
            }
            removed = ArrayList()
            added = ArrayList()
        }

        for (line in text.split(Regex("\r?\n"))) {
            if (line.startsWith("--- ")) {
                flushChanges()
                pendingOldPath = cleanPatchPath(line.substring(4))
                continue
            }
            if (line.startsWith("+++ ")) {
                flushChanges()
                current = MutableFile(pendingOldPath, cleanPatchPath(line.substring(4)))
                files.add(current!!.toFile())
                continue
            }
            val hunk = HUNK.matchEntire(line)
            if (hunk != null) {
                if (current == null) {
                    current = MutableFile(null, null)
                    files.add(current!!.toFile())
                }
                flushChanges()
                oldLineNo = hunk.groups[1]!!.value.toInt()
                newLineNo = hunk.groups[2]!!.value.toInt()
                current!!.rows.add(SplitDiffRow.Hunk(line))
                continue
            }
            val file = current ?: continue
            if (line.startsWith("\\ ")) {
                flushChanges()
                file.rows.add(SplitDiffRow.Hunk(line))
                continue
            }
            val prefix = line.firstOrNull() ?: continue
            val content = line.substring(1)
            when (prefix) {
                ' ' -> {
                    flushChanges()
                    file.rows.add(
                        SplitDiffRow.Line(
                            SplitDiffCell(oldLineNo++, content, DiffCellType.Context),
                            SplitDiffCell(newLineNo++, content, DiffCellType.Context),
                        ),
                    )
                }
                '-' -> removed.add(PendingLine(oldLineNo++, content))
                '+' -> added.add(PendingLine(newLineNo++, content))
                else -> {
                    if (line.isNotEmpty()) {
                        flushChanges()
                        file.rows.add(SplitDiffRow.Hunk(line))
                    }
                }
            }
        }
        flushChanges()

        val result = files.filter { file -> file.rows.any { it is SplitDiffRow.Line } }
        return result.ifEmpty { null }
    }

    private data class PendingLine(val lineNo: Int, val text: String)

    private class MutableFile(val oldPath: String?, val newPath: String?) {
        val rows = ArrayList<SplitDiffRow>()

        fun toFile(): SplitDiffFile = SplitDiffFile(oldPath, newPath, rows)
    }

    private fun cleanPatchPath(path: String): String = path.substringBefore('\t').trim()

    private val HUNK = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@")
}

/**
 * Line diff for tool results that ship `oldText`/`newText` instead of a patch.
 * Uses an LCS table with a work cap; oversized edits degrade to a whole-block
 * replacement instead of allocating unbounded memory.
 */
object ComputedDiff {

    private const val CONTEXT = 3
    private const val MAX_LCS_CELLS = 2_000_000

    fun split(oldText: String, newText: String): List<SplitDiffFile>? {
        if (oldText == newText) return null
        val oldLines = splitLines(oldText)
        val newLines = splitLines(newText)
        val ops = diffOps(oldLines, newLines)
        if (ops.none { it is Op.Delete || it is Op.Insert }) return null

        val rows = ArrayList<SplitDiffRow>()
        val changedIndices = ops.indices.filter { ops[it] !is Op.Equal }
        if (changedIndices.isEmpty()) return null

        var groupStart = (changedIndices.first() - CONTEXT).coerceAtLeast(0)
        var groupEnd = (changedIndices.first() + CONTEXT).coerceAtMost(ops.lastIndex)
        var previousGroupEnd = -1

        fun appendGroup(start: Int, end: Int) {
            if (previousGroupEnd >= 0) {
                rows.add(SplitDiffRow.Hunk("\u22ef ${start - previousGroupEnd - 1} unchanged lines"))
            }
            var oldNo = 1
            var newNo = 1
            for (i in 0 until start) {
                when (ops[i]) {
                    is Op.Equal -> { oldNo++; newNo++ }
                    is Op.Delete -> oldNo++
                    is Op.Insert -> newNo++
                }
            }
            val oldCount = ops.subList(start, end + 1).count { it !is Op.Insert }
            val newCount = ops.subList(start, end + 1).count { it !is Op.Delete }
            rows.add(SplitDiffRow.Hunk("@@ -$oldNo,$oldCount +$newNo,$newCount @@"))

            var pendingRemoved = ArrayList<SplitDiffCell>()
            var pendingAdded = ArrayList<SplitDiffCell>()
            fun flush() {
                val count = maxOf(pendingRemoved.size, pendingAdded.size)
                for (i in 0 until count) {
                    rows.add(
                        SplitDiffRow.Line(
                            pendingRemoved.getOrNull(i) ?: SplitDiffCell(null, "", DiffCellType.Empty),
                            pendingAdded.getOrNull(i) ?: SplitDiffCell(null, "", DiffCellType.Empty),
                        ),
                    )
                }
                pendingRemoved = ArrayList()
                pendingAdded = ArrayList()
            }
            for (i in start..end) {
                when (val op = ops[i]) {
                    is Op.Equal -> {
                        flush()
                        rows.add(
                            SplitDiffRow.Line(
                                SplitDiffCell(oldNo, op.text, DiffCellType.Context),
                                SplitDiffCell(newNo, op.text, DiffCellType.Context),
                            ),
                        )
                        oldNo++
                        newNo++
                    }
                    is Op.Delete -> pendingRemoved.add(SplitDiffCell(oldNo++, op.text, DiffCellType.Removed))
                    is Op.Insert -> pendingAdded.add(SplitDiffCell(newNo++, op.text, DiffCellType.Added))
                }
            }
            flush()
            previousGroupEnd = end
        }

        for (index in changedIndices) {
            if (index <= groupEnd) {
                groupEnd = (index + CONTEXT).coerceAtMost(ops.lastIndex)
            } else {
                appendGroup(groupStart, groupEnd)
                groupStart = (index - CONTEXT).coerceAtLeast(0)
                groupEnd = (index + CONTEXT).coerceAtMost(ops.lastIndex)
            }
        }
        appendGroup(groupStart, groupEnd)

        return listOf(SplitDiffFile(oldPath = null, newPath = null, rows = rows))
    }

    private sealed interface Op {
        data class Equal(val text: String) : Op
        data class Delete(val text: String) : Op
        data class Insert(val text: String) : Op
    }

    private fun diffOps(oldLines: List<String>, newLines: List<String>): List<Op> {
        val prefix = oldLines.zip(newLines).takeWhile { (a, b) -> a == b }.size
        var suffix = 0
        while (
            suffix < oldLines.size - prefix && suffix < newLines.size - prefix &&
            oldLines[oldLines.size - 1 - suffix] == newLines[newLines.size - 1 - suffix]
        ) {
            suffix++
        }
        val oldMiddle = oldLines.subList(prefix, oldLines.size - suffix)
        val newMiddle = newLines.subList(prefix, newLines.size - suffix)

        val ops = ArrayList<Op>(oldLines.size + newLines.size)
        for (i in 0 until prefix) ops.add(Op.Equal(oldLines[i]))

        val cells = oldMiddle.size.toLong() * newMiddle.size.toLong()
        if (oldMiddle.isEmpty()) {
            for (line in newMiddle) ops.add(Op.Insert(line))
        } else if (newMiddle.isEmpty()) {
            for (line in oldMiddle) ops.add(Op.Delete(line))
        } else if (cells <= MAX_LCS_CELLS) {
            lcsOps(oldMiddle, newMiddle, ops)
        } else {
            for (line in oldMiddle) ops.add(Op.Delete(line))
            for (line in newMiddle) ops.add(Op.Insert(line))
        }

        for (i in oldLines.size - suffix until oldLines.size) ops.add(Op.Equal(oldLines[i]))
        return ops
    }

    private fun lcsOps(oldLines: List<String>, newLines: List<String>, ops: MutableList<Op>) {
        val n = oldLines.size
        val m = newLines.size
        val width = m + 1
        val table = IntArray((n + 1) * width)
        for (i in n - 1 downTo 0) {
            for (j in m - 1 downTo 0) {
                table[i * width + j] = if (oldLines[i] == newLines[j]) {
                    table[(i + 1) * width + j + 1] + 1
                } else {
                    maxOf(table[(i + 1) * width + j], table[i * width + j + 1])
                }
            }
        }
        var i = 0
        var j = 0
        while (i < n && j < m) {
            when {
                oldLines[i] == newLines[j] -> {
                    ops.add(Op.Equal(oldLines[i]))
                    i++
                    j++
                }
                table[(i + 1) * width + j] >= table[i * width + j + 1] -> {
                    ops.add(Op.Delete(oldLines[i]))
                    i++
                }
                else -> {
                    ops.add(Op.Insert(newLines[j]))
                    j++
                }
            }
        }
        while (i < n) {
            ops.add(Op.Delete(oldLines[i]))
            i++
        }
        while (j < m) {
            ops.add(Op.Insert(newLines[j]))
            j++
        }
    }

    private fun splitLines(text: String): List<String> {
        val lines = text.split('\n')
        return if (lines.isNotEmpty() && lines.last().isEmpty()) {
            lines.dropLast(1)
        } else {
            lines
        }
    }
}

/**
 * Picks the patch text for [DiffView] from a tool result's `details` fields.
 *
 * A `patch`/`diff` that is already a unified patch is shown verbatim. `omp`
 * tools instead report a compact numbered snapshot (`" 2|beta"` for an
 * unchanged line, `"+4|delta"` for an added one, `-` for a removed one); that
 * text is converted into a unified hunk so the row renders as a real split /
 * unified diff instead of a wall of raw lines. Anything else keeps the raw-text
 * fallback of `MessageView-diff-view.tsx`.
 */
object ToolDiff {

    private val COMPACT_LINE = Regex("^([ +-])(\\d+)\\|(.*)$")

    fun resolve(patch: String?, diff: String?): String? {
        val candidates = listOfNotNull(patch?.takeIf { it.isNotBlank() }, diff?.takeIf { it.isNotBlank() })
        if (candidates.isEmpty()) return null
        for (candidate in candidates) {
            if (UnifiedPatchParser.parse(candidate) != null) return candidate
            compactToUnified(candidate)?.let { return it }
        }
        return candidates.first()
    }

    /**
     * Converts `omp`'s numbered diff into a single-hunk unified patch. Returns
     * null unless every line carries the `marker<lineNo>|text` shape, so a
     * different format keeps its raw presentation. Gaps between hunks are not
     * part of that format (the tool only prints changed lines plus context).
     */
    fun compactToUnified(text: String): String? {
        val body = StringBuilder()
        var oldStart: Int? = null
        var newStart: Int? = null
        var oldCount = 0
        var newCount = 0
        var sawLine = false
        for (line in text.lines()) {
            if (line.isEmpty()) continue
            val match = COMPACT_LINE.matchEntire(line) ?: return null
            val lineNo = match.groupValues[2].toIntOrNull() ?: return null
            val content = match.groupValues[3]
            sawLine = true
            when (match.groupValues[1]) {
                " " -> {
                    if (oldStart == null) oldStart = lineNo
                    if (newStart == null) newStart = lineNo
                    oldCount++
                    newCount++
                    body.append(' ').append(content).append('\n')
                }
                "-" -> {
                    if (oldStart == null) oldStart = lineNo
                    oldCount++
                    body.append('-').append(content).append('\n')
                }
                else -> {
                    if (newStart == null) newStart = lineNo
                    newCount++
                    body.append('+').append(content).append('\n')
                }
            }
        }
        if (!sawLine) return null
        return "@@ -${oldStart ?: 0},$oldCount +${newStart ?: 0},$newCount @@\n$body"
    }
}
