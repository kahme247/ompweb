package io.github.kahme247.ompweb.ui.render

import java.util.Locale

/**
 * Markdown parser for [MarkdownText].
 *
 * Ports the GFM subset the web renders (headings, lists, task lists, tables,
 * quotes, code fences, images, hr) plus the two transforms that must happen
 * before block parsing: [normalizeDisplayMath] and the GitHub/agent/file
 * linkification of `lib/github-refs.ts`, `lib/agent-links.ts` and
 * `lib/file-links.ts`.
 *
 * The parser is pure Kotlin so unit tests can drive it on the JVM.
 */
object MarkdownParser {

    // ---------------------------------------------------------------------
    // Document parsing
    // ---------------------------------------------------------------------

    /**
     * Files written on Windows (and text the server reads verbatim) use CRLF.
     * The block parser splits on `\n`, so a trailing `\r` stops every anchored
     * marker from matching and a whole document degrades to plain text —
     * headings, lists and code fences included. Normalize like the web
     * renderer does, before any offset is computed.
     */
    fun normalizeLineEndings(markdown: String): String =
        if (markdown.indexOf('\r') < 0) {
            markdown
        } else {
            markdown.replace("\r\n", "\n").replace('\r', '\n')
        }

    fun parse(markdown: String, githubRepo: GithubRepoRef?): MarkdownDocument {
        val normalized = normalizeDisplayMath(normalizeLineEndings(markdown))
        val spans = parseSpans(normalized, 0, githubRepo)
        return MarkdownDocument(
            text = normalized,
            blocks = spans.map { it.block },
            starts = spans.map { it.start },
            ends = spans.map { it.end },
        )
    }

    /**
     * Re-parses only the tail that starts at [fromOffset]. Used by
     * [MarkdownDocumentCache] while a message streams; [githubRepo] must be
     * the same one the prefix was parsed with.
     */
    internal fun parseTail(markdown: String, fromOffset: Int, githubRepo: GithubRepoRef?): List<BlockSpan> =
        parseSpans(markdown, fromOffset, githubRepo)

    /**
     * Whether the last line of [text] would start a block on its own.
     *
     * A paragraph never contains such a line, so appending plain text that
     * turns the current last line into one ("1" + "." = an empty ordered list
     * item) changes the block structure; [MarkdownDocumentCache] then has to
     * re-parse instead of extending the paragraph in place.
     */
    internal fun lastLineStartsBlock(text: String): Boolean {
        val lineStart = text.lastIndexOf('\n') + 1
        val line = text.substring(lineStart)
        if (line.isBlank()) return false
        if (line.trim() == "$$") return true
        if (FENCE_LINE.matches(line) || ATX_HEADING.matches(line) || RULE.matches(line)) return true
        if (QUOTE_LINE.containsMatchIn(line)) return true
        if (LIST_LINE.matches(line)) return true
        if (lineStart > 0 && TABLE_DELIMITER.matches(line)) {
            val before = text.substring(0, lineStart - 1)
            val previousStart = before.lastIndexOf('\n') + 1
            if (before.substring(previousStart).contains('|')) return true
        }
        return false
    }

    private fun parseSpans(text: String, fromOffset: Int, githubRepo: GithubRepoRef?): List<BlockSpan> {
        if (fromOffset >= text.length) return emptyList()
        val parser = BlockParser(text.substring(fromOffset), githubRepo)
        return parser.parse().map { span ->
            span.copy(start = span.start + fromOffset, end = span.end + fromOffset)
        }
    }

    // ---------------------------------------------------------------------
    // Inline parsing (public for tests)
    // ---------------------------------------------------------------------

    fun parseInlines(source: String, githubRepo: GithubRepoRef? = null): List<MdInline> =
        linkify(parseInlinesInternal(source, githubRepo), githubRepo)

    // ---------------------------------------------------------------------
    // Display-math normalization (port of lib/markdown.ts)
    // ---------------------------------------------------------------------

    /**
     * Converts `\[…\]` display delimiters and glued `$$` fences into the
     * three-line `$$` form block parsing understands, and `\(…\)` into `$…$`.
     * Never touches fenced code, inline code, raw code tags, escaped
     * delimiters or link destinations.
     */
    fun normalizeDisplayMath(markdown: String): String {
        val lineBreak = if (markdown.contains("\r\n")) "\r\n" else "\n"
        val lines = markdown.split(Regex("\r?\n"))
        val normalized = ArrayList<String>(lines.size)
        var fence: Pair<Char, Int>? = null
        var inlineCodeMarkerSize = 0
        var rawCodeTag: String? = null
        val unmatchedDisplayMathUntil = HashMap<String, Int>()

        var index = 0
        while (index < lines.size) {
            val line = lines[index]

            if (rawCodeTag != null) {
                normalized.add(line)
                if (Regex("</$rawCodeTag\\s*>", RegexOption.IGNORE_CASE).containsMatchIn(line)) rawCodeTag = null
                index++
                continue
            }

            val fenceMatch = FENCE_OPEN.matchEntire(line)
            if (fenceMatch != null) {
                val marker = fenceMatch.groups[1]!!.value[0]
                val size = fenceMatch.groups[1]!!.value.length
                if (fence == null) {
                    fence = marker to size
                } else if (marker == fence.first && size >= fence.second) {
                    fence = null
                }
                inlineCodeMarkerSize = 0
                normalized.add(line)
                index++
                continue
            }

            if (fence != null) {
                normalized.add(line)
                index++
                continue
            }

            val rawCodeOpen = RAW_CODE_OPEN.find(line)
            if (rawCodeOpen != null) {
                val tag = rawCodeOpen.groups[1]!!.value.lowercase(Locale.ROOT)
                val remainder = line.substring(rawCodeOpen.range.last + 1)
                if (!Regex("</$tag\\s*>", RegexOption.IGNORE_CASE).containsMatchIn(remainder)) rawCodeTag = tag
                inlineCodeMarkerSize = 0
                normalized.add(line)
                index++
                continue
            }

            if (INDENTED_OR_BLANK.containsMatchIn(line) || line.isBlank()) {
                inlineCodeMarkerSize = 0
                normalized.add(line)
                index++
                continue
            }

            if (inlineCodeMarkerSize != 0 || line.contains('`')) {
                inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize)
                normalized.add(line)
                index++
                continue
            }

            val bracketOneLine = BRACKET_DISPLAY_ONE_LINE.matchEntire(line)
            if (bracketOneLine != null) {
                val math = bracketOneLine.groups[2]!!.value.trim()
                if (math.isNotEmpty()) {
                    val indent = bracketOneLine.groups[1]!!.value
                    normalized.add("$indent$$")
                    normalized.add("$indent$math")
                    normalized.add("$indent$$")
                    index++
                    continue
                }
            }

            val bracketStart = BRACKET_DISPLAY_START.matchEntire(line)
            if (bracketStart != null) {
                val closingIndex = findBracketDisplayClose(lines, index + 1)
                if (closingIndex != -1) {
                    val indent = bracketStart.groups[1]!!.value
                    normalized.add("$indent$$")
                    for (j in index + 1 until closingIndex) {
                        normalized.add(indentDisplayMathContent(lines[j], indent))
                    }
                    normalized.add("$indent$$")
                    index = closingIndex + 1
                    continue
                }
            }

            val displayOneLine = DISPLAY_ONE_LINE.matchEntire(line)
            if (displayOneLine != null) {
                val math = displayOneLine.groups[2]!!.value.trim()
                if (math.isNotEmpty()) {
                    val indent = displayOneLine.groups[1]!!.value
                    normalized.add("$indent$$")
                    normalized.add("$indent$math")
                    normalized.add("$indent$$")
                    index++
                    continue
                }
            }

            // Models may glue display fences to the first or last formula line.
            val displayMultiLine = DISPLAY_MULTI_LINE.matchEntire(line)
            if (displayMultiLine != null) {
                val indent = displayMultiLine.groups[1]!!.value
                val firstLine = displayMultiLine.groups[2]!!.value.trimEnd()
                // Keep `$$x$$ and text` inline; it is not a display block opener.
                if (firstLine.isNotEmpty() && !firstLine.contains("$$")) {
                    val closing = findDisplayMathClose(lines, index + 1, indent, unmatchedDisplayMathUntil)
                    if (closing != null) {
                        normalized.add("$indent$$")
                        normalized.add("$indent$firstLine")
                        for (j in index + 1 until closing.index) {
                            normalized.add(indentDisplayMathContent(lines[j], indent))
                        }
                        if (closing.content.isNotEmpty()) normalized.add("$indent${closing.content}")
                        normalized.add("$indent$$")
                        index = closing.index + 1
                        continue
                    }
                }
            }

            val bareOpen = DISPLAY_BARE_OPEN.matchEntire(line)
            if (bareOpen != null) {
                val indent = bareOpen.groups[1]!!.value
                val closing = findDisplayMathClose(lines, index + 1, indent, unmatchedDisplayMathUntil)
                if (closing != null && (closing.glued || indent.isNotEmpty())) {
                    normalized.add("$indent$$")
                    for (j in index + 1 until closing.index) {
                        normalized.add(indentDisplayMathContent(lines[j], indent))
                    }
                    if (closing.content.isNotEmpty()) normalized.add("$indent${closing.content}")
                    normalized.add("$indent$$")
                    index = closing.index + 1
                    continue
                }
            }

            normalized.add(normalizeInlineLatexMath(line))
            index++
        }

        return normalized.joinToString(lineBreak)
    }

    private data class DisplayMathClose(val index: Int, val content: String, val glued: Boolean)

    private fun findDisplayMathClose(
        lines: List<String>,
        startIndex: Int,
        indent: String,
        unmatchedUntil: MutableMap<String, Int>,
    ): DisplayMathClose? {
        val known = unmatchedUntil[indent]
        if (known != null && startIndex < known) return null

        for (index in startIndex until lines.size) {
            val line = lines[index]
            if (isDisplayMathFence(line, indent)) return DisplayMathClose(index, "", false)
            if (isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
                unmatchedUntil[indent] = index
                return null
            }
            val content = getDisplayMathGluedCloseContent(line, indent)
            if (content != null) return DisplayMathClose(index, content, true)
        }

        unmatchedUntil[indent] = lines.size
        return null
    }

    private fun isDisplayMathFence(line: String, indent: String): Boolean =
        if (indent.isEmpty()) {
            Regex("^ {0,3}\\$\\$\\s*$").matches(line)
        } else {
            line.startsWith(indent) && Regex("^\\$\\$\\s*$").matches(line.substring(indent.length))
        }

    private fun getDisplayMathGluedCloseContent(line: String, indent: String): String? {
        if (!line.startsWith(indent)) return null
        val match = Regex("^(.+?)\\$\\$\\s*$").matchEntire(line.substring(indent.length)) ?: return null
        val content = match.groups[1]!!.value.trimEnd()
        return if (content.isNotEmpty() && !content.contains("$$")) content else null
    }

    private fun isDisplayMathOpeningLine(line: String): Boolean =
        Regex("^ {0,3}\\$\\$(?:\\S|[ \\t]+\\S)").containsMatchIn(line)

    private fun isDisplayMathBlockBoundary(line: String): Boolean =
        Regex("^ {0,3}(`{3,}|~{3,})").containsMatchIn(line) ||
            Regex("^[ \\t]*(?:[-+*]|\\d{1,9}[.)])(?:[ \\t]+|$)").containsMatchIn(line) ||
            Regex("^ {0,3}#{1,6}(?:[ \\t]+|$)").containsMatchIn(line) ||
            Regex("^ {0,3}>").containsMatchIn(line) ||
            Regex("<(code|pre|script|style)\\b", RegexOption.IGNORE_CASE).containsMatchIn(line)

    private fun indentDisplayMathContent(line: String, indent: String): String {
        if (indent.isEmpty() || line.isEmpty() || line.startsWith("\t")) return line
        val leadingSpaces = line.takeWhile { it == ' ' }.length
        if (leadingSpaces >= indent.length) return line
        return indent.substring(leadingSpaces) + line
    }

    private fun findBracketDisplayClose(lines: List<String>, startIndex: Int): Int {
        for (index in startIndex until lines.size) {
            val line = lines[index]
            if (Regex("^ {0,3}\\\\\\][ \\t]*$").matches(line)) return index
            if (
                Regex("^ {0,3}(`{3,}|~{3,})").containsMatchIn(line) ||
                Regex("^ {0,3}\\\\\\[[ \\t]*$").matches(line) ||
                Regex("<(code|pre|script|style)\\b", RegexOption.IGNORE_CASE).containsMatchIn(line)
            ) {
                return -1
            }
        }
        return -1
    }

    private fun updateInlineCodeMarker(line: String, initialMarkerSize: Int): Int {
        var markerSize = initialMarkerSize
        var cursor = 0
        while (cursor < line.length) {
            if (line[cursor] != '`') {
                cursor++
                continue
            }
            var end = cursor + 1
            while (end < line.length && line[end] == '`') end++
            val runSize = end - cursor
            if (markerSize == 0) markerSize = runSize else if (runSize == markerSize) markerSize = 0
            cursor = end
        }
        return markerSize
    }

    private fun normalizeInlineLatexMath(line: String): String {
        if (
            Regex("^\\s{0,3}\\[[^]]+\\]:").containsMatchIn(line) ||
            Regex("]\\s*\\(").containsMatchIn(line) ||
            Regex("<(?:!--|/?[A-Za-z][^>]*>)").containsMatchIn(line) ||
            Regex("\\b(?:https?|file|mailto):", RegexOption.IGNORE_CASE).containsMatchIn(line) ||
            Regex("\\b[A-Za-z]:\\\\").containsMatchIn(line)
        ) {
            return line
        }
        return INLINE_LATEX_PAREN.replace(line) { match ->
            val math = match.groups[1]!!.value
            if (math.trim().isNotEmpty()) "$$math$" else match.value
        }
    }

    // ---------------------------------------------------------------------
    // Regular expressions
    // ---------------------------------------------------------------------

    private val FENCE_OPEN = Regex("^ {0,3}(`{3,}|~{3,})")
    private val RAW_CODE_OPEN = Regex("<(code|pre|script|style)\\b", RegexOption.IGNORE_CASE)
    private val INDENTED_OR_BLANK = Regex("^(?: {4}|\\t)")
    private val BRACKET_DISPLAY_ONE_LINE = Regex("^([ ]{0,3})\\\\\\[[ \\t]*(.+?)[ \\t]*\\\\\\][ \\t]*$")
    private val BRACKET_DISPLAY_START = Regex("^([ ]{0,3})\\\\\\[[ \\t]*$")
    private val DISPLAY_ONE_LINE = Regex("^([ \\t]{0,3})\\$\\$(.+)\\$\\$[ \\t]*$")
    private val DISPLAY_MULTI_LINE = Regex("^([ \\t]{0,3})\\$\\$(.+)$")
    private val DISPLAY_BARE_OPEN = Regex("^([ \\t]{0,3})\\$\\$\\s*$")
    private val INLINE_LATEX_PAREN = Regex("(?<!\\\\)\\\\\\(([^`\\r\\n$]+?)(?<!\\\\)\\\\\\)")

    // ---------------------------------------------------------------------
    // Block parser
    // ---------------------------------------------------------------------

    private class BlockParser(private val text: String, private val githubRepo: GithubRepoRef?) {
        private val lines: List<String> = text.split('\n')
        private val starts: IntArray = IntArray(lines.size).also { offsets ->
            var offset = 0
            for (i in lines.indices) {
                offsets[i] = offset
                offset += lines[i].length + 1
            }
        }

        fun parse(): List<BlockSpan> {
            val out = ArrayList<BlockSpan>()
            var i = 0
            while (i < lines.size) {
                if (lines[i].isBlank()) {
                    i++
                    continue
                }
                val blockStart = i
                val parsed = parseBlock(i)
                val next = parsed.second
                val block = parsed.first
                val end = if (next <= blockStart) starts[blockStart] + lines[blockStart].length else lineEnd(next - 1)
                out.add(BlockSpan(block, starts[blockStart], end))
                i = if (next <= blockStart) blockStart + 1 else next
            }
            return out
        }

        private fun lineEnd(index: Int): Int = starts[index] + lines[index].length

        private fun parseBlock(from: Int): Pair<MdBlock, Int> {
            val line = lines[from]

            val fenceMatch = FENCE_LINE.matchEntire(line)
            if (fenceMatch != null) return parseFence(from, fenceMatch)

            if (line.trim() == "$$") return parseMathBlock(from)

            val heading = ATX_HEADING.matchEntire(line)
            if (heading != null) {
                val level = heading.groups[1]!!.value.length
                val content = heading.groups[2]?.value.orEmpty()
                    .trimEnd()
                    .replace(Regex("[ \\t]+#+$"), "")
                    .trimEnd()
                return MdBlock.Heading(level, inline(content)) to from + 1
            }

            if (RULE.matches(line)) return MdBlock.Rule to from + 1

            if (QUOTE_LINE.containsMatchIn(line)) return parseQuote(from)

            if (LIST_LINE.matches(line)) return parseList(from)

            if (isTableStart(from)) return parseTable(from)

            if (INDENTED_CODE.containsMatchIn(line)) return parseIndentedCode(from)

            return parseParagraph(from)
        }

        private fun parseFence(from: Int, opening: MatchResult): Pair<MdBlock, Int> {
            val marker = opening.groups[1]!!.value
            val info = opening.groups[2]?.value.orEmpty().trim()
            val language = info.split(Regex("\\s+")).firstOrNull()?.takeIf { it.isNotEmpty() }
            val code = StringBuilder()
            var i = from + 1
            var closed = false
            while (i < lines.size) {
                val close = FENCE_CLOSE.matchEntire(lines[i])
                if (close != null) {
                    val closeMarker = close.groups[1]!!.value
                    if (closeMarker[0] == marker[0] && closeMarker.length >= marker.length) {
                        closed = true
                        i++
                        break
                    }
                }
                if (code.isNotEmpty()) code.append('\n')
                code.append(lines[i])
                i++
            }
            if (!closed) {
                // An unclosed fence while streaming is still a code block.
                return MdBlock.CodeFence(language, code.toString()) to i
            }
            return MdBlock.CodeFence(language, code.toString()) to i
        }

        private fun parseMathBlock(from: Int): Pair<MdBlock, Int> {
            val math = StringBuilder()
            var i = from + 1
            while (i < lines.size && lines[i].trim() != "$$") {
                if (math.isNotEmpty()) math.append('\n')
                math.append(lines[i])
                i++
            }
            val next = if (i < lines.size) i + 1 else i
            return MdBlock.MathBlock(math.toString().trim()) to next
        }

        private fun parseQuote(from: Int): Pair<MdBlock, Int> {
            val body = ArrayList<String>()
            var i = from
            while (i < lines.size) {
                val match = QUOTE_LINE.matchEntire(lines[i])
                if (match != null) {
                    body.add(match.groups[1]!!.value)
                    i++
                    continue
                }
                if (lines[i].isBlank() && i + 1 < lines.size && QUOTE_LINE.containsMatchIn(lines[i + 1])) {
                    body.add("")
                    i++
                    continue
                }
                break
            }
            // Trailing blank lines only separated the quote from the next block.
            while (body.isNotEmpty() && body.last().isBlank()) body.removeAt(body.size - 1)
            val nested = BlockParser(body.joinToString("\n"), githubRepo).parse().map { it.block }
            return MdBlock.Quote(nested) to i
        }

        private fun parseList(from: Int): Pair<MdBlock, Int> {
            val first = LIST_LINE.matchEntire(lines[from])!!
            val firstIndent = first.groups[1]!!.value.length
            val firstMarker = first.groups[2]!!.value
            val ordered = firstMarker[0].isDigit()
            val startNumber = first.groups[3]?.value?.toIntOrNull() ?: 1
            val items = ArrayList<MdListItem>()
            var i = from

            while (i < lines.size) {
                val match = LIST_LINE.matchEntire(lines[i]) ?: break
                val indent = match.groups[1]!!.value.length
                val marker = match.groups[2]!!.value
                if (indent != firstIndent || marker[0].isDigit() != ordered) break

                val separator = match.groups[4]!!.value
                val contentIndent = indent + marker.length + separator.length
                val body = ArrayList<String>()
                body.add(match.groups[5]!!.value)
                var j = i + 1
                while (j < lines.size) {
                    val current = lines[j]
                    if (current.isBlank()) {
                        body.add("")
                        j++
                        continue
                    }
                    val lead = current.takeWhile { it == ' ' }.length
                    if (lead >= contentIndent) {
                        body.add(current.drop(contentIndent))
                        j++
                        continue
                    }
                    // A sibling item ends this item.
                    val nextItem = LIST_LINE.matchEntire(current)
                    if (nextItem != null && nextItem.groups[1]!!.value.length == firstIndent) break
                    // Lazy paragraph continuation.
                    if (body.lastOrNull()?.isNotBlank() == true && !startsBlock(current, j)) {
                        body.add(current.trimStart())
                        j++
                        continue
                    }
                    break
                }
                while (body.isNotEmpty() && body.last().isBlank()) body.removeAt(body.size - 1)

                var nestedBlocks = BlockParser(body.joinToString("\n"), githubRepo).parse().map { it.block }
                var task: Boolean? = null
                val firstBlock = nestedBlocks.firstOrNull()
                if (firstBlock is MdBlock.Paragraph) {
                    // Only a leading `[ ]`/`[x]` text node counts as a task marker.
                    val leading = firstBlock.inlines.firstOrNull() as? MdInline.Text
                    val markerMatch = leading?.let { TASK_PREFIX.matchAt(it.text, 0) }
                    if (leading != null && markerMatch != null) {
                        task = markerMatch.groups[1]!!.value.equals("x", ignoreCase = true)
                        val rest = leading.text.substring(markerMatch.range.last + 1)
                        val inlines = if (rest.isEmpty()) {
                            firstBlock.inlines.drop(1)
                        } else {
                            listOf(MdInline.Text(rest)) + firstBlock.inlines.drop(1)
                        }
                        nestedBlocks = if (inlines.isEmpty()) nestedBlocks.drop(1) else listOf(MdBlock.Paragraph(inlines)) + nestedBlocks.drop(1)
                    }
                }
                items.add(MdListItem(task = task, blocks = nestedBlocks))

                i = j
                while (i < lines.size && lines[i].isBlank()) i++
            }

            return MdBlock.ListBlock(ordered = ordered, start = startNumber, items = items) to i
        }

        private fun parseTable(from: Int): Pair<MdBlock, Int> {
            val header = splitTableRow(lines[from])
            val delimiter = splitTableRow(lines[from + 1])
            val align = delimiter.map { cell ->
                val left = cell.startsWith(":")
                val right = cell.endsWith(":")
                when {
                    left && right -> MdAlign.Center
                    right -> MdAlign.Right
                    left -> MdAlign.Left
                    else -> MdAlign.None
                }
            }
            val headerCells = normalizeCells(header, align.size).map { inline(it) }
            val rows = ArrayList<List<List<MdInline>>>()
            var i = from + 2
            while (i < lines.size) {
                val line = lines[i]
                if (line.isBlank() || !line.contains('|')) break
                rows.add(normalizeCells(splitTableRow(line), align.size).map { inline(it) })
                i++
            }
            return MdBlock.Table(headerCells, align, rows) to i
        }

        private fun parseIndentedCode(from: Int): Pair<MdBlock, Int> {
            val code = StringBuilder()
            var i = from
            while (i < lines.size) {
                val line = lines[i]
                if (line.isBlank()) {
                    code.append('\n')
                    i++
                    continue
                }
                if (!INDENTED_CODE.containsMatchIn(line)) break
                code.append(line.removePrefix("    ").removePrefix("\t"))
                code.append('\n')
                i++
            }
            return MdBlock.CodeFence(null, code.toString().trimEnd('\n')) to i
        }

        private fun parseParagraph(from: Int): Pair<MdBlock, Int> {
            val content = ArrayList<String>()
            var i = from
            while (i < lines.size) {
                val line = lines[i]
                if (line.isBlank()) break
                if (content.isNotEmpty() && (startsBlock(line, i) || SETEXT_1.matches(line) || SETEXT_2.matches(line))) break
                content.add(line)
                i++
            }

            if (content.size == 1) {
                val next = if (i < lines.size) lines[i] else null
                if (next != null && SETEXT_1.matches(next)) {
                    return MdBlock.Heading(1, inline(content[0].trim())) to i + 1
                }
                if (next != null && SETEXT_2.matches(next) && content[0].isNotBlank()) {
                    return MdBlock.Heading(2, inline(content[0].trim())) to i + 1
                }
            }

            val source = content.joinToString("\n")
            val inlines = inline(source)
            val blocks = splitImages(inlines)
            if (blocks.size == 1) return blocks[0] to i
            // Mixed text and images: emit a group block that renders in order.
            return MdBlock.Group(blocks) to i
        }

        private fun splitImages(inlines: List<MdInline>): List<MdBlock> {
            if (inlines.none { it is MdInline.Image }) {
                return if (inlines.isEmpty()) emptyList() else listOf(MdBlock.Paragraph(inlines))
            }
            val result = ArrayList<MdBlock>()
            var current = ArrayList<MdInline>()
            fun flush() {
                if (current.isNotEmpty()) {
                    result.add(MdBlock.Paragraph(trimInlines(current)))
                    current = ArrayList()
                }
            }
            for (inline in inlines) {
                if (inline is MdInline.Image) {
                    flush()
                    result.add(MdBlock.Image(inline.alt, inline.src))
                } else {
                    current.add(inline)
                }
            }
            flush()
            return result
        }

        private fun trimInlines(inlines: List<MdInline>): List<MdInline> {
            val copy = inlines.toMutableList()
            while (copy.isNotEmpty() && (copy.first() as? MdInline.Text)?.text?.isBlank() == true) copy.removeAt(0)
            while (copy.isNotEmpty() && (copy.last() as? MdInline.Text)?.text?.isBlank() == true) copy.removeAt(copy.size - 1)
            return copy
        }

        private fun inline(source: String): List<MdInline> = MarkdownParser.parseInlines(source, githubRepo)

        private fun isTableStart(index: Int): Boolean {
            if (index + 1 >= lines.size) return false
            if (!lines[index].contains('|')) return false
            val candidate = lines[index + 1]
            if (!TABLE_DELIMITER.matches(candidate)) return false
            return lines[index].count { it == '|' } >= 1
        }

        private fun startsBlock(line: String, index: Int): Boolean {
            if (FENCE_LINE.matches(line)) return true
            if (ATX_HEADING.matches(line)) return true
            if (RULE.matches(line)) return true
            if (QUOTE_LINE.containsMatchIn(line)) return true
            if (LIST_LINE.matches(line)) return true
            if (line.trim() == "$$") return true
            if (isTableStart(index)) return true
            return false
        }
    }

    // ---------------------------------------------------------------------
    // Inline scanner
    // ---------------------------------------------------------------------

    private fun parseInlinesInternal(source: String, githubRepo: GithubRepoRef?): List<MdInline> {
        val nodes = ArrayList<MdInline>()
        val buffer = StringBuilder()
        var i = 0
        val n = source.length

        fun flush() {
            if (buffer.isNotEmpty()) {
                nodes.add(MdInline.Text(buffer.toString()))
                buffer.setLength(0)
            }
        }

        while (i < n) {
            val c = source[i]
            when {
                c == '\\' && i + 1 < n && source[i + 1] == '\n' -> {
                    flush()
                    nodes.add(MdInline.HardBreak)
                    i += 2
                }
                c == '\\' && i + 1 < n && source[i + 1] in ESCAPABLE -> {
                    buffer.append(source[i + 1])
                    i += 2
                }
                c == '\n' -> {
                    val hard = buffer.endsWith("  ")
                    flush()
                    nodes.add(if (hard) MdInline.HardBreak else MdInline.SoftBreak)
                    i++
                }
                c == '`' -> {
                    val run = countRun(source, i, '`')
                    val close = findCodeSpanClose(source, i + run, run)
                    if (close < 0) {
                        buffer.append(source, i, i + run)
                        i += run
                    } else {
                        var content = source.substring(i + run, close).replace('\n', ' ')
                        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.isNotBlank()) {
                            content = content.substring(1, content.length - 1)
                        }
                        flush()
                        nodes.add(MdInline.Code(content))
                        i = close + run
                    }
                }
                c == '!' && i + 1 < n && source[i + 1] == '[' -> {
                    val parsed = parseLinkOrImage(source, i, image = true, githubRepo)
                    if (parsed != null) {
                        flush(); nodes.add(parsed.first); i = parsed.second
                    } else {
                        buffer.append(c); i++
                    }
                }
                c == '[' -> {
                    val parsed = parseLinkOrImage(source, i, image = false, githubRepo)
                    if (parsed != null) {
                        flush(); nodes.add(parsed.first); i = parsed.second
                    } else {
                        buffer.append(c); i++
                    }
                }
                c == '<' -> {
                    val end = source.indexOf('>', i + 1)
                    if (end > i) {
                        val inner = source.substring(i + 1, end)
                        when {
                            inner.startsWith("http://") || inner.startsWith("https://") -> {
                                flush()
                                nodes.add(MdInline.Link(listOf(MdInline.Text(inner)), inner))
                                i = end + 1
                            }
                            inner.startsWith("mailto:") -> {
                                flush()
                                nodes.add(MdInline.Link(listOf(MdInline.Text(inner.removePrefix("mailto:"))), inner))
                                i = end + 1
                            }
                            EMAIL_ADDRESS.matches(inner) -> {
                                flush()
                                nodes.add(MdInline.Link(listOf(MdInline.Text(inner)), "mailto:$inner"))
                                i = end + 1
                            }
                            inner.equals("br", ignoreCase = true) || inner.equals("br/", ignoreCase = true) -> {
                                flush()
                                nodes.add(MdInline.HardBreak)
                                i = end + 1
                            }
                            inner.startsWith("!--") || HTML_TAG.matches(inner) -> {
                                // Raw HTML is sanitized away, like rehype-sanitize.
                                i = end + 1
                            }
                            else -> {
                                buffer.append(c); i++
                            }
                        }
                    } else {
                        buffer.append(c); i++
                    }
                }
                c == '$' -> {
                    val parsed = parseMath(source, i)
                    if (parsed != null) {
                        flush(); nodes.add(parsed.first); i = parsed.second
                    } else {
                        buffer.append(c); i++
                    }
                }
                c == '*' || c == '_' -> {
                    val parsed = parseEmphasis(source, i, c, githubRepo)
                    if (parsed != null) {
                        flush(); nodes.add(parsed.first); i = parsed.second
                    } else {
                        buffer.append(c); i++
                    }
                }
                c == '~' && i + 1 < n && source[i + 1] == '~' -> {
                    val close = findInlineDelimiter(source, i + 2, "~~")
                    if (close > i + 2) {
                        val inner = parseInlinesInternal(source.substring(i + 2, close), githubRepo)
                        flush(); nodes.add(MdInline.Strike(inner)); i = close + 2
                    } else {
                        buffer.append(c); i++
                    }
                }
                else -> {
                    buffer.append(c); i++
                }
            }
        }
        flush()
        return nodes
    }

    private fun parseEmphasis(
        source: String,
        start: Int,
        marker: Char,
        githubRepo: GithubRepoRef?,
    ): Pair<MdInline, Int>? {
        val n = source.length
        val isDouble = start + 1 < n && source[start + 1] == marker
        if (isDouble) {
            if (start + 2 >= n || source[start + 2].isWhitespace()) return null
            val close = findInlineDelimiter(source, start + 2, "$marker$marker")
            if (close <= start + 2) return null
            val inner = parseInlinesInternal(source.substring(start + 2, close), githubRepo)
            return MdInline.Strong(inner) to close + 2
        }
        if (marker == '_' && start > 0 && isWordChar(source[start - 1])) return null
        if (start + 1 >= n || source[start + 1].isWhitespace()) return null
        val close = findInlineDelimiter(source, start + 1, marker.toString())
        if (close <= start + 1) return null
        if (source[close - 1].isWhitespace()) return null
        if (marker == '_' && close + 1 < n && isWordChar(source[close + 1])) return null
        val inner = parseInlinesInternal(source.substring(start + 1, close), githubRepo)
        return MdInline.Em(inner) to close + 1
    }

    private fun parseLinkOrImage(
        source: String,
        start: Int,
        image: Boolean,
        githubRepo: GithubRepoRef?,
    ): Pair<MdInline, Int>? {
        val labelStart = if (image) start + 2 else start + 1
        val labelEnd = findMatchingBracket(source, labelStart) ?: return null
        if (labelEnd + 1 >= source.length || source[labelEnd + 1] != '(') return null
        val destEnd = findMatchingParen(source, labelEnd + 2) ?: return null
        val rawDestination = source.substring(labelEnd + 2, destEnd).trim()
        val href = parseDestination(rawDestination) ?: return null
        val label = source.substring(labelStart, labelEnd)
        val next = destEnd + 1
        if (image) {
            return MdInline.Image(altText(label), href) to next
        }
        val children = parseInlinesInternal(label, githubRepo)
        return MdInline.Link(children, href) to next
    }

    private fun parseDestination(raw: String): String? {
        if (raw.isEmpty()) return null
        if (raw.startsWith("<")) {
            val end = raw.indexOf('>')
            if (end > 1) return raw.substring(1, end).trim().ifEmpty { null }
        }
        val token = raw.split(Regex("[ \\t]")).firstOrNull().orEmpty()
        return token.ifEmpty { null }
    }

    private fun altText(label: String): String =
        plainText(parseInlinesInternal(label, null)).trim()

    private fun parseMath(source: String, start: Int): Pair<MdInline, Int>? {
        val n = source.length
        if (start + 1 < n && source[start + 1] == '$') {
            val close = source.indexOf("$$", start + 2)
            if (close > start + 2) {
                return MdInline.Math(source.substring(start + 2, close).trim(), true) to close + 2
            }
            return null
        }
        if (start + 1 >= n || source[start + 1].isWhitespace() || source[start + 1] == '$') return null
        var i = start + 1
        while (i < n) {
            when (source[i]) {
                '\\' -> i += 2
                '\n' -> return null
                '$' -> {
                    val closingFollowedByDigit = i + 1 < n && source[i + 1].isDigit()
                    if (i > start + 1 && !source[i - 1].isWhitespace() && !closingFollowedByDigit) {
                        return MdInline.Math(source.substring(start + 1, i).trim(), false) to i + 1
                    }
                    return null
                }
                else -> i++
            }
        }
        return null
    }

    // ---------------------------------------------------------------------
    // Linkification of plain text (GitHub refs, agent handles, bare URLs)
    // ---------------------------------------------------------------------

    private data class TextMatch(val start: Int, val end: Int, val inline: MdInline, val priority: Int)

    private fun linkify(nodes: List<MdInline>, repo: GithubRepoRef?): List<MdInline> =
        nodes.flatMap { node ->
            when (node) {
                is MdInline.Text -> linkifyText(node.text, repo)
                is MdInline.Strong -> listOf(MdInline.Strong(linkify(node.children, repo)))
                is MdInline.Em -> listOf(MdInline.Em(linkify(node.children, repo)))
                is MdInline.Strike -> listOf(MdInline.Strike(linkify(node.children, repo)))
                // Existing links stay untouched, exactly like mdast-util-find-and-replace's `ignore`.
                else -> listOf(node)
            }
        }

    private fun linkifyText(text: String, repo: GithubRepoRef?): List<MdInline> {
        if (text.isEmpty()) return emptyList()
        val matches = ArrayList<TextMatch>()

        for (ref in findGithubRefs(text, repo)) {
            matches.add(
                TextMatch(
                    ref.start,
                    ref.end,
                    MdInline.Link(listOf(MdInline.Text(ref.text)), githubUrl(ref.target)),
                    priority = 0,
                ),
            )
        }
        for (range in findAgentHandles(text)) {
            val handle = text.substring(range.first, range.last + 1)
            matches.add(TextMatch(range.first, range.last + 1, MdInline.Link(listOf(MdInline.Text(handle)), handle), priority = 1))
        }
        for (match in BARE_URL.findAll(text)) {
            var url = match.value
            while (url.isNotEmpty() && url.last() in TRAILING_URL_PUNCTUATION) {
                url = url.dropLast(1)
            }
            if (url.length <= 4) continue
            val href = if (url.startsWith("www.", ignoreCase = true)) "https://$url" else url
            matches.add(TextMatch(match.range.first, match.range.first + url.length, MdInline.Link(listOf(MdInline.Text(url)), href), priority = 2))
        }

        if (matches.isEmpty()) return listOf(MdInline.Text(text))

        matches.sortWith(compareBy<TextMatch> { it.start }.thenBy { it.priority })
        val accepted = ArrayList<TextMatch>()
        var coveredUntil = -1
        for (match in matches) {
            if (match.start < coveredUntil) continue
            accepted.add(match)
            coveredUntil = match.end
        }

        val out = ArrayList<MdInline>()
        var cursor = 0
        for (match in accepted) {
            if (match.start > cursor) out.add(MdInline.Text(text.substring(cursor, match.start)))
            out.add(match.inline)
            cursor = match.end
        }
        if (cursor < text.length) out.add(MdInline.Text(text.substring(cursor)))
        return out
    }

    private fun githubUrl(target: LinkTarget.GithubIssue): String =
        "https://github.com/${target.owner}/${target.repo}/issues/${target.number}"

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    private fun countRun(source: String, start: Int, char: Char): Int {
        var end = start
        while (end < source.length && source[end] == char) end++
        return end - start
    }

    private fun findCodeSpanClose(source: String, from: Int, run: Int): Int {
        var i = from
        while (i < source.length) {
            if (source[i] == '`') {
                val size = countRun(source, i, '`')
                if (size == run) return i
                i += size
            } else {
                i++
            }
        }
        return -1
    }

    private fun findInlineDelimiter(source: String, from: Int, delimiter: String): Int {
        var i = from
        while (i < source.length) {
            when {
                source[i] == '\\' -> i += 2
                source[i] == '`' -> {
                    val run = countRun(source, i, '`')
                    val close = findCodeSpanClose(source, i + run, run)
                    i = if (close < 0) i + run else close + run
                }
                source.startsWith(delimiter, i) -> return i
                else -> i++
            }
        }
        return -1
    }

    private fun findMatchingBracket(source: String, from: Int): Int? {
        var depth = 1
        var i = from
        while (i < source.length) {
            when (source[i]) {
                '\\' -> i++
                '[' -> depth++
                ']' -> {
                    depth--
                    if (depth == 0) return i
                }
            }
            i++
        }
        return null
    }

    private fun findMatchingParen(source: String, from: Int): Int? {
        var depth = 1
        var i = from
        while (i < source.length) {
            when (source[i]) {
                '\\' -> i++
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return i
                }
                '\n' -> {
                    // A link destination never spans a line.
                    if (depth == 1) return null
                }
            }
            i++
        }
        return null
    }

    private fun isWordChar(c: Char): Boolean = c.isLetterOrDigit() || c == '_'

    internal fun plainText(nodes: List<MdInline>): String = buildString {
        fun appendAll(list: List<MdInline>) {
            for (node in list) {
                when (node) {
                    is MdInline.Text -> append(node.text)
                    is MdInline.Code -> append(node.text)
                    is MdInline.Strong -> appendAll(node.children)
                    is MdInline.Em -> appendAll(node.children)
                    is MdInline.Strike -> appendAll(node.children)
                    is MdInline.Link -> appendAll(node.children)
                    is MdInline.Image -> append(node.alt)
                    is MdInline.Math -> append(node.tex)
                    MdInline.SoftBreak -> append(' ')
                    MdInline.HardBreak -> append('\n')
                }
            }
        }
        appendAll(nodes)
    }

    private fun splitTableRow(line: String): List<String> {
        val trimmed = line.trim().removePrefix("|").removeSuffix("|")
        val cells = ArrayList<String>()
        val current = StringBuilder()
        var escaped = false
        for (c in trimmed) {
            when {
                escaped -> {
                    current.append(c)
                    escaped = false
                }
                c == '\\' -> escaped = true
                c == '|' -> {
                    cells.add(current.toString().trim())
                    current.setLength(0)
                }
                else -> current.append(c)
            }
        }
        cells.add(current.toString().trim())
        return cells
    }

    private fun normalizeCells(cells: List<String>, count: Int): List<String> {
        if (cells.size == count) return cells
        val result = ArrayList<String>(count)
        for (i in 0 until count) result.add(cells.getOrElse(i) { "" })
        return result
    }

    private val FENCE_LINE = Regex("^ {0,3}(`{3,}|~{3,})(.*)$")
    private val FENCE_CLOSE = Regex("^ {0,3}(`{3,}|~{3,})[ \\t]*$")
    private val ATX_HEADING = Regex("^ {0,3}(#{1,6})(?:[ \\t]+(.*))?$")
    private val RULE = Regex("^ {0,3}(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$")
    private val QUOTE_LINE = Regex("^ {0,3}> ?(.*)$")
    private val LIST_LINE = Regex("^( {0,3})([-+*]|(\\d{1,9})[.)])([ \\t]+|$)(.*)$")
    private val INDENTED_CODE = Regex("^(?: {4}|\\t)")
    private val TABLE_DELIMITER = Regex("^ {0,3}\\|?[ \\t]*:?-+:?[ \\t]*(?:\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t]*$")
    private val SETEXT_1 = Regex("^ {0,3}=+[ \\t]*$")
    private val SETEXT_2 = Regex("^ {0,3}-+[ \\t]*$")
    private val TASK_PREFIX = Regex("^\\[([ xX])\\](?:[ \\t]+|$)")
    private val EMAIL_ADDRESS = Regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$")
    private val HTML_TAG = Regex("^/?[A-Za-z][A-Za-z0-9-]*(?:\\s[^>]*)?/?$")
    private val BARE_URL = Regex("""(?<![\w/])(?:https?://|www\.)[^\s<>"']+""", RegexOption.IGNORE_CASE)

    private const val ESCAPABLE = "\\`*_{}[]()#+-.!|~>$"
    private const val TRAILING_URL_PUNCTUATION = ".,;:!?"
}
