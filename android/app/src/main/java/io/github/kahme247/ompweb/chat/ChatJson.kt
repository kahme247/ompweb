package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/** Tolerant accessors: every field of an omp frame is optional by contract. */
internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

internal fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

internal fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray

/** Safe text of a user/custom content payload (string or `[{type:"text"}]`). */
internal fun contentText(content: JsonElement?): String = when (content) {
    is JsonPrimitive -> if (content is JsonNull) "" else content.contentOrNull.orEmpty()
    is JsonArray -> content.mapNotNull { block ->
        val obj = block as? JsonObject ?: return@mapNotNull null
        if (obj.string("type") == "text") obj.string("text") else null
    }.joinToString("\n")
    else -> ""
}

internal fun contentImages(content: JsonElement?): List<ChatImage> {
    val array = content as? JsonArray ?: return emptyList()
    return array.mapNotNull { element ->
        val block = element as? JsonObject ?: return@mapNotNull null
        if (block.string("type") != "image") return@mapNotNull null
        parseImage(block)
    }.filterNot { it.isEmpty }
}

/** Both the flat (`data`/`mimeType`) and the nested (`source`) image shapes. */
internal fun parseImage(block: JsonObject): ChatImage {
    val source = block.obj("source")
    val mimeType = block.string("mimeType") ?: source?.string("media_type")
    val base64 = block.string("data") ?: source?.string("data")
    val url = block.string("url")
        ?: source?.takeIf { it.string("type") == "url" }?.string("url")
    return ChatImage(mimeType = mimeType, url = url, base64 = base64)
}

private val partialJson = Json { isLenient = true; ignoreUnknownKeys = true }

/**
 * The compaction summary a banner can show (web `readCompactResult`): only a
 * numeric `tokensBefore` qualifies, and a missing estimate counts as 0.
 */
internal fun readCompactResult(result: JsonElement?, reason: String): CompactResult? {
    val obj = result as? JsonObject ?: return null
    val before = obj.long("tokensBefore") ?: return null
    return CompactResult(reason = reason, tokensBefore = before, estimatedTokensAfter = obj.long("estimatedTokensAfter") ?: 0L)
}

/**
 * Tool calls reach the app with two field spellings: `id`/`name`/`arguments`
 * while streaming, `toolCallId`/`toolName`/`input` in committed messages and
 * session files (web: `lib/normalize.ts`). While an argument object is still
 * empty, the streaming `partialArgs` JSON is parsed so the row can show the
 * command instead of a blank preview.
 */
internal fun parseToolCall(block: JsonObject): AssistantBlock.ToolCall? {
    if (block.string("type") != "toolCall") return null
    val id = block.string("toolCallId") ?: block.string("id") ?: ""
    val name = block.string("toolName") ?: block.string("name") ?: ""
    val direct = block.obj("input") ?: block.obj("arguments")
    val partialArgs = block.string("partialArgs")
    val input = direct?.takeIf { it.isNotEmpty() }
        ?: partialArgs?.let { parsePartialArguments(it) }
        ?: JsonObject(emptyMap())
    return AssistantBlock.ToolCall(
        toolCallId = id,
        toolName = name,
        input = input,
    )
}

private fun parsePartialArguments(raw: String): JsonObject? {
    if (raw.isBlank()) return null
    return try {
        partialJson.parseToJsonElement(raw) as? JsonObject
    } catch (_: Exception) {
        null
    }
}

internal fun parseAssistantBlocks(message: JsonObject): List<AssistantBlock> {
    val content = message["content"] as? JsonArray ?: return emptyList()
    return content.mapIndexedNotNull { index, element ->
        val block = element as? JsonObject ?: return@mapIndexedNotNull null
        when (block.string("type")) {
            "text" -> AssistantBlock.Text(block.string("text") ?: "")
            "thinking" -> AssistantBlock.Thinking(
                thinking = block.string("thinking") ?: "",
                deferred = block.bool("deferred") == true,
                blockIndex = block.int("blockIndex") ?: index,
            )
            "toolCall" -> parseToolCall(block)
            "image" -> AssistantBlock.Image(parseImage(block)).takeUnless { it.image.isEmpty }
            else -> AssistantBlock.Other(block.string("type") ?: "unknown")
        }
    }
}

/** Parse one `message` object (SSE frame or `context.messages` entry). */
internal fun parseChatMessage(
    message: JsonObject,
    entryId: String?,
    syntheticKey: String,
): ChatMessage? {
    val timestamp = message.long("timestamp")
    return when (message.string("role")) {
        "user" -> ChatMessage.User(
            key = entryId ?: syntheticKey,
            timestamp = timestamp,
            entryId = entryId,
            text = contentText(message["content"]),
            images = contentImages(message["content"]),
            branchSummary = message.bool("branchSummary") == true,
        )
        "assistant" -> ChatMessage.Assistant(
            key = entryId ?: syntheticKey,
            timestamp = timestamp,
            entryId = entryId,
            blocks = parseAssistantBlocks(message),
            model = message.string("model"),
            provider = message.string("provider"),
            stopReason = message.string("stopReason"),
            errorMessage = message.string("errorMessage"),
            durationMs = message.double("duration"),
            usageOutput = message.obj("usage")?.double("output")?.toInt(),
            ttftMs = message.double("ttft"),
            completedAt = message.long("completedAt"),
        )
        "toolResult" -> {
            val content = message["content"]
            ChatMessage.ToolResult(
                key = entryId ?: syntheticKey,
                timestamp = timestamp,
                entryId = entryId,
                toolCallId = message.string("toolCallId") ?: message.string("id") ?: "",
                toolName = message.string("toolName") ?: message.string("name") ?: "",
                text = contentText(content),
                images = contentImages(content),
                details = message.obj("details"),
                isError = message.bool("isError") == true,
                partial = message.bool("partial") == true,
            )
        }
        "bashExecution" -> ChatMessage.BashExecution(
            key = entryId ?: syntheticKey,
            timestamp = timestamp,
            entryId = entryId,
            command = message.string("command") ?: "",
            output = message.string("output"),
            exitCode = message.int("exitCode"),
            cancelled = message.bool("cancelled") == true,
            fullOutputPath = message.string("fullOutputPath"),
        )
        "custom" -> ChatMessage.Custom(
            key = entryId ?: syntheticKey,
            timestamp = timestamp,
            entryId = entryId,
            customType = message.string("customType") ?: "",
            text = contentText(message["content"]),
            details = message.obj("details"),
            display = message.bool("display") != false,
        )
        else -> {
            val role = message.string("role") ?: return null
            ChatMessage.Other(key = entryId ?: syntheticKey, timestamp = timestamp, entryId = entryId, role = role)
        }
    }
}

/**
 * A tool payload (`partialResult` / `result` / live `toolEvents`) omits the
 * `role` field; inject it so it parses as a tool result row.
 */
internal fun parseToolResultPayload(value: JsonObject, key: String): ChatMessage.ToolResult? {
    if (value.string("role") != null) return parseChatMessage(value, null, key) as? ChatMessage.ToolResult
    return parseChatMessage(
        JsonObject(value + ("role" to JsonPrimitive("toolResult"))),
        null,
        key,
    ) as? ChatMessage.ToolResult
}
