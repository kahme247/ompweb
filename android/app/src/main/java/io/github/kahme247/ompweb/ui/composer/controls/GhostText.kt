package io.github.kahme247.ompweb.ui.composer.controls

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation

/**
 * Inline ghost text for the composer field, the Android counterpart of
 * `components/GhostMirror.tsx`: the suffix is spliced in at the caret and
 * painted in [color], and every offset past the caret shifts by its length so
 * the caret and selection stay where the user put them.
 *
 * Only pass a suffix for the draft that produced it ([WordPredictor] clears it
 * otherwise); an empty suffix, no suffix, or a caret outside the text yields
 * the identity transformation.
 */
fun ghostTextTransformation(
    suffix: String?,
    caret: Int,
    textLength: Int,
    color: Color = Color.Unspecified,
): VisualTransformation {
    if (suffix.isNullOrEmpty() || caret !in 0..textLength) return IdentityTransformation
    return GhostTransformation(suffix, caret, color)
}

private object IdentityTransformation : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText =
        TransformedText(text, OffsetMapping.Identity)
}

private class GhostTransformation(
    private val suffix: String,
    private val caret: Int,
    private val color: Color,
) : VisualTransformation {

    private val mapping = object : OffsetMapping {
        private val ghostEnd = caret + suffix.length

        override fun originalToTransformed(offset: Int): Int =
            if (offset <= caret) offset else offset + suffix.length

        override fun transformedToOriginal(offset: Int): Int = when {
            offset <= caret -> offset
            // Anywhere inside the ghost is "before it", i.e. at the caret.
            offset <= ghostEnd -> caret
            else -> offset - suffix.length
        }
    }

    override fun filter(text: AnnotatedString): TransformedText {
        if (text.isEmpty() || caret !in 0..text.length) {
            return TransformedText(text, OffsetMapping.Identity)
        }
        val ghostEnd = caret + suffix.length
        // Shift every existing range past the caret so the caller's styling survives.
        fun shift(index: Int): Int = if (index <= caret) index else index + suffix.length
        val spanStyles = text.spanStyles.mapNotNull { range ->
            val start = shift(range.start)
            val end = shift(range.end)
            if (start > end) null else AnnotatedString.Range(range.item, start, end)
        }
        val paragraphStyles = text.paragraphStyles.map { range ->
            AnnotatedString.Range(range.item, shift(range.start), shift(range.end))
        }
        val ghostStyle = if (color == Color.Unspecified) {
            emptyList()
        } else {
            listOf(AnnotatedString.Range(SpanStyle(color = color), caret, ghostEnd))
        }
        val transformed = text.text.substring(0, caret) + suffix + text.text.substring(caret)
        return TransformedText(
            AnnotatedString(transformed, spanStyles + ghostStyle, paragraphStyles),
            mapping,
        )
    }

    override fun equals(other: Any?): Boolean = other is GhostTransformation &&
        other.suffix == suffix && other.caret == caret && other.color == color

    override fun hashCode(): Int = 31 * (31 * suffix.hashCode() + caret) + color.hashCode()
}
