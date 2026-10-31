package io.github.kahme247.ompweb.ui.composer.controls

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.ModelKey
import io.github.kahme247.ompweb.domain.ModelOption
import io.github.kahme247.ompweb.domain.ProviderModelGroup
import io.github.kahme247.ompweb.domain.filterModelOptions
import io.github.kahme247.ompweb.domain.groupModelOptionsByProvider
import io.github.kahme247.ompweb.domain.orderProviderGroups
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The nested model picker (`components/ChatInput-model-picker.tsx`): providers
 * on the rail, that provider's models in the pane, search flattens across
 * providers. Narrow screens start on the rail and open one provider, wide
 * screens show both panes, exactly like the web's `isMobile` split.
 *
 * "Add Providers" is deliberately absent: the web opens Settings → Models from
 * it, and this app has no Models screen before Phase 10.
 */
@Composable
internal fun ModelPickerDialog(
    state: ComposerControlsState,
    onDismiss: () -> Unit,
    onSelect: (provider: String, modelId: String) -> Unit,
) {
    val colors = LocalOmpColors.current
    val narrow = LocalConfiguration.current.screenWidthDp < 600
    var query by rememberSaveable { mutableStateOf("") }
    var selectedProvider by rememberSaveable { mutableStateOf<String?>(null) }

    OmpDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            color = colors.panel,
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier
                .fillMaxWidth(if (narrow) 0.94f else 0.7f)
                .heightIn(max = 560.dp),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.controls_change_model),
                        color = colors.text,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = stringResource(R.string.controls_close),
                            tint = colors.textDim,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }

                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    singleLine = true,
                    textStyle = TextStyle(fontSize = 13.sp),
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = null,
                            tint = colors.textDim,
                            modifier = Modifier.size(15.dp),
                        )
                    },
                    placeholder = {
                        Text(
                            text = stringResource(R.string.controls_search_models),
                            color = colors.textDim,
                            fontSize = 13.sp,
                        )
                    },
                )

                state.modelsError?.let { error ->
                    Text(
                        text = error,
                        color = colors.statusError,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }

                val searching = query.isNotBlank()
                val options = remember(state.models, query) {
                    filterModelOptions(state.models, query)
                }
                val groups = remember(options, state.model) {
                    orderProviderGroups(
                        groupModelOptionsByProvider(options),
                        state.model?.provider,
                    )
                }
                val activeProvider = resolveActiveProvider(groups, selectedProvider, state.model?.provider)
                val showRail = !searching && (!narrow || selectedProvider == null)
                val showModels = searching || !narrow || selectedProvider != null

                Box(modifier = Modifier.padding(top = 8.dp)) {
                    when {
                        state.modelsLoading && state.models.isEmpty() -> LoadingRow()
                        state.models.isEmpty() -> EmptyRow(
                            stringResource(R.string.controls_no_available_models),
                        )

                        showRail && !showModels -> ProviderRail(
                            groups = groups,
                            activeProvider = activeProvider,
                            currentProvider = state.model?.provider,
                            modifier = Modifier.fillMaxWidth(),
                            onPick = { selectedProvider = it },
                        )

                        else -> Row(modifier = Modifier.fillMaxWidth()) {
                            if (showRail) {
                                ProviderRail(
                                    groups = groups,
                                    activeProvider = activeProvider,
                                    currentProvider = state.model?.provider,
                                    modifier = Modifier.weight(0.38f),
                                    onPick = { selectedProvider = it },
                                )
                            }
                            ModelList(
                                modifier = Modifier.weight(if (showRail) 0.62f else 1f),
                                groups = if (searching) {
                                    groups
                                } else {
                                    groups.filter { it.provider == activeProvider }
                                },
                                searching = searching,
                                current = state.model,
                                onBack = if (narrow && showRail) {
                                    null
                                } else if (narrow) {
                                    { selectedProvider = null }
                                } else {
                                    null
                                },
                                onSelect = onSelect,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProviderRail(
    groups: List<ProviderModelGroup>,
    activeProvider: String?,
    currentProvider: String?,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier = modifier) {
        if (groups.isEmpty()) {
            item { EmptyRow(stringResource(R.string.controls_no_available_models)) }
        }
        items(groups, key = { it.provider }) { group ->
            ProviderRow(
                group = group,
                active = group.provider == activeProvider,
                current = group.provider == currentProvider,
                onClick = { onPick(group.provider) },
            )
        }
    }
}

@Composable
private fun ModelList(
    groups: List<ProviderModelGroup>,
    searching: Boolean,
    current: ModelKey?,
    onBack: (() -> Unit)?,
    onSelect: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    LazyColumn(modifier = modifier) {
        if (onBack != null) {
            item(key = "back") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onBack)
                        .padding(horizontal = 6.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = Icons.Filled.KeyboardArrowLeft,
                        contentDescription = stringResource(R.string.controls_back_to_providers),
                        tint = colors.textDim,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = groups.firstOrNull()?.provider
                            ?: stringResource(R.string.controls_providers),
                        color = colors.textMuted,
                        fontSize = 12.sp,
                    )
                }
            }
        }
        if (groups.all { it.options.isEmpty() }) {
            item(key = "empty") {
                EmptyRow(
                    stringResource(
                        if (searching) {
                            R.string.controls_no_matching_models
                        } else {
                            R.string.controls_no_available_models
                        },
                    ),
                )
            }
        }
        groups.forEach { group ->
            if (searching) {
                item(key = "label:${group.provider}") {
                    Text(
                        text = group.provider,
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 5.dp),
                    )
                }
            }
            items(group.options, key = { "${group.provider}:${it.modelId}" }) { option ->
                ModelRow(
                    option = option,
                    active = current != null &&
                        current.provider == option.provider && current.modelId == option.modelId,
                    showProvider = searching,
                    onClick = { onSelect(option.provider, option.modelId) },
                )
            }
        }
    }
}

@Composable
private fun ProviderRow(
    group: ProviderModelGroup,
    active: Boolean,
    current: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (active) colors.selected else colors.panel, RoundedCornerShape(7.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ProviderBadge(group.provider, size = 15)
        Text(
            text = group.provider,
            color = if (current) colors.text else colors.textMuted,
            fontSize = 12.sp,
            fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Icons.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(12.dp),
        )
    }
}

@Composable
private fun ModelRow(
    option: ModelOption,
    active: Boolean,
    showProvider: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (active) colors.selected else colors.panel, RoundedCornerShape(7.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(modifier = Modifier.size(12.dp), contentAlignment = Alignment.Center) {
            if (active) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = colors.accent,
                    modifier = Modifier.size(11.dp),
                )
            }
        }
        Text(
            text = option.displayName,
            color = if (active) colors.text else colors.textMuted,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (showProvider) {
            Text(
                text = option.provider,
                color = colors.textDim,
                fontSize = 10.sp,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun LoadingRow() {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 2.dp,
            color = colors.accent,
        )
        Text(
            text = stringResource(R.string.controls_loading_models),
            color = colors.textDim,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun EmptyRow(text: String) {
    Text(
        text = text,
        color = LocalOmpColors.current.textDim,
        fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 18.dp),
    )
}

/** Web `activeProvider`: explicit pick, else the current model's provider, else the first. */
private fun resolveActiveProvider(
    groups: List<ProviderModelGroup>,
    selected: String?,
    currentProvider: String?,
): String? {
    if (selected != null && groups.any { it.provider == selected }) return selected
    if (currentProvider != null && groups.any { it.provider == currentProvider }) return currentProvider
    return groups.firstOrNull()?.provider
}
