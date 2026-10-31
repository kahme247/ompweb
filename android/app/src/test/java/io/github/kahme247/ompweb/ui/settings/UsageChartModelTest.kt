package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.net.ModelUsageSummary
import io.github.kahme247.ompweb.net.UsageCostQuality
import io.github.kahme247.ompweb.net.UsageDaySummary
import io.github.kahme247.ompweb.net.UsageProjectSummary
import io.github.kahme247.ompweb.net.UsageReport
import io.github.kahme247.ompweb.net.UsageScanInfo
import io.github.kahme247.ompweb.net.UsageSummary
import io.github.kahme247.ompweb.net.UsageTimeSeriesPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A16: all series points, the cost/token metric mapping and the
 * "<first> to <last>" subtitle (web `UsageConfig.tsx:96-105,613-639`).
 */
class UsageChartModelTest {

    private fun points(count: Int): List<UsageTimeSeriesPoint> = (1..count).map { day ->
        UsageTimeSeriesPoint(
            date = "2026-10-${day.toString().padStart(2, '0')}",
            label = "Oct $day",
            totalCost = day * 0.5,
            totalTokens = day * 1_000L,
        )
    }

    private fun report(
        series: List<UsageTimeSeriesPoint> = points(3),
    ) = UsageReport(
        timeRange = "30d",
        granularity = "daily",
        summary = UsageSummary(
            totalCost = 3.0,
            totalTokens = 6_000,
            inputTokens = 4_000,
            outputTokens = 2_000,
            reasoningTokens = 0,
            cacheReadTokens = 0,
            cacheWriteTokens = 0,
            cacheSavings = 0.0,
            activeDays = 3,
            tokensPerActiveDay = 2_000,
            cachePercentage = 0.0,
            costQuality = UsageCostQuality(100.0, 0.0, 0.0),
        ),
        providers = emptyList(),
        timeSeries = series,
        modelBreakdown = listOf(
            ModelUsageSummary("gpt-x", "openai", cost = 2.0, tokens = 4_000, share = 66.7, recordsCount = 2),
        ),
        dayBreakdown = listOf(
            UsageDaySummary("2026-10-01", "Oct 1", cost = 1.0, tokens = 2_000, share = 33.3),
        ),
        projectBreakdown = listOf(
            UsageProjectSummary("C:/repo", "repo", cost = 3.0, tokens = 6_000, share = 100.0, sessionsCount = 1),
        ),
        scanInfo = UsageScanInfo(0, 0, 0, 0.0),
    )

    @Test
    fun `every series point becomes a bar, never a takeLast window`() {
        val bars = UsageChartModel.bars(points(40), UsageMetricView.COST)

        assertEquals(40, bars.size)
        assertEquals((0..39).toList(), bars.map { it.index })
        assertEquals("Oct 1", bars.first().label)
        assertEquals("Oct 40", bars.last().label)
    }

    @Test
    fun `the metric switches the bar values`() {
        val series = points(2)

        val cost = UsageChartModel.bars(series, UsageMetricView.COST)
        val tokens = UsageChartModel.bars(series, UsageMetricView.TOKENS)

        assertEquals(0.5, cost.first().value, 0.0001)
        assertEquals(1_000.0, tokens.first().value, 0.0001)
        // Both bars keep their own cost/token pair for the tooltip.
        assertEquals(1_000L, cost.first().tokens)
        assertEquals(0.5, tokens.first().cost, 0.0001)
    }

    @Test
    fun `the maximum is floored so a flat series stays drawable`() {
        val flat = listOf(UsageTimeSeriesPoint("2026-10-01", "Oct 1", totalCost = 0.0, totalTokens = 0))

        assertEquals(0.01, UsageChartModel.maxValue(flat, UsageMetricView.COST), 0.0001)
        assertEquals(100.0, UsageChartModel.maxValue(flat, UsageMetricView.TOKENS), 0.0001)
        // A zero series still draws the minimum bar height instead of vanishing.
        assertEquals(0.02f, UsageChartModel.bars(flat, UsageMetricView.COST).single().fraction, 0.0001f)
    }

    @Test
    fun `the tallest bar fills the chart and small bars stay visible`() {
        val series = listOf(
            UsageTimeSeriesPoint("2026-10-01", "Oct 1", totalCost = 10.0, totalTokens = 0),
            UsageTimeSeriesPoint("2026-10-02", "Oct 2", totalCost = 0.0, totalTokens = 0),
        )

        val bars = UsageChartModel.bars(series, UsageMetricView.COST)

        assertEquals(1f, bars.first().fraction, 0.0001f)
        assertEquals(0.02f, bars.last().fraction, 0.0001f)
    }

    @Test
    fun `the subtitle spans the first and last label`() {
        val subtitle = UsageChartModel.subtitle(points(7))!!

        assertEquals("Oct 1", subtitle.first)
        assertEquals("Oct 7", subtitle.last)
        assertFalse(subtitle.single)
    }

    @Test
    fun `a single point shows one label instead of a range`() {
        val subtitle = UsageChartModel.subtitle(points(1))!!

        assertEquals("Oct 1", subtitle.first)
        assertTrue(subtitle.single)
        assertNull(UsageChartModel.subtitle(emptyList()))
    }

    @Test
    fun `the breakdown follows the selected view`() {
        val usage = report()

        assertEquals(listOf("gpt-x"), UsageChartModel.breakdown(usage, UsageBreakdownView.MODEL).map { it.label })
        assertEquals(listOf("Oct 1"), UsageChartModel.breakdown(usage, UsageBreakdownView.DAY).map { it.label })
        assertEquals(listOf("repo"), UsageChartModel.breakdown(usage, UsageBreakdownView.PROJECT).map { it.label })
        // The model row keeps its provider as the detail line.
        assertEquals("openai", UsageChartModel.breakdown(usage, UsageBreakdownView.MODEL).single().detail)
    }

    @Test
    fun `an empty table is reported as empty`() {
        val usage = report().copy(modelBreakdown = emptyList())

        assertTrue(UsageChartModel.isEmpty(usage, UsageBreakdownView.MODEL))
        assertFalse(UsageChartModel.isEmpty(usage, UsageBreakdownView.DAY))
    }

    @Test
    fun `formatting matches the web helpers`() {
        assertEquals("$0.00", formatCurrency(0.0))
        assertEquals("$0.004", formatCurrency(0.004))
        assertEquals("$1,234.50", formatCurrency(1234.5))
        assertEquals("1.5K", formatTokens(1_500))
        assertEquals("10K", formatTokens(10_000))
        assertEquals("1.23M", formatTokens(1_230_000))
        assertEquals("0", formatTokens(0))
        assertEquals("50.0", formatPercent(50.0))
    }
}
