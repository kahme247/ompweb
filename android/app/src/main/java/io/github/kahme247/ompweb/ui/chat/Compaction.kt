package io.github.kahme247.ompweb.ui.chat

/** Compaction summary body plus the file context omp appends (web `lib/compaction-summary.ts`). */
data class ParsedCompactionSummary(
    val body: String,
    val readFiles: List<String>,
    val modifiedFiles: List<String>,
)

private val FILE_SECTION_RE = Regex(
    """<(read-files|modified-files)>\s*([\s\S]*?)\s*</\1>""",
)
private val TRAILING_FILE_SECTIONS_RE = Regex(
    """(?:\r?\n){2,}((?:[ \t]*<(?:read-files|modified-files)>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*</(?:read-files|modified-files)>[ \t]*(?:\r?\n)?)+)\s*$""",
)

fun parseCompactionSummary(summary: String): ParsedCompactionSummary {
    val readFiles = ArrayList<String>()
    val modifiedFiles = ArrayList<String>()
    val metadataMatch = TRAILING_FILE_SECTIONS_RE.find(summary)
    val metadataBlock = metadataMatch?.groups?.get(1)?.value.orEmpty()
    val body = if (metadataMatch == null) summary else summary.substring(0, metadataMatch.range.first)

    for (match in FILE_SECTION_RE.findAll(metadataBlock)) {
        val section = match.groups[1]!!.value
        val files = match.groups[2]!!.value.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }
        if (section == "read-files") readFiles += files else modifiedFiles += files
    }
    return ParsedCompactionSummary(body.trim(), readFiles, modifiedFiles)
}
