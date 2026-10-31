package io.github.kahme247.ompweb.chat

import io.github.kahme247.ompweb.domain.shortModel
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Which of the four date shapes a transcript timestamp needs (web `formatTime`). */
enum class TimeBucket { Today, Yesterday, SameYear, OlderYear }

/** Which label a transcript day separator carries. */
enum class DayBucket { Today, Yesterday, Date }

/** Who wrote a transcript block; drives the compact message header. */
enum class SpeakerRole { You, Assistant, Subagent }

/**
 * The speaker of one transcript block. [name] is the model's short name (web
 * `modelNames`) or the subagent's agent name; `null` means the UI falls back to
 * the role's localized default.
 */
data class Speaker(val role: SpeakerRole, val name: String? = null) {
    /** The single character of the round role badge. */
    val initial: Char
        get() = name?.firstOrNull()?.uppercaseChar() ?: when (role) {
            SpeakerRole.You -> 'Y'
            SpeakerRole.Assistant -> 'A'
            SpeakerRole.Subagent -> 'S'
        }
}

/** One transcript block that can carry a header, in render order. */
data class HeaderBlock(
    val key: String,
    val speaker: Speaker?,
    val timestamp: Long?,
)

/** Where a block's header goes. Null speakers never show one. */
data class HeaderSlot(
    val key: String,
    val showHeader: Boolean,
    val speaker: Speaker?,
    val timestamp: Long?,
)

/**
 * Pure transcript formatting: time buckets, day separators and speaker header
 * grouping. Everything that needs the platform's locale-aware formatters stays
 * in `ui.chat` (`ChatTimeFormatter`); this object only decides *which* shape a
 * timestamp needs and *whether* a header or separator is drawn, so the rules
 * are JVM-testable.
 */
object TranscriptFormat {

    /** Suffix of a turn group's assistant header block key. */
    const val ASSISTANT_HEADER_SUFFIX = ":assistant"

    /** The model name a header falls back to when the message has no model. */
    fun speakerOf(message: ChatMessage): Speaker? = when (message) {
        is ChatMessage.User -> if (message.branchSummary) null else Speaker(SpeakerRole.You)
        is ChatMessage.Assistant -> Speaker(
            SpeakerRole.Assistant,
            shortModel(message.model ?: message.provider),
        )
        else -> null
    }

    /** Every header-capable block of the rendered rows, in render order. */
    fun headerBlocks(rows: List<TranscriptRow>): List<HeaderBlock> = buildList {
        for (row in rows) {
            when (row) {
                is TranscriptRow.Message ->
                    add(HeaderBlock(row.key, speakerOf(row.message), row.message.timestamp))
                is TranscriptRow.Group -> {
                    // A turn group renders its user anchor, then one assistant block.
                    add(HeaderBlock(row.key, speakerOf(row.anchor), row.anchor.timestamp))
                    add(assistantHeaderBlock(row))
                }
            }
        }
    }

    private fun assistantHeaderBlock(group: TranscriptRow.Group): HeaderBlock {
        var firstAssistant: ChatMessage.Assistant? = null
        for (segment in group.segments) {
            when (segment) {
                is TurnSegment.Text -> {
                    firstAssistant = segment.message
                }
                is TurnSegment.Activity -> {
                    firstAssistant = segment.pieces
                        .map { it.message }
                        .filterIsInstance<ChatMessage.Assistant>()
                        .firstOrNull()
                }
            }
            if (firstAssistant != null) break
        }
        val message = firstAssistant
        return HeaderBlock(
            key = group.key + ASSISTANT_HEADER_SUFFIX,
            speaker = message?.let(::speakerOf) ?: Speaker(SpeakerRole.Assistant),
            timestamp = message?.timestamp ?: group.anchor.timestamp,
        )
    }

    /**
     * A header is drawn once per run of blocks by the same speaker, and a new
     * calendar day always starts a new header. Day separators are a per-element
     * concern of the rendered transcript ([daySeparators]), so a change of day
     * inside one turn or in the live tail is never lost.
     */
    fun headerPlan(
        blocks: List<HeaderBlock>,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<HeaderSlot> {
        var previousSpeaker: Speaker? = null
        var previousDay: LocalDate? = null
        return blocks.mapIndexed { index, block ->
            val day = block.timestamp?.let { dayOf(it, zone) }
            val startsDay = index > 0 && day != null && previousDay != null && day != previousDay
            val showHeader = block.speaker != null &&
                (previousSpeaker == null || block.speaker != previousSpeaker || startsDay)
            if (block.speaker != null) previousSpeaker = block.speaker
            if (day != null) previousDay = day
            HeaderSlot(
                key = block.key,
                showHeader = showHeader,
                speaker = block.speaker,
                timestamp = block.timestamp,
            )
        }
    }

    /** [headerPlan] keyed by block, ready for a keyed lookup from the renderer. */
    fun headerSlots(
        blocks: List<HeaderBlock>,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Map<String, HeaderSlot> = headerPlan(blocks, zone).associateBy { it.key }

    // ------------------------------------------------------------ visibility

    /**
     * Whether the transcript draws [message] at all. A hidden assistant
     * message (thinking-only with "hide thinking", an empty reply, a tool
     * result) must not consume a speaker header or a day separator.
     */
    fun isVisible(message: ChatMessage, hideThinking: Boolean = false): Boolean = when (message) {
        is ChatMessage.Assistant -> assistantVisible(message, hideThinking)
        is ChatMessage.ToolResult, is ChatMessage.Other -> false
        is ChatMessage.Custom -> when {
            message.customType == PASSIVE_TOOL_CONTEXT || message.customType == MOUNT_NOTICE -> false
            message.customType == "compaction" -> true
            else -> message.display
        }
        is ChatMessage.User, is ChatMessage.BashExecution -> true
    }

    /**
     * Whether the assistant row renders: `AssistantRow` returns before its
     * column when there is no displayable block, no error and no stream.
     */
    fun assistantVisible(message: ChatMessage.Assistant, hideThinking: Boolean = false): Boolean {
        if (message.errorMessage != null || message.streaming) return true
        return TranscriptPlan.displayableBlocks(message).any { block ->
            !(hideThinking && block is AssistantBlock.Thinking)
        }
    }

    /**
     * The first assistant message in `[startIndex, endIndex)` that actually
     * draws something. The live tail must hang its speaker header on that
     * message, not on an invisible one above it.
     */
    fun firstVisibleAssistantIndex(
        messages: List<ChatMessage>,
        startIndex: Int,
        endIndex: Int,
        hideThinking: Boolean = false,
    ): Int? {
        for (index in startIndex until endIndex.coerceAtMost(messages.size)) {
            val message = messages[index] as? ChatMessage.Assistant ?: continue
            if (assistantVisible(message, hideThinking)) return index
        }
        return null
    }

    // -------------------------------------------------------- day separators

    /**
     * Every place the folded transcript changes calendar day, keyed by the
     * element that draws the separator: a row key, a group's assistant header
     * key, or a turn segment key. Derived from the rendered sequence, not from
     * the header blocks, so a change inside one turn is a separator of its own.
     * The first element of the window never draws one.
     */
    fun daySeparators(
        rows: List<TranscriptRow>,
        hideThinking: Boolean = false,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Map<String, Long> {
        val elements = LinkedHashMap<String, Long>()
        var previousDay: LocalDate? = null

        fun visit(key: String, timestamp: Long?) {
            if (timestamp == null) return
            val day = dayOf(timestamp, zone)
            if (previousDay != null && previousDay != day) elements[key] = timestamp
            previousDay = day
        }

        for (row in rows) {
            when (row) {
                is TranscriptRow.Message -> {
                    if (isVisible(row.message, hideThinking)) visit(row.key, row.message.timestamp)
                }
                is TranscriptRow.Group -> {
                    visit(row.key, row.anchor.timestamp)
                    val header = assistantHeaderBlock(row)
                    visit(row.key + ASSISTANT_HEADER_SUFFIX, header.timestamp)
                    for (segment in row.segments) {
                        when (segment) {
                            is TurnSegment.Text -> visit(segment.key, segment.message.timestamp)
                            is TurnSegment.Activity -> {
                                // The fold is one element: a day change inside it
                                // is a separator above the fold.
                                var breakAt: Long? = null
                                for (piece in segment.pieces) {
                                    val timestamp = piece.message.timestamp ?: continue
                                    val day = dayOf(timestamp, zone)
                                    if (breakAt == null && previousDay != null && previousDay != day) {
                                        breakAt = timestamp
                                    }
                                    previousDay = day
                                }
                                if (breakAt != null) elements[segment.key] = breakAt
                            }
                        }
                    }
                }
            }
        }
        return elements
    }

    /**
     * Day separators of the flat live tail, keyed by message key. The run
     * starts at [startIndex]'s day, so its anchor never repeats a separator the
     * row above it already drew; invisible messages are skipped like the tail
     * does.
     */
    fun messageDaySeparators(
        messages: List<ChatMessage>,
        startIndex: Int,
        endIndex: Int,
        hideThinking: Boolean = false,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Map<String, Long> {
        val breaks = LinkedHashMap<String, Long>()
        var previousDay: LocalDate? = messages.getOrNull(startIndex)?.timestamp?.let { dayOf(it, zone) }
        for (index in (startIndex + 1) until endIndex.coerceAtMost(messages.size)) {
            val message = messages[index]
            if (!isVisible(message, hideThinking)) continue
            val timestamp = message.timestamp ?: continue
            val day = dayOf(timestamp, zone)
            if (previousDay != null && previousDay != day) breaks[message.key] = timestamp
            previousDay = day
        }
        return breaks
    }

    fun timeBucket(
        timestamp: Long,
        now: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): TimeBucket {
        val day = dayOf(timestamp, zone)
        val today = dayOf(now, zone)
        return when {
            day == today -> TimeBucket.Today
            day == today.minusDays(1) -> TimeBucket.Yesterday
            day.year == today.year -> TimeBucket.SameYear
            else -> TimeBucket.OlderYear
        }
    }

    fun dayBucket(
        timestamp: Long,
        now: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): DayBucket = when (timeBucket(timestamp, now, zone)) {
        TimeBucket.Today -> DayBucket.Today
        TimeBucket.Yesterday -> DayBucket.Yesterday
        TimeBucket.SameYear, TimeBucket.OlderYear -> DayBucket.Date
    }

    /**
     * `12 s`, `3 min 05 s`, `1 h 04 min`: the short duration an activity row
     * shows for a running call and, once it settles, its final duration.
     */
    fun formatElapsedShort(elapsedMs: Long): String {
        val total = elapsedMs.coerceAtLeast(0) / 1000
        val hours = total / 3600
        val minutes = (total % 3600) / 60
        val seconds = total % 60
        return when {
            hours > 0 -> "$hours h ${minutes.toString().padStart(2, '0')} min"
            minutes > 0 -> "$minutes min ${seconds.toString().padStart(2, '0')} s"
            else -> "$seconds s"
        }
    }

    /**
     * When the running turn started. A run this client sent knows its prompt
     * time, so a tool start or a steering message cannot reset the timer; a
     * run observed from outside falls back to its earliest running tool, then
     * to the newest prompt.
     */
    fun turnStartedAt(state: ChatState): Long? =
        state.runStartedAt
            ?: state.liveTools.filter { it.endedAt == null }.minOfOrNull { it.startedAt }
            ?: state.messages.lastOrNull { it is ChatMessage.User }?.timestamp

    private fun dayOf(timestamp: Long, zone: ZoneId): LocalDate =
        Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
}
