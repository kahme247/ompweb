package io.github.kahme247.ompweb.chat

import java.time.ZoneId
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transcript's pure formatting rules: which date shape a timestamp needs,
 * where day separators go and which blocks share a speaker header. The
 * Android-side rendering only asks this helper and formats the result.
 */
class TranscriptFormatTest {

    private val zone = ZoneId.of("Europe/Berlin")

    /** 2026-10-26 12:00 in [zone] (CET, UTC+1). */
    private val now = 1793012400000L

    private fun stamp(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long =
        java.time.ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zone)
            .toInstant()
            .toEpochMilli()

    // ------------------------------------------------------------- time buckets

    @Test
    fun `a timestamp later today is today`() {
        assertEquals(TimeBucket.Today, TranscriptFormat.timeBucket(stamp(2026, 10, 26, 23, 59), now, zone))
        assertEquals(TimeBucket.Today, TranscriptFormat.timeBucket(stamp(2026, 10, 26, 0, 1), now, zone))
    }

    @Test
    fun `the day before is yesterday and two days back is this year`() {
        assertEquals(TimeBucket.Yesterday, TranscriptFormat.timeBucket(stamp(2026, 10, 25, 23, 59), now, zone))
        assertEquals(TimeBucket.SameYear, TranscriptFormat.timeBucket(stamp(2026, 10, 24, 23, 59), now, zone))
    }

    @Test
    fun `a previous year is the older shape`() {
        assertEquals(TimeBucket.OlderYear, TranscriptFormat.timeBucket(stamp(2025, 12, 31, 23, 59), now, zone))
    }

    @Test
    fun `a timestamp in the future keeps its bucket`() {
        assertEquals(TimeBucket.SameYear, TranscriptFormat.timeBucket(stamp(2026, 11, 2, 9, 0), now, zone))
    }

    @Test
    fun `day buckets name today and yesterday and leave the rest to a date`() {
        assertEquals(DayBucket.Today, TranscriptFormat.dayBucket(stamp(2026, 10, 26, 8, 0), now, zone))
        assertEquals(DayBucket.Yesterday, TranscriptFormat.dayBucket(stamp(2026, 10, 25, 8, 0), now, zone))
        assertEquals(DayBucket.Date, TranscriptFormat.dayBucket(stamp(2026, 10, 20, 8, 0), now, zone))
        assertEquals(DayBucket.Date, TranscriptFormat.dayBucket(stamp(2025, 10, 20, 8, 0), now, zone))
    }

    // ----------------------------------------------------------- elapsed shapes

    @Test
    fun `elapsed time reads as seconds, minutes and hours`() {
        assertEquals("0 s", TranscriptFormat.formatElapsedShort(0))
        assertEquals("12 s", TranscriptFormat.formatElapsedShort(12_400))
        assertEquals("59 s", TranscriptFormat.formatElapsedShort(59_999))
        assertEquals("1 min 00 s", TranscriptFormat.formatElapsedShort(60_000))
        assertEquals("3 min 05 s", TranscriptFormat.formatElapsedShort(185_000))
        assertEquals("1 h 00 min", TranscriptFormat.formatElapsedShort(3_600_000))
        assertEquals("1 h 02 min", TranscriptFormat.formatElapsedShort(3_725_000))
    }

    @Test
    fun `a clock that went backwards never shows a negative time`() {
        assertEquals("0 s", TranscriptFormat.formatElapsedShort(-5_000))
    }

    // ------------------------------------------------------------ header blocks

    @Test
    fun `consecutive blocks of the same speaker share one header`() {
        val blocks = listOf(
            HeaderBlock("u1", Speaker(SpeakerRole.You), now),
            HeaderBlock("a1", Speaker(SpeakerRole.Assistant, "deepseek-v4.1-flash"), now),
            HeaderBlock("a2", Speaker(SpeakerRole.Assistant, "deepseek-v4.1-flash"), now + 1_000),
            HeaderBlock("u2", Speaker(SpeakerRole.You), now + 2_000),
        )
        val slots = TranscriptFormat.headerPlan(blocks, zone)
        assertEquals(listOf(true, true, false, true), slots.map { it.showHeader })
    }

    @Test
    fun `a new day always starts a header`() {
        val yesterday = stamp(2026, 10, 25, 23, 50)
        val blocks = listOf(
            HeaderBlock("u1", Speaker(SpeakerRole.You), yesterday),
            HeaderBlock("a1", Speaker(SpeakerRole.Assistant), yesterday + 60_000),
            HeaderBlock("a2", Speaker(SpeakerRole.Assistant), stamp(2026, 10, 26, 0, 1)),
        )
        val slots = TranscriptFormat.headerPlan(blocks, zone)
        assertEquals(listOf(true, true, true), slots.map { it.showHeader })
    }

    @Test
    fun `a block without a speaker neither draws a header nor breaks a run`() {
        val blocks = listOf(
            HeaderBlock("a1", Speaker(SpeakerRole.Assistant), now),
            HeaderBlock("custom", null, now + 1_000),
            HeaderBlock("a2", Speaker(SpeakerRole.Assistant), now + 2_000),
        )
        val slots = TranscriptFormat.headerPlan(blocks, zone)
        assertEquals(listOf(true, false, false), slots.map { it.showHeader })
    }

    @Test
    fun `the first block always shows its header`() {
        val slots = TranscriptFormat.headerPlan(
            listOf(HeaderBlock("u1", Speaker(SpeakerRole.You), now)),
            zone,
        )
        assertTrue(slots.single().showHeader)
    }

    @Test
    fun `the header plan is addressable by block key`() {
        val slots = TranscriptFormat.headerSlots(
            listOf(
                HeaderBlock("turn:u1", Speaker(SpeakerRole.You), now),
                HeaderBlock("turn:u1:assistant", Speaker(SpeakerRole.Assistant, "glm-5"), now + 1_000),
            ),
            zone,
        )
        assertTrue(slots.getValue("turn:u1").showHeader)
        assertTrue(slots.getValue("turn:u1:assistant").showHeader)
        assertEquals("glm-5", slots.getValue("turn:u1:assistant").speaker?.name)
    }

    // ------------------------------------------------------------ header blocks

    @Test
    fun `a turn group gets a user header and one assistant header`() {
        val user = ChatMessage.User("u1", now, "entry-u1", "run it")
        val answer = ChatMessage.Assistant(
            key = "a1",
            timestamp = now + 2_000,
            entryId = "entry-a1",
            blocks = listOf(AssistantBlock.Text("done")),
            model = "deepseek/deepseek-v4.1-flash:high",
            provider = "deepseek",
        )
        val rows = listOf(
            TranscriptRow.Group(
                anchor = user,
                anchorIndex = 0,
                endIndex = 2,
                segments = listOf(
                    TurnSegment.Text(
                        message = answer,
                        messageIndex = 1,
                        blocks = answer.blocks,
                        last = true,
                        key = "text:a1:0",
                    ),
                ),
            ),
        )
        val blocks = TranscriptFormat.headerBlocks(rows)
        assertEquals(
            listOf("turn:u1", "turn:u1" + TranscriptFormat.ASSISTANT_HEADER_SUFFIX),
            blocks.map { it.key },
        )
        assertEquals(SpeakerRole.You, blocks[0].speaker?.role)
        assertEquals(SpeakerRole.Assistant, blocks[1].speaker?.role)
        assertEquals("deepseek-v4.1-flash", blocks[1].speaker?.name)
        assertEquals(now + 2_000, blocks[1].timestamp)
    }

    @Test
    fun `a turn group without an assistant message still gets an assistant header`() {
        val user = ChatMessage.User("u1", now, "entry-u1", "run it")
        val bash = ChatMessage.BashExecution(
            key = "b1",
            timestamp = now + 1_000,
            entryId = null,
            command = "ls",
            output = "",
            exitCode = null,
        )
        val rows = listOf(
            TranscriptRow.Group(
                anchor = user,
                anchorIndex = 0,
                endIndex = 2,
                segments = listOf(
                    TurnSegment.Activity(
                        pieces = listOf(ActivityPiece(bash, 1)),
                        stepCount = 1,
                        toolCallCount = 0,
                        key = "activity:u1:0",
                    ),
                ),
            ),
        )
        val blocks = TranscriptFormat.headerBlocks(rows)
        assertEquals(SpeakerRole.Assistant, blocks[1].speaker?.role)
        assertNull(blocks[1].speaker?.name)
        assertEquals(now, blocks[1].timestamp)
    }

    @Test
    fun `standalone messages carry their own speaker block`() {
        val rows = listOf(
            TranscriptRow.Message(ChatMessage.User("u1", now, null, "hi")),
            TranscriptRow.Message(ChatMessage.ToolResult("r1", now, null, "t1", "read", "x")),
        )
        val blocks = TranscriptFormat.headerBlocks(rows)
        assertEquals(2, blocks.size)
        assertEquals(SpeakerRole.You, blocks[0].speaker?.role)
        assertNull(blocks[1].speaker)
    }

    // ---------------------------------------------------------------- speakers

    @Test
    fun `the assistant header names the message's model`() {
        val message = ChatMessage.Assistant(
            key = "a1",
            timestamp = now,
            entryId = null,
            blocks = emptyList(),
            model = "anthropic/claude-sonnet-4:high",
            provider = "anthropic",
        )
        val speaker = TranscriptFormat.speakerOf(message)
        assertEquals(SpeakerRole.Assistant, speaker?.role)
        assertEquals("claude-sonnet-4", speaker?.name)
    }

    @Test
    fun `an assistant without a model falls back to the localized default`() {
        val message = ChatMessage.Assistant("a1", now, null, emptyList())
        val speaker = TranscriptFormat.speakerOf(message)
        assertEquals(SpeakerRole.Assistant, speaker?.role)
        assertNull(speaker?.name)
        assertEquals('A', speaker?.initial)
    }

    @Test
    fun `a user header is You and a branch summary has none`() {
        assertEquals(SpeakerRole.You, TranscriptFormat.speakerOf(ChatMessage.User("u1", now, null, "x"))?.role)
        assertNull(TranscriptFormat.speakerOf(ChatMessage.User("u1", now, null, "x", branchSummary = true)))
        assertNull(TranscriptFormat.speakerOf(ChatMessage.ToolResult("r1", now, null, "t1", "bash", "x")))
    }

    @Test
    fun `the badge initial comes from the speaker name`() {
        assertEquals('Y', Speaker(SpeakerRole.You).initial)
        assertEquals('D', Speaker(SpeakerRole.Assistant, "deepseek-v4.1-flash").initial)
        assertEquals('E', Speaker(SpeakerRole.Subagent, "explore").initial)
        assertEquals('S', Speaker(SpeakerRole.Subagent).initial)
    }

    // ------------------------------------------------------------ turn timing

    @Test
    fun `a day change inside one turn draws its own separator`() {
        val user = ChatMessage.User("u1", stamp(2026, 10, 25, 23, 50), null, "go")
        val first = ChatMessage.Assistant(
            key = "a1",
            timestamp = stamp(2026, 10, 25, 23, 51),
            entryId = null,
            blocks = listOf(AssistantBlock.Text("before midnight")),
        )
        val second = ChatMessage.Assistant(
            key = "a2",
            timestamp = stamp(2026, 10, 26, 0, 10),
            entryId = null,
            blocks = listOf(AssistantBlock.Text("after midnight")),
        )
        val rows = listOf(
            TranscriptRow.Group(
                anchor = user,
                anchorIndex = 0,
                endIndex = 3,
                segments = listOf(
                    TurnSegment.Text(first, 1, first.blocks, last = false, key = "text:a1:0"),
                    TurnSegment.Text(second, 2, second.blocks, last = true, key = "text:a2:1"),
                ),
            ),
        )

        val breaks = TranscriptFormat.daySeparators(rows, zone = zone)

        assertEquals(setOf("text:a2:1"), breaks.keys)
        assertEquals(stamp(2026, 10, 26, 0, 10), breaks.getValue("text:a2:1"))
    }

    @Test
    fun `a standalone message on a new day draws a separator even without a speaker`() {
        val user = ChatMessage.User("u1", stamp(2026, 10, 25, 23, 50), null, "go")
        val notice = ChatMessage.Custom(
            key = "notice",
            timestamp = stamp(2026, 10, 26, 0, 5),
            entryId = null,
            customType = "async-result",
            text = "done",
        )
        val next = ChatMessage.User("u2", stamp(2026, 10, 26, 0, 6), null, "next")

        val breaks = TranscriptFormat.daySeparators(
            listOf(
                TranscriptRow.Message(user),
                TranscriptRow.Message(notice),
                TranscriptRow.Message(next),
            ),
            zone = zone,
        )

        assertEquals(setOf("message:notice"), breaks.keys)
    }

    @Test
    fun `an invisible assistant message does not carry the day change`() {
        val user = ChatMessage.User("u1", stamp(2026, 10, 25, 23, 50), null, "go")
        val thinkingOnly = ChatMessage.Assistant(
            key = "a1",
            timestamp = stamp(2026, 10, 26, 0, 2),
            entryId = null,
            blocks = listOf(AssistantBlock.Thinking("hmm", deferred = false, blockIndex = 0)),
        )
        val answer = ChatMessage.Assistant(
            key = "a2",
            timestamp = stamp(2026, 10, 26, 0, 10),
            entryId = null,
            blocks = listOf(AssistantBlock.Text("done")),
        )
        val rows = listOf(
            TranscriptRow.Message(user),
            TranscriptRow.Message(thinkingOnly),
            TranscriptRow.Message(answer),
        )

        val hidden = TranscriptFormat.daySeparators(rows, hideThinking = true, zone = zone)
        val shown = TranscriptFormat.daySeparators(rows, hideThinking = false, zone = zone)

        assertEquals(setOf("message:a2"), hidden.keys)
        assertEquals(setOf("message:a1"), shown.keys)
    }

    @Test
    fun `the live tail separates visible messages across midnight`() {
        val user = ChatMessage.User("u1", stamp(2026, 10, 25, 23, 50), null, "go")
        val invisible = ChatMessage.Assistant(
            key = "a1",
            timestamp = stamp(2026, 10, 26, 0, 1),
            entryId = null,
            blocks = listOf(AssistantBlock.Thinking("hmm", deferred = false, blockIndex = 0)),
        )
        val answer = ChatMessage.Assistant(
            key = "a2",
            timestamp = stamp(2026, 10, 26, 0, 10),
            entryId = null,
            blocks = listOf(AssistantBlock.Text("done")),
        )
        val messages = listOf(user, invisible, answer)

        val breaks = TranscriptFormat.messageDaySeparators(
            messages = messages,
            startIndex = 0,
            endIndex = messages.size,
            hideThinking = true,
            zone = zone,
        )

        assertEquals(setOf("a2"), breaks.keys)
    }

    @Test
    fun `the live tail header hangs on the first visible assistant`() {
        val user = ChatMessage.User("u1", now, null, "go")
        val thinkingOnly = ChatMessage.Assistant(
            key = "a1",
            timestamp = now + 1_000,
            entryId = null,
            blocks = listOf(AssistantBlock.Thinking("hmm", deferred = false, blockIndex = 0)),
        )
        val answer = ChatMessage.Assistant(
            key = "a2",
            timestamp = now + 2_000,
            entryId = null,
            blocks = listOf(AssistantBlock.Text("done")),
        )
        val messages = listOf(user, thinkingOnly, answer)

        assertEquals(
            2,
            TranscriptFormat.firstVisibleAssistantIndex(messages, 0, messages.size, hideThinking = true),
        )
        assertEquals(
            1,
            TranscriptFormat.firstVisibleAssistantIndex(messages, 0, messages.size, hideThinking = false),
        )
    }

    @Test
    fun `the turn timer starts at the prompt and never resets on a tool or steering`() {
        val state = ChatState(
            runStartedAt = 1_000,
            messages = listOf(
                ChatMessage.User("u1", 1_000, null, "go"),
                ChatMessage.Assistant("a1", 2_000, null, emptyList()),
                ChatMessage.User("u2", 7_000, null, "steer"),
            ),
            liveTools = listOf(LiveTool("t1", "bash", buildJsonObject { }, null, startedAt = 5_000)),
        )

        assertEquals(1_000L, TranscriptFormat.turnStartedAt(state))
    }

    @Test
    fun `a running turn starts with its earliest running tool`() {
        val state = ChatState(
            messages = listOf(ChatMessage.User("u1", 1_000, null, "go")),
            liveTools = listOf(
                LiveTool("t1", "bash", buildJsonObject { }, null, startedAt = 5_000),
                LiveTool("t2", "read", buildJsonObject { }, null, startedAt = 3_000),
                LiveTool("t0", "bash", buildJsonObject { }, null, startedAt = 2_000, endedAt = 4_000),
            ),
        )
        assertEquals(3_000L, TranscriptFormat.turnStartedAt(state))
    }

    @Test
    fun `without a running tool the newest prompt starts the turn`() {
        val state = ChatState(
            messages = listOf(
                ChatMessage.User("u1", 1_000, null, "first"),
                ChatMessage.Assistant("a1", 2_000, null, emptyList()),
                ChatMessage.User("u2", 7_000, null, "second"),
            ),
        )
        assertEquals(7_000L, TranscriptFormat.turnStartedAt(state))
    }

    @Test
    fun `an idle transcript has no turn start`() {
        assertNull(TranscriptFormat.turnStartedAt(ChatState()))
    }
}
