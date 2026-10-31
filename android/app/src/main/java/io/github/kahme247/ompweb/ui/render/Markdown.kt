package io.github.kahme247.ompweb.ui.render

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.hrm.latex.renderer.LatexAutoWrap
import com.hrm.latex.renderer.model.LatexConfig
import com.hrm.latex.renderer.model.LatexTheme
import com.hrm.latex.renderer.model.LatexThemeColors
import com.hrm.latex.renderer.measure.LatexMeasurerState
import com.hrm.latex.renderer.measure.rememberLatexMeasurer
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/** `owner/repo` of the GitHub repository bare `#N` references resolve against. */
data class GithubRepoRef(val owner: String, val repo: String)

/**
 * Base directory used to resolve relative file links in markdown (the session
 * cwd). Absolute paths, `~/` paths and `file:` URLs work without it.
 */
val LocalFileLinkBaseDir = staticCompositionLocalOf<String?> { null }

/**
 * Renders markdown the way `components/MarkdownBody.tsx` does: GFM blocks,
 * native math, mermaid, syntax-highlighted code, GitHub/agent/file link
 * routing and selectable text.
 *
 * [onLink] receives the classified target; the chat screen decides whether to
 * open a Custom Tab, the subagent dialog or the file viewer.
 */
@Composable
fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier,
    githubRepo: GithubRepoRef? = null,
    onLink: (LinkTarget) -> Unit,
    selectable: Boolean = true,
) {
    val baseDir = LocalFileLinkBaseDir.current
    val cache = remember(githubRepo, baseDir) { MarkdownDocumentCache() }
    val document = remember(markdown, githubRepo, baseDir) { cache.parse(markdown, githubRepo) }

    val body: @Composable () -> Unit = {
        MarkdownBlocks(
            blocks = document.blocks,
            githubRepo = githubRepo,
            baseDir = baseDir,
            onLink = onLink,
        )
    }
    Box(modifier) {
        if (selectable) {
            SelectionContainer { body() }
        } else {
            body()
        }
    }
}

/**
 * Keeps the parsed prefix of a streaming message and only re-parses the tail.
 * Appends are the common case; any rewrite (edited message, a delimiter that
 * changes meaning backwards) falls back to a full parse.
 */
internal class MarkdownDocumentCache {
    private var document: MarkdownDocument? = null
    private var repo: GithubRepoRef? = null

    /** Number of full parses; tests use it to prove appends stay incremental. */
    internal var fullParses: Int = 0
        private set

    fun parse(raw: String, githubRepo: GithubRepoRef?): MarkdownDocument {
        // CRLF would leave a `\r` on every line, and the offsets the cache
        // compares must be the ones of the document the parser produced.
        val markdown = MarkdownParser.normalizeLineEndings(raw)
        val normalized = MarkdownParser.normalizeDisplayMath(markdown)
        val previous = document
        if (
            previous != null && githubRepo == repo &&
            normalized.length >= previous.text.length && normalized.startsWith(previous.text)
        ) {
            if (normalized.length == previous.text.length) return previous
            // A single growing paragraph: extend its inline tree instead of
            // re-parsing it (the usual streaming case).
            if (previous.blocks.size == 1) {
                appendPlainSuffix(previous, normalized, githubRepo)?.let {
                    document = it
                    repo = githubRepo
                    return it
                }
            }
            // Only the tail can gain meaning from appended text, but a block
            // that starts on the next line without a blank line can dissolve
            // into the paragraph above it (`*` stops being a list item once a
            // letter follows), so the tail starts at the first block after
            // such a run.
            var keep = previous.blocks.size - 1
            while (keep > 0 && !separatedByBlankLine(previous, keep)) keep--
            if (keep > 0) {
                val tail = MarkdownParser.parseTail(normalized, previous.starts[keep], githubRepo)
                val merged = MarkdownDocument(
                    text = normalized,
                    blocks = previous.blocks.take(keep) + tail.map { it.block },
                    starts = previous.starts.take(keep) + tail.map { it.start },
                    ends = previous.ends.take(keep) + tail.map { it.end },
                )
                document = merged
                repo = githubRepo
                return merged
            }
        }
        fullParses++
        return MarkdownParser.parse(markdown, githubRepo).also {
            document = it
            repo = githubRepo
        }
    }

    /**
     * Appends a syntactically inert suffix to a single-paragraph document.
     *
     * The suffix must contain no inline construct character (so it cannot
     * start emphasised/code/link text). When the paragraph ends in plain text,
     * its trailing token extended by the suffix must still linkify to plain
     * text (so a bare URL or handle cannot form across the boundary); when it
     * ends in a closed construct, the suffix forms its own token, which must
     * linkify to exactly the appended text. A link at the end is never safe:
     * it may have been cut out of end-of-text text by linkification and can
     * keep growing (`www.exam` + `ple.com`). Returns null when a check fails;
     * the caller then re-parses the paragraph.
     */
    private fun appendPlainSuffix(
        previous: MarkdownDocument,
        normalized: String,
        githubRepo: GithubRepoRef?,
    ): MarkdownDocument? {
        val paragraph = previous.blocks.singleOrNull() as? MdBlock.Paragraph ?: return null
        if (previous.ends.singleOrNull() != previous.text.length) return null
        val suffix = normalized.substring(previous.text.length)
        if (suffix.isEmpty() || !PLAIN_SUFFIX.matches(suffix)) return null
        // Appending can turn the current last line into a block marker
        // ("1" + "." becomes a list item), which ends the paragraph here.
        if (MarkdownParser.lastLineStartsBlock(normalized)) return null
        val last = paragraph.inlines.lastOrNull() ?: return null
        val inlines = if (last is MdInline.Text) {
            val token = last.text.substring(last.text.indexOfLast { it.isWhitespace() } + 1)
            val extended = token + suffix
            val stillPlain = MarkdownParser.parseInlines(extended, githubRepo).singleOrNull() as? MdInline.Text
            if (stillPlain?.text != extended) return null
            paragraph.inlines.dropLast(1) + MdInline.Text(last.text + suffix)
        } else {
            if (!isSealedConstruct(last, previous.text)) return null
            // The paragraph ends with a closed construct, so the suffix starts a
            // new token that no earlier construct can reach into.
            val plain = MarkdownParser.parseInlines(suffix, githubRepo).singleOrNull() as? MdInline.Text
            if (plain?.text != suffix) return null
            paragraph.inlines + plain
        }
        return MarkdownDocument(
            text = normalized,
            blocks = listOf(MdBlock.Paragraph(inlines)),
            starts = previous.starts,
            ends = listOf(normalized.length),
        )
    }

    /**
     * Whether a block boundary at [index] has a blank line before it. Without
     * one the block may merge back into the paragraph above once appended text
     * changes how its first line is read.
     */
    private fun separatedByBlankLine(document: MarkdownDocument, index: Int): Boolean {
        if (index <= 0 || index >= document.starts.size) return false
        val from = document.ends[index - 1]
        val to = document.starts[index]
        if (from < 0 || from >= to || to > document.text.length) return false
        return BLANK_LINE.containsMatchIn(document.text.substring(from, to))
    }

    private companion object {
        /** Characters that would start or extend an inline construct. */
        val PLAIN_SUFFIX = Regex("""^[^`*_~$\[\]()<>!#|@:/\\&\r\n]*$""")

        /** A blank line between two block spans (line endings vary). */
        val BLANK_LINE = Regex("""\n[ \t\r]*\n""")
    }
}

/**
 * Inline nodes whose source cannot absorb appended plain text, verified by
 * probing every character the suffix allows: the node stays the same and the
 * suffix becomes one plain text node. Underscore emphasis, inline math and
 * links are excluded because their closing delimiter depends on what follows
 * (`_a_` + `b` is no longer emphasis, `$a$` + `2` no longer math) or because
 * linkification can cut them out of end-of-text content.
 */
private fun isSealedConstruct(inline: MdInline, source: String): Boolean = when (inline) {
    is MdInline.Code, is MdInline.Strike, is MdInline.Image -> true
    // Asterisk emphasis keeps closing before plain text; `_a_` + `b` does not.
    is MdInline.Strong, is MdInline.Em -> source.lastOrNull() == '*'
    else -> false
}

@Composable
private fun MarkdownBlocks(
    blocks: List<MdBlock>,
    githubRepo: GithubRepoRef?,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        blocks.forEach { block ->
            MarkdownBlock(block, githubRepo, baseDir, onLink)
        }
    }
}

@Composable
private fun MarkdownBlock(
    block: MdBlock,
    githubRepo: GithubRepoRef?,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    when (block) {
        is MdBlock.Heading -> {
            val size = when (block.level) {
                1 -> 25.sp
                2 -> 22.sp
                3 -> 19.sp
                4 -> 17.sp
                5 -> 16.sp
                else -> 15.sp
            }
            InlineText(
                inlines = block.inlines,
                style = MaterialTheme.typography.bodyLarge.copy(
                    fontSize = size,
                    fontWeight = FontWeight.Bold,
                    lineHeight = size * 1.3f,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = if (block.level == 1) 8.dp else 4.dp),
                baseDir = baseDir,
                onLink = onLink,
            )
        }

        is MdBlock.Paragraph -> InlineText(
            inlines = block.inlines,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth(),
            baseDir = baseDir,
            onLink = onLink,
        )

        is MdBlock.CodeFence -> {
            if (block.language?.lowercase() == "mermaid") {
                MermaidBlock(block.code)
            } else {
                CodeBlock(
                    code = block.code,
                    language = block.language,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        is MdBlock.MathBlock -> MathFormula(
            tex = block.tex,
            modifier = Modifier.fillMaxWidth(),
        )

        is MdBlock.Quote -> {
            val barColor = LocalOmpColors.current.border
            Box(
                Modifier
                    .fillMaxWidth()
                    .drawBehind {
                        drawRect(
                            color = barColor,
                            size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height),
                        )
                    },
            ) {
                Box(Modifier.padding(start = 13.dp)) {
                    MarkdownBlocks(block.blocks, githubRepo, baseDir, onLink)
                }
            }
        }

        is MdBlock.ListBlock -> MarkdownList(block, githubRepo, baseDir, onLink)

        is MdBlock.Table -> MarkdownTable(block, baseDir, onLink)

        MdBlock.Rule -> HorizontalDivider(color = LocalOmpColors.current.border)

        is MdBlock.Image -> RemoteImage(
            source = imageSourceFor(block.src),
            contentDescription = block.alt.ifBlank { null },
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 480.dp),
        )

        is MdBlock.Group -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            block.blocks.forEach { MarkdownBlock(it, githubRepo, baseDir, onLink) }
        }
    }
}

@Composable
private fun MarkdownList(
    block: MdBlock.ListBlock,
    githubRepo: GithubRepoRef?,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        block.items.forEachIndexed { index, item ->
            Row(Modifier.fillMaxWidth()) {
                val marker = when {
                    item.task != null -> if (item.task) "\u2611" else "\u2610"
                    block.ordered -> "${block.start + index}."
                    else -> "•"
                }
                Text(
                    text = marker,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (item.task != null) colors.accent else colors.textMuted,
                    modifier = Modifier
                        .width(if (block.ordered) 30.dp else 20.dp)
                        .padding(top = 1.dp),
                    textAlign = if (block.ordered) TextAlign.End else TextAlign.Center,
                )
                Spacer(Modifier.width(8.dp))
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    item.blocks.forEach { MarkdownBlock(it, githubRepo, baseDir, onLink) }
                }
            }
        }
    }
}

/** Plain text of an inline run, used to measure table column widths. */
internal fun plainText(inlines: List<MdInline>): String = buildString {
    fun appendAll(nodes: List<MdInline>) {
        for (node in nodes) {
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
                MdInline.HardBreak -> append(' ')
            }
        }
    }
    appendAll(inlines)
}

@Composable
private fun MarkdownTable(
    block: MdBlock.Table,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    val colors = LocalOmpColors.current
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val style = MaterialTheme.typography.bodySmall
    val widths = remember(block, style, density) {
        val columnCount = maxOf(
            block.header.size,
            block.rows.maxOfOrNull { it.size } ?: 0,
        )
        (0 until columnCount).map { column ->
            var widest = 0
            fun measureRow(cells: List<List<MdInline>>) {
                val cell = cells.getOrNull(column) ?: return
                val result = measurer.measure(
                    text = AnnotatedString(plainText(cell)),
                    style = style,
                    softWrap = false,
                    maxLines = 1,
                )
                widest = maxOf(widest, result.size.width)
            }
            measureRow(block.header)
            block.rows.forEach(::measureRow)
            with(density) {
                (widest + 20.dp.roundToPx()).toDp().coerceIn(96.dp, 260.dp)
            }
        }
    }
    Box(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(scroll),
    ) {
        Column(Modifier.widthIn(min = 120.dp)) {
            TableRow(
                cells = block.header,
                widths = widths,
                align = block.align,
                header = true,
                baseDir = baseDir,
                onLink = onLink,
            )
            block.rows.forEach { row ->
                HorizontalDivider(color = colors.border)
                TableRow(
                    cells = row,
                    widths = widths,
                    align = block.align,
                    header = false,
                    baseDir = baseDir,
                    onLink = onLink,
                )
            }
        }
    }
}

@Composable
private fun TableRow(
    cells: List<List<MdInline>>,
    widths: List<Dp>,
    align: List<MdAlign>,
    header: Boolean,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(Modifier.background(if (header) colors.backgroundSubtle else Color.Transparent)) {
        cells.forEachIndexed { index, cell ->
            val textAlign = when (align.getOrElse(index) { MdAlign.None }) {
                MdAlign.Left -> TextAlign.Start
                MdAlign.Center -> TextAlign.Center
                MdAlign.Right -> TextAlign.End
                MdAlign.None -> TextAlign.Start
            }
            InlineText(
                inlines = cell,
                style = MaterialTheme.typography.bodySmall.copy(
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                ),
                modifier = Modifier
                    .width(widths.getOrElse(index) { 96.dp })
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                baseDir = baseDir,
                onLink = onLink,
                textAlign = textAlign,
            )
        }
    }
}

/**
 * Builds the annotated text for one inline run. Math is embedded through the
 * LaTeX measurer; if measurement fails the source remains as alternate text.
 */
@Composable
private fun InlineText(
    inlines: List<MdInline>,
    style: TextStyle,
    modifier: Modifier,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
    textAlign: TextAlign? = null,
    maxLines: Int = Int.MAX_VALUE,
) {
    val colors = LocalOmpColors.current
    val currentOnLink by rememberUpdatedState(onLink)
    val measurer = rememberLatexMeasurer(
        LatexConfig(
            fontSize = if (style.fontSize.value.isFinite() && style.fontSize.value > 0f) style.fontSize else 16.sp,
            theme = latexTheme(colors),
        ),
    )
    val inlineContent = remember { LinkedHashMap<String, InlineTextContent>() }
    val annotated = remember(inlines, style, colors, measurer, baseDir) {
        inlineContent.clear()
        buildAnnotatedString {
            appendInlines(
                inlines = inlines,
                style = style,
                colors = colors,
                measurer = measurer,
                inlineContent = inlineContent,
                baseDir = baseDir,
                onLink = { target -> currentOnLink(target) },
            )
        }
    }
    Text(
        text = annotated,
        modifier = modifier,
        style = style,
        color = colors.text,
        inlineContent = inlineContent,
        textAlign = textAlign,
        maxLines = maxLines,
    )
}

@Composable
private fun latexTheme(colors: OmpColors): LatexTheme = LatexTheme.auto(
    light = LatexThemeColors(color = colors.text, backgroundColor = Color.Transparent),
    dark = LatexThemeColors(color = colors.text, backgroundColor = Color.Transparent),
)

private fun AnnotatedString.Builder.appendInlines(
    inlines: List<MdInline>,
    style: TextStyle,
    colors: OmpColors,
    measurer: LatexMeasurerState,
    inlineContent: MutableMap<String, InlineTextContent>,
    baseDir: String?,
    onLink: (LinkTarget) -> Unit,
) {
    var annotationIndex = 0

    fun appendNodes(nodes: List<MdInline>, span: SpanStyle) {
        for (node in nodes) {
            when (node) {
                is MdInline.Text -> withStyle(span) { append(node.text) }
                is MdInline.SoftBreak -> withStyle(span) { append(' ') }
                is MdInline.HardBreak -> withStyle(span) { append('\n') }
                is MdInline.Strong -> appendNodes(node.children, span + SpanStyle(fontWeight = FontWeight.Bold))
                is MdInline.Em -> appendNodes(node.children, span + SpanStyle(fontStyle = FontStyle.Italic))
                is MdInline.Strike -> appendNodes(node.children, span + SpanStyle(textDecoration = TextDecoration.LineThrough))
                is MdInline.Code -> {
                    val codeStyle = span + SpanStyle(
                        fontFamily = OmpMonoFontFamily,
                        fontSize = (style.fontSize.value * 0.92f).sp,
                        background = colors.text.copy(alpha = 0.08f),
                    )
                    val target = inlineCodeTarget(node.text, baseDir)
                    if (target != null) {
                        val link = LinkAnnotation.Clickable(
                            tag = "md-inline-${annotationIndex++}",
                            styles = linkStyles(colors),
                            linkInteractionListener = { onLink(target) },
                        )
                        withLink(link) { withStyle(codeStyle) { append(node.text) } }
                    } else {
                        withStyle(codeStyle) { append(node.text) }
                    }
                }
                is MdInline.Link -> {
                    val target = classifyLink(node.href, baseDir)
                    if (target is LinkTarget.Inert) {
                        // Unsupported scheme: plain text, never a click target.
                        appendNodes(node.children, span)
                    } else {
                        val link = LinkAnnotation.Clickable(
                            tag = "md-link-${annotationIndex++}",
                            styles = linkStyles(colors),
                            linkInteractionListener = { onLink(target) },
                        )
                        withLink(link) { appendNodes(node.children, span) }
                    }
                }
                is MdInline.Image -> {
                    val target = classifyLink(node.src, baseDir)
                    if (target is LinkTarget.Inert) {
                        withStyle(span) { append(node.alt.ifBlank { node.src }) }
                    } else {
                        val link = LinkAnnotation.Clickable(
                            tag = "md-image-${annotationIndex++}",
                            styles = linkStyles(colors),
                            linkInteractionListener = { onLink(target) },
                        )
                        withLink(link) { withStyle(span) { append(node.alt.ifBlank { node.src }) } }
                    }
                }
                is MdInline.Math -> {
                    val id = "math-${annotationIndex++}"
                    val content = measurer.inlineContent(node.tex)
                    if (content != null) {
                        inlineContent[id] = content
                        appendInlineContent(id, node.tex)
                    } else {
                        // Never drop the formula: show its source instead.
                        withStyle(span + SpanStyle(fontFamily = OmpMonoFontFamily)) { append(node.tex) }
                    }
                }
            }
        }
    }

    appendNodes(inlines, SpanStyle(color = colors.text))
}

private fun linkStyles(colors: OmpColors): TextLinkStyles = TextLinkStyles(
    style = SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
    focusedStyle = SpanStyle(color = colors.accent),
    hoveredStyle = SpanStyle(color = colors.accentHover),
    pressedStyle = SpanStyle(color = colors.accentHover),
)

/** Exact `agent://` handle or a conservative inline-code file path. */
internal fun inlineCodeTarget(text: String, baseDir: String?): LinkTarget? {
    if (isExactAgentHandle(text)) return LinkTarget.Agent(text)
    if (!isInlineCodeFilePath(text)) return null
    val file = resolveLocalFileTarget(text, baseDir) ?: return null
    return LinkTarget.File(file.path, file.line)
}

/** Display math and inline math share the native renderer; source never disappears. */
@Composable
private fun MathFormula(tex: String, modifier: Modifier) {
    val colors = LocalOmpColors.current
    val renderable = remember(tex) { isLatexRenderable(tex) }
    if (!renderable) {
        CodeBlock(code = tex, language = "latex", modifier = modifier)
        return
    }
    LatexAutoWrap(
        latex = tex,
        modifier = modifier,
        config = LatexConfig(
            fontSize = 18.sp,
            theme = latexTheme(colors),
        ),
    )
}

private fun isLatexRenderable(tex: String): Boolean = try {
    val parser = com.hrm.latex.parser.IncrementalLatexParser()
    parser.append(tex)
    parser.getCurrentDocument().children.isNotEmpty()
} catch (_: Exception) {
    false
}
