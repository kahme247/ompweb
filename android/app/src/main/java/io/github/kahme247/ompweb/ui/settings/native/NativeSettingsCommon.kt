package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsMessage
import io.github.kahme247.ompweb.ui.settings.SettingsRow
import io.github.kahme247.ompweb.ui.settings.SettingsSectionTitle
import io.github.kahme247.ompweb.ui.settings.SettingsSelect
import io.github.kahme247.ompweb.ui.settings.SettingsSwitch
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** Loading / saving / failed state of the native settings document. */
@Composable
fun NativeSettingsStatus(
    state: NativeSettingsState,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    when {
        state.loading -> Text(
            text = stringResource(R.string.native_settings_loading),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
            modifier = modifier,
        )

        state.error != null -> Row(
            modifier = modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SettingsMessage(text = state.error, error = true, modifier = Modifier.weight(1f))
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.native_settings_retry))
            }
        }

        state.saving -> Text(
            text = stringResource(R.string.native_settings_saving),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
            modifier = modifier,
        )
    }
}

/** A card with a section heading and lead, matching the web's grouped rows. */
@Composable
fun NativeSectionCard(
    title: String,
    description: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalOmpColors.current
    SettingsCard(modifier = modifier) {
        SettingsSectionTitle(title)
        if (description != null) {
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        content()
    }
}

/** A switch row with the web's label, description and provenance chip. */
@Composable
fun NativeToggleRow(
    id: String,
    highlight: String?,
    title: String,
    description: String?,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    SettingsRow(
        title = title,
        description = description,
        scope = SettingsScope.NATIVE_OMP,
        highlighted = highlight == id,
        trailing = {
            SettingsSwitch(
                checked = checked,
                onCheckedChange = onCheckedChange,
                enabled = enabled,
            )
        },
    )
}

/** A drop-down row; [options] are wire value → visible label. */
@Composable
fun NativeChoiceRow(
    id: String,
    highlight: String?,
    title: String,
    description: String?,
    options: List<Pair<String, String>>,
    selected: String,
    enabled: Boolean = true,
    onSelect: (String) -> Unit,
) {
    SettingsRow(
        title = title,
        description = description,
        scope = SettingsScope.NATIVE_OMP,
        highlighted = highlight == id,
        trailing = {
            SettingsSelect(
                options = options,
                selected = selected,
                onSelect = onSelect,
                enabled = enabled,
            )
        },
    )
}

/**
 * Outlines and scrolls a whole block (compaction editor, MCP/Skills/Plugins
 * sections) into view for a search hit.
 */
@Composable
fun HighlightedBlock(
    id: String,
    highlight: String?,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalOmpColors.current
    val active = highlight == id
    val requester = remember { BringIntoViewRequester() }
    LaunchedEffect(active) {
        if (active) requester.bringIntoView()
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .bringIntoViewRequester(requester)
            .then(
                if (active) {
                    Modifier
                        .border(2.dp, colors.accent, RoundedCornerShape(12.dp))
                        .padding(horizontal = 6.dp, vertical = 4.dp)
                } else {
                    Modifier
                },
            ),
        content = content,
    )
}

/** A selectable row used for server/package/skill lists. */
@Composable
fun NativeListRow(
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val colors = LocalOmpColors.current
    androidx.compose.material3.Surface(
        onClick = onClick,
        color = if (selected) colors.accent.copy(alpha = 0.12f) else colors.panel,
        border = BorderStroke(1.dp, if (selected) colors.accent else colors.border),
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            content = content,
        )
    }
}
