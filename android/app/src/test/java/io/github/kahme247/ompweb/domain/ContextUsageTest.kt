package io.github.kahme247.ompweb.domain

import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Mirrors the formatters `components/ComposerPanels.tsx` and
 * `components/ChatInput.tsx` rely on (`lib/format.ts`, `lib/subagent-format.ts`,
 * `formatUsageLimitLabel`, `readCompactResult`).
 */
class ContextUsageTest {

    private val utc = ZoneId.of("UTC")

    @Test
    fun `percent keeps one decimal and the dot separator`() {
        assertEquals("42.0%", formatPercent(42.0))
        assertEquals("7.5%", formatPercent(7.5))
        assertEquals("100.0%", formatPercent(100.0))
    }

    @Test
    fun `compact token counts match the web formatter`() {
        assertEquals("999", formatTokenCount(999))
        assertEquals("1k", formatTokenCount(1_234))
        assertEquals("2k", formatTokenCount(1_500))
        assertEquals("34k", formatTokenCount(34_000))
        assertEquals("1.0M", formatTokenCount(1_000_000))
        assertEquals("1.2M", formatTokenCount(1_200_000))
    }

    @Test
    fun `cache hit rate is cacheRead over input plus cacheRead`() {
        assertEquals(75.0, cacheHitRate(input = 100, cacheRead = 300)!!, 0.0001)
        assertEquals(0.0, cacheHitRate(input = 500, cacheRead = 0)!!, 0.0001)
        assertNull(cacheHitRate(input = 0, cacheRead = 0))
    }

    @Test
    fun `cost prints four decimals under a cent and two above it`() {
        assertNull(formatCost(null))
        assertNull(formatCost(0.0))
        assertNull(formatCost(-1.0))
        assertNull(formatCost(Double.NaN))
        assertEquals("\$0.0050", formatCost(0.005))
        assertEquals("\$1.20", formatCost(1.2))
    }

    @Test
    fun `the ring turns warning past 70 and error past 90`() {
        assertEquals(ContextTone.NORMAL, contextTone(null))
        assertEquals(ContextTone.NORMAL, contextTone(70.0))
        assertEquals(ContextTone.WARNING, contextTone(70.1))
        assertEquals(ContextTone.WARNING, contextTone(90.0))
        assertEquals(ContextTone.ERROR, contextTone(90.1))
    }

    @Test
    fun `allowance percentages drop the fraction only when it is zero`() {
        assertEquals("42", formatAllowancePercent(42.0))
        assertEquals("42.5", formatAllowancePercent(42.5))
    }

    @Test
    fun `a reset in the past or a missing one has no clock`() {
        val now = 1_000_000L
        assertNull(usableSlowModeResetTime(null, now))
        // Exactly now counts as past: the label would show a clock that already happened.
        assertNull(usableSlowModeResetTime(1_000L, now))
        assertNull(usableSlowModeResetTime(500L, now))
        assertEquals(2_000_000L, usableSlowModeResetTime(2_000L, now))
    }

    @Test
    fun `reset clock is a time today, or weekday plus time when further out`() {
        val now = java.time.Instant.parse("2026-01-01T12:00:00Z").toEpochMilli()
        val soon = java.time.Instant.parse("2026-01-01T15:30:00Z").toEpochMilli()
        val tomorrow = java.time.Instant.parse("2026-01-02T12:00:00Z").toEpochMilli()
        assertEquals("15:30", formatSlowModeResetClock(soon, now, utc, Locale.US))
        assertEquals("Fri 12:00", formatSlowModeResetClock(tomorrow, now, utc, Locale.US))
    }

    @Test
    fun `usage limit labels carry the reset instant and the low-priority arm's allowance`() {
        val now = 1_000_000L
        val lowPriority = UsageLimit(
            stage = UsageLimit.Stage.LOW_PRIORITY,
            resetsAtSec = 2_000L,
            allowanceLeftPercent = 42.5,
        )
        assertEquals(
            UsageLimitLabel.LowPriority(resetAtMillis = 2_000_000L, allowancePercent = 42.5),
            usageLimitLabel(lowPriority, now),
        )
        // A stale reset is dropped rather than printed.
        assertEquals(
            UsageLimitLabel.LowPriority(resetAtMillis = null, allowancePercent = null),
            usageLimitLabel(UsageLimit(UsageLimit.Stage.LOW_PRIORITY, resetsAtSec = 10L), now),
        )
        assertEquals(
            UsageLimitLabel.WrapUp(resetAtMillis = null, extraUsage = true),
            usageLimitLabel(UsageLimit(UsageLimit.Stage.WRAP_UP, extraUsage = true), now),
        )
    }

    @Test
    fun `context usage parses tokens, window and percent`() {
        val parsed = parseContextUsage(
            Json.parseToJsonElement("""{"tokens":1200,"contextWindow":200000,"percent":0.6}"""),
        )
        assertEquals(ContextUsageInfo(tokens = 1200, contextWindow = 200_000, percent = 0.6), parsed)
        assertNull(parseContextUsage(null))
        assertNull(parseContextUsage(JsonNull))
        // Without a window there is nothing to draw.
        assertNull(parseContextUsage(Json.parseToJsonElement("""{"tokens":12}""")))
        assertEquals(
            ContextUsageInfo(tokens = null, contextWindow = 1_000, percent = null),
            parseContextUsage(Json.parseToJsonElement("""{"contextWindow":1000}""")),
        )
    }

    @Test
    fun `compact results need tokensBefore and default the estimate`() {
        val result = readCompactResult(
            Json.parseToJsonElement("""{"tokensBefore":1000,"estimatedTokensAfter":250}"""),
            "manual",
        )
        assertEquals(CompactResult("manual", 1000, 250), result)
        assertEquals(750, result!!.savedTokens)
        assertEquals(
            CompactResult("auto", 500, 0),
            readCompactResult(Json.parseToJsonElement("""{"tokensBefore":500}"""), "auto"),
        )
        assertNull(readCompactResult(Json.parseToJsonElement("""{"estimatedTokensAfter":10}"""), "auto"))
        assertNull(readCompactResult(null, "auto"))
        // A shrinking estimate never reports negative savings.
        assertEquals(0, CompactResult("manual", 100, 200).savedTokens)
    }
}
