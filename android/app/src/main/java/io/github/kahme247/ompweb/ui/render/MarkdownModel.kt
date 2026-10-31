package io.github.kahme247.ompweb.ui.render

/**
 * Parsed markdown used by [MarkdownText]. The model is deliberately small: it
 * covers the GFM subset the web renders (`remark-gfm` + sanitized raw HTML)
 * and keeps math as source until the renderer draws it.
 */
sealed interface MdInline {
    data class Text(val text: String) : MdInline

    /** Code span; the renderer links exact agent handles and file paths. */
    data class Code(val text: String) : MdInline

    data class Strong(val children: List<MdInline>) : MdInline

    data class Em(val children: List<MdInline>) : MdInline

    data class Strike(val children: List<MdInline>) : MdInline

    /** An explicit markdown link; its [href] is classified when rendered. */
    data class Link(val children: List<MdInline>, val href: String) : MdInline

    /** Alt text and target of an image; block-level images are [MdBlock.Image]. */
    data class Image(val alt: String, val src: String) : MdInline

    /** Inline (`$…$`) or inline-occurring display (`$$…$$`) math. */
    data class Math(val tex: String, val display: Boolean) : MdInline

    data object SoftBreak : MdInline

    data object HardBreak : MdInline
}

enum class MdAlign { None, Left, Center, Right }

sealed interface MdBlock {
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock

    data class Paragraph(val inlines: List<MdInline>) : MdBlock

    data class CodeFence(val language: String?, val code: String) : MdBlock

    data class MathBlock(val tex: String) : MdBlock

    data class Quote(val blocks: List<MdBlock>) : MdBlock

    data class ListBlock(
        val ordered: Boolean,
        val start: Int,
        val items: List<MdListItem>,
    ) : MdBlock

    data class Table(
        val header: List<List<MdInline>>,
        val align: List<MdAlign>,
        val rows: List<List<List<MdInline>>>,
    ) : MdBlock

    data object Rule : MdBlock

    data class Image(val alt: String, val src: String) : MdBlock

    /** Consecutive blocks parsed from one source run (text + images in order). */
    data class Group(val blocks: List<MdBlock>) : MdBlock
}

data class MdListItem(
    /** `null` = not a task item; otherwise the checkbox state. */
    val task: Boolean?,
    val blocks: List<MdBlock>,
)

/** One top-level block plus the source range it was parsed from. */
internal data class BlockSpan(val block: MdBlock, val start: Int, val end: Int)

/**
 * A parsed transcript message. [starts]/[ends] are character offsets of the
 * top-level blocks and let [MarkdownDocumentCache] re-parse only the tail
 * while a message streams.
 */
class MarkdownDocument(
    val text: String,
    val blocks: List<MdBlock>,
    internal val starts: List<Int>,
    internal val ends: List<Int>,
)
