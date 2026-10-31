package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiffModelTest {

    @Test
    fun `parses paired changes into split rows`() {
        val patch = """
            --- a/demo.ts
            +++ b/demo.ts
            @@ -10,3 +10,3 @@
             const keep = true;
            -const value = "old";
            +const value = "new";
             done();
        """.trimIndent()
        val files = UnifiedPatchParser.parse(patch)
        assertNotNull(files)
        assertEquals(1, files!!.size)
        assertEquals("a/demo.ts", files[0].oldPath)
        assertEquals("b/demo.ts", files[0].newPath)
        val lines = files[0].rows.filterIsInstance<SplitDiffRow.Line>()
        assertEquals(3, lines.size)
        assertEquals(
            SplitDiffCell(10, "const keep = true;", DiffCellType.Context),
            lines[0].left,
        )
        assertEquals(
            SplitDiffCell(11, "const value = \"old\";", DiffCellType.Removed),
            lines[1].left,
        )
        assertEquals(
            SplitDiffCell(11, "const value = \"new\";", DiffCellType.Added),
            lines[1].right,
        )
        assertEquals(SplitDiffCell(12, "done();", DiffCellType.Context), lines[2].right)
    }

    @Test
    fun `pads one-sided additions and cleans timestamp suffixes`() {
        val patch = "--- a/demo.ts\t2026-01-01\n+++ b/demo.ts\t2026-01-02\n@@ -1,1 +1,2 @@\n first\n+second\n"
        val file = UnifiedPatchParser.parse(patch)!!.single()
        assertEquals("a/demo.ts", file.oldPath)
        assertEquals("b/demo.ts", file.newPath)
        val last = file.rows.last() as SplitDiffRow.Line
        assertEquals(SplitDiffCell(null, "", DiffCellType.Empty), last.left)
        assertEquals(SplitDiffCell(2, "second", DiffCellType.Added), last.right)
    }

    @Test
    fun `returns null for text without diff lines`() {
        assertNull(UnifiedPatchParser.parse("not a patch"))
        assertNull(UnifiedPatchParser.parse("--- a/x\n+++ b/x\n"))
    }

    @Test
    fun `computed diff groups context and marks changes`() {
        val old = (1..10).joinToString("\n") { "line $it" }
        val new = (1..10).joinToString("\n") { if (it == 5) "line five" else "line $it" }
        val file = ComputedDiff.split(old, new)!!.single()
        val lines = file.rows.filterIsInstance<SplitDiffRow.Line>().filter { it.left.type != DiffCellType.Context }
        val removed = lines.filter { it.left.type == DiffCellType.Removed }
        val added = lines.filter { it.right.type == DiffCellType.Added }
        assertEquals(listOf("line 5"), removed.map { it.left.text })
        assertEquals(listOf("line five"), added.map { it.right.text })
        assertEquals(5, removed.single().left.lineNo)

        val hunks = file.rows.filterIsInstance<SplitDiffRow.Hunk>()
        assertTrue(hunks.any { it.text.startsWith("@@ -2,7 +2,7 @@") })
    }

    @Test
    fun `computed diff reports no change for equal text`() {
        assertNull(ComputedDiff.split("same", "same"))
    }

    @Test
    fun `computed diff handles insertions and deletions`() {
        val added = ComputedDiff.split("a\nb", "a\nb\nc")!!.single()
            .rows.filterIsInstance<SplitDiffRow.Line>()
            .last()
        assertEquals(DiffCellType.Added, added.right.type)
        assertEquals("c", added.right.text)
        assertEquals(DiffCellType.Empty, added.left.type)

        val deleted = ComputedDiff.split("a\nb\nc", "a\nc")!!.single()
            .rows.filterIsInstance<SplitDiffRow.Line>()
            .first { it.left.type == DiffCellType.Removed }
        assertEquals("b", deleted.left.text)
        assertEquals(DiffCellType.Empty, deleted.right.type)
    }

    @Test
    fun `tool diff keeps a parseable unified patch`() {
        val patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"
        assertEquals(patch, ToolDiff.resolve(patch, null))
    }

    @Test
    fun `tool diff converts omp's numbered snapshot into a real diff`() {
        val resolved = ToolDiff.resolve(null, " 2|beta\n 3|gamma\n+4|delta")!!
        val file = UnifiedPatchParser.parse(resolved)!!.single()
        val lines = file.rows.filterIsInstance<SplitDiffRow.Line>()
        assertEquals(3, lines.size)
        assertEquals(SplitDiffCell(2, "beta", DiffCellType.Context), lines[0].left)
        assertEquals(SplitDiffCell(2, "beta", DiffCellType.Context), lines[0].right)
        assertEquals(SplitDiffCell(3, "gamma", DiffCellType.Context), lines[1].right)
        assertEquals(SplitDiffCell(null, "", DiffCellType.Empty), lines[2].left)
        assertEquals(SplitDiffCell(4, "delta", DiffCellType.Added), lines[2].right)
    }

    @Test
    fun `tool diff keeps removed lines on the old side`() {
        val resolved = ToolDiff.resolve("@@ nothing", "-2|beta\n 3|gamma\n+2|BETA")!!
        val lines = UnifiedPatchParser.parse(resolved)!!.single()
            .rows.filterIsInstance<SplitDiffRow.Line>()
        assertEquals(DiffCellType.Removed, lines[0].left.type)
        assertEquals("beta", lines[0].left.text)
        assertEquals(DiffCellType.Empty, lines[0].right.type)
        assertEquals("gamma", lines[1].right.text)
        assertEquals(DiffCellType.Added, lines[2].right.type)
    }

    @Test
    fun `tool diff keeps raw text for unknown formats`() {
        assertEquals("not a diff at all", ToolDiff.resolve(null, "not a diff at all"))
        assertNull(ToolDiff.resolve(null, "   "))
        assertNull(ToolDiff.resolve(null, null))
    }
}
