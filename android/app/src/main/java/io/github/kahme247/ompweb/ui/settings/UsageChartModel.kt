package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.net.UsageDaySummary
import io.github.kahme247.ompweb.net.UsageReport
import io.github.kahme247.ompweb.net.UsageTimeSeriesPoint
import java.util.Locale
import kotlin.math.max

/** Web `metricView` (`UsageConfig.tsx`): what the bars and the tooltip show. */
enum class UsageMetricView {
    COST,
    TOKENS,
}

/** Web `breakdownView`: which table the Breakdown card shows. */
enum class UsageBreakdownView {
    MODEL,
    DAY,
    PROJECT,
}

/** One bar of the time-series chart. */
data class UsageBar(
    val index: Int,
    val label: String,
    val cost: Double,
    val tokens: Long,
    /** The selected metric for this bar. */
    val value: Double,
    /** Height against [UsageChartModel.maxValue]; never zero so a tiny bar stays visible. */
    val fraction: Float,
)

/** The web's chart heading: the first and last visible period. */
data class UsageChartSubtitle(val first: String, val last: String) {
    /** A one-point series or a single month shows one label instead of "X to X". */
    val single: Boolean get() = first == last
}

/** One row of the breakdown table, whichever list it came from. */
data class UsageBreakdownRow(
    val label: String,
    val detail: String?,
    val cost: Double,
    val tokens: Long,
    val share: Double,
)

/**
 * The pure half of the Usage tab: the web renders every time-series point
 * (an SVG scaled to the width, `UsageConfig.tsx:613-639`) and derives the
 * chart label from the first and last point (`:96-105`). Keeping it out of
 * the composable makes the counts testable.
 */
object UsageChartModel {

    /** Web `valueOf`: the metric the bars and the tooltip read. */
    fun valueOf(point: UsageTimeSeriesPoint, metric: UsageMetricView): Double = when (metric) {
        UsageMetricView.COST -> point.totalCost
        UsageMetricView.TOKENS -> point.totalTokens.toDouble()
    }

    /** Web `maxValue`: at least 0.01 (cost) / 100 (tokens) so a flat series does not divide by zero. */
    fun maxValue(points: List<UsageTimeSeriesPoint>, metric: UsageMetricView): Double {
        val observed = points.maxOfOrNull { valueOf(it, metric) } ?: 0.0
        return max(observed, if (metric == UsageMetricView.COST) 0.01 else 100.0)
    }

    /** Every point, in report order — the web never truncates the series. */
    fun bars(points: List<UsageTimeSeriesPoint>, metric: UsageMetricView): List<UsageBar> {
        val maximum = maxValue(points, metric)
        return points.mapIndexed { index, point ->
            val value = valueOf(point, metric)
            UsageBar(
                index = index,
                label = point.label.ifBlank { point.date },
                cost = point.totalCost,
                tokens = point.totalTokens,
                value = value,
                fraction = (value / maximum).toFloat().coerceIn(MIN_BAR_FRACTION, 1f),
            )
        }
    }

    /**
     * The web's subtitle: the first and last label, collapsed to a single
     * label when both are equal (a one-point series or a single month).
     */
    fun subtitle(points: List<UsageTimeSeriesPoint>): UsageChartSubtitle? {
        if (points.isEmpty()) return null
        val first = points.first().label.ifBlank { points.first().date }
        val last = points.last().label.ifBlank { points.last().date }
        return UsageChartSubtitle(first = first, last = last)
    }

    /** Rows for [view]; each list is already sorted by the server. */
    fun breakdown(report: UsageReport, view: UsageBreakdownView): List<UsageBreakdownRow> = when (view) {
        UsageBreakdownView.MODEL -> report.modelBreakdown.map { model ->
            UsageBreakdownRow(
                label = model.model,
                detail = model.provider.takeIf { it.isNotBlank() },
                cost = model.cost,
                tokens = model.tokens,
                share = model.share,
            )
        }
        UsageBreakdownView.DAY -> report.dayBreakdown.map { day -> day.toRow() }
        UsageBreakdownView.PROJECT -> report.projectBreakdown.map { project ->
            UsageBreakdownRow(
                label = project.projectName,
                detail = project.project.takeIf { it.isNotBlank() && it != project.projectName },
                cost = project.cost,
                tokens = project.tokens,
                share = project.share,
            )
        }
    }

    /** True when the selected table has nothing to show for this report. */
    fun isEmpty(report: UsageReport, view: UsageBreakdownView): Boolean = breakdown(report, view).isEmpty()

    private fun UsageDaySummary.toRow(): UsageBreakdownRow = UsageBreakdownRow(
        label = label.ifBlank { date },
        detail = null,
        cost = cost,
        tokens = tokens,
        share = share,
    )

    private const val MIN_BAR_FRACTION = 0.02f
}

/** The web's `formatCurrency` (`UsageConfig.tsx`), including its 3-decimal band. */
internal fun formatCurrency(value: Double): String = when {
    value == 0.0 || !value.isFinite() -> "$0.00"
    value < 0.01 && value > 0.0 -> String.format(Locale.US, "$%.3f", value)
    else -> String.format(Locale.US, "$%,.2f", value)
}

/** The web's `formatTokens` (`UsageConfig.tsx`): `1.5K`, `10K`, `1.23M`. */
internal fun formatTokens(count: Long): String = when {
    count <= 0L -> "0"
    count < 1_000L -> count.toString()
    count < 1_000_000L ->
        if (count % 1_000L == 0L) "${count / 1_000L}K" else String.format(Locale.US, "%.1fK", count / 1_000.0)
    count < 1_000_000_000L ->
        if (count % 1_000_000L == 0L) "${count / 1_000_000L}M" else String.format(Locale.US, "%.2fM", count / 1_000_000.0)
    else -> String.format(Locale.US, "%.2fB", count / 1_000_000_000.0)
}

/** One decimal, no suffix: the surrounding string resource adds `%` (web `toFixed(1)`). */
internal fun formatPercent(value: Double): String = String.format(Locale.US, "%.1f", value)
