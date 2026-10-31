package io.github.kahme247.ompweb.domain

/**
 * The explorer's tree, its git decorations and the path/mention helpers the
 * file panel shares with the composer.
 *
 * Port of the client halves of `components/FileExplorer.tsx` and
 * `lib/file-paths.ts`/`lib/file-fuzzy.ts`: lazy directory listings keyed by
 * absolute path, the flattened visible rows, the directory "contains changes"
 * dots, the ranked file-index rows, and the `@path` text the `@` button
 * inserts.
 */

/** One entry of `GET /api/files/{dir}?type=list` (dirs first, alphabetical). */
data class FileEntry(val name: String, val isDir: Boolean, val size: Long = 0)

/** One visible tree row; `empty` marks an expanded directory without entries. */
data class FileTreeRow(
    val name: String,
    val path: String,
    val isDir: Boolean,
    val size: Long,
    val depth: Int,
    val expanded: Boolean,
    val loading: Boolean,
    val empty: Boolean = false,
)

/** One ranked `/api/file-index` result, flattened for the search list. */
data class FileSearchRow(val path: String, val name: String, val directory: String)

private val WINDOWS_DRIVE = Regex("""^[a-zA-Z]:[\\/]""")
private val WINDOWS_DRIVE_SLASH = Regex("""^[a-zA-Z]:/""")

/** Slashes are always `/` internally; Windows and UNC paths keep their prefix. */
fun normalizeFilePath(filePath: String): String =
    if (WINDOWS_DRIVE.containsMatchIn(filePath) || filePath.startsWith("\\\\")) {
        filePath.replace('\\', '/')
    } else {
        filePath
    }

/** True for drive, UNC, POSIX-absolute and `~/` paths (the file API expands the last). */
fun isAbsoluteFilePath(filePath: String): Boolean {
    val path = normalizeFilePath(filePath)
    return path.startsWith("/") || WINDOWS_DRIVE_SLASH.containsMatchIn(path) || path.startsWith("~/")
}

/**
 * Paths are compared the way the filesystem does: NTFS is case-insensitive, so
 * a session's cwd and the server's realpath'd file may differ in case.
 */
fun comparableFilePath(filePath: String): String {
    val normalized = normalizeFilePath(filePath).trimEnd('/')
    return if (WINDOWS_DRIVE_SLASH.containsMatchIn(normalized) || normalized.startsWith("//")) {
        normalized.lowercase()
    } else {
        normalized
    }
}

fun fileName(filePath: String): String =
    normalizeFilePath(filePath).trimEnd('/').substringAfterLast('/')

/** `getFileDirectory` (web): the parent, the drive/UNC root staying intact. */
fun fileDirectory(filePath: String): String {
    val normalized = normalizeFilePath(filePath).trimEnd('/')
    val cut = normalized.lastIndexOf('/')
    if (cut < 0) return ""
    if (cut == 0) return "/"
    val parent = normalized.substring(0, cut)
    // `C:` alone is not a directory; `C:/` is.
    return if (WINDOWS_DRIVE.matches(parent + "/")) "$parent/" else parent
}

/**
 * `joinFilePath` (web): exactly one separator, whatever the parent ended with.
 * The root keeps its slash (`joinFilePath("/", "a") == "/a"`), and a bare
 * `C:` becomes the drive root, so every path built here stays absolute.
 */
fun joinFilePath(parent: String, child: String): String {
    val base = normalizeFilePath(parent).trimEnd('/')
    val name = normalizeFilePath(child).trimStart('/')
    return "$base/$name"
}

/** `getRelativeFilePath` (web): the path below [cwd], the absolute path otherwise. */
fun relativeFilePath(filePath: String, cwd: String?): String {
    if (cwd.isNullOrBlank()) return filePath
    val normalizedFile = normalizeFilePath(filePath)
    val normalizedCwd = normalizeFilePath(cwd).trimEnd('/')
    val fileKey = comparableFilePath(normalizedFile)
    val cwdKey = comparableFilePath(normalizedCwd)
    if (fileKey == cwdKey) return ""
    if (!fileKey.startsWith("$cwdKey/")) return filePath
    // Slice by the *original* casing: only the comparison is case-insensitive.
    val normalizedFileTrimmed = normalizedFile.trimEnd('/')
    return normalizedFileTrimmed.substring(normalizedCwd.length + 1)
}

/** True when [filePath] is [directory] itself or lies below it. */
fun isInsideDirectory(filePath: String, directory: String): Boolean {
    val file = comparableFilePath(filePath)
    val dir = comparableFilePath(directory)
    return file == dir || file.startsWith("$dir/")
}

/**
 * Merges one directory listing into the tree. The new listing replaces the
 * old one, so a refresh drops files that were renamed or deleted; every other
 * directory keeps its entries (a collapse must not throw away the cache).
 */
fun mergeDirectoryListing(
    childrenByPath: Map<String, List<FileEntry>>,
    directory: String,
    entries: List<FileEntry>,
): Map<String, List<FileEntry>> {
    val sorted = entries.sortedWith(
        compareByDescending<FileEntry> { it.isDir }.thenBy { it.name.lowercase() },
    )
    return childrenByPath + (comparableFilePath(directory) to sorted)
}

/** Args: the tree's root, its loaded listings keyed by comparable path, and the expanded set. */
fun flattenFileTree(
    root: String,
    childrenByPath: Map<String, List<FileEntry>>,
    expanded: Set<String>,
    loading: Set<String> = emptySet(),
): List<FileTreeRow> {
    val rows = mutableListOf<FileTreeRow>()
    val expandedKeys = expanded.mapTo(HashSet()) { comparableFilePath(it) }
    val loadingKeys = loading.mapTo(HashSet()) { comparableFilePath(it) }

    fun walk(directory: String, depth: Int) {
        val key = comparableFilePath(directory)
        val entries = childrenByPath[key] ?: return
        for (entry in entries) {
            val path = joinFilePath(directory, entry.name)
            val pathKey = comparableFilePath(path)
            val open = entry.isDir && pathKey in expandedKeys
            rows += FileTreeRow(
                name = entry.name,
                path = path,
                isDir = entry.isDir,
                size = entry.size,
                depth = depth,
                expanded = open,
                loading = entry.isDir && pathKey in loadingKeys,
            )
            if (!open) continue
            val children = childrenByPath[pathKey]
            if (children == null) continue
            if (children.isEmpty()) {
                rows += FileTreeRow(
                    name = "",
                    path = path,
                    isDir = true,
                    size = 0,
                    depth = depth + 1,
                    expanded = false,
                    loading = false,
                    empty = true,
                )
            } else {
                walk(path, depth + 1)
            }
        }
    }

    walk(root, 0)
    return rows
}

/** Every ancestor directory of [target] below [cwd], outermost first (for reveal). */
fun revealAncestors(cwd: String, target: String): List<String> {
    if (!isInsideDirectory(target, cwd)) return emptyList()
    val relative = relativeFilePath(target, cwd).trimEnd('/')
    if (relative.isEmpty()) return emptyList()
    val segments = relative.split('/').filter { it.isNotEmpty() }
    if (segments.size <= 1) return emptyList()
    val ancestors = mutableListOf<String>()
    var path = cwd
    // The target itself is not expanded: it is a row to scroll to, and
    // expanding a file is meaningless.
    for (segment in segments.dropLast(1)) {
        path = joinFilePath(path, segment)
        ancestors += path
    }
    return ancestors
}

/**
 * The directory dots of the explorer: every ancestor of a changed file up to
 * and including [cwd]. Directories outside the workspace are ignored, so a
 * session opened in a subdirectory does not decorate its parents.
 */
fun changedDirectoryPaths(cwd: String, changedPaths: List<String>): Set<String> {
    val directories = mutableSetOf<String>()
    val root = comparableFilePath(cwd)
    for (changed in changedPaths) {
        var directory = fileDirectory(normalizeFilePath(changed))
        // A changed file directly in cwd still marks cwd.
        while (isInsideDirectory(directory, cwd)) {
            val key = comparableFilePath(directory)
            directories += key
            if (key == root) break
            val parent = fileDirectory(directory)
            if (parent == directory || parent.isEmpty()) break
            directory = parent
        }
    }
    return directories
}

/** Ranked index rows stay in server order; duplicates and empty paths are dropped. */
fun fileSearchRows(paths: List<String>): List<FileSearchRow> {
    val seen = HashSet<String>()
    return paths.mapNotNull { raw ->
        val path = normalizeFilePath(raw)
        if (path.isEmpty() || !seen.add(path)) return@mapNotNull null
        val cut = path.lastIndexOf('/')
        FileSearchRow(
            path = path,
            name = if (cut < 0) path else path.substring(cut + 1),
            directory = if (cut < 0) "" else path.substring(0, cut),
        )
    }
}

/** `buildAtMentionText` (web): a directory gets a trailing slash, spaces are quoted. */
fun atMentionText(relativePath: String, isDir: Boolean): String {
    val path = if (isDir) "$relativePath/" else relativePath
    return if (path.contains(' ')) "@\"$path\" " else "@$path "
}

/** `buildFileAtMentionsText` (web): one mention per uploaded file, in server order. */
fun atMentionsText(relativePaths: List<String>): String =
    relativePaths.joinToString("") { atMentionText(it, isDir = false) }

/** `buildFileLineMentionText` (web): a closed file mention for one line or an inclusive range. */
fun fileLineMentionText(relativePath: String, startLine: Int, endLine: Int): String {
    val first = maxOf(1, minOf(startLine, endLine))
    val last = maxOf(1, maxOf(startLine, endLine))
    val mention = if (relativePath.contains(' ')) "@\"$relativePath\"" else "@$relativePath"
    val suffix = if (first == last) ":$first" else ":$first-$last"
    return "$mention$suffix "
}

/**
 * The mention the viewer inserts for a file: `@path` normally, `@path:line`
 * when the tab was opened at a line (web `onMentionLines`), so the agent gets
 * the same closed reference the Markdown line links produce.
 */
fun fileMentionText(relativePath: String, line: Int?): String =
    if (line != null) fileLineMentionText(relativePath, line, line) else atMentionText(relativePath, isDir = false)
