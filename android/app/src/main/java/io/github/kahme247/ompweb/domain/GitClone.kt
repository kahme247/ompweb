package io.github.kahme247.ompweb.domain

private val HTTPS_URL = Regex("""^https://[^\s/@]+(?:@[^\s/]+)?/\S+$""")
private val SSH_URL = Regex("""^ssh://(?:[^\s/@]+@)?[^\s/]+/\S+$""")
// scp-like `user@host:path` / `alias:path`. A 2+ char host and no backslashes
// keep Windows paths (`C:/repo`, `C:\repo`) out; `::` transports never match.
private val SCP_URL = Regex("""^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]{2,}:(?!:|//)[^\s\\]+$""")
private val DIRECTORY_NAME = Regex("""^[A-Za-z0-9._-]+$""")

/**
 * Accepts https, ssh:// and scp-like ssh URLs only (no file://, ext::, or
 * option-looking input); returns the directory name git would clone into, or
 * null when the URL is unsupported or yields no safe name.
 *
 * Port of `cloneDirectoryName` in `lib/git-clone.ts`.
 */
fun cloneDirectoryName(url: String): String? {
    val trimmed = url.trim()
    if (!HTTPS_URL.matches(trimmed) && !SSH_URL.matches(trimmed) && !SCP_URL.matches(trimmed)) return null
    val path = trimmed.replace(Regex("[?#].*$"), "").replace(Regex("/+$"), "")
    val name = path.substring(maxOf(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1)
        .replace(Regex("""\.git$"""), "")
    return name.takeIf { DIRECTORY_NAME.matches(it) && it != "." && it != ".." }
}

const val MAX_PROGRESS_LINES = 200

/**
 * Appends git output to the progress log, applying carriage returns (git
 * rewrites its progress line with `\r`) so the log keeps only each line's
 * latest state. A trailing `\r` is kept so the next chunk overwrites it.
 */
fun appendProgress(log: String, chunk: String): String {
    val lines = (log + chunk).split("\n").map { line ->
        val segments = line.split("\r").filter { it.isNotEmpty() }
        val latest = segments.lastOrNull() ?: ""
        if (line.endsWith("\r") && latest.isNotEmpty()) "$latest\r" else latest
    }
    return lines.takeLast(MAX_PROGRESS_LINES).joinToString("\n")
}
