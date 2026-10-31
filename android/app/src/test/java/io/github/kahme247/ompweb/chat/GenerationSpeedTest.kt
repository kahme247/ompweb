package io.github.kahme247.ompweb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The rate metric: omp's committed numbers (`usage.output`, `duration`,
 * `ttft`, `completedAt`) and the streamed estimate that feeds the live value.
 */
class GenerationSpeedTest {

    private fun assistant(
        output: Int? = null,
        duration: Double? = null,
        ttft: Double? = null,
        completedAt: Long? = null,
        timestamp: Long? = null,
        stopReason: String? = null,
        blocks: List<AssistantBlock> = emptyList(),
    ) = ChatMessage.Assistant(
        key = "m",
        timestamp = timestamp,
        entryId = null,
        blocks = blocks,
        stopReason = stopReason,
        durationMs = duration,
        usageOutput = output,
        ttftMs = ttft,
        completedAt = completedAt,
    )

    private fun rate(message: ChatMessage.Assistant): Double? =
        messageSpeed(message)?.tokensPerSecond

    @Test
    fun `real sample A excludes the time to first token`() {
        val speed = messageSpeed(
            assistant(output = 7751, duration = 197638.7748, ttft = 2707.7157),
        )
        assertEquals(39.76, speed!!.tokensPerSecond, 0.02)
        assertEquals(7751, speed.outputTokens)
        assertEquals(194931L, speed.spanMs)
    }

    @Test
    fun `real sample B`() {
        assertEquals(
            46.55,
            rate(assistant(output = 526, duration = 17799.3082, ttft = 6500.3954))!!,
            0.02,
        )
    }

    @Test
    fun `real sample C`() {
        assertEquals(
            44.88,
            rate(assistant(output = 17130, duration = 386090.2889, ttft = 4398.5871))!!,
            0.02,
        )
    }

    @Test
    fun `without ttft the whole duration is the span`() {
        assertEquals(39.22, rate(assistant(output = 7751, duration = 197638.7748))!!, 0.02)
    }

    @Test
    fun `a sample whose generation lasted under a millisecond has no rate`() {
        assertNull(rate(assistant(output = 4, duration = 1155.4055, ttft = 1154.4604)))
    }

    @Test
    fun `completedAt minus timestamp is the fallback span`() {
        val message = assistant(
            output = 100,
            timestamp = 1_700_000_000_000L,
            completedAt = 1_700_000_002_000L,
        )
        assertEquals(50.0, rate(message)!!, 0.0001)
    }

    @Test
    fun `an error answer has no rate`() {
        assertNull(
            rate(assistant(output = 100, duration = 2000.0, stopReason = "error")),
        )
    }

    @Test
    fun `missing output and missing timestamps have no rate`() {
        assertNull(rate(assistant(duration = 2000.0)))
        assertNull(rate(assistant(output = 100)))
        assertNull(rate(assistant(output = 0, duration = 2000.0)))
    }

    @Test
    fun `a ttft beyond the duration falls back to the whole duration`() {
        assertEquals(
            50.0,
            rate(assistant(output = 100, duration = 2000.0, ttft = 2500.0))!!,
            0.0001,
        )
    }

    @Test
    fun `estimate counts ascii quarters and every other code point whole`() {
        val ascii = AssistantBlock.Text("a".repeat(400))
        val cjk = AssistantBlock.Text("漢".repeat(10))
        assertEquals(100.0, estimateStreamTokens(listOf(ascii)), 0.0001)
        assertEquals(10.0, estimateStreamTokens(listOf(cjk)), 0.0001)
        assertEquals(110.0, estimateStreamTokens(listOf(ascii, cjk)), 0.0001)
    }

    @Test
    fun `estimate includes thinking but not tool calls`() {
        val blocks = listOf(
            AssistantBlock.Thinking("abcd", deferred = false, blockIndex = 0),
            AssistantBlock.ToolCall("t1", "bash", kotlinx.serialization.json.JsonObject(emptyMap())),
        )
        assertEquals(1.0, estimateStreamTokens(blocks), 0.0001)
    }

    @Test
    fun `tracker reports the rate over the window`() {
        val tracker = StreamRateTracker()
        tracker.observe(100.0, at = 0L)
        tracker.observe(300.0, at = 2_000L)
        assertEquals(100.0, tracker.rate(2_000L)!!, 0.0001)
    }

    @Test
    fun `tracker hides a short and small window`() {
        val tracker = StreamRateTracker()
        tracker.observe(100.0, at = 0L)
        tracker.observe(105.0, at = 100L)
        assertNull(tracker.rate(100L))
    }

    @Test
    fun `tracker goes stale when the stream stops`() {
        val tracker = StreamRateTracker()
        tracker.observe(100.0, at = 0L)
        tracker.observe(300.0, at = 2_000L)
        assertNull("no delta for six seconds", tracker.rate(8_000L))
    }

    @Test
    fun `an unchanged estimate does not keep the window alive`() {
        val tracker = StreamRateTracker()
        tracker.observe(100.0, at = 0L)
        tracker.observe(300.0, at = 2_000L)
        // A poll of the same snapshot carries no delta: the newest real sample
        // keeps its timestamp, so the reading still ages out.
        tracker.observe(300.0, at = 3_500L)
        assertEquals(100.0, tracker.rate(3_500L)!!, 0.0001)
        assertNull("newest real delta was at 2 s", tracker.rate(4_100L))
    }

    @Test
    fun `a shrinking estimate starts over from the new baseline`() {
        val tracker = StreamRateTracker()
        tracker.observe(300.0, at = 0L)
        tracker.observe(100.0, at = 1_000L)
        tracker.observe(300.0, at = 2_000L)
        assertEquals(200.0, tracker.rate(2_000L)!!, 0.0001)
    }

    @Test
    fun `reset forgets every sample`() {
        val tracker = StreamRateTracker()
        tracker.observe(100.0, at = 0L)
        tracker.observe(300.0, at = 2_000L)
        tracker.reset()
        assertNull(tracker.rate(2_000L))
    }

    @Test
    fun `rate formatting is one decimal and locale independent`() {
        assertEquals("39.8", formatGenerationRate(39.7627))
        assertEquals("12.3", formatGenerationRate(12.34))
    }
}
