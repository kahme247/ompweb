package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {

    private val repo = GithubRepoRef("o", "r")

    private fun blocks(markdown: String, repo: GithubRepoRef? = null): List<MdBlock> =
        MarkdownParser.parse(markdown, repo).blocks

    private fun links(inlines: List<MdInline>): List<MdInline.Link> = inlines.flatMap { node ->
        when (node) {
            is MdInline.Link -> listOf(node)
            is MdInline.Strong -> links(node.children)
            is MdInline.Em -> links(node.children)
            is MdInline.Strike -> links(node.children)
            else -> emptyList()
        }
    }

    private fun paragraphText(block: MdBlock): String = when (block) {
        is MdBlock.Paragraph -> MarkdownParser.plainText(block.inlines)
        else -> error("not a paragraph: $block")
    }

    // ---------------------------------------------------------------- math

    @Test
    fun `normalizes latex parenthesis delimiters`() {
        assertEquals("inline \$x^2\$ here", MarkdownParser.normalizeDisplayMath("""inline \(x^2\) here"""))
    }

    @Test
    fun `normalizes paired latex bracket delimiters as display math`() {
        assertEquals(
            """$$
\frac{1}{2}
$$""",
            MarkdownParser.normalizeDisplayMath("""\[ \frac{1}{2} \]"""),
        )
        assertEquals(
            """$$
a = b
c = d
$$""",
            MarkdownParser.normalizeDisplayMath("""\[
a = b
c = d
\]"""),
        )
    }

    @Test
    fun `leaves an unmatched latex bracket delimiter unchanged`() {
        assertEquals("""\[ x""", MarkdownParser.normalizeDisplayMath("""\[ x"""))
    }

    @Test
    fun `does not normalize delimiters inside code or escaped text`() {
        val fence = "```\n\\[x\\]\n```"
        assertEquals(fence, MarkdownParser.normalizeDisplayMath(fence))
        assertEquals("""`\(x\)`""", MarkdownParser.normalizeDisplayMath("""`\(x\)`"""))
        assertEquals("""\\(x\\)""", MarkdownParser.normalizeDisplayMath("""\\(x\\)"""))
        assertEquals("""[a](https://x.test/\(y\))""", MarkdownParser.normalizeDisplayMath("""[a](https://x.test/\(y\))"""))
    }

    @Test
    fun `plain text flattens inline runs for measuring`() {
        val inlines = listOf(
            MdInline.Text("a "),
            MdInline.Code("x"),
            MdInline.Strong(listOf(MdInline.Text("b"))),
            MdInline.Em(listOf(MdInline.Strike(listOf(MdInline.Text("c"))))),
            MdInline.Image("alt", "img.png"),
            MdInline.Math("y", false),
        )
        assertEquals("a xbcalty", plainText(inlines))
    }

    @Test
    fun `parses inline and block math`() {
        val inline = MarkdownParser.parseInlines("a \$x^2\$ b")
        assertTrue(inline.any { it is MdInline.Math && !it.display && it.tex == "x^2" })
        val block = blocks("$$\nE = mc^2\n$$").single() as MdBlock.MathBlock
        assertEquals("E = mc^2", block.tex)
    }

    // --------------------------------------------------------------- links

    @Test
    fun `links bare and qualified github refs in prose`() {
        val inlines = MarkdownParser.parseInlines("On PR #3460 (see o/r#12130).", repo)
        val hrefs = links(inlines).map { it.href }
        assertEquals(
            listOf("https://github.com/o/r/issues/3460", "https://github.com/o/r/issues/12130"),
            hrefs,
        )
        val withoutRepo = links(MarkdownParser.parseInlines("#12 and a/b#7", null)).map { it.href }
        assertEquals(listOf("https://github.com/a/b/issues/7"), withoutRepo)
    }

    @Test
    fun `does not link refs in code, existing links or glued words`() {
        val inlines = MarkdownParser.parseInlines("`#1` [see #2](https://x.test) C#3 file.ts#4 a/b/c#5 #6x #0", repo)
        assertEquals(listOf("https://x.test"), links(inlines).map { it.href })
        val code = inlines.filterIsInstance<MdInline.Code>().single()
        assertEquals("#1", code.text)
    }

    @Test
    fun `links agent handles in prose but not in code spans`() {
        val inlines = MarkdownParser.parseInlines("Output at agent://Scout. See `agent://Notes` and `write agent://X`.", repo)
        assertEquals(listOf("agent://Scout"), links(inlines).map { it.href })
        val codeTexts = inlines.filterIsInstance<MdInline.Code>().map { it.text }
        assertEquals(listOf("agent://Notes", "write agent://X"), codeTexts)
        assertEquals(LinkTarget.Agent("agent://Notes"), inlineCodeTarget("agent://Notes", null))
        assertNull(inlineCodeTarget("write agent://X", null))
    }

    @Test
    fun `never links the broadcast address`() {
        assertTrue(links(MarkdownParser.parseInlines("agent://all", repo)).isEmpty())
    }

    @Test
    fun `links bare urls once`() {
        val inlines = MarkdownParser.parseInlines("see https://example.com/a?b=1.", null)
        assertEquals(listOf("https://example.com/a?b=1"), links(inlines).map { it.href })
    }

    // -------------------------------------------------------------- blocks

    @Test
    fun `parses headings lists quotes rules and fences`() {
        val doc = blocks(
            """
            # Title

            - one
            - [x] done
            - [ ] todo

            > quoted

            ---

            ```kotlin
            val x = 1
            ```
            """.trimIndent(),
            repo,
        )
        assertEquals(MdBlock.Heading(1, listOf(MdInline.Text("Title"))), doc[0])
        val list = doc[1] as MdBlock.ListBlock
        assertEquals(3, list.items.size)
        assertNull(list.items[0].task)
        assertEquals(true, list.items[1].task)
        assertEquals(false, list.items[2].task)
        assertEquals("done", paragraphText(list.items[1].blocks.first()))
        assertTrue(doc[2] is MdBlock.Quote)
        assertEquals(MdBlock.Rule, doc[3])
        val fence = doc[4] as MdBlock.CodeFence
        assertEquals("kotlin", fence.language)
        assertEquals("val x = 1", fence.code)
    }

    @Test
    fun `parses ordered list start numbers and setext headings`() {
        val list = blocks("3. three\n4. four").single() as MdBlock.ListBlock
        assertTrue(list.ordered)
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)

        val setext = blocks("Title\n=====").single() as MdBlock.Heading
        assertEquals(1, setext.level)
    }

    @Test
    fun `parses tables with alignment`() {
        val table = blocks("| a | b |\n|:--|--:|\n| 1 | 2 |").single() as MdBlock.Table
        assertEquals(2, table.header.size)
        assertEquals(listOf(MdAlign.Left, MdAlign.Right), table.align)
        assertEquals("a", paragraphText(MdBlock.Paragraph(table.header[0])))
        assertEquals(1, table.rows.size)
    }

    @Test
    fun `splits images out of paragraphs`() {
        val mixed = blocks("before ![alt](img.png) after").single()
        val group = mixed as MdBlock.Group
        assertEquals(3, group.blocks.size)
        assertTrue(group.blocks[1] is MdBlock.Image)
        assertEquals("alt", (group.blocks[1] as MdBlock.Image).alt)

        val standalone = blocks("![alt](img.png)").single() as MdBlock.Image
        assertEquals("img.png", standalone.src)
    }

    @Test
    fun `sanitizes raw html`() {
        val text = paragraphText(blocks("<span onclick=\"x()\">hi</span>").single())
        assertEquals("hi", text)
    }

    // ----------------------------------------------------------- streaming

    @Test
    fun `reuses the parsed prefix while streaming`() {
        val cache = MarkdownDocumentCache()
        val first = cache.parse("hello\n\nworld", repo)
        assertEquals(2, first.blocks.size)
        val second = cache.parse("hello\n\nworld\n\nmore", repo)
        assertEquals(3, second.blocks.size)
        assertEquals(first.blocks[0], second.blocks[0])
        assertEquals("more", paragraphText(second.blocks[2]))
        assertEquals(second, cache.parse("hello\n\nworld\n\nmore", repo))
    }

    @Test
    fun `reparses fully when the text is rewritten`() {
        val cache = MarkdownDocumentCache()
        cache.parse("abc", repo)
        val rewritten = cache.parse("xbc", repo)
        assertEquals("xbc", paragraphText(rewritten.blocks.single()))
    }

    @Test
    fun `tasks keep inline formatting after the marker`() {
        val list = blocks("- [x] **bold** and `code`").single() as MdBlock.ListBlock
        val item = list.items.single()
        assertEquals(true, item.task)
        val paragraph = item.blocks.single() as MdBlock.Paragraph
        assertTrue(paragraph.inlines.any { it is MdInline.Strong })
        assertTrue(paragraph.inlines.any { it is MdInline.Code })
    }

    @Test
    fun `inline code file paths are linkable but prose is not`() {
        val target = inlineCodeTarget("src/main/Main.kt:12", "/home/me/project")
        assertEquals(LinkTarget.File("/home/me/project/src/main/Main.kt", 12), target)
        assertNull(inlineCodeTarget("npm test", "/home/me/project"))
        assertNotNull(resolveLocalFileHref("/home/me/project/src/main/Main.kt", "/home/me/project"))
    }

    @Test
    fun `a growing paragraph is extended without a full parse`() {
        val cache = MarkdownDocumentCache()
        cache.parse("Hello", repo)
        assertEquals(1, cache.fullParses)

        var text = "Hello"
        for (chunk in listOf(" world", " and", " more", " text")) {
            text += chunk
            val document = cache.parse(text, repo)
            assertEquals("the whole document is one paragraph", 1, document.blocks.size)
            assertEquals(
                "the cached document equals a full parse",
                MarkdownParser.parse(text, repo).blocks,
                document.blocks,
            )
        }

        assertEquals("appends stay incremental", 1, cache.fullParses)
    }

    @Test
    fun `a paragraph that ends in a closed construct still extends incrementally`() {
        val cache = MarkdownDocumentCache()
        var text = "Hello **world**"
        cache.parse(text, repo)
        assertEquals(1, cache.fullParses)

        for (chunk in listOf(" and", " more", " text")) {
            text += chunk
            val document = cache.parse(text, repo)
            assertEquals(
                "the cached document equals a full parse",
                MarkdownParser.parse(text, repo).blocks,
                document.blocks,
            )
        }

        assertEquals("appends after a construct stay incremental", 1, cache.fullParses)
        assertTrue("the emphasis is still there", cache.parse(text, repo).blocks.single().let { block ->
            (block as MdBlock.Paragraph).inlines.any { it is MdInline.Strong }
        })
    }

    @Test
    fun `a growing paragraph with inline markup in the middle stays incremental`() {
        val cache = MarkdownDocumentCache()
        var text = "Start **bold**"
        cache.parse(text, repo)
        assertEquals(1, cache.fullParses)

        for (chunk in listOf(" and", " more", " text")) {
            text += chunk
            val document = cache.parse(text, repo)
            assertEquals(
                "the cached document equals a full parse",
                MarkdownParser.parse(text, repo).blocks,
                document.blocks,
            )
        }
        assertEquals("markup earlier in the paragraph does not force a re-parse", 1, cache.fullParses)
    }

    @Test
    fun `opening a construct while streaming costs one parse and then streams again`() {
        val cache = MarkdownDocumentCache()
        var text = "Hello **bol"
        cache.parse(text, repo)
        assertEquals(1, cache.fullParses)

        text += "d"
        assertEquals(MarkdownParser.parse(text, repo).blocks, cache.parse(text, repo).blocks)
        assertEquals("a plain continuation inside the open construct is incremental", 1, cache.fullParses)

        text += "**"
        assertEquals(MarkdownParser.parse(text, repo).blocks, cache.parse(text, repo).blocks)
        assertEquals("closing the construct needs one real parse", 2, cache.fullParses)

        text += " and more"
        assertEquals(MarkdownParser.parse(text, repo).blocks, cache.parse(text, repo).blocks)
        assertEquals("the closed construct does not cost another parse", 2, cache.fullParses)
    }

    @Test
    fun `a suffix that would form a link after a construct falls back to a full parse`() {
        val cache = MarkdownDocumentCache()
        cache.parse("`code`", repo)
        val document = cache.parse("`code` www.example.com", repo)
        assertEquals(
            MarkdownParser.parse("`code` www.example.com", repo).blocks,
            document.blocks,
        )
        assertEquals("a bare URL still needs a real parse", 2, cache.fullParses)
    }

    @Test
    fun `an appended url or markup falls back to a full parse`() {
        val cache = MarkdownDocumentCache()
        cache.parse("see www", repo)
        val document = cache.parse("see www.example.com", repo)
        assertEquals(
            MarkdownParser.parse("see www.example.com", repo).blocks,
            document.blocks,
        )
        assertEquals("the boundary link needs a real parse", 2, cache.fullParses)

        val markup = MarkdownDocumentCache()
        markup.parse("plain ", repo)
        val bold = markup.parse("plain **bold**", repo)
        assertEquals(MarkdownParser.parse("plain **bold**", repo).blocks, bold.blocks)
        assertEquals(2, markup.fullParses)
    }

    @Test
    fun `an appended suffix that extends a bare url or ref needs a real parse`() {
        val url = MarkdownDocumentCache()
        url.parse("See www.exam", repo)
        val extended = url.parse("See www.example.com now", repo)
        assertEquals(MarkdownParser.parse("See www.example.com now", repo).blocks, extended.blocks)
        assertEquals("the boundary link needs a real parse", 2, url.fullParses)

        val ref = MarkdownDocumentCache()
        ref.parse("closed by #1", repo)
        val text = "closed by #1de"
        assertEquals(MarkdownParser.parse(text, repo).blocks, ref.parse(text, repo).blocks)
        assertEquals("the trailing ref must be re-read", 2, ref.fullParses)
    }

    @Test
    fun `a block that dissolves into the paragraph above re-parses from that paragraph`() {
        val cache = MarkdownDocumentCache()
        cache.parse("!\n*", repo)
        assertEquals("a lone `*` is a list item", 2, cache.parse("!\n*", repo).blocks.size)

        val text = "!\n*d2a"
        assertEquals(MarkdownParser.parse(text, repo).blocks, cache.parse(text, repo).blocks)
        assertEquals("the list dissolves into the paragraph", 1, cache.parse(text, repo).blocks.size)
    }

    @Test
    fun `turning the last line into a block marker falls back to a full parse`() {
        val cache = MarkdownDocumentCache()
        cache.parse("1", repo)
        val document = cache.parse("1.", repo)
        assertEquals(MarkdownParser.parse("1.", repo).blocks, document.blocks)
        assertTrue("`1.` is an empty ordered list item", document.blocks.single() is MdBlock.ListBlock)
    }

    @Test
    fun `underscore emphasis does not absorb appended text`() {
        val cache = MarkdownDocumentCache()
        cache.parse("_a_", repo)
        val text = "_a_b"
        assertEquals(MarkdownParser.parse(text, repo).blocks, cache.parse(text, repo).blocks)
        assertEquals("`_a_` plus a letter is literal text", 2, cache.fullParses)
    }

    @Test
    fun `crlf documents parse like their lf twins`() {
        val lf = "# Title\n\ntext\n\n- a\n- b\n\n```kotlin\nval x = 1\n```\n"
        val crlf = lf.replace("\n", "\r\n")
        val fromLf = MarkdownParser.parse(lf, repo)
        val fromCrlf = MarkdownParser.parse(crlf, repo)
        assertEquals(fromLf.blocks, fromCrlf.blocks)
        assertEquals(fromLf.text, fromCrlf.text)
        assertNotNull(fromCrlf.blocks.firstOrNull() as? MdBlock.Heading)
        assertNotNull(fromCrlf.blocks.lastOrNull() as? MdBlock.CodeFence)
    }

    @Test
    fun `a crlf document keeps its structure through the append cache`() {
        val cache = MarkdownDocumentCache()
        val document = cache.parse("# Title\r\n\r\n- a\r\n", repo)
        assertTrue("no carriage returns survive", document.text.indexOf('\r') < 0)
        assertEquals(MarkdownParser.parse("# Title\n\n- a\n", repo).blocks, document.blocks)
        assertEquals("one full parse for the whole document", 1, cache.fullParses)
    }

    @Test
    fun `a plain streaming paragraph never re-parses`() {
        val cache = MarkdownDocumentCache()
        val text = "word ".repeat(80).trim()
        var prefix = ""
        for (char in text) {
            prefix += char
            cache.parse(prefix, repo)
        }
        assertEquals("one parse for the whole stream", 1, cache.fullParses)
        assertEquals(1, cache.parse(prefix, repo).blocks.size)
    }
}
