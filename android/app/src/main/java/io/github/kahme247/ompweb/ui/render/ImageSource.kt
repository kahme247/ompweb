package io.github.kahme247.ompweb.ui.render

/** Image data the transcript can reference: a server path/URL or inline base64. */
sealed interface ImageSource {
    data class Url(val path: String) : ImageSource
    data class Inline(val mimeType: String, val base64: String) : ImageSource
}

/**
 * Classifies an image reference. Markdown images may carry a `data:` URI,
 * which is split into an inline source instead of becoming an unloadable URL.
 */
fun imageSourceFor(src: String): ImageSource {
    if (src.startsWith("data:", ignoreCase = true)) {
        val comma = src.indexOf(',')
        if (comma > 5) {
            val header = src.substring(5, comma)
            if (header.contains(";base64", ignoreCase = true)) {
                val mimeType = header.substringBefore(';').ifBlank { "image/png" }
                val payload = src.substring(comma + 1)
                if (payload.isNotBlank()) return ImageSource.Inline(mimeType, payload)
            }
        }
    }
    return ImageSource.Url(src)
}
