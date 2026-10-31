package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.domain.formatCompactNumber
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/** Tool families that get their own icon/label treatment (web `MessageView-tool-format.ts`). */
enum class ToolCategory { Read, Search, Edit, Terminal, Todo, Task, Code, Web, Hub, Other }

fun getToolCategory(toolName: String): ToolCategory {
    val name = toolName.lowercase().replace(Regex("""\s*\(.*\)\s*$"""), "")
    return when {
        name == "hub" -> ToolCategory.Hub
        name == "read" || name.endsWith(".read") || name.endsWith("_read") || name == "file_read" -> ToolCategory.Read
        name == "grep" || name == "glob" || name.contains("search") || name.endsWith(".grep") || name.endsWith(".glob") -> ToolCategory.Search
        name == "edit" || name == "write" || name == "ast_edit" || name.endsWith(".edit") || name.endsWith(".write") -> ToolCategory.Edit
        name == "bash" || name == "terminal" || name == "exec" || name == "shell" || name == "cmd" -> ToolCategory.Terminal
        name == "todo" || name.endsWith(".todo") -> ToolCategory.Todo
        name == "task" || name == "agent" || name.endsWith(".task") || name.endsWith(".agent") -> ToolCategory.Task
        name == "eval" || name.endsWith(".eval") -> ToolCategory.Code
        name == "web_search" || name == "browser" || name.contains("browser") -> ToolCategory.Web
        else -> ToolCategory.Other
    }
}

data class TodoSummary(val op: String, val action: String, val label: String, val task: String?)

fun getTodoSummary(input: JsonObject?): TodoSummary? {
    val op = input?.str("op") ?: return null
    val task = input.str("task")
    val phase = input.str("phase")
    val items = input.arr("items")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    return when (op) {
        "done" -> TodoSummary(op, "Completed", if (task != null) "Completed \"$task\"" else "Completed task", task)
        "start" -> TodoSummary(op, "Started", if (task != null) "Started \"$task\"" else "Started task", task)
        "append" -> {
            val count = items?.size ?: 0
            val label = when {
                task != null -> "Added \"$task\""
                count > 0 -> "Added $count task${if (count > 1) "s" else ""}"
                else -> "Added task"
            }
            TodoSummary(op, "Added", label, task ?: items?.firstOrNull())
        }
        "init" -> {
            val listCount = input.arr("list")?.sumOf { plan ->
                (plan as? JsonObject)?.arr("items")?.size ?: 0
            } ?: (items?.size ?: 0)
            TodoSummary(op, "Initialized", "Initialized plan ($listCount tasks)", phase)
        }
        "block" -> TodoSummary(op, "Blocked", if (task != null) "Blocked \"$task\"" else "Blocked task", task)
        "unblock" -> TodoSummary(op, "Unblocked", if (task != null) "Unblocked \"$task\"" else "Unblocked task", task)
        "drop" -> TodoSummary(op, "Dropped", if (task != null) "Dropped \"$task\"" else "Dropped task", task)
        else -> TodoSummary(op, op, "Task: $op${if (task != null) " \"$task\"" else ""}", task)
    }
}

data class HubSendSummary(val to: List<String>, val message: String, val snippet: String)

fun getHubSendSummary(input: JsonObject?): HubSendSummary? {
    if (input?.str("op") != "send") return null
    val raw = when (val to = input["to"]) {
        is JsonArray -> to.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        is JsonPrimitive -> listOfNotNull(to.contentOrNull)
        else -> emptyList()
    }
    val to = raw.filter { it.isNotEmpty() }.take(10)
    if (to.isEmpty()) return null
    val message = input.str("message").orEmpty()
    val firstLine = message.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
    val snippet = if (firstLine.length > 120) firstLine.take(120) + "…" else firstLine
    return HubSendSummary(to, message, snippet)
}

data class HubJob(
    val id: String,
    val type: String,
    val status: String,
    val label: String,
    val durationMs: Double? = null,
    val resolvedModel: String? = null,
)

fun getHubJobs(details: JsonObject?): List<HubJob>? {
    if (details?.str("op") != "jobs") return null
    val jobs = details.arr("jobs") ?: return null
    val rows = ArrayList<HubJob>()
    for (raw in jobs) {
        val job = raw as? JsonObject ?: continue
        val id = job.str("id")?.takeIf { it.isNotEmpty() } ?: continue
        rows += HubJob(
            id = id,
            type = job.str("type") ?: "task",
            status = job.str("status") ?: "running",
            label = job.str("label")?.takeIf { it.isNotEmpty() } ?: id,
            durationMs = job.num("durationMs"),
            resolvedModel = job.str("resolvedModel")?.takeIf { it.isNotEmpty() },
        )
        if (rows.size >= 50) break
    }
    return rows.ifEmpty { null }
}

fun getHubJobsHeader(jobs: List<HubJob>): String {
    val waiting = jobs.any { it.status == "running" || it.status == "started" || it.status == "waiting" }
    return if (waiting) {
        "waiting on ${jobs.size} job${if (jobs.size == 1) "" else "s"}"
    } else {
        "${jobs.size} job${if (jobs.size == 1) "" else "s"}"
    }
}

fun getToolPreview(block: AssistantBlock.ToolCall): String {
    val input = block.input
    if (block.toolName.lowercase() == "ask") {
        val preview = getAskPreview(input)
        if (preview != null) return preview.take(120)
    }
    when (getToolCategory(block.toolName)) {
        ToolCategory.Todo -> getTodoSummary(input)?.let { return it.label }
        ToolCategory.Hub -> {
            when (input.str("op")) {
                "send" -> return getHubSendSummary(input)?.snippet ?: "send"
                "jobs" -> return "jobs"
                else -> input.str("op")?.let { return it }
            }
        }
        else -> Unit
    }
    val keys = input.keys.toList()
    if (keys.isEmpty()) return ""
    for (key in listOf("command", "path", "file_path", "pattern", "query")) {
        if (key in input) return formatPreviewValue(input[key]).take(120)
    }
    return formatPreviewValue(input[keys.first()]).take(120)
}

private fun getAskPreview(input: JsonObject): String? {
    val questions = input.arr("questions") ?: return null
    val prompts = questions.filterIsInstance<JsonObject>().mapNotNull { question ->
        val header = question.str("header").orEmpty().trim()
        val prompt = question.str("question").orEmpty().trim()
        when {
            header.isNotEmpty() && prompt.isNotEmpty() -> "$header: $prompt"
            header.isNotEmpty() -> header
            prompt.isNotEmpty() -> prompt
            else -> null
        }
    }
    if (prompts.isEmpty()) {
        return if (questions.isNotEmpty()) "${questions.size} question${if (questions.size == 1) "" else "s"}" else ""
    }
    val label = if (prompts.size == 1) "Question" else "${prompts.size} questions"
    return "$label: ${prompts.joinToString(" · ") { "“$it”" }}"
}

private fun formatPreviewValue(value: JsonElement?): String = when (value) {
    null -> ""
    is JsonPrimitive -> value.contentOrNull ?: value.toString()
    else -> value.toString()
}

data class SemanticToolLabel(val action: String, val target: String, val isFile: Boolean = false)

fun getSemanticToolLabel(block: AssistantBlock.ToolCall): SemanticToolLabel {
    val input = block.input
    when (getToolCategory(block.toolName)) {
        ToolCategory.Todo -> getTodoSummary(input)?.let { summary ->
            return SemanticToolLabel(summary.action, summary.task ?: summary.label)
        }
        ToolCategory.Hub -> {
            when (input.str("op")) {
                "send" -> {
                    val send = getHubSendSummary(input)
                    return if (send != null) {
                        SemanticToolLabel("IRC", "→ ${send.to.joinToString(", ")}")
                    } else {
                        SemanticToolLabel("IRC", "send")
                    }
                }
                "jobs" -> return SemanticToolLabel("hub", "jobs")
                else -> input.str("op")?.let { return SemanticToolLabel("hub", it) }
            }
        }
        ToolCategory.Read -> input.str("path")?.let {
            return SemanticToolLabel("Read", it, isFile = true)
        }
        ToolCategory.Search -> {
            input.str("pattern")?.let {
                val scope = input.str("path")?.let { path -> " in $path" }.orEmpty()
                return SemanticToolLabel("Search", "\"$it\"$scope")
            }
            input.str("path")?.let { return SemanticToolLabel("Find", it) }
            input.str("query")?.let { return SemanticToolLabel("Search", "\"$it\"") }
        }
        ToolCategory.Edit -> input.str("path")?.let {
            val action = if (block.toolName.lowercase().contains("write")) "Create" else "Edit"
            return SemanticToolLabel(action, it, isFile = true)
        }
        ToolCategory.Terminal -> input.str("command")?.let { return SemanticToolLabel("Run", it) }
        ToolCategory.Code -> {
            val target = input.str("title") ?: input.str("language")?.let { "$it code" } ?: "code"
            return SemanticToolLabel("Eval", target)
        }
        ToolCategory.Web -> input.str("query")?.let { return SemanticToolLabel("Search Web", "\"$it\"") }
        else -> Unit
    }
    return SemanticToolLabel(block.toolName, getToolPreview(block))
}

fun formatToolCommand(block: AssistantBlock.ToolCall): String {
    val input = block.input
    input.str("command")?.let { return it }
    if (getToolCategory(block.toolName) == ToolCategory.Hub) {
        val op = input.str("op")
        if (op == "send") {
            val send = getHubSendSummary(input)
            return if (send != null) "hub send → ${send.to.joinToString(", ")}" else "hub send"
        }
        if (op != null) return "hub $op"
    }
    input.str("path")?.let { return "${block.toolName} $it" }
    input.str("file_path")?.let { return "${block.toolName} $it" }
    input.str("query")?.let { return "${block.toolName} $it" }
    return "${block.toolName} $input"
}

fun formatToolOutput(text: String, toolName: String): String =
    if (isReadToolName(toolName)) {
        text.lineSequence().joinToString("\n") { it.replace(Regex("""^\s*\d+:\s?"""), "") }
    } else {
        text
    }

fun isReadToolName(toolName: String): Boolean {
    val name = toolName.lowercase()
    return name == "read" || name.endsWith(".read") || name.endsWith("_read")
}

fun getToolResultMeta(details: JsonObject?): String? {
    if (details == null) return null
    val usage = details.obj("usage") ?: details
    fun read(vararg keys: String): Int? = keys.firstNotNullOfOrNull { key ->
        val value = (usage[key] as? JsonPrimitive)?.doubleOrNull ?: (usage[key] as? JsonPrimitive)?.intOrNull?.toDouble()
        value?.takeIf { it > 0 }?.toInt()
    }
    val input = read("input", "inputTokens", "input_tokens")
    val output = read("output", "outputTokens", "output_tokens")
    val cacheRead = read("cacheRead", "cache_read", "cacheReadTokens")
    val cacheWrite = read("cacheWrite", "cache_write", "cacheWriteTokens")
    val parts = listOfNotNull(
        input?.let { "in ${formatCompactNumber(it.toDouble())}" },
        output?.let { "out ${formatCompactNumber(it.toDouble())}" },
        cacheRead?.let { "cache R ${formatCompactNumber(it.toDouble())}" },
        cacheWrite?.let { "cache W ${formatCompactNumber(it.toDouble())}" },
    )
    return parts.joinToString(" · ").ifEmpty { null }
}

/** TUI-style job duration: `45s`, `31m30s`, `2h5m`. */
fun formatJobDuration(ms: Double?): String? {
    if (ms == null || ms < 1000) return null
    val totalSeconds = (ms / 1000).toLong()
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return when {
        hours > 0 -> if (minutes > 0) "${hours}h${minutes}m" else "${hours}h"
        minutes > 0 -> if (seconds > 0) "${minutes}m${seconds}s" else "${minutes}m"
        else -> "${seconds}s"
    }
}

internal fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.num(key: String): Double? =
    (this[key] as? JsonPrimitive)?.doubleOrNull

internal fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull

internal fun JsonObject.int(key: String): Int? =
    (this[key] as? JsonPrimitive)?.intOrNull

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
