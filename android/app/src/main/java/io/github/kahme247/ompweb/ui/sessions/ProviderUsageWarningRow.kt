package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.providerUsageWarning
import io.github.kahme247.ompweb.ui.settings.ProviderUsageSubscription
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The sessions list's only usage surface: one slim row while any account
 * window is at or above 80 % (e.g. `Usage: work · Max 7D 85%`), which opens
 * Settings where the full provider block lives. Without a tight window the
 * composable emits nothing, so the list keeps its whole height.
 *
 * The row subscribes to the same shared poller as the Settings block; the
 * lifecycle pairing lives in [ProviderUsageSubscription] so both surfaces use
 * one implementation.
 */
@Composable
internal fun ProviderUsageWarningRow(
    viewModel: SettingsViewModel,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ProviderUsageSubscription(viewModel)
    val state by viewModel.providerUsageState.collectAsStateWithLifecycle()
    val warning = providerUsageWarning(state.snapshot?.reports.orEmpty()) ?: return
    val colors = LocalOmpColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .testTag("usage-warning")
            .clickable(onClick = onClick)
            .background(colors.panel)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.sessions_usage_warning_label, warning.account),
            style = MaterialTheme.typography.labelMedium,
            color = colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = stringResource(R.string.sessions_usage_warning_value, warning.window, warning.percent),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = colors.statusError,
            maxLines = 1,
        )
    }
}
