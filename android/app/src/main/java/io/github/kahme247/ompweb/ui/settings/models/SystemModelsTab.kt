package io.github.kahme247.ompweb.ui.settings.models

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.FALLBACK_REVERT_POLICIES
import io.github.kahme247.ompweb.domain.NATIVE_MODEL_ROLES
import io.github.kahme247.ompweb.domain.nativeSettingsWritable
import io.github.kahme247.ompweb.domain.parseModelRoleSelector
import io.github.kahme247.ompweb.domain.registryKey
import io.github.kahme247.ompweb.domain.roleModelKeys
import io.github.kahme247.ompweb.ui.settings.CopyableValue
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** The System sub-tab: registry, composer picker, roles and retry/fallbacks. */
@Composable
fun SystemModelsContent(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    ModelsSegmented(
        options = listOf(
            SystemPage.REGISTRY to stringResource(R.string.models_system_registry),
            SystemPage.PICKER to stringResource(R.string.models_system_picker),
            SystemPage.ROLES to stringResource(R.string.models_system_roles),
            SystemPage.FALLBACKS to stringResource(R.string.models_system_fallbacks),
        ),
        selected = state.systemPage,
        onSelect = vm::selectSystemPage,
    )
    state.settingsError?.let { error ->
        ModelsError(error)
        TextButton(onClick = vm::reloadSettings) {
            Text(stringResource(R.string.models_reload), fontSize = 11.sp)
        }
    }
    when (state.systemPage) {
        SystemPage.REGISTRY -> RegistryPage(state, vm)
        SystemPage.PICKER -> PickerPage(state, vm)
        SystemPage.ROLES -> RolesPage(state, vm)
        SystemPage.FALLBACKS -> FallbacksPage(state, vm)
    }
}

@Composable
private fun RegistryPage(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    ModelsSectionTitle(stringResource(R.string.models_registry_title))
    ModelsHint(stringResource(R.string.models_registry_desc))
    state.settingsPath?.let { CopyableValue(it) }

    if (state.ompSettings == null && state.settingsLoading) {
        ModelsHint(stringResource(R.string.models_loading))
        return
    }
    if (!nativeSettingsWritable(state.ompSettings, state.settingsError)) {
        if (state.settingsError == null) ModelsError(stringResource(R.string.models_settings_unavailable))
        return
    }
    if (state.registryReadOnly) {
        ModelsError(stringResource(R.string.models_registry_readonly))
    }
    val locked = state.registryReadOnly || state.settingsSaving

    ModelsCard {
        ModelsCheckRow(
            checked = state.allowListEnabled,
            label = stringResource(R.string.models_registry_restrict),
            enabled = !locked,
            onCheckedChange = vm::setAllowListEnabled,
        )
        ModelsHint(
            stringResource(
                if (state.allowListEnabled) R.string.models_registry_unchecked_unavailable
                else R.string.models_registry_all_allowed,
            ),
        )
        if (state.allowListEnabled) {
            if (state.modelOptions.isEmpty()) {
                ModelsHint(stringResource(R.string.models_registry_no_models))
            }
            state.modelOptions.forEach { model ->
                ModelsCheckRow(
                    checked = state.enabledModels.contains(model.registryKey),
                    label = model.name.ifBlank { model.modelId },
                    caption = model.registryKey,
                    enabled = !locked,
                    onCheckedChange = { checked -> vm.setModelEnabled(model.registryKey, checked) },
                )
            }
        }
    }

    ModelsCard {
        ModelsSectionTitle(stringResource(R.string.models_registry_disabled_providers))
        ModelsHint(stringResource(R.string.models_registry_disabled_desc))
        state.registryProviders.forEach { provider ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProviderAvatar(provider, size = 20)
                Spacer(Modifier.width(8.dp))
                ModelsCheckRow(
                    checked = state.disabledProviders.contains(provider),
                    label = provider,
                    enabled = !locked,
                    onCheckedChange = { disabled -> vm.setProviderDisabled(provider, disabled) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }

    ModelsCard {
        ModelsSectionTitle(stringResource(R.string.models_registry_order))
        ModelsHint(stringResource(R.string.models_registry_order_desc))
        state.registryProviders.forEachIndexed { index, provider ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "${index + 1}.",
                    color = colors.textDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    modifier = Modifier.widthIn(min = 24.dp),
                )
                Text(
                    text = provider,
                    color = colors.textMuted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = { vm.moveProvider(index, -1) },
                    enabled = !locked && index > 0,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                ) {
                    Icon(Icons.Filled.KeyboardArrowUp, contentDescription = stringResource(R.string.models_move_up), modifier = Modifier.size(16.dp))
                }
                TextButton(
                    onClick = { vm.moveProvider(index, 1) },
                    enabled = !locked && index < state.registryProviders.lastIndex,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.models_move_down), modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun PickerPage(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    var filter by remember { mutableStateOf("") }
    val query = filter.trim().lowercase()
    ModelsSectionTitle(stringResource(R.string.models_picker_title))
    ModelsHint(stringResource(R.string.models_picker_desc))
    if (state.runtimeLoading && state.modelOptions.isEmpty()) {
        ModelsHint(stringResource(R.string.models_loading))
        return
    }
    Text(
        text = stringResource(R.string.models_picker_visible, state.visibleModelCount, state.modelOptions.size),
        color = colors.textMuted,
        fontSize = 11.5.sp,
    )
    ModelsTextField(
        label = stringResource(R.string.models_picker_filter),
        value = filter,
        onValueChange = { filter = it },
    )

    val groups = state.modelOptions.groupBy { it.provider }.toSortedMap()
    if (groups.isEmpty()) {
        ModelsHint(stringResource(R.string.models_picker_empty))
        return
    }
    groups.forEach { (provider, models) ->
        val shown = models.filter { model ->
            query.isEmpty() || model.modelId.lowercase().contains(query) || model.name.lowercase().contains(query)
        }
        if (shown.isEmpty() && query.isNotEmpty()) return@forEach
        val providerDisabled = state.disabledProviders.contains(provider)
        val visibleNow = shown.filter { state.composerModels?.contains(it.key) ?: true }
        ModelsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProviderAvatar(provider, size = 22)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(provider, color = colors.text, fontSize = 12.5.sp)
                    Text(
                        text = stringResource(R.string.models_picker_provider_count, models.size),
                        color = colors.textMuted,
                        fontSize = 10.5.sp,
                    )
                }
            }
            ModelsCheckRow(
                checked = visibleNow.size == shown.size && shown.isNotEmpty(),
                indeterminate = visibleNow.isNotEmpty() && visibleNow.size < shown.size,
                label = stringResource(R.string.models_picker_show_provider),
                onCheckedChange = { show -> vm.setComposerProviderVisible(provider, show) },
            )
            shown.forEach { model ->
                ModelsCheckRow(
                    checked = state.composerModels?.contains(model.key) ?: true,
                    label = model.name.ifBlank { model.modelId },
                    caption = model.key,
                    onCheckedChange = { visible -> vm.setComposerModelVisible(model.key, visible) },
                )
            }
            if (providerDisabled) {
                ModelsHint(stringResource(R.string.models_picker_connected_disabled))
                Button(onClick = { vm.setProviderDisabled(provider, false) }) {
                    Text(stringResource(R.string.models_picker_enable), fontSize = 12.sp)
                }
            } else if (models.isEmpty()) {
                ModelsHint(stringResource(R.string.models_picker_connected_empty))
            }
        }
    }
    val connectedWithoutModels = state.connectedProviders
        .filter { it.id !in groups.keys }
        .filter { query.isEmpty() || it.id.lowercase().contains(query) }
    connectedWithoutModels.forEach { provider ->
        ModelsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProviderAvatar(provider.id, size = 22)
                Spacer(Modifier.width(8.dp))
                Text(provider.name.ifBlank { provider.id }, color = colors.text, fontSize = 12.5.sp)
            }
            ModelsHint(
                stringResource(
                    if (provider.disabled) R.string.models_picker_connected_disabled
                    else R.string.models_picker_connected_empty,
                ),
            )
            if (provider.disabled) {
                Button(onClick = { vm.enableProvider(provider.id) }) {
                    Text(stringResource(R.string.models_picker_enable), fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun RolesPage(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    ModelsSectionTitle(stringResource(R.string.models_roles_title))
    ModelsHint(stringResource(R.string.models_roles_desc))
    if (state.rolesLoading && state.roles.isEmpty()) {
        ModelsHint(stringResource(R.string.models_roles_loading))
        return
    }
    NATIVE_MODEL_ROLES.forEach { role ->
        val selector = parseModelRoleSelector(state.roles[role].orEmpty())
        val modelKeys = roleModelKeys(state.modelOptions)
        val known = modelKeys.contains(selector.model)
        val runtime = state.runtimeModels.firstOrNull { "${it.provider}/${it.id}" == selector.model }
        val modelOptions = buildList {
            add("" to stringResource(R.string.models_roles_none))
            if (selector.model.isNotEmpty() && !known) {
                add(selector.model to stringResource(R.string.models_roles_unavailable, selector.model))
            }
            state.modelOptions.forEach { option ->
                add(option.registryKey to "${option.name.ifBlank { option.modelId }} (${option.registryKey})")
            }
        }
        ModelsCard {
            Text(role, color = colors.textMuted, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            ModelsDropdown(
                label = stringResource(R.string.models_roles_title),
                value = selector.model,
                options = modelOptions,
                onSelect = { model -> vm.setRoleModel(role, model) },
            )
            val efforts = buildList {
                add("" to stringResource(R.string.models_roles_default_effort))
                runtime?.thinkingLevels?.filter { it != "off" }?.forEach { level -> add(level to level) }
                selector.effort?.takeIf { effort -> runtime?.thinkingLevels?.contains(effort) != true }
                    ?.let { add(it to it) }
            }
            ModelsDropdown(
                label = stringResource(R.string.models_roles_effort),
                value = selector.effort.orEmpty(),
                options = efforts,
                enabled = runtime != null,
                onSelect = { effort -> vm.setRoleEffort(role, effort) },
            )
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = vm::saveRoles, enabled = state.rolesDirty && !state.rolesSaving && !state.rolesLoading) {
            Text(
                stringResource(
                    if (state.rolesSaving) R.string.models_saving else R.string.models_roles_save,
                ),
            )
        }
        if (state.rolesPath != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = state.rolesPath,
                color = colors.textDim,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun FallbacksPage(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    ModelsSectionTitle(stringResource(R.string.models_fallbacks_title))
    ModelsHint(stringResource(R.string.models_fallbacks_desc))
    if (state.ompSettings == null && state.settingsLoading) {
        ModelsHint(stringResource(R.string.models_loading))
        return
    }
    if (!nativeSettingsWritable(state.ompSettings, state.settingsError)) {
        if (state.settingsError == null) ModelsError(stringResource(R.string.models_settings_unavailable))
        return
    }
    val locked = state.settingsSaving
    ModelsCard {
        ModelsCheckRow(
            checked = state.retryEnabled,
            label = stringResource(R.string.models_fallbacks_retry),
            enabled = !locked,
            onCheckedChange = vm::setRetryEnabled,
        )
        ModelsCheckRow(
            checked = state.modelFallback,
            label = stringResource(R.string.models_fallbacks_model_fallback),
            enabled = !locked,
            onCheckedChange = vm::setModelFallback,
        )
        ModelsDropdown(
            label = stringResource(R.string.models_fallbacks_attempts),
            value = state.maxRetries.toString(),
            options = listOf(0, 1, 2, 3, 5, 10, 15, 20).map { it.toString() to it.toString() },
            enabled = !locked,
            onSelect = { value -> vm.setMaxRetries(value.toIntOrNull() ?: 10) },
        )
        ModelsDropdown(
            label = stringResource(R.string.models_fallbacks_revert),
            value = state.revertPolicy,
            options = FALLBACK_REVERT_POLICIES.map { policy ->
                policy to when (policy) {
                    "cooldown-expiry" -> stringResource(R.string.models_fallbacks_after_cooldown)
                    "never" -> stringResource(R.string.models_fallbacks_never)
                    else -> policy
                }
            },
            enabled = !locked,
            onSelect = vm::setRevertPolicy,
        )
    }

    ModelsCard {
        ModelsDropdown(
            label = stringResource(R.string.models_fallbacks_chain_for),
            value = state.fallbackRole,
            options = NATIVE_MODEL_ROLES.map { it to it },
            onSelect = vm::setFallbackRole,
        )
        val chain = state.fallbackChain
        if (chain.isEmpty()) {
            ModelsHint(stringResource(R.string.models_fallbacks_empty))
        } else {
            chain.forEachIndexed { index, selector ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "${index + 1}.",
                        color = colors.textDim,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        modifier = Modifier.widthIn(min = 24.dp),
                    )
                    Text(
                        text = selector,
                        color = colors.textMuted,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = { vm.moveFallback(index, -1) },
                        enabled = !locked && index > 0,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(Icons.Filled.KeyboardArrowUp, contentDescription = stringResource(R.string.models_move_up), modifier = Modifier.size(16.dp))
                    }
                    TextButton(
                        onClick = { vm.moveFallback(index, 1) },
                        enabled = !locked && index < chain.lastIndex,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.models_move_down), modifier = Modifier.size(16.dp))
                    }
                    TextButton(
                        onClick = { vm.removeFallback(selector) },
                        enabled = !locked,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.models_remove), modifier = Modifier.size(15.dp))
                    }
                }
            }
        }
        var candidate by remember(state.fallbackRole) { mutableStateOf("") }
        val available = roleModelKeys(state.modelOptions).filterNot { chain.contains(it) }
        ModelsDropdown(
            label = stringResource(R.string.models_fallbacks_select_model),
            value = candidate,
            options = listOf("" to stringResource(R.string.models_fallbacks_select_model)) +
                available.map { it to it },
            enabled = !locked,
            onSelect = { candidate = it },
        )
        Row {
            Button(
                onClick = {
                    vm.addFallback(candidate)
                    candidate = ""
                },
                enabled = !locked && candidate.isNotBlank(),
            ) {
                Text(stringResource(R.string.models_add), fontSize = 12.sp)
            }
        }
    }
}
