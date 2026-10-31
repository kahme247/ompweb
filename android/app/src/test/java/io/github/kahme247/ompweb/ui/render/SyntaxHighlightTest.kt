package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyntaxHighlightTest {

    @Test
    fun `highlights kotlin keywords strings comments and numbers`() {
        val code = "val count = 42 // answer\nval name = \"omp\""
        val spans = SyntaxHighlighter.highlight(code, "kotlin")
        val keywordTexts = spans.filter { it.kind == SyntaxHighlighter.Kind.Keyword }
            .map { code.substring(it.start, it.end) }
        assertEquals(listOf("val", "val"), keywordTexts)
        assertEquals(
            listOf("42"),
            spans.filter { it.kind == SyntaxHighlighter.Kind.Number }.map { code.substring(it.start, it.end) },
        )
        assertEquals(
            listOf("\"omp\""),
            spans.filter { it.kind == SyntaxHighlighter.Kind.String }.map { code.substring(it.start, it.end) },
        )
        assertEquals(
            listOf("// answer"),
            spans.filter { it.kind == SyntaxHighlighter.Kind.Comment }.map { code.substring(it.start, it.end) },
        )
    }

    @Test
    fun `spans are ordered and never overlap`() {
        val code = "/* c */ fun f() = 1 + 2"
        val spans = SyntaxHighlighter.highlight(code, "kotlin")
        assertTrue(spans.zipWithNext().all { (a, b) -> a.end <= b.start })
        assertTrue(spans.all { it.start < it.end && it.end <= code.length })
    }

    @Test
    fun `unknown languages stay plain`() {
        assertTrue(SyntaxHighlighter.highlight("anything", "brainfuck").isEmpty())
        assertTrue(SyntaxHighlighter.highlight("anything", null).isEmpty())
        assertTrue(SyntaxHighlighter.highlight("", "kotlin").isEmpty())
    }

    @Test
    fun `json literals are highlighted without keywords`() {
        val code = "{\"ok\": true, \"n\": null, \"x\": 1}"
        val spans = SyntaxHighlighter.highlight(code, "json")
        val literal = spans.filter { it.kind == SyntaxHighlighter.Kind.Literal }.map { code.substring(it.start, it.end) }
        assertEquals(listOf("true", "null"), literal)
        assertFalse(spans.any { it.kind == SyntaxHighlighter.Kind.Keyword })
    }

    @Test
    fun `python triple quoted strings stay one span`() {
        val code = "def f():\n    return \"\"\"multi\nline\"\"\""
        val strings = SyntaxHighlighter.highlight(code, "python")
            .filter { it.kind == SyntaxHighlighter.Kind.String }
        assertEquals(1, strings.size)
        assertTrue(code.substring(strings[0].start, strings[0].end).startsWith("\"\"\""))
    }
}
