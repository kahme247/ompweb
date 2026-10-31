package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageWindow

/**
 * The share of a limit from which the sessions list warns. The provider block
 * paints the same value as an error (web `usageTone`), so the warning row and
 * the full block agree on when a window is tight.
 */
const val PROVIDER_USAGE_WARNING_PERCENT: Double = 80.0

/** One account's windows in the block's fixed order (`5H`, `7D`, `30D`). */
fun providerUsageWindows(report: ProviderUsageReport): List<Pair<String, ProviderUsageWindow>> =
    buildList {
        report.fiveHour?.let { add("5H" to it) }
        report.sevenDay?.let { add("7D" to it) }
        report.monthly?.let { add("30D" to it) }
    }

/** The account line the usage block prints: label (provider), plan, `#index`. */
fun providerUsageAccountLabel(report: ProviderUsageReport): String = buildString {
    append(report.accountLabel ?: report.provider)
    if (report.plan != null) append(" · ").append(report.plan)
    if (report.accountIndex != null) append(" #").append(report.accountIndex)
}

/** The account's most-used window, or null when it reports no limit at all. */
fun providerUsageWorstWindow(report: ProviderUsageReport): Pair<String, ProviderUsageWindow>? =
    providerUsageWindows(report).maxByOrNull { it.second.percent }

/**
 * The single line the sessions list shows while a limit is tight.
 *
 * [percent] is the raw share rounded to whole percent; [account] stays the
 * full label, the row ellipsizes it in layout so the window and the percentage
 * never scroll out of view.
 */
data class ProviderUsageWarning(
    val account: String,
    val window: String,
    val percent: Int,
)

/**
 * The worst account window across [reports], as long as at least one window
 * reached [threshold] (>=, so exactly 80 % warns). Returns null otherwise —
 * the sessions list then shows no row at all and keeps its full height.
 *
 * Ties keep the first account/window in the report order, which is also the
 * order the Settings block prints.
 */
fun providerUsageWarning(
    reports: List<ProviderUsageReport>,
    threshold: Double = PROVIDER_USAGE_WARNING_PERCENT,
): ProviderUsageWarning? {
    var bestAccount: String? = null
    var bestWindow: String? = null
    var bestPercent = Double.NEGATIVE_INFINITY
    for (report in reports) {
        for ((short, window) in providerUsageWindows(report)) {
            if (window.percent < threshold || window.percent <= bestPercent) continue
            bestAccount = providerUsageAccountLabel(report)
            bestWindow = short
            bestPercent = window.percent
        }
    }
    val account = bestAccount ?: return null
    val window = bestWindow ?: return null
    return ProviderUsageWarning(
        account = account,
        window = window,
        percent = Math.round(bestPercent).toInt(),
    )
}
