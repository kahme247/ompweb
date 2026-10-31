package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Git changes as `GET /api/git/status` and `GET /api/git/diff` deliver them
 * (port of `lib/git-types.ts` and the client halves of
 * `components/GitChangesPanel.tsx` / `components/FileExplorer.tsx`).
 *
 * The server runs git; the app never does. This file therefore owns exactly
 * what the client decides: how an untrusted response becomes status rows,
 * which rows the filter keeps, which rows `.gitattributes` moved into the
 * collapsed group, and which row is previewed first.
 */

/** `GitFileStatusKind` in `lib/git-types.ts`; [code] is the one-letter badge. */
enum class GitFileStatusKind(val wireName: String, val code: String) {
    MODIFIED("modified", "M"),
    ADDED("added", "A"),
    DELETED("deleted", "D"),
    RENAMED("renamed", "R"),
    UNTRACKED("untracked", "U"),
    CONFLICT("conflict", "C");

    companion object {
        fun fromWire(value: String?): GitFileStatusKind? =
            entries.firstOrNull { it.wireName == value }

        /** Fallback for a server that only sent the porcelain code. */
        fun fromCode(value: String?): GitFileStatusKind? =
            entries.firstOrNull { it.code == value }
    }
}

/** Why `.gitattributes` moved a changed file out of the main review list. */
enum class GitCollapseReason(val wireName: String) {
    GENERATED("generated"),
    VENDORED("vendored"),
    DOCUMENTATION("documentation"),
    NO_DIFF("no-diff");

    companion object {
        fun fromWire(value: String?): GitCollapseReason? =
            entries.firstOrNull { it.wireName == value }
    }
}

/** One changed file, as `GitFileStatus` in `lib/git-types.ts`. */
data class GitFileStatus(
    /** Absolute path on the server, exactly as the routes report it. */
    val filePath: String,
    val status: GitFileStatusKind,
    /** Badge character; the server's `code`, validated to the six known ones. */
    val code: String,
    val collapseReason: GitCollapseReason? = null,
)

/** `GitStatusResponse`: the whole answer of `GET /api/git/status?cwd=`. */
data class GitStatusResponse(
    val isGitRepository: Boolean,
    val repositoryRoot: String?,
    val files: List<GitFileStatus>,
)

/**
 * `GitFileDiffResponse`: `{supported, status?, patch?}`. `supported: false`
 * covers every case where git has no textual diff (deleted, binary,
 * `.gitattributes -diff`, unchanged, too large) — the viewer then shows the
 * "no diff" state instead of an empty pane.
 */
data class GitFileDiff(
    val supported: Boolean,
    val patch: String? = null,
)

/** The two groups the changes list renders (web `[primaryFiles, attributeFiles]`). */
data class GitChangeGroups(
    val primary: List<GitFileStatus> = emptyList(),
    val collapsed: List<GitFileStatus> = emptyList(),
)

/**
 * Parses `GET /api/git/status` leniently: `null` means the body is not the
 * documented shape (the caller reports [`io.github.kahme247.ompweb.net.ApiError.Http`]),
 * while a single row without a recognizable status is dropped — there is no
 * label, colour or diff mode to give it.
 */
fun parseGitStatusResponse(body: String): GitStatusResponse? {
    val root = runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
    val filesElement = root["files"] as? JsonArray ?: return null
    val files = filesElement.mapNotNull(::parseGitFileStatus)
    return GitStatusResponse(
        isGitRepository = root["isGitRepository"]?.jsonPrimitive?.booleanOrNull ?: false,
        repositoryRoot = root["repositoryRoot"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() },
        files = files,
    )
}

private fun parseGitFileStatus(element: JsonElement): GitFileStatus? {
    val entry = element as? JsonObject ?: return null
    val filePath = entry["filePath"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return null
    val rawCode = entry["code"]?.jsonPrimitive?.contentOrNull
    val kind = GitFileStatusKind.fromWire(entry["status"]?.jsonPrimitive?.contentOrNull)
        ?: GitFileStatusKind.fromCode(rawCode)
        ?: return null
    val code = rawCode?.takeIf { candidate -> GitFileStatusKind.fromCode(candidate) != null } ?: kind.code
    return GitFileStatus(
        filePath = filePath,
        status = kind,
        code = code,
        collapseReason = GitCollapseReason.fromWire(entry["collapseReason"]?.jsonPrimitive?.contentOrNull),
    )
}

/** Parses `GET /api/git/diff`; `null` when the body is not the documented shape. */
fun parseGitFileDiff(body: String): GitFileDiff? {
    val root = runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
    val supported = root["supported"]?.jsonPrimitive?.booleanOrNull ?: return null
    return GitFileDiff(
        supported = supported,
        patch = root["patch"]?.jsonPrimitive?.contentOrNull,
    )
}

// --- Client-side list rules (web `GitChangesPanel`) -------------------------

/**
 * The row the pane previews: the previous selection while it still exists,
 * otherwise the first reviewable change (not one `.gitattributes` collapsed),
 * exactly like the web.
 */
fun pickGitSelection(previous: String?, files: List<GitFileStatus>): String? {
    if (previous != null && files.any { it.filePath == previous }) return previous
    return (files.firstOrNull { it.collapseReason == null } ?: files.firstOrNull())?.filePath
}

/**
 * Splits the changed files the way the web does: the filter matches the path
 * shown in the row (relative to [cwd], `/`-separated, case-insensitive), and
 * `.gitattributes` rows go to the collapsed group.
 */
fun gitChangeGroups(files: List<GitFileStatus>, filter: String, cwd: String?): GitChangeGroups {
    val needle = filter.trim().lowercase()
    val matching = if (needle.isEmpty()) {
        files
    } else {
        files.filter { relativeFilePath(it.filePath, cwd).lowercase().contains(needle) }
    }
    return GitChangeGroups(
        primary = matching.filter { it.collapseReason == null },
        collapsed = matching.filter { it.collapseReason != null },
    )
}
