package io.github.kahme247.ompweb.ui.panels.extension

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * The ANSI slice of `lib/ansi.ts` the extension panels need: SGR styles for
 * status/widget/terminal lines, escape stripping and the TUI frame cleanup
 * (`normalizeCustomPanelLines`). Only styles Compose can paint are mapped;
 * everything else is dropped exactly like the web's `stripAnsi`.
 */
private val ANSI_ESCAPE =
    Regex("\u001B(?:\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])")
private val ANSI_ESCAPE_AT_START =
    Regex("^\u001B(?:\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])")
private val ANSI_SGR = Regex("\u001B\\[([0-9;]*)m")
private val TUI_CURSOR_MARKER = Regex("\u001B_pi:c\u0007")

private val ANSI_8_COLORS = listOf(
    "#1f2937", "#dc2626", "#16a34a", "#d97706", "#2563eb", "#9333ea", "#0891b2", "#6b7280",
)
private val ANSI_BRIGHT_COLORS = listOf(
    "#9ca3af", "#ef4444", "#22c55e", "#f59e0b", "#3b82f6", "#a855f7", "#06b6d4", "#e5e7eb",
)

/** One styled run of a line; [dim] is the SGR 2 "faint" attribute. */
data class AnsiSegment(val text: String, val style: SpanStyle, val dim: Boolean = false)

fun stripAnsi(text: String): String = text.replace(TUI_CURSOR_MARKER, "").replace(ANSI_ESCAPE, "")

private fun colorOf(hex: String): Color = Color(0xFF000000L or hex.removePrefix("#").toLong(16))

private fun ansi256Color(index: Int): Color? = when {
    index in 0..7 -> colorOf(ANSI_8_COLORS[index])
    index in 8..15 -> colorOf(ANSI_BRIGHT_COLORS[index - 8])
    index in 16..231 -> {
        val n = index - 16
        val scale = { value: Int -> if (value == 0) 0 else 55 + value * 40 }
        Color(scale(n / 36), scale((n % 36) / 6), scale(n % 6))
    }

    index in 232..255 -> {
        val gray = 8 + (index - 232) * 10
        Color(gray, gray, gray)
    }

    else -> null
}

private class AnsiStyleState(var style: SpanStyle = SpanStyle(), var dim: Boolean = false)

private fun AnsiStyleState.applyCodes(codes: List<Int>) {
    var i = 0
    while (i < codes.size) {
        when (val code = codes[i]) {
            0 -> {
                style = SpanStyle()
                dim = false
            }

            1 -> style = style.copy(fontWeight = FontWeight.Bold)
            2 -> dim = true
            3 -> style = style.copy(fontStyle = FontStyle.Italic)
            4 -> style = style.copy(textDecoration = TextDecoration.Underline)
            22 -> {
                style = style.copy(fontWeight = null)
                dim = false
            }

            23 -> style = style.copy(fontStyle = null)
            24 -> style = style.copy(textDecoration = TextDecoration.None)
            39 -> style = style.copy(color = Color.Unspecified)
            49 -> style = style.copy(background = Color.Unspecified)
            in 30..37 -> style = style.copy(color = colorOf(ANSI_8_COLORS[code - 30]))
            in 90..97 -> style = style.copy(color = colorOf(ANSI_BRIGHT_COLORS[code - 90]))
            in 40..47 -> style = style.copy(background = colorOf(ANSI_8_COLORS[code - 40]))
            in 100..107 -> style = style.copy(background = colorOf(ANSI_BRIGHT_COLORS[code - 100]))
            38, 48 -> {
                if (codes.getOrNull(i + 1) == 2) {
                    val color = Color(
                        codes.getOrNull(i + 2) ?: 0,
                        codes.getOrNull(i + 3) ?: 0,
                        codes.getOrNull(i + 4) ?: 0,
                    )
                    style = if (code == 38) style.copy(color = color) else style.copy(background = color)
                    i += 4
                } else if (codes.getOrNull(i + 1) == 5) {
                    ansi256Color(codes.getOrNull(i + 2) ?: -1)?.let { color ->
                        style = if (code == 38) style.copy(color = color) else style.copy(background = color)
                    }
                    i += 2
                }
            }
        }
        i++
    }
}

/** Split one line into styled runs (web `parseAnsiLine`). */
fun ansiSegments(line: String): List<AnsiSegment> {
    val segments = mutableListOf<AnsiSegment>()
    val state = AnsiStyleState()
    var lastIndex = 0
    for (match in ANSI_SGR.findAll(line)) {
        val text = stripAnsi(line.substring(lastIndex, match.range.first))
        if (text.isNotEmpty()) segments += AnsiSegment(text, state.style, state.dim)
        val codes = match.groupValues[1]
            .takeIf { it.isNotEmpty() }
            ?.split(';')
            ?.map { it.toIntOrNull() ?: 0 }
            ?: listOf(0)
        state.applyCodes(codes)
        lastIndex = match.range.last + 1
    }
    val tail = stripAnsi(line.substring(lastIndex))
    if (tail.isNotEmpty()) segments += AnsiSegment(tail, state.style, state.dim)
    return segments
}

/** [lines] as one annotated block, joined by newlines (web `renderAnsiLine` per line). */
fun ansiText(lines: List<String>, baseColor: Color): AnnotatedString = buildAnnotatedString {
    lines.forEachIndexed { index, line ->
        ansiSegments(line).forEach { segment ->
            val style = if (segment.dim) {
                val base = segment.style.color.takeIf { it != Color.Unspecified } ?: baseColor
                segment.style.copy(color = base.copy(alpha = 0.65f))
            } else {
                segment.style
            }
            pushStyle(style)
            append(segment.text)
            pop()
        }
        if (index < lines.lastIndex) append('\n')
    }
}

@Composable
fun AnsiLines(
    lines: List<String>,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = 12.sp,
    lineHeight: TextUnit = 16.sp,
    color: Color = LocalOmpColors.current.text,
) {
    val text = remember(lines, color) { ansiText(lines, color) }
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontFamily = OmpMonoFontFamily,
        fontSize = fontSize,
        lineHeight = lineHeight,
    )
}

// ---------------------------------------------------------------------------
// Terminal frame cleanup (web `normalizeCustomPanelLines`)
// ---------------------------------------------------------------------------

private data class VisibleChar(val start: Int, val end: Int, val char: String)

private val HORIZONTAL_FRAME_LINE = Regex("^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$")

private fun visibleChars(text: String): List<VisibleChar> {
    val positions = mutableListOf<VisibleChar>()
    var i = 0
    while (i < text.length) {
        if (text[i] == '\u001B') {
            val match = ANSI_ESCAPE_AT_START.find(text.substring(i))
            if (match != null) {
                i += match.value.length
                continue
            }
        }
        val char = String(Character.toChars(text.codePointAt(i)))
        positions += VisibleChar(i, i + char.length, char)
        i += char.length
    }
    return positions
}

private fun removeVisibleCharAt(text: String, index: Int): String {
    val position = visibleChars(text).getOrNull(index) ?: return text
    return text.substring(0, position.start) + text.substring(position.end)
}

private fun lastNonSpaceVisibleIndex(text: String): Int {
    val positions = visibleChars(text)
    for (i in positions.indices.reversed()) {
        if (positions[i].char.isNotBlank()) return i
    }
    return -1
}

private fun trimEndVisibleSpaces(text: String): String {
    var next = text
    while (true) {
        val positions = visibleChars(next)
        val last = positions.lastOrNull() ?: return next
        if (last.char.isNotBlank()) return next
        next = next.substring(0, last.start) + next.substring(last.end)
    }
}

/**
 * Strip the TUI box an extension draws around its custom panel so only the
 * content lines remain. Falls back to the raw lines when nothing is left.
 */
fun normalizeCustomPanelLines(lines: List<String>): List<String> {
    val normalized = mutableListOf<String>()
    for (raw in lines) {
        val withoutCursor = raw.replace(TUI_CURSOR_MARKER, "")
        if (HORIZONTAL_FRAME_LINE.matches(stripAnsi(withoutCursor).trimEnd())) continue
        var line = withoutCursor
        val first = visibleChars(line).firstOrNull()?.char
        if (first == "│" || first == "┃") {
            line = removeVisibleCharAt(line, 0)
            if (visibleChars(line).firstOrNull()?.char == " ") line = removeVisibleCharAt(line, 0)
        }
        val rightIndex = lastNonSpaceVisibleIndex(line)
        val right = visibleChars(line).getOrNull(rightIndex)?.char
        if (right == "│" || right == "┃") line = removeVisibleCharAt(line, rightIndex)
        normalized += trimEndVisibleSpaces(line)
    }
    while (normalized.isNotEmpty() && stripAnsi(normalized.first()).isBlank()) normalized.removeAt(0)
    while (normalized.isNotEmpty() && stripAnsi(normalized.last()).isBlank()) normalized.removeAt(normalized.lastIndex)
    return normalized.ifEmpty { lines }
}
