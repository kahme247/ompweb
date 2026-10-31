package io.github.kahme247.ompweb.ui.render

import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import java.net.URI

/**
 * Port of `lib/file-links.ts`: decides which markdown links and inline-code
 * spans name a local file, and normalizes that path for the file API.
 *
 * The rules are exactly the web's, including its deliberate conservatism:
 * anything with a scheme (except `file:`), an `/api/` route or a `//` prefix
 * stays a normal link; relative paths need a base directory.
 */
private fun normalizeFilePathSlashes(filePath: String): String {
    val windows = Regex("""^[a-zA-Z]:[\\/]""").containsMatchIn(filePath) || filePath.startsWith("\\\\")
    return if (windows) filePath.replace('\\', '/') else filePath
}

private fun safeDecode(value: String): String =
    if (value.indexOf('%') < 0) {
        value
    } else {
        try {
            // URLDecoder turns `+` into a space; a path may legitimately contain one.
            java.net.URLDecoder.decode(value.replace("+", "%2B"), Charsets.UTF_8.name())
        } catch (_: IllegalArgumentException) {
            value
        }
    }

private fun normalizeLocalPath(filePath: String): String {
    val normalized = normalizeFilePathSlashes(filePath)
    val isWindowsDrive = Regex("""^[a-zA-Z]:/""").containsMatchIn(normalized)
    val isUnc = normalized.startsWith("//")
    val leadingSlash = normalized.startsWith("/") && !isWindowsDrive && !isUnc
    val parts = mutableListOf<String>()

    for (part in normalized.split('/')) {
        if (part.isEmpty() || part == ".") continue
        if (part == "..") {
            if (parts.isNotEmpty() && parts.last() != "..") {
                parts.removeAt(parts.size - 1)
            } else if (!leadingSlash && !isWindowsDrive && !isUnc) {
                parts.add(part)
            }
            continue
        }
        parts.add(part)
    }

    val joined = parts.joinToString("/")
    return when {
        isWindowsDrive -> joined
        isUnc -> "//$joined"
        leadingSlash -> "/$joined"
        else -> joined
    }
}

private fun isPathInside(candidate: String, root: String): Boolean {
    val normalizedCandidate = normalizeLocalPath(candidate).trimEnd('/')
    val normalizedRoot = normalizeLocalPath(root).trimEnd('/')
    val caseInsensitive = Regex("""^[a-zA-Z]:/""").containsMatchIn(normalizedCandidate) ||
        Regex("""^[a-zA-Z]:/""").containsMatchIn(normalizedRoot)
    val filePath = if (caseInsensitive) normalizedCandidate.lowercase() else normalizedCandidate
    val rootPath = if (caseInsensitive) normalizedRoot.lowercase() else normalizedRoot
    return filePath == rootPath || filePath.startsWith("$rootPath/")
}

private fun looksLikeRelativeFileHref(href: String): Boolean {
    if (href.startsWith("#") || href.startsWith("?")) return false
    if (href.startsWith("./") || href.startsWith("../")) return true
    if (href.contains('/')) return true
    return Regex("""(^|/)\.?[^/]+\.[^/.]+$""").containsMatchIn(href)
}

private fun fileUrlToPath(href: String): String? {
    return try {
        val url = URI(href)
        if (url.scheme != "file") return null
        val pathname = safeDecode(url.rawPath ?: "")
        val hostname = url.host
        when {
            !hostname.isNullOrEmpty() -> "//$hostname${if (pathname.startsWith("/")) pathname else "/$pathname"}"
            Regex("""^/[a-zA-Z]:/""").containsMatchIn(pathname) -> pathname.substring(1)
            else -> pathname
        }
    } catch (_: Exception) {
        null
    }
}

private val LINE_SUFFIX = Regex("""^(.*?):(\d+)(?::\d+)?$""")
private val LINE_SUFFIX_END = Regex(""":\d+(?::\d+)?$""")

/** A resolved local file path with the line/column suffix split off. */
data class LocalFileTarget(val path: String, val line: Int?)

/**
 * Resolves [href] to a local path, or null when it is not a local file link.
 * A `:line[:col]` suffix is split off into [LocalFileTarget.line].
 */
fun resolveLocalFileTarget(href: String?, baseDir: String?, relativeRoot: String? = baseDir): LocalFileTarget? {
    val raw = href?.substringBefore('#')?.substringBefore('?')?.trim() ?: return null
    if (raw.isEmpty()) return null
    val decoded = safeDecode(raw)
    val suffix = LINE_SUFFIX.matchEntire(decoded)
    val withoutLine = suffix?.groups?.get(1)?.value ?: decoded
    val resolved = resolveLocalFileHref(withoutLine, baseDir, relativeRoot) ?: return null
    return LocalFileTarget(resolved, suffix?.groups?.get(2)?.value?.toIntOrNull())
}

/**
 * Port of `resolveLocalFileHref(href, baseDir, relativeRoot)`.
 *
 * Accepts absolute POSIX paths, `~/…` (expanded server-side), `C:\`/`C:/`
 * drive paths, UNC paths and `file:` URLs; relative hrefs resolve against
 * [baseDir] and are rejected when they escape it.
 */
fun resolveLocalFileHref(href: String?, baseDir: String?, relativeRoot: String? = baseDir): String? {
    if (href.isNullOrEmpty()) return null

    val cleanHref = href.substringBefore('#').substringBefore('?').trim()
    if (cleanHref.isEmpty()) return null

    val decodedHref = safeDecode(cleanHref)
    val isBackslashUncPath = decodedHref.startsWith("\\\\")
    val normalizedHref = normalizeFilePathSlashes(decodedHref)
    val lowerHref = normalizedHref.lowercase()
    val isWindowsDrivePath = Regex("""^[a-zA-Z]:/""").containsMatchIn(normalizedHref)

    if (lowerHref.startsWith("/api/") || lowerHref.startsWith("/_next/")) return null
    if (!isBackslashUncPath && normalizedHref.startsWith("//")) return null
    if (Regex("""^[a-zA-Z][a-zA-Z0-9+.-]*:""").containsMatchIn(normalizedHref) &&
        !lowerHref.startsWith("file:") && !isWindowsDrivePath
    ) {
        return null
    }

    var candidate: String? = null
    var candidateKind: String? = null

    when {
        lowerHref.startsWith("file:") -> {
            candidate = fileUrlToPath(normalizedHref)
            candidateKind = if (candidate != null) "absolute" else null
        }
        isWindowsDrivePath -> {
            candidate = normalizedHref
            candidateKind = "absolute"
        }
        normalizedHref.startsWith("/") -> {
            candidate = normalizedHref
            candidateKind = "absolute"
        }
        normalizedHref.startsWith("~/") -> {
            // Kept as `~/…`: the file API expands it to the server user's home.
            candidate = normalizedHref
            candidateKind = "absolute"
        }
        baseDir != null && looksLikeRelativeFileHref(normalizedHref) -> {
            candidate = "${normalizeFilePathSlashes(baseDir).trimEnd('/')}/$normalizedHref"
            candidateKind = "relative"
        }
    }

    val resolvedCandidate = candidate ?: return null
    val filePath = normalizeLocalPath(resolvedCandidate).replace(LINE_SUFFIX_END, "")
    if (candidateKind == "relative" && !relativeRoot.isNullOrEmpty() && !isPathInside(filePath, relativeRoot)) {
        return null
    }
    // `~/../x` normalizes out of the home dir; it no longer names a home path.
    if (normalizedHref.startsWith("~/") && !filePath.startsWith("~/")) return null
    return filePath
}

private const val PATH_SEGMENT = """[\w.@+~\[\]-]+"""

/**
 * Inline code that is exactly one local path, with an optional `:line[:col]`.
 * Conservative on purpose — anything with spaces, quotes, parens, `?`, `#` or
 * a scheme stays code (same expression as `lib/file-links.ts`).
 */
private val INLINE_CODE_PATH_RE = Regex(
    "^(?:" +
        "/$PATH_SEGMENT(?:/$PATH_SEGMENT)+" +
        "|~/$PATH_SEGMENT(?:/$PATH_SEGMENT)*" +
        """|[A-Za-z]:[\\/]$PATH_SEGMENT(?:[\\/]$PATH_SEGMENT)*""" +
        """|(?:$PATH_SEGMENT/)+[\w.@+~\[\]-]*\.[A-Za-z][A-Za-z0-9]*""" +
        """)(?::\d+(?::\d+)?)?$""",
)

/** True when an inline code span is exactly one local file path (before cwd resolution). */
fun isInlineCodeFilePath(text: String): Boolean = INLINE_CODE_PATH_RE.matches(text)

/**
 * Classifies any markdown href into the click target the chat view handles.
 * Order matters: agent handles, then local files, then GitHub issue URLs,
 * then external URLs the system may open; everything else stays inert.
 */
fun classifyLink(href: String, baseDir: String?): LinkTarget {
    agentLinkTarget(href)?.let { return it }
    resolveLocalFileTarget(href, baseDir)?.let { return LinkTarget.File(it.path, it.line) }
    githubIssueFromUrl(href)?.let { return it }
    return if (isSafeOpenUrl(href)) LinkTarget.External(href) else LinkTarget.Inert
}
