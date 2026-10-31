package io.github.kahme247.ompweb.domain

import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * Attachment budgets and composition, ported from `lib/chat-attachments.ts` and
 * `lib/image-attachments.ts`.
 *
 * The mobile composer and the RPC payload builder must agree on the same
 * numbers as the server routes: 8 MiB JSON command body, 5 MiB decoded images,
 * 4 MiB attached text across at most 10 files.
 */

/** Complete JSON body accepted by `POST /api/agent/{id}` and `/api/agent/new`. */
const val MAX_AGENT_COMMAND_REQUEST_BYTES: Int = 8 * 1024 * 1024

/** Decoded bytes of all images in one message. */
const val MAX_TOTAL_ATTACHED_IMAGE_BYTES: Int = 5 * 1024 * 1024

/** Decoded bytes of a single image; a lone image may fill the whole budget. */
const val MAX_ATTACHED_IMAGE_BYTES: Int = MAX_TOTAL_ATTACHED_IMAGE_BYTES

const val MAX_ATTACHED_IMAGES: Int = 10

/** Text-attachment budget, enforced on the aggregate rather than per file. */
const val MAX_TOTAL_ATTACHED_TEXT_BYTES: Int = 4 * 1024 * 1024

/** A lone text file may fill the whole text budget. */
const val MAX_ATTACHED_TEXT_BYTES: Int = MAX_TOTAL_ATTACHED_TEXT_BYTES

const val MAX_ATTACHED_TEXT_FILES: Int = 10

/** `{"type":"image","data":"","mimeType":"",},` plus slack for the mime type. */
private const val IMAGE_ENTRY_OVERHEAD_BYTES = 96

/** Command type, streaming behavior, and the surrounding JSON object. */
private const val COMMAND_ENVELOPE_BYTES = 256

/** Attachment extensions that are always text; Markdown is decided by [isMarkdownFile]. */
private val TEXT_FILE_EXTENSIONS = setOf("txt", "text")

/** One base64 image ready for the RPC `images` array. */
data class ComposerImage(val data: String, val mimeType: String)

/** One text file inlined into the prompt as an `Attached file:` block. */
data class AttachedTextFile(
    val name: String,
    val mimeType: String,
    val content: String,
    val size: Int,
)

/** What the composer already holds (or has in flight) when a new batch lands. */
data class TextAttachmentBudget(val usedBytes: Int, val usedSlots: Int)

data class TextAttachmentSelection<T>(
    val accepted: List<T>,
    /** Candidates dropped for exceeding the per-file cap. */
    val tooLarge: Int,
    /** Candidates dropped because the message's aggregate text budget was spent. */
    val overBudget: Int,
)

fun fileExtension(name: String): String =
    name.lowercase().replace('\\', '/').substringAfterLast('/').substringAfterLast('.', missingDelimiterValue = "")

/** Human-readable limit for the composer banners ("512 KB" / "4 MB"). */
fun formatAttachmentBytes(bytes: Int): String = if (bytes >= 1024 * 1024) {
    "${Math.round(bytes / (1024.0 * 1024.0))} MB"
} else {
    "${Math.round(bytes / 1024.0)} KB"
}

/**
 * Per-file, aggregate and slot rules for text attachments — the single place
 * the composer and draft restore both enforce them. Candidates past the
 * remaining slots are dropped silently; a candidate too large on its own is
 * reported before a budget miss so the banner names the limit actually hit.
 */
fun <T> selectTextAttachments(
    candidates: List<T>,
    sizeOf: (T) -> Int,
    budget: TextAttachmentBudget,
): TextAttachmentSelection<T> {
    val accepted = ArrayList<T>(candidates.size)
    val remainingSlots = (MAX_ATTACHED_TEXT_FILES - budget.usedSlots).coerceAtLeast(0)
    var totalBytes = budget.usedBytes
    var tooLarge = 0
    var overBudget = 0
    for (candidate in candidates) {
        if (accepted.size >= remainingSlots) break
        val size = sizeOf(candidate)
        if (size < 0 || size > MAX_ATTACHED_TEXT_BYTES) {
            tooLarge++
            continue
        }
        if (totalBytes + size > MAX_TOTAL_ATTACHED_TEXT_BYTES) {
            overBudget++
            continue
        }
        totalBytes += size
        accepted += candidate
    }
    return TextAttachmentSelection(accepted, tooLarge, overBudget)
}

/** Banner text for a batch that produced no usable attachments. */
fun describeTextAttachmentSkip(selection: TextAttachmentSelection<*>): String? {
    if (selection.tooLarge > 0) {
        return "${selection.tooLarge} file(s) skipped: files up to " +
            "${formatAttachmentBytes(MAX_ATTACHED_TEXT_BYTES)} are supported."
    }
    if (selection.overBudget > 0) {
        return "${selection.overBudget} file(s) skipped: attachments are limited to " +
            "${formatAttachmentBytes(MAX_TOTAL_ATTACHED_TEXT_BYTES)} per message."
    }
    return null
}

fun isTextAttachmentFile(name: String, mimeType: String): Boolean =
    mimeType == "text/plain" || mimeType == "text/markdown" ||
        fileExtension(name) in TEXT_FILE_EXTENSIONS || isMarkdownFile(name)

private fun languageForFile(name: String): String =
    if (isMarkdownFile(name)) "markdown" else "text"

private fun fenceForContent(content: String): String {
    val longestRun = Regex("`+").findAll(content).maxOfOrNull { it.value.length } ?: 0
    return "`".repeat(maxOf(3, longestRun + 1))
}

/**
 * Attachment names are provider-supplied metadata (a share can name itself
 * anything): keep them on one line and free of fence delimiters so a crafted
 * name cannot open or close the attachment block.
 */
fun sanitizeAttachmentName(name: String, maxLength: Int = 120): String {
    val cleaned = buildString {
        for (char in name) {
            when {
                char == '`' -> append('\'')
                char == '\r' || char == '\n' || char.isISOControl() -> append(' ')
                else -> append(char)
            }
        }
    }.replace(Regex("\\s{2,}"), " ").trim()
    return cleaned.take(maxLength).ifEmpty { "attachment" }
}

/** Add text-file contents to the prompt while keeping the attachment boundary clear. */
fun composeMessageWithTextAttachments(message: String, files: List<AttachedTextFile>): String {
    if (files.isEmpty()) return message
    val blocks = files.map { file ->
        val name = sanitizeAttachmentName(file.name)
        val fence = fenceForContent(file.content)
        "Attached file: $name\n$fence${languageForFile(name)}\n${file.content}\n$fence"
    }
    return (listOf(message.trim()) + blocks).filter { it.isNotEmpty() }.joinToString("\n\n")
}

/**
 * Merge a share batch into a draft's images within the outgoing budgets,
 * dropping byte-identical duplicates. Existing images win so a share never
 * displaces what the user already attached.
 */
fun mergeImageAttachments(
    existing: List<ComposerImage>,
    incoming: List<ComposerImage>,
): List<ComposerImage> {
    val merged = existing.toMutableList()
    val seen = existing.mapTo(HashSet()) { it.data }
    var totalBytes = existing.sumOf { base64DecodedByteLength(it.data) ?: 0 }
    for (image in incoming) {
        if (!seen.add(image.data)) continue
        if (!image.mimeType.startsWith("image/")) continue
        val bytes = base64DecodedByteLength(image.data) ?: continue
        if (merged.size >= MAX_ATTACHED_IMAGES || bytes > MAX_ATTACHED_IMAGE_BYTES) continue
        if (totalBytes + bytes > MAX_TOTAL_ATTACHED_IMAGE_BYTES) continue
        merged += image
        totalBytes += bytes
    }
    return merged
}

/**
 * Read [stream] fully, but only while it stays within [cap] bytes. Returns
 * `null` when the source is larger: a silently truncated attachment would
 * reach the model as if it were complete.
 */
fun readCappedOrNull(stream: InputStream, cap: Int): ByteArray? {
    val out = ByteArrayOutputStream(minOf(cap, 64 * 1024))
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0
    while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        total += read
        if (total > cap) return null
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}

private fun isBase64DataChar(code: Int): Boolean =
    (code in 0x41..0x5a) || (code in 0x61..0x7a) || (code in 0x30..0x39) ||
        code == 0x2b || code == 0x2f

/** Decoded byte length of a well-formed base64 payload, or null. */
fun base64DecodedByteLength(data: String): Int? {
    if (data.isEmpty() || data.length % 4 != 0) return null
    val padding = when {
        data.endsWith("==") -> 2
        data.endsWith("=") -> 1
        else -> 0
    }
    val dataEnd = data.length - padding
    for (index in 0 until dataEnd) {
        if (!isBase64DataChar(data[index].code)) return null
    }
    for (index in dataEnd until data.length) {
        if (data[index] != '=') return null
    }
    return (data.length / 4) * 3 - padding
}

private fun imageByteLengthWithinLimits(image: ComposerImage): Int? {
    if (!image.mimeType.startsWith("image/")) return null
    val bytes = base64DecodedByteLength(image.data) ?: return null
    return bytes.takeIf { it <= MAX_ATTACHED_IMAGE_BYTES }
}

/** Count, per-image and aggregate rules for one outgoing `images` array. */
fun validateImageBudget(images: List<ComposerImage>): String? {
    if (images.size > MAX_ATTACHED_IMAGES) {
        return "A message can include at most $MAX_ATTACHED_IMAGES images"
    }
    var totalBytes = 0
    for (image in images) {
        val bytes = imageByteLengthWithinLimits(image)
            ?: return "Each image must be valid base64 image data of " +
                "${MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or smaller"
        totalBytes += bytes
    }
    if (totalBytes > MAX_TOTAL_ATTACHED_IMAGE_BYTES) {
        return "Attached images must total ${MAX_TOTAL_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or less"
    }
    return null
}

/** UTF-8 size of [value] once JSON-escaped, matching `JSON.stringify` bytes. */
fun jsonStringByteLength(value: String): Int {
    var bytes = 2 // the surrounding quotes
    var index = 0
    while (index < value.length) {
        val codePoint = value.codePointAt(index)
        when (codePoint) {
            0x22, 0x5c -> bytes += 2
            0x08, 0x0c, 0x0a, 0x0d, 0x09 -> bytes += 2
            in 0x00..0x1f -> bytes += 6
            in 0x20..0x7e -> bytes += 1
            in 0x80..0x7ff -> bytes += 2
            in 0x800..0xffff -> bytes += 3
            else -> bytes += 4
        }
        index += Character.charCount(codePoint)
    }
    return bytes
}

/**
 * Size of the JSON command body an outgoing prompt produces. Base64 data is
 * ASCII and needs no escaping, so it is measured by length.
 */
fun agentRequestByteLength(message: String, images: List<ComposerImage>): Int {
    var bytes = COMMAND_ENVELOPE_BYTES + jsonStringByteLength(message)
    for (image in images) {
        bytes += IMAGE_ENTRY_OVERHEAD_BYTES + image.data.length + jsonStringByteLength(image.mimeType)
    }
    return bytes
}

/** Preflight for the composer: reject a prompt the agent route would refuse. */
fun validateOutgoingPrompt(message: String, images: List<ComposerImage>): String? {
    validateImageBudget(images)?.let { return it }
    if (agentRequestByteLength(message, images) > MAX_AGENT_COMMAND_REQUEST_BYTES) {
        return "This message is too large to send: keep it under " +
            "${MAX_AGENT_COMMAND_REQUEST_BYTES / (1024 * 1024)}MB including attachments."
    }
    return null
}
