package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The composer's slash command palette and its `@` file autocomplete, ported
 * from `lib/web-slash-commands.ts`, `components/ChatInput-slash-commands.ts`,
 * `lib/slash-autocomplete.ts` and `lib/file-fuzzy.ts`.
 *
 * Web-native prompt commands exist because omp's own `/goal`, `/plan`, … are
 * TUI-only: over the RPC prompt path they would reach the model as literal
 * slash text. The client expands them into a real instruction instead.
 */

/** One entry of the composer palette; [description] may be empty. */
data class SlashCommandItem(
    val name: String,
    val description: String = "",
    val argumentHint: String? = null,
    val source: SlashCommandSource = SlashCommandSource.BUILTIN,
)

enum class SlashCommandSource(val wireName: String) {
    BUILTIN("builtin"),
    EXTENSION("extension"),
    PROMPT("prompt"),
    SKILL("skill"),
    OMP_BUILTIN("ompBuiltin"),
}

/** Client-side slash commands: the request/response router traces this set. */
val BUILTIN_SLASH_COMMAND_NAMES: List<String> = listOf(
    "goal", "plan", "review", "fix", "test", "explain", "simplify", "commit", "advisor", "loop",
    "btw", "compact", "reload", "name", "session", "copy",
)

fun isClientBuiltinCommand(name: String): Boolean = name in BUILTIN_SLASH_COMMAND_NAMES

/** A web prompt command: [name], whether it needs arguments and its expansion. */
data class WebSlashCommand(
    val name: String,
    val requiresArgs: Boolean,
    /** Resource-key suffix for the bracketed usage hint (e.g. "Goal"). */
    val argumentHintKey: String,
    val buildPrompt: (String) -> String,
)

private const val LOOP_MAX_ATTEMPTS = 10
private const val LOOP_DEFAULT_ATTEMPTS = 3

private fun loopPrompt(args: String): String {
    val match = Regex("^(\\d+)\\s+([\\s\\S]+)$").find(args)
    val attempts = if (match != null) {
        // Digits can exceed Int (and a plain toIntOrNull would silently fall
        // back to the default): compare as a BigInteger, capped at the max.
        val digits = match.groupValues[1].trimStart('0')
        if (digits.isEmpty()) {
            LOOP_DEFAULT_ATTEMPTS
        } else {
            val parsed = digits.toBigIntegerOrNull()?.min(java.math.BigInteger.TEN)?.toInt()
            (parsed ?: LOOP_MAX_ATTEMPTS).coerceIn(1, LOOP_MAX_ATTEMPTS)
        }
    } else {
        LOOP_DEFAULT_ATTEMPTS
    }
    val task = if (match != null) match.groupValues[2].trim() else args
    return "Attempt the following task, verifying the result concretely after each attempt " +
        "(run the relevant checks or tests). If it is not fully done, try again from where it stands, " +
        "building on what you learned — up to $attempts attempts in total. Stop early once it is done. " +
        "Do not ask for confirmation between attempts.\n\nTask:\n\n$task"
}

val WEB_SLASH_COMMANDS: List<WebSlashCommand> = listOf(
    WebSlashCommand("goal", requiresArgs = true, argumentHintKey = "composer_cmd_goal_arg") { args ->
        "Work toward this goal for the rest of the session:\n\n$args\n\n" +
            "Treat it as the objective to prioritize when deciding what to do next."
    },
    WebSlashCommand("plan", requiresArgs = true, argumentHintKey = "composer_cmd_plan_arg") { args ->
        "Create a plan for this task before doing anything else:\n\n$args\n\n" +
            "Think it through step by step, list concrete steps, and state what you will verify when done."
    },
    WebSlashCommand("review", requiresArgs = false, argumentHintKey = "composer_cmd_review_arg") { args ->
        if (args.isNotEmpty()) {
            "Review $args for bugs, security issues, and opportunities to simplify. " +
                "Summarize what you find, then fix anything clearly wrong."
        } else {
            "Review the current project state and recent changes for bugs, security issues, and " +
                "opportunities to simplify. Summarize what you find, then fix anything clearly wrong."
        }
    },
    WebSlashCommand("fix", requiresArgs = true, argumentHintKey = "composer_cmd_fix_arg") { args ->
        "Fix this issue:\n\n$args\n\nReproduce the problem, apply the smallest correct fix, " +
            "and verify it works before finishing."
    },
    WebSlashCommand("test", requiresArgs = true, argumentHintKey = "composer_cmd_test_arg") { args ->
        "Write tests for $args. Follow the project's test conventions, cover the important behavior " +
            "and edge cases, and run the tests to confirm they pass."
    },
    WebSlashCommand("explain", requiresArgs = true, argumentHintKey = "composer_cmd_explain_arg") { args ->
        "Explain $args concisely: what it does, how it works, and the key details worth knowing."
    },
    WebSlashCommand("simplify", requiresArgs = true, argumentHintKey = "composer_cmd_simplify_arg") { args ->
        "Simplify $args. Remove unnecessary complexity while preserving behavior, keep the change " +
            "focused, and verify nothing breaks."
    },
    WebSlashCommand("commit", requiresArgs = false, argumentHintKey = "composer_cmd_commit_arg") { args ->
        if (args.isNotEmpty()) {
            "Stage the relevant files and commit the current changes with this message: " +
                "${JsonPrimitive(args)}. Run the project's checks first so the commit is green."
        } else {
            "Stage the relevant files and commit the current changes with a clear conventional " +
                "commit message. Run the project's checks first so the commit is green."
        }
    },
    WebSlashCommand("advisor", requiresArgs = false, argumentHintKey = "composer_cmd_advisor_arg") { args ->
        if (args.isNotEmpty()) {
            "Act as an independent advisor reviewing this work: $args. Assess the approach, point out " +
                "risks, gaps, and better alternatives, and give concrete recommendations without changing any code."
        } else {
            "Act as an independent advisor reviewing the current work. Assess the recent changes and " +
                "overall direction, point out risks, gaps, and better alternatives, and give concrete " +
                "recommendations without changing any code."
        }
    },
    WebSlashCommand("loop", requiresArgs = true, argumentHintKey = "composer_cmd_loop_arg", buildPrompt = ::loopPrompt),
)

private val WEB_SLASH_COMMAND_LOOKUP: Map<String, WebSlashCommand> =
    WEB_SLASH_COMMANDS.associateBy { it.name }

fun getWebSlashCommand(name: String): WebSlashCommand? = WEB_SLASH_COMMAND_LOOKUP[name]

sealed interface WebSlashExpansion {
    data class Expand(val prompt: String) : WebSlashExpansion

    data class UsageError(val command: String, val argumentHint: String) : WebSlashExpansion

    data object NotWeb : WebSlashExpansion
}

/**
 * Resolve a full command line (`/goal ship the export`) into the expanded
 * prompt, a usage error for a required-arg command without args, or
 * [WebSlashExpansion.NotWeb] for commands the client does not own.
 */
fun expandWebSlashCommand(text: String): WebSlashExpansion {
    if (!text.startsWith("/")) return WebSlashExpansion.NotWeb
    val match = Regex("^/(\\S+)(?:\\s+([\\s\\S]*))?$").find(text) ?: return WebSlashExpansion.NotWeb
    val def = getWebSlashCommand(match.groupValues[1]) ?: return WebSlashExpansion.NotWeb
    val args = match.groupValues[2].trim()
    if (def.requiresArgs && args.isEmpty()) {
        return WebSlashExpansion.UsageError("/${def.name}", def.argumentHintKey)
    }
    return WebSlashExpansion.Expand(def.buildPrompt(args))
}

/** Rank used by both the palette and the mid-prompt skill lookup. */
fun slashMatchRank(command: SlashCommandItem, query: String): Int {
    val name = command.name.lowercase()
    val description = command.description.lowercase()
    return when {
        name == query -> 0
        name.startsWith(query) -> 1
        name.contains(query) -> 2
        description.contains(query) -> 3
        else -> 4
    }
}

/**
 * External (omp-reported) commands: `builtin` entries are hidden (the client
 * owns those names) and everything else keeps its source for grouping.
 */
fun toSlashCommandItem(root: JsonObject): SlashCommandItem? {
    val name = (root["name"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
    if (name.isEmpty()) return null
    val source = (root["source"] as? JsonPrimitive)?.contentOrNull
    if (source == "builtin") return null
    val mapped = when (source) {
        "extension" -> SlashCommandSource.EXTENSION
        "skill" -> SlashCommandSource.SKILL
        else -> SlashCommandSource.PROMPT
    }
    val description = (root["description"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val hint = ((root["input"] as? JsonObject)?.get("hint") as? JsonPrimitive)?.contentOrNull
    return SlashCommandItem(name = name, description = description, argumentHint = hint, source = mapped)
}

/** Parse a `get_commands` reply or an `available_commands_update` frame. */
fun parseSlashCommands(element: kotlinx.serialization.json.JsonElement?): List<SlashCommandItem> {
    val array = element as? JsonArray ?: return emptyList()
    return array.mapNotNull { (it as? JsonObject)?.let(::toSlashCommandItem) }
}

// ---------------------------------------------------------------- autocomplete

data class SlashQuery(val mode: SlashMode, val start: Int, val query: String)

enum class SlashMode { LEADING, MID_PROMPT }

/**
 * Detect a slash token immediately before the caret. A URL never matches, and
 * whitespace after `/` closes the lookup (web `extractSlashQuery`).
 */
fun extractSlashQuery(textBeforeCursor: String): SlashQuery? {
    if (textBeforeCursor.isEmpty()) return null
    Regex("^\\s*/([^\\s/]*)$").find(textBeforeCursor)?.let { match ->
        return SlashQuery(
            mode = SlashMode.LEADING,
            start = textBeforeCursor.indexOf('/'),
            query = match.groupValues[1].lowercase(),
        )
    }
    val trailing = Regex("(^|\\s)/([^\\s/]*)$").find(textBeforeCursor) ?: return null
    val slashIndex = trailing.range.first + trailing.value.indexOf('/')
    if (textBeforeCursor.substring(0, slashIndex).trim().isEmpty()) return null
    return SlashQuery(
        mode = SlashMode.MID_PROMPT,
        start = slashIndex,
        query = trailing.groupValues[2].lowercase(),
    )
}

fun buildSlashInsertText(commandName: String, mode: SlashMode): String =
    if (mode == SlashMode.MID_PROMPT) {
        "/skill:${commandName.replace(Regex("^skill:", RegexOption.IGNORE_CASE), "")} "
    } else {
        "/$commandName "
    }

/** The palette order: client built-ins first, then omp's groups, then name. */
private val SLASH_SOURCE_ORDER = mapOf(
    SlashCommandSource.BUILTIN to 0,
    SlashCommandSource.EXTENSION to 1,
    SlashCommandSource.PROMPT to 2,
    SlashCommandSource.SKILL to 3,
    SlashCommandSource.OMP_BUILTIN to 4,
)

/**
 * Filter and rank [commands] for [query]. A mid-prompt lookup only shows
 * skills, matched on the bare skill name (web `ChatInput`).
 */
fun filterSlashCommands(
    commands: List<SlashCommandItem>,
    query: String,
    midPrompt: Boolean,
): List<SlashCommandItem> {
    val candidates = if (midPrompt) {
        commands.filter { it.source == SlashCommandSource.SKILL || it.name.startsWith("skill:") }
    } else {
        commands
    }
    val needle = query.lowercase()
    return candidates
        .mapNotNull { command ->
            val name = command.name.lowercase()
            val bare = name.removePrefix("skill:")
            val description = command.description.lowercase()
            val matches = if (midPrompt) {
                bare.contains(needle) || name.contains(needle) || description.contains(needle)
            } else {
                name.contains(needle) || description.contains(needle)
            }
            if (!matches) return@mapNotNull null
            val rank = if (midPrompt) {
                slashMatchRank(command.copy(name = command.name.removePrefix("skill:")), needle)
            } else {
                slashMatchRank(command, needle)
            }
            command to rank
        }
        .sortedWith(
            compareBy<Pair<SlashCommandItem, Int>> { it.second }
                .thenBy { SLASH_SOURCE_ORDER[it.first.source] ?: 99 }
                .thenBy { it.first.name.lowercase() },
        )
        .map { it.first }
}

// ------------------------------------------------------------------ @ mentions

data class AtQuery(val start: Int, val query: String, val quoted: Boolean)

/** Detect the `@` file token before the caret (line start or after whitespace). */
fun extractAtQuery(textBeforeCursor: String): AtQuery? {
    Regex("(?:^|\\s)@\"([^\"\\n]*)$").find(textBeforeCursor)?.let { match ->
        val query = match.groupValues[1]
        return AtQuery(
            start = textBeforeCursor.length - (query.length + 2),
            query = query,
            quoted = true,
        )
    }
    Regex("(?:^|\\s)@([^\\s\"]*)$").find(textBeforeCursor)?.let { match ->
        val query = match.groupValues[1]
        return AtQuery(
            start = textBeforeCursor.length - (query.length + 1),
            query = query,
            quoted = false,
        )
    }
    return null
}

data class FileIndexEntry(val path: String, val isDir: Boolean)

private fun pathDepth(path: String): Int = path.count { it == '/' }

/** Derive directory entries from the server's flat file list, shallow first. */
fun buildEntriesFromFiles(files: List<String>): List<FileIndexEntry> {
    val dirs = LinkedHashSet<String>()
    for (file in files) {
        var index = file.indexOf('/')
        while (index != -1) {
            dirs += file.substring(0, index)
            index = file.indexOf('/', index + 1)
        }
    }
    val entries = ArrayList<FileIndexEntry>(dirs.size + files.size)
    dirs.forEach { entries += FileIndexEntry(it, isDir = true) }
    files.forEach { if (it.isNotEmpty()) entries += FileIndexEntry(it, isDir = false) }
    return entries.sortedWith(compareBy({ pathDepth(it.path) }, { it.path }))
}

private fun isSubsequence(needle: String, haystack: String): Boolean {
    if (needle.isEmpty()) return true
    var index = 0
    for (char in haystack) {
        if (index < needle.length && char == needle[index]) index++
    }
    return index == needle.length
}

/** The TUI's `scoreEntry` ladder plus a low-weight subsequence fallback. */
private fun scoreEntry(entry: FileIndexEntry, lowerQuery: String): Int {
    val lowerPath = entry.path.lowercase()
    var score = 0
    if ('/' in lowerQuery) {
        score = when {
            lowerPath == lowerQuery -> 100
            lowerPath.startsWith(lowerQuery) -> 80
            lowerPath.contains(lowerQuery) -> 50
            isSubsequence(lowerQuery, lowerPath) -> 10
            else -> 0
        }
    } else {
        val name = lowerPath.substringAfterLast('/')
        score = when {
            name == lowerQuery -> 100
            name.startsWith(lowerQuery) -> 80
            name.contains(lowerQuery) -> 50
            lowerPath.contains(lowerQuery) -> 30
            isSubsequence(lowerQuery, lowerPath) -> 10
            else -> 0
        }
    }
    if (entry.isDir && score > 0) score += 10
    return score
}

const val AT_RESULT_LIMIT: Int = 20

fun filterFileEntries(
    entries: List<FileIndexEntry>,
    query: String,
    limit: Int = AT_RESULT_LIMIT,
): List<FileIndexEntry> {
    val needle = query.lowercase()
    if (needle.isEmpty()) return entries.take(limit)
    return entries
        .mapNotNull { entry ->
            val score = scoreEntry(entry, needle)
            if (score > 0) entry to score else null
        }
        .sortedWith(
            compareByDescending<Pair<FileIndexEntry, Int>> { it.second }
                .thenBy { pathDepth(it.first.path) }
                .thenBy { it.first.path },
        )
        .take(limit)
        .map { it.first }
}

data class AtInsertion(val text: String, val cursorOffset: Int)

/**
 * Replacement for the `@` token when a suggestion is confirmed: files close
 * the token (`@path `, quoted when needed), directories keep it open for
 * drill-down (`@dir/`).
 */
fun buildAtInsertText(entryPath: String, isDir: Boolean, forceQuotes: Boolean = false): AtInsertion {
    val path = if (isDir) "$entryPath/" else entryPath
    val needsQuotes = forceQuotes || ' ' in path
    return if (isDir) {
        val text = if (needsQuotes) "@\"$path\"" else "@$path"
        AtInsertion(text, if (needsQuotes) text.length - 1 else text.length)
    } else {
        val text = if (needsQuotes) "@\"$path\" " else "@$path "
        AtInsertion(text, text.length)
    }
}

/** Replace the `@` token [query] spans with [entry]; returns the new text/caret. */
fun applyAtCompletion(
    text: String,
    caret: Int,
    query: AtQuery,
    entry: FileIndexEntry,
): TextInsertion {
    val position = caret.coerceIn(0, text.length)
    var after = text.substring(position)
    if (query.quoted && after.startsWith("\"")) after = after.drop(1)
    val insert = buildAtInsertText(entry.path, entry.isDir, query.quoted)
    val before = text.substring(0, query.start.coerceIn(0, text.length))
    return TextInsertion(before + insert.text + after, before.length + insert.cursorOffset)
}
