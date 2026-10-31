package io.github.kahme247.ompweb.ui.render

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * Fenced code block with language label, copy button and syntax colours.
 * Long lines scroll horizontally unless [wrap] is set; [maxCollapsedLines]
 * folds the body behind a "Show all" control like the web's tool-output view.
 *
 * [revealLine] is the 1-based line a viewer was opened at (a Markdown link, a
 * host tool): its y position in the window is reported once through
 * [onRevealLine], and the caller scrolls its own container to it.
 */
@Composable
fun CodeBlock(
    code: String,
    language: String?,
    modifier: Modifier = Modifier,
    wrap: Boolean = false,
    maxCollapsedLines: Int? = null,
    revealLine: Int? = null,
    onRevealLine: ((Float) -> Unit)? = null,
) {
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    var copied by remember(code) { mutableStateOf(false) }
    var expanded by remember(code) { mutableStateOf(false) }

    val totalLines = remember(code) { code.count { it == '\n' } + 1 }
    val collapsible = maxCollapsedLines != null && totalLines > maxCollapsedLines && !expanded
    val visibleCode = remember(code, collapsible, maxCollapsedLines) {
        maxCollapsedLines?.takeIf { collapsible }?.let { firstLines(code, it) } ?: code
    }

    val annotated = remember(visibleCode, language, colors) {
        highlightCode(visibleCode, language, colors)
    }

    // Line reveal: the layout knows where the line sits inside the Text, the
    // window position of the Text turns that into an absolute y for the caller.
    var layout by remember(visibleCode, wrap) { mutableStateOf<TextLayoutResult?>(null) }
    var textTop by remember(visibleCode) { mutableStateOf<Float?>(null) }
    val revealOffset = remember(visibleCode, revealLine) {
        revealLine?.takeIf { !collapsible }?.let { line -> lineStartOffset(visibleCode, line) }
    }
    LaunchedEffect(revealOffset, layout, textTop, onRevealLine) {
        val result = layout ?: return@LaunchedEffect
        val top = textTop ?: return@LaunchedEffect
        val offset = revealOffset ?: return@LaunchedEffect
        onRevealLine?.invoke(top + result.getLineTop(result.getLineForOffset(offset)))
    }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, colors.border, RoundedCornerShape(8.dp))
            .background(colors.panel),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = language?.takeIf { it.isNotBlank() } ?: "text",
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (copied) "Copied" else "Copy",
                color = if (copied) colors.statusSuccess else colors.textMuted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clickable {
                        copyTextToClipboard(context, "code", code)
                        copied = true
                        Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .background(colors.background),
        ) {
            Column {
                val bodyModifier = if (wrap) {
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 8.dp)
                } else {
                    Modifier
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 10.dp, vertical = 8.dp)
                }
                Text(
                    text = annotated,
                    modifier = bodyModifier.onGloballyPositioned { textTop = it.positionInRoot().y },
                    fontFamily = OmpMonoFontFamily,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    softWrap = wrap,
                    color = colors.text,
                    onTextLayout = { layout = it },
                )
                if (maxCollapsedLines != null && totalLines > maxCollapsedLines) {
                    Text(
                        text = if (expanded) "Show less" else "Show all ($totalLines lines)",
                        color = colors.accent,
                        fontSize = 11.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { expanded = !expanded }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}

/**
 * Character offset where the 1-based [line] starts in [code]; null when the
 * line does not exist. The line after a trailing newline is a real (empty)
 * line, exactly as the renderer counts it.
 */
internal fun lineStartOffset(code: String, line: Int): Int? {
    if (line < 1) return null
    var index = 0
    var current = 1
    while (current < line) {
        val next = code.indexOf('\n', index)
        if (next < 0) return null
        index = next + 1
        current++
    }
    return index
}

/** First [count] lines without the trailing newline. */
internal fun firstLines(code: String, count: Int): String {
    if (count <= 0) return ""
    var seen = 0
    var index = 0
    while (index < code.length) {
        if (code[index] == '\n') {
            seen++
            if (seen >= count) return code.substring(0, index)
        }
        index++
    }
    return code
}

/**
 * Maps the tokenizer output onto an [AnnotatedString]. Base colour is applied
 * per span so the caller's `Text(color = …)` is never overridden unexpectedly.
 */
internal fun highlightCode(code: String, language: String?, colors: OmpColors): AnnotatedString {
    val spans = SyntaxHighlighter.highlight(code, language)
    return buildAnnotatedString {
        var cursor = 0
        for (span in spans) {
            if (span.start > cursor) append(code.substring(cursor, span.start))
            val color = when (span.kind) {
                SyntaxHighlighter.Kind.Comment -> colors.textDim
                SyntaxHighlighter.Kind.Keyword -> colors.accent
                SyntaxHighlighter.Kind.Type -> colors.statusRenamed
                SyntaxHighlighter.Kind.String -> colors.statusSuccess
                SyntaxHighlighter.Kind.Number -> colors.statusWarning
                SyntaxHighlighter.Kind.Literal -> colors.statusModified
            }
            withStyle(
                SpanStyle(
                    color = color,
                    fontWeight = if (span.kind == SyntaxHighlighter.Kind.Keyword) FontWeight.Medium else null,
                ),
            ) {
                append(code.substring(span.start, span.end.coerceAtMost(code.length)))
            }
            cursor = span.end.coerceAtMost(code.length)
        }
        if (cursor < code.length) append(code.substring(cursor))
    }
}
