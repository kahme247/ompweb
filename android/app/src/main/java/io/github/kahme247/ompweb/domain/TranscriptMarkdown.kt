package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Markdown export for "Copy transcript".
 *
 * Port of `lib/transcript.ts` (the Tauri desktop session-menu formatter):
 * User/Assistant sections, thinking details, Tool/Shell sections, with
 * matching tool results nested under their tool call. Pure, no platform
 * dependencies; images degrade to a placeholder because binary bytes cannot
 * travel through the clipboard.
 */
const val TRANSCRIPT_BLOCK_CHAR_LIMIT = 20000
const val TRANSCRIPT_TOTAL_CHAR_LIMIT = 500000

private val PRETTY_JSON = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

fun transcriptToMarkdown(messages: List<JsonObject>, title: String? = null, cwd: String? = null): String {
    val sections = mutableListOf<String>()
    if (!title.isNullOrBlank()) sections += "# $title"
    if (!cwd.isNullOrBlank()) sections += "_${cwd}_"

    val pendingResults = LinkedHashMap<String, PendingToolResult>()
    for (message in messages) {
        if (message.str("role") != "toolResult") continue
        val callId = message.str("toolCallId") ?: continue
        pendingResults[callId] = PendingToolResult(
            name = message.str("toolName"),
            text = textOf(message["content"]),
            isError = message.bool("isError"),
        )
    }
    val consumedResults = HashSet<String>()

    for (message in messages) {
        when (message.str("role")) {
            "user" -> {
                val text = textOf(message["content"]).trim()
                if (text.isNotEmpty()) sections += "## User\n\n${truncateBlock(text)}"
            }

            "assistant" -> {
                val blocks = message["content"] as? JsonArray ?: JsonArray(emptyList<JsonElement>())
                val provider = message.str("provider")
                val model = message.str("model")
                val qualifier = listOfNotNull(provider, model).filter { it.isNotBlank() }.joinToString("/")
                val header = if (qualifier.isNotEmpty()) "## Assistant ($qualifier)" else "## Assistant"
                val body = mutableListOf<String>()
                val text = assistantText(blocks).trim()
                if (text.isNotEmpty()) body += truncateBlock(text)
                body += assistantThinking(blocks)
                for (block in blocks) {
                    val blockObject = block as? JsonObject ?: continue
                    if (blockObject.str("type") != "toolCall") continue
                    val toolName = blockObject.str("toolName") ?: "tool"
                    val callId = blockObject.str("toolCallId") ?: ""
                    val lines = mutableListOf("### Tool: $toolName `$callId`")
                    toolInputSummary(blockObject["input"])?.let(lines::add)
                    val result = pendingResults[callId]
                    if (result != null) {
                        consumedResults += callId
                        val label = if (result.isError) "Tool result (error)" else "Tool result"
                        lines += "**$label: ${result.name ?: toolName}**"
                        lines += if (result.text.trim().isNotEmpty()) fenced(truncateBlock(result.text.trim())) else "_(empty)_"
                    }
                    body += lines.joinToString("\n\n")
                }
                val errorMessage = message.str("errorMessage")
                if (!errorMessage.isNullOrBlank()) {
                    val isInterrupted = message.str("stopReason") == "aborted" ||
                        Regex("""^interrupted(\s+by\s+user)?""", RegexOption.IGNORE_CASE).containsMatchIn(errorMessage)
                    body += if (isInterrupted) "_Generation stopped by user_" else "**Error:** $errorMessage"
                }
                if (body.isNotEmpty()) sections += "$header\n\n${body.joinToString("\n\n")}"
            }

            "toolResult" -> {
                val callId = message.str("toolCallId") ?: ""
                if (callId in consumedResults) continue
                val text = textOf(message["content"]).trim()
                val label = if (message.bool("isError")) "### Tool result (error)" else "### Tool result"
                val name = message.str("toolName") ?: callId
                sections += if (text.isNotEmpty()) {
                    "$label: $name\n\n${fenced(truncateBlock(text))}"
                } else {
                    "$label: $name\n\n_(empty)_"
                }
            }

            "bashExecution" -> {
                val lines = mutableListOf("### Shell: `${message.str("command") ?: ""}`")
                val cancelled = message.bool("cancelled")
                if (message["exitCode"] != null || cancelled) {
                    lines += "_exit ${if (cancelled) "cancelled" else message.int("exitCode")}_"
                }
                val output = message.str("output")?.trim().orEmpty()
                if (output.isNotEmpty()) lines += fenced(truncateBlock(output))
                sections += lines.joinToString("\n\n")
            }

            "pythonExecution" -> {
                val lines = mutableListOf("### Python")
                lines += fenced(truncateBlock(message.str("code")?.trim().orEmpty()), "python")
                val output = message.str("output")?.trim().orEmpty()
                if (output.isNotEmpty()) lines += fenced(truncateBlock(output))
                sections += lines.joinToString("\n\n")
            }

            "fileMention" -> {
                val lines = mutableListOf("### Attached files")
                (message["files"] as? JsonArray)?.forEach { element ->
                    val file = element as? JsonObject ?: return@forEach
                    val reason = file.str("skippedReason")
                    lines += "- `${file.str("path") ?: ""}`${if (reason != null) " _($reason)_" else ""}"
                }
                sections += lines.joinToString("\n")
            }

            "developer" -> {
                val text = textOf(message["content"]).trim()
                if (text.isNotEmpty()) sections += "### System note\n\n${truncateBlock(text)}"
            }

            "custom" -> {
                if (!message.bool("display")) continue
                val text = textOf(message["content"]).trim()
                if (text.isNotEmpty()) sections += "### ${message.str("customType") ?: ""}\n\n${truncateBlock(text)}"
            }
        }
    }

    val joined = sections.joinToString("\n\n---\n\n") + "\n"
    return if (joined.length > TRANSCRIPT_TOTAL_CHAR_LIMIT) {
        joined.take(TRANSCRIPT_TOTAL_CHAR_LIMIT) +
            "\n\n…(transcript truncated at $TRANSCRIPT_TOTAL_CHAR_LIMIT chars)\n"
    } else {
        joined
    }
}

private data class PendingToolResult(val name: String?, val text: String, val isError: Boolean)

private fun truncateBlock(text: String): String =
    if (text.length <= TRANSCRIPT_BLOCK_CHAR_LIMIT) {
        text
    } else {
        text.take(TRANSCRIPT_BLOCK_CHAR_LIMIT) +
            "\n\n…(truncated ${text.length - TRANSCRIPT_BLOCK_CHAR_LIMIT} chars)"
    }

private fun pickFence(text: String): String = if ("```" in text) "~~~~" else "```"

private fun fenced(text: String, language: String = ""): String {
    val fence = pickFence(text)
    return "$fence$language\n$text\n$fence"
}

private fun textOf(content: JsonElement?): String {
    if (content == null) return ""
    if (content is JsonPrimitive) return content.contentOrNull ?: ""
    if (content !is JsonArray) return ""
    val parts = mutableListOf<String>()
    for (block in content) {
        val objectBlock = block as? JsonObject ?: continue
        when (objectBlock.str("type")) {
            "text" -> parts += objectBlock.str("text") ?: ""
            "image" -> parts += "[attached image]"
        }
    }
    return parts.joinToString("\n\n")
}

private fun assistantText(blocks: JsonArray): String {
    val parts = mutableListOf<String>()
    for (block in blocks) {
        val objectBlock = block as? JsonObject ?: continue
        when (objectBlock.str("type")) {
            "text" -> parts += objectBlock.str("text") ?: ""
            "image" -> parts += "[attached image]"
        }
    }
    return parts.joinToString("\n\n")
}

private fun assistantThinking(blocks: JsonArray): List<String> {
    val out = mutableListOf<String>()
    for (block in blocks) {
        val objectBlock = block as? JsonObject ?: continue
        if (objectBlock.str("type") != "thinking") continue
        val thinking = objectBlock.str("thinking") ?: continue
        if (thinking.trim().isEmpty()) continue
        out += "<details><summary>Thinking</summary>\n\n${truncateBlock(thinking)}\n\n</details>"
    }
    return out
}

private fun toolInputSummary(input: JsonElement?): String? {
    val objectInput = input as? JsonObject ?: return null
    if (objectInput.isEmpty()) return ""
    val rendered = PRETTY_JSON.encodeToString(JsonElement.serializer(), objectInput)
    return fenced(truncateBlock(rendered), "json")
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.bool(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.contentOrNull?.equals("true", ignoreCase = true) == true

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.jsonPrimitive?.content?.toIntOrNull()
