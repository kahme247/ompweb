package io.github.kahme247.ompweb.chat

/**
 * File API paths (web: `lib/file-links.ts`). A rendered link is resolved by
 * `ui.render.resolveLocalFileTarget`; this object only turns that resolved
 * path into the catch-all segments of `GET /api/files/[...path]`.
 */
object FileLinks {

    /** The catch-all segments of `/api/files/[...path]` (the client encodes them). */
    fun apiPathSegments(path: String): List<String> {
        val normalized = if (DRIVE_PATH.matches(path) || path.startsWith("\\\\")) {
            path.replace('\\', '/')
        } else {
            path
        }
        val segments = normalized.split('/').filter { it.isNotEmpty() }
        // `.`/`..` never name a file; reaching here with one means the caller
        // tried to climb out of the workspace.
        if (segments.any { it == "." || it == ".." }) return emptyList()
        // A UNC path keeps its `//server` prefix in the first segment.
        return if (normalized.startsWith("//") && segments.isNotEmpty()) {
            listOf("//${segments[0]}") + segments.drop(1)
        } else {
            segments
        }
    }

    private val DRIVE_PATH = Regex("""^[a-zA-Z]:[\\/].*""")
}
