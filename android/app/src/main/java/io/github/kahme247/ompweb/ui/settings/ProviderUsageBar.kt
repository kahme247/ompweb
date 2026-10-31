package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.PROVIDER_USAGE_WARNING_PERCENT
import io.github.kahme247.ompweb.domain.providerUsageAccountLabel
import io.github.kahme247.ompweb.domain.providerUsageWindows
import io.github.kahme247.ompweb.domain.providerUsageWorstWindow
import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageWindow
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Keeps the shared provider-limit poller running while the calling surface is
 * started: a backgrounded app stops requesting, and coming back refreshes
 * immediately instead of waiting for the next five-minute tick (web:
 * visible-page polling only). Both the Settings block and the sessions
 * warning row use this one implementation.
 */
@Composable
internal fun ProviderUsageSubscription(viewModel: SettingsViewModel) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, viewModel) {
        // Pair exactly the calls this composition made. Reading the lifecycle
        // twice (setup and dispose) can disagree when the surface composes
        // below STARTED and receives ON_START afterwards: the flag records
        // what actually happened instead of re-deriving it (P11Bug 10).
        var subscribed = false
        fun subscribe() {
            if (subscribed) return
            subscribed = true
            viewModel.subscribeProviderUsage()
        }
        fun unsubscribe() {
            if (!subscribed) return
            subscribed = false
            viewModel.unsubscribeProviderUsage()
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> subscribe()
                Lifecycle.Event.ON_STOP -> unsubscribe()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) subscribe()
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            unsubscribe()
        }
    }
}

/**
 * The full provider rate-limit block (`ProviderUsageBar.tsx`), pinned above the
 * settings navigation. One line per account (worst window only); tapping a
 * line expands that account's windows, and the snapshot refreshes every five
 * minutes like the web.
 *
 * This is the only place the full block lives: the sessions list shows just the
 * slim warning row (`ui/sessions/ProviderUsageWarningRow.kt`) and links here.
 */
@Composable
fun ProviderUsageBar(
    viewModel: SettingsViewModel,
    modifier: Modifier = Modifier,
) {
    ProviderUsageSubscription(viewModel)
    val state by viewModel.providerUsageState.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    val reports = state.snapshot?.reports.orEmpty()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.panel, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.provider_usage_title),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.text,
                modifier = Modifier.weight(1f),
            )
            if (state.loading) {
                Text(
                    stringResource(R.string.provider_usage_loading),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
            }
        }
        when {
            state.error && reports.isEmpty() -> Text(
                stringResource(R.string.provider_usage_error),
                style = MaterialTheme.typography.labelSmall,
                color = colors.statusError,
            )
            reports.isEmpty() && !state.loading -> Text(
                stringResource(R.string.provider_usage_empty),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
            else -> for ((index, report) in reports.withIndex()) {
                val key = providerUsageRowKey(report, index)
                ProviderUsageRow(
                    report = report,
                    expanded = state.expandedKey == key,
                    onToggle = { viewModel.toggleProviderUsageExpanded(key) },
                )
            }
        }
        TextButton(
            onClick = { viewModel.loadProviderUsage(force = true) },
            enabled = !state.loading,
        ) {
            Text(stringResource(R.string.settings_refresh))
        }
    }
}

/** Stable row identity: provider, account and model (index keeps duplicates apart). */
internal fun providerUsageRowKey(report: ProviderUsageReport, index: Int): String =
    listOf(
        report.provider,
        report.accountLabel.orEmpty(),
        report.accountIndex?.toString().orEmpty(),
        report.modelId ?: "all",
        index.toString(),
    ).joinToString("\u0000")

@Composable
private fun ProviderUsageRow(
    report: ProviderUsageReport,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val name = providerUsageAccountLabel(report)
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (report.noLimits) Modifier else Modifier.clickable(onClick = onToggle))
                .background(if (expanded) colors.backgroundSubtle else colors.panel),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = name,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textMuted,
                modifier = Modifier.weight(1f),
            )
            if (report.noLimits) {
                Text(
                    stringResource(R.string.provider_usage_no_limits),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
            } else {
                val worst = providerUsageWorstWindow(report)
                if (worst != null) {
                    Text(
                        text = stringResource(
                            R.string.provider_usage_worst,
                            worst.first,
                            Math.round(worst.second.percent).toInt(),
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = usageTone(worst.second.percent),
                    )
                }
            }
        }
        if (expanded) {
            for ((short, window) in providerUsageWindows(report)) {
                ProviderWindowMeter(short, window)
            }
        }
    }
}

@Composable
private fun ProviderWindowMeter(short: String, window: ProviderUsageWindow) {
    val colors = LocalOmpColors.current
    val tone = usageTone(window.percent)
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = short,
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
            modifier = Modifier.padding(end = 0.dp),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(3.dp)
                .background(colors.border, RoundedCornerShape(2.dp)),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth((window.percent / 100.0).toFloat().coerceIn(0f, 1f))
                    .fillMaxHeight()
                    .background(tone, RoundedCornerShape(2.dp)),
            )
        }
        Text(
            text = "${Math.round(window.percent)}%",
            style = MaterialTheme.typography.labelSmall,
            color = tone,
        )
        val reset = formatReset(window)
        if (reset != null) {
            Text(
                text = stringResource(R.string.provider_usage_resets, reset),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
    }
}

private fun formatReset(window: ProviderUsageWindow): String? = when {
    window.resetMinutes != null -> formatResetValue(window.resetMinutes.toLong(), minutes = true)
    window.resetHours != null -> formatResetValue(window.resetHours.toLong(), minutes = false)
    else -> null
}

private fun formatResetValue(value: Long, minutes: Boolean): String {
    if (minutes) {
        if (value < 60) return "${value}m"
        val hours = value / 60
        val rest = value % 60
        return if (rest > 0) "${hours}h ${rest}m" else "${hours}h"
    }
    if (value < 24) return "${value}h"
    val days = value / 24
    val rest = value % 24
    return if (rest > 0) "${days}d ${rest}h" else "${days}d"
}

@Composable
private fun usageTone(percent: Double) = when {
    percent >= PROVIDER_USAGE_WARNING_PERCENT -> LocalOmpColors.current.statusError
    percent >= 50 -> LocalOmpColors.current.statusWarning
    else -> LocalOmpColors.current.textMuted
}
