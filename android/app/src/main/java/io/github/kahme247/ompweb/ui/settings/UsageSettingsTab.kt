package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.UsageGranularity
import io.github.kahme247.ompweb.net.UsageTimeRange
import io.github.kahme247.ompweb.net.UsageTimeSeriesPoint
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import java.util.Locale

/**
 * Settings → Usage: the real `/api/usage` report (costs, tokens, cache and
 * the model/day/project breakdown), with range, granularity, metric and
 * breakdown selectors, a manual refresh and a chart that plots every series
 * point (web `UsageConfig.tsx`).
 */
@Composable
fun UsageSettingsTab(
    viewModel: SettingsViewModel,
    modifier: Modifier = Modifier,
    highlight: String? = null,
) {
    val state by viewModel.usageState.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        if (state.report == null) viewModel.loadUsage()
    }

    SettingsPage(
        title = stringResource(R.string.usage_title),
        lead = stringResource(R.string.usage_desc),
        modifier = modifier,
    ) {
        item(key = "usage-controls") {
            SettingsCard(highlighted = highlight == "usage-summary") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SettingsSelect(
                        options = listOf(
                            UsageTimeRange.TODAY to stringResource(R.string.usage_range_today),
                            UsageTimeRange.SEVEN_DAYS to stringResource(R.string.usage_range_7d),
                            UsageTimeRange.THIRTY_DAYS to stringResource(R.string.usage_range_30d),
                            UsageTimeRange.NINETY_DAYS to stringResource(R.string.usage_range_90d),
                            UsageTimeRange.MONTH to stringResource(R.string.usage_range_month),
                            UsageTimeRange.ALL to stringResource(R.string.usage_range_all),
                        ),
                        selected = state.range,
                        onSelect = viewModel::setUsageRange,
                        modifier = Modifier.weight(1f),
                    )
                    SettingsSelect(
                        options = listOf(
                            UsageGranularity.DAILY to stringResource(R.string.usage_granularity_daily),
                            UsageGranularity.MONTHLY to stringResource(R.string.usage_granularity_monthly),
                            UsageGranularity.PROJECTS to stringResource(R.string.usage_granularity_projects),
                        ),
                        selected = state.granularity,
                        onSelect = viewModel::setUsageGranularity,
                    )
                    TextButton(
                        onClick = { viewModel.loadUsage(force = true) },
                        enabled = !state.loading,
                    ) {
                        Text(stringResource(R.string.settings_refresh))
                    }
                }
                state.error?.let { SettingsMessage(it, error = true) }
                if (state.loading) {
                    Text(
                        text = stringResource(R.string.usage_loading),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalOmpColors.current.textDim,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        }

        val report = state.report
        if (report == null) {
            item(key = "usage-loading") {
                SettingsLoading(stringResource(R.string.usage_loading))
            }
            return@SettingsPage
        }

        item(key = "usage-summary") {
            SettingsCard(highlighted = highlight in setOf("token-cost", "cache-savings")) {
                SettingsSectionTitle(stringResource(R.string.usage_total_cost))
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    UsageMetric(
                        stringResource(R.string.usage_total_cost),
                        formatCurrency(report.summary.totalCost),
                        Modifier.weight(1f),
                    )
                    UsageMetric(
                        stringResource(R.string.usage_total_tokens),
                        formatTokens(report.summary.totalTokens),
                        Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    UsageMetric(
                        stringResource(R.string.usage_cache_read),
                        formatTokens(report.summary.cacheReadTokens),
                        Modifier.weight(1f),
                    )
                    UsageMetric(
                        stringResource(R.string.usage_cache_savings),
                        formatCurrency(report.summary.cacheSavings),
                        Modifier.weight(1f),
                    )
                }
                Text(
                    text = stringResource(R.string.usage_active_days, report.summary.activeDays) +
                        " · " + stringResource(
                        R.string.usage_tokens_per_day,
                        formatTokens(report.summary.tokensPerActiveDay),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = LocalOmpColors.current.textMuted,
                )
                Text(
                    text = stringResource(
                        R.string.usage_cost_quality_value,
                        formatPercent(report.summary.costQuality.providerReported),
                        formatPercent(report.summary.costQuality.modelPriced),
                        formatPercent(report.summary.costQuality.unpriced),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = LocalOmpColors.current.textDim,
                )
            }
        }

        item(key = "usage-providers") {
            SettingsCard {
                SettingsSectionTitle(stringResource(R.string.usage_providers))
                if (report.providers.isEmpty()) {
                    Text(
                        stringResource(R.string.usage_no_data),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalOmpColors.current.textMuted,
                    )
                }
                for (provider in report.providers) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(modifier = Modifier.fillMaxWidth()) {
                            Text(
                                text = provider.name,
                                style = MaterialTheme.typography.bodyMedium,
                                color = LocalOmpColors.current.text,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = "${formatCurrency(provider.cost)} · ${stringResource(R.string.usage_share, formatPercent(provider.share))}",
                                style = MaterialTheme.typography.bodySmall,
                                color = LocalOmpColors.current.textMuted,
                            )
                        }
                        UsageShareBar(provider.share)
                    }
                }
            }
        }

        item(key = "usage-time-series") {
            SettingsCard(highlighted = highlight == "usage-time-series") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        SettingsSectionTitle(stringResource(R.string.usage_time_series))
                        UsageChartModel.subtitle(report.timeSeries)?.let { subtitle ->
                            Text(
                                text = if (subtitle.single) {
                                    subtitle.first
                                } else {
                                    stringResource(
                                        R.string.usage_range_subtitle,
                                        subtitle.first,
                                        subtitle.last,
                                    )
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = LocalOmpColors.current.textDim,
                            )
                        }
                    }
                    UsageSegmented(
                        options = listOf(
                            UsageMetricView.COST to stringResource(R.string.usage_metric_cost),
                            UsageMetricView.TOKENS to stringResource(R.string.usage_metric_tokens),
                        ),
                        selected = state.metric,
                        onSelect = viewModel::setUsageMetric,
                    )
                }
                UsageTimeSeriesChart(
                    points = report.timeSeries,
                    metric = state.metric,
                    selectedIndex = state.selectedPointIndex,
                    onSelect = viewModel::toggleUsagePoint,
                )
            }
        }

        item(key = "usage-breakdown") {
            SettingsCard(highlighted = highlight == "model-breakdown") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SettingsSectionTitle(
                        stringResource(R.string.usage_breakdown),
                        modifier = Modifier.weight(1f),
                    )
                    SettingsSelect(
                        options = listOf(
                            UsageBreakdownView.MODEL to stringResource(R.string.usage_breakdown_model),
                            UsageBreakdownView.DAY to stringResource(R.string.usage_breakdown_day),
                            UsageBreakdownView.PROJECT to stringResource(R.string.usage_breakdown_project),
                        ),
                        selected = state.breakdown,
                        onSelect = viewModel::setUsageBreakdown,
                    )
                }
                val rows = UsageChartModel.breakdown(report, state.breakdown)
                if (rows.isEmpty()) {
                    EmptyBreakdown()
                } else {
                    BreakdownHeader()
                    for (row in rows) {
                        BreakdownRow(
                            label = row.label,
                            cost = row.cost,
                            tokens = row.tokens,
                            share = row.share,
                            detail = row.detail,
                        )
                    }
                }
            }
        }

        item(key = "usage-scan") {
            Text(
                text = stringResource(
                    R.string.usage_scan,
                    report.scanInfo.transcriptsScanned,
                    report.scanInfo.usageRecordsCount,
                    String.format(Locale.US, "%.1f", report.scanInfo.durationSeconds),
                ),
                style = MaterialTheme.typography.labelSmall,
                color = LocalOmpColors.current.textDim,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}

/**
 * Every series point, never a `takeLast` window: the row scrolls horizontally
 * when 30/90 daily bars do not fit, and each bar keeps a readable width.
 * Tapping a bar selects it (the parent shows its value); tapping again clears.
 */
@Composable
private fun UsageTimeSeriesChart(
    points: List<UsageTimeSeriesPoint>,
    metric: UsageMetricView,
    selectedIndex: Int?,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val bars = UsageChartModel.bars(points, metric)
    val selected = bars.firstOrNull { it.index == selectedIndex }
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (bars.isEmpty()) {
            Text(
                stringResource(R.string.usage_no_data),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
            return@Column
        }
        Row(
            modifier = Modifier.fillMaxWidth().height(18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selected != null) {
                Text(
                    text = stringResource(
                        R.string.usage_selected_point,
                        selected.label,
                        when (metric) {
                            UsageMetricView.COST -> formatCurrency(selected.cost)
                            UsageMetricView.TOKENS -> formatTokens(selected.tokens)
                        },
                    ),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.accent,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val barWidth: Dp = (maxWidth / bars.size.coerceAtLeast(1)).coerceIn(3.dp, 28.dp)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(104.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                for (bar in bars) {
                    val active = bar.index == selectedIndex
                    Box(
                        modifier = Modifier
                            .width(barWidth)
                            .fillMaxHeight()
                            .testTag("usage-bar-${bar.index}")
                            .clickable { onSelect(bar.index) }
                            .semantics {
                                contentDescription = "${bar.label}: " + when (metric) {
                                    UsageMetricView.COST -> formatCurrency(bar.cost)
                                    UsageMetricView.TOKENS -> formatTokens(bar.tokens)
                                }
                            },
                        contentAlignment = Alignment.BottomCenter,
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .fillMaxHeight(bar.fraction)
                                .background(
                                    if (active) colors.accent else colors.accent.copy(alpha = 0.55f),
                                    RoundedCornerShape(2.dp),
                                ),
                        )
                    }
                }
            }
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                bars.first().label,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
            if (bars.size > 1) {
                Text(
                    bars.last().label,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
            }
        }
    }
}

/** A compact two-way selector (web: the metric pills above the chart). */
@Composable
private fun <T> UsageSegmented(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((value, label) in options) {
            val active = value == selected
            Surface(
                onClick = { if (!active) onSelect(value) },
                color = if (active) colors.accent else colors.background,
                border = BorderStroke(1.dp, if (active) colors.accent else colors.border),
                shape = RoundedCornerShape(8.dp),
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (active) colors.onAccent else colors.text,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }
    }
}

@Composable
private fun UsageMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = LocalOmpColors.current.textDim)
        Text(
            value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = LocalOmpColors.current.text,
        )
    }
}

@Composable
private fun UsageShareBar(percent: Double) {
    val colors = LocalOmpColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(4.dp)
            .background(colors.border, RoundedCornerShape(2.dp)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth((percent / 100.0).toFloat().coerceIn(0f, 1f))
                .fillMaxHeight()
                .background(colors.accent, RoundedCornerShape(2.dp)),
        )
    }
}

/** The web table's column names above the breakdown rows. */
@Composable
private fun BreakdownHeader() {
    val colors = LocalOmpColors.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            stringResource(R.string.usage_column_name),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
            modifier = Modifier.weight(1f),
        )
        Text(
            "${stringResource(R.string.usage_column_cost)} · ${stringResource(R.string.usage_column_share)} · ${stringResource(R.string.usage_column_tokens)}",
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
        )
    }
}

@Composable
private fun BreakdownRow(label: String, cost: Double, tokens: Long, share: Double, detail: String? = null) {
    val colors = LocalOmpColors.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.text)
                if (detail != null) {
                    Text(detail, style = MaterialTheme.typography.labelSmall, color = colors.textDim)
                }
            }
            Text(
                text = "${formatCurrency(cost)} · ${formatPercent(share)}% · ${formatTokens(tokens)}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = colors.textMuted,
            )
        }
        UsageShareBar(share)
    }
}

@Composable
private fun EmptyBreakdown() {
    Text(
        stringResource(R.string.usage_breakdown_empty),
        style = MaterialTheme.typography.bodySmall,
        color = LocalOmpColors.current.textMuted,
    )
}
