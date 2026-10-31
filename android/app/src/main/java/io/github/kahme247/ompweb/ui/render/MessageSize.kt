package io.github.kahme247.ompweb.ui.render

import java.util.Locale

/**
 * Above this many characters a message is rendered as a collapsed block with
 * an explicit "show" action instead of full markdown (web `SAFE_MARKDOWN_LIMIT`):
 * a multi-megabyte paste must not lock the UI thread in the markdown parser.
 */
const val MAX_MARKDOWN_CHARS = 100_000

fun isLargeMessage(text: String): Boolean = text.length > MAX_MARKDOWN_CHARS

/** Human size of a message, e.g. `123 KB` or `1.0 MB` (chars ≈ bytes here). */
fun formatMessageSize(chars: Int): String {
    val kb = chars / 1000.0
    return if (kb >= 1000) {
        String.format(Locale.US, "%.1f MB", kb / 1000)
    } else {
        String.format(Locale.US, "%.0f KB", kb)
    }
}
