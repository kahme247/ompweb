package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu

/** One scrollable settings page: title, optional lead, then the cards. */
@Composable
fun SettingsPage(
    title: String,
    modifier: Modifier = Modifier,
    lead: String? = null,
    content: LazyListScope.() -> Unit,
) {
    val colors = LocalOmpColors.current
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        state = rememberLazyListState(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "page-title") {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.text,
                    modifier = Modifier.semantics { heading() },
                )
                if (lead != null) {
                    Text(
                        text = lead,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textMuted,
                    )
                }
            }
        }
        content()
    }
}

@Composable
fun SettingsCard(
    modifier: Modifier = Modifier,
    highlighted: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalOmpColors.current
    val bringIntoView = remember { BringIntoViewRequester() }
    LaunchedEffect(highlighted) {
        if (highlighted) bringIntoView.bringIntoView()
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .bringIntoViewRequester(bringIntoView),
        color = colors.panel,
        border = BorderStroke(if (highlighted) 2.dp else 1.dp, if (highlighted) colors.accent else colors.border),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
fun SettingsSectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier.semantics { heading() },
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = LocalOmpColors.current.text,
    )
}

/**
 * A settings row with the web's shape: label, description and provenance
 * chip, plus an optional trailing control. [highlighted] draws the search
 * outline and scrolls the row into view once.
 */
@Composable
fun SettingsRow(
    title: String,
    description: String? = null,
    modifier: Modifier = Modifier,
    scope: SettingsScope? = null,
    highlighted: Boolean = false,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    val colors = LocalOmpColors.current
    val bringIntoView = remember { BringIntoViewRequester() }
    LaunchedEffect(highlighted) {
        if (highlighted) bringIntoView.bringIntoView()
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .bringIntoViewRequester(bringIntoView)
            .then(
                if (highlighted) {
                    Modifier
                        .border(2.dp, colors.accent, RoundedCornerShape(10.dp))
                        .padding(horizontal = 8.dp, vertical = 6.dp)
                } else {
                    Modifier
                },
            )
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (enabled) colors.text else colors.textDim,
                )
                if (scope != null) SettingsScopeChip(scope)
            }
            if (description != null) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                )
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun SettingsScopeChip(scope: SettingsScope) {
    val colors = LocalOmpColors.current
    val label = when (scope) {
        SettingsScope.UI -> stringResource(R.string.settings_scope_ui)
        SettingsScope.NATIVE_OMP -> stringResource(R.string.settings_scope_native)
        SettingsScope.WORKSPACE -> stringResource(R.string.settings_scope_workspace)
    }
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = colors.textDim,
        modifier = Modifier
            .background(colors.backgroundSubtle, RoundedCornerShape(999.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

@Composable
fun SettingsSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        modifier = modifier,
        enabled = enabled,
    )
}

/** A compact labelled select rendered as a button plus a drop-down menu. */
@Composable
fun <T> SettingsSelect(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = LocalOmpColors.current
    var open by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selected }?.second ?: ""
    Box(modifier = modifier) {
        Surface(
            onClick = { if (enabled) open = true },
            enabled = enabled,
            color = colors.background,
            border = BorderStroke(1.dp, colors.border),
            shape = RoundedCornerShape(8.dp),
        ) {
            Text(
                text = selectedLabel,
                style = MaterialTheme.typography.bodyMedium,
                color = if (enabled) colors.text else colors.textDim,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        OmpDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (option in options) {
                DropdownMenuItem(
                    text = {
                        Text(
                            text = option.second,
                            color = if (option.first == selected) colors.accent else colors.text,
                        )
                    },
                    onClick = {
                        open = false
                        onSelect(option.first)
                    },
                )
            }
        }
    }
}

@Composable
fun SettingsMessage(
    text: String,
    error: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = if (error) colors.statusError.copy(alpha = 0.12f) else colors.backgroundSubtle,
        shape = RoundedCornerShape(10.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = if (error) colors.statusError else colors.textMuted,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

/**
 * A monospace value with an explicit copy button (commands, URLs, paths).
 * Pass `sensitive = true` for credentials such as OAuth URLs and device codes
 * so the clip stays hidden from the clipboard preview.
 */
@Composable
fun CopyableValue(
    value: String,
    modifier: Modifier = Modifier,
    sensitive: Boolean = false,
) {
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    var copied by remember(value) { mutableStateOf(false) }
    if (copied) {
        LaunchedEffect(copied) {
            kotlinx.coroutines.delay(2_000)
            copied = false
        }
    }
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SelectionContainer(modifier = Modifier.weight(1f)) {
            Text(
                text = value,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = colors.text,
                modifier = Modifier
                    .background(colors.background, RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
        TextButton(
            onClick = {
                copyTextToClipboard(context, "ompweb", value, sensitive = sensitive)
                copied = true
            },
        ) {
            Text(stringResource(if (copied) R.string.settings_copied else R.string.settings_copy))
        }
    }
}

@Composable
fun SettingsTextArea(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    minLines: Int = 3,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        placeholder = placeholder?.let { text -> { Text(text) } },
        minLines = minLines,
        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
    )
}

/** Simple key/value line for the Mobile app and Windows cards. */
@Composable
fun SettingsFact(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = LocalOmpColors.current
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
            modifier = Modifier.width(120.dp),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = colors.text,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
fun SettingsLoading(label: String, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = LocalOmpColors.current.textMuted)
    }
}

@Composable
fun SettingsDivider() {
    Spacer(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(LocalOmpColors.current.border),
    )
}

/** Shared empty/error block. */
@Composable
fun SettingsNotAvailable(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = LocalOmpColors.current.backgroundSubtle,
        shape = RoundedCornerShape(10.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = LocalOmpColors.current.textMuted,
            modifier = Modifier.padding(16.dp),
        )
    }
}
