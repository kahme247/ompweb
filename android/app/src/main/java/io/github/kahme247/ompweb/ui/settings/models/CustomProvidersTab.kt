package io.github.kahme247.ompweb.ui.settings.models

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowRight
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.API_PROTOCOLS
import io.github.kahme247.ompweb.domain.ENDPOINT_PRESETS
import io.github.kahme247.ompweb.domain.MODEL_THINKING_LEVELS
import io.github.kahme247.ompweb.domain.ModelCostConfig
import io.github.kahme247.ompweb.domain.ThinkingConfig
import io.github.kahme247.ompweb.domain.isValidProviderBaseUrl
import io.github.kahme247.ompweb.domain.normalizedModelCost
import io.github.kahme247.ompweb.domain.withThinkingLevel
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** Custom providers: list, provider editor, model editor and the catalog picker. */
@Composable
fun CustomProvidersContent(
    state: ProvidersModelsState,
    vm: ProvidersModelsViewModel,
) {
    when (val selection = state.selection) {
        is ModelsSelection.Provider -> ProviderEditor(
            state = state,
            vm = vm,
            name = selection.name,
        )
        is ModelsSelection.Model -> ModelEditor(
            state = state,
            vm = vm,
            providerName = selection.providerName,
            index = selection.index,
        )
        else -> CustomProviderList(state = state, vm = vm)
    }
    if (state.catalogProvider != null) {
        CatalogDialog(state = state, vm = vm)
    }
}

@Composable
private fun CustomProviderList(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            ModelsSectionTitle(stringResource(R.string.models_custom_title))
            ModelsHint(stringResource(R.string.models_custom_desc))
        }
        Button(onClick = vm::addProvider) {
            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.models_new_provider), fontSize = 12.sp)
        }
    }
    if (state.config.providers.isEmpty()) {
        ModelsHint(stringResource(R.string.models_no_custom_providers))
        return
    }
    state.config.providers.forEach { (name, provider) ->
        val host = provider.baseUrl?.takeIf { it.isNotBlank() } ?: stringResource(R.string.models_base_url)
        ModelsCard(modifier = Modifier.clickable { vm.select(ModelsSelection.Provider(name)) }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProviderAvatar(name)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, color = colors.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = host,
                        color = colors.textMuted,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.5.sp,
                    )
                    Text(
                        text = stringResource(R.string.models_model_count, provider.models.size),
                        color = colors.textMuted,
                        fontSize = 10.5.sp,
                    )
                }
                when {
                    provider.auth == "none" -> StatusBadge(
                        text = stringResource(R.string.models_auth_none),
                        color = colors.textMuted,
                    )
                    provider.apiKey.isNullOrBlank() -> StatusBadge(
                        text = stringResource(R.string.models_key_missing),
                        color = colors.statusError,
                    )
                    else -> StatusBadge(
                        text = stringResource(R.string.models_key_set),
                        color = colors.accent,
                    )
                }
                Spacer(Modifier.width(4.dp))
                Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.textDim, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun ProviderEditor(
    state: ProvidersModelsState,
    vm: ProvidersModelsViewModel,
    name: String,
) {
    val colors = LocalOmpColors.current
    val provider = state.config.providers[name] ?: return
    var nameDraft by remember(name) { mutableStateOf(name) }
    var deleteOpen by remember { mutableStateOf(false) }
    val apiOptions = (listOf("" to stringResource(R.string.models_inherit_none)) +
        API_PROTOCOLS.map { it to it })

    // Web parity: a provider without `api` opens as openai-completions.
    LaunchedEffect(name) {
        if (provider.api == null) vm.updateProvider(name) { it.copy(api = "openai-completions") }
    }

    ModelsDetailHeader(
        title = name,
        subtitle = provider.baseUrl?.takeIf { it.isNotBlank() },
        onBack = { vm.select(null) },
    )

    Row(verticalAlignment = Alignment.CenterVertically) {
        ModelsTextField(
            label = stringResource(R.string.models_provider_name),
            value = nameDraft,
            onValueChange = { nameDraft = it },
            mono = true,
            modifier = Modifier
                .weight(1f)
                .onFocusChanged { focus ->
                    if (!focus.isFocused && nameDraft.trim() != name) vm.renameProvider(name, nameDraft)
                },
            onDone = { if (nameDraft.trim() != name) vm.renameProvider(name, nameDraft) },
        )
        if (nameDraft.trim() != name) {
            Spacer(Modifier.width(8.dp))
            Button(onClick = { vm.renameProvider(name, nameDraft) }) {
                Text(stringResource(R.string.models_save), fontSize = 12.sp)
            }
        }
    }

    ModelsTextField(
        label = stringResource(R.string.models_base_url),
        value = provider.baseUrl.orEmpty(),
        onValueChange = { value ->
            vm.updateProvider(name) { it.copy(baseUrl = value.ifBlank { null }) }
        },
        placeholder = "https://api.example.com/v1",
        mono = true,
    )
    urlError(provider.baseUrl)?.let { ModelsError(it) }

    ModelsDropdown(
        label = stringResource(R.string.models_auth_mode),
        value = provider.auth ?: "apiKey",
        options = listOf(
            "apiKey" to stringResource(R.string.models_auth_api_key),
            "none" to stringResource(R.string.models_auth_none),
            "oauth" to stringResource(R.string.models_auth_oauth),
        ),
        onSelect = { mode ->
            vm.updateProvider(name) {
                it.copy(auth = mode.takeUnless { value -> value == "apiKey" })
            }
        },
    )

    ModelsTextField(
        label = stringResource(R.string.models_api_key),
        value = provider.apiKey.orEmpty(),
        onValueChange = { value ->
            vm.updateProvider(name) { it.copy(apiKey = value.ifBlank { null }) }
        },
        placeholder = stringResource(R.string.models_api_key_placeholder),
        mono = true,
        secret = true,
        enabled = provider.auth != "none",
    )
    ModelsHint(stringResource(R.string.models_api_key_hint))

    ModelsDropdown(
        label = stringResource(R.string.models_api_protocol),
        value = provider.api ?: "",
        options = apiOptions,
        onSelect = { value ->
            vm.updateProvider(name) { it.copy(api = value.ifBlank { null }) }
        },
    )

    ModelsSectionTitle(stringResource(R.string.models_quick_endpoints))
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ENDPOINT_PRESETS.forEach { preset ->
            OutlinedButton(
                onClick = {
                    vm.updateProvider(name) {
                        it.copy(
                            baseUrl = preset.baseUrl,
                            api = "openai-completions",
                            auth = if (preset.auth == "keep") it.auth else preset.auth,
                        )
                    }
                },
            ) {
                Text(preset.label, fontSize = 11.sp)
            }
        }
    }

    ModelsSectionTitle(stringResource(R.string.models_provider_models))
    if (provider.models.isEmpty()) {
        ModelsHint(stringResource(R.string.models_no_models))
    } else {
        provider.models.forEachIndexed { index, model ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(colors.background)
                    .clickable { vm.select(ModelsSelection.Model(name, index)) }
                    .padding(horizontal = 10.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = model.id.ifBlank { stringResource(R.string.models_model_id) },
                        color = if (model.id.isBlank()) colors.textDim else colors.text,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                    )
                    model.name?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = colors.textMuted, fontSize = 10.5.sp)
                    }
                }
                Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.textDim, modifier = Modifier.size(18.dp))
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { vm.addModel(name) }) {
            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.models_add_model), fontSize = 12.sp)
        }
        OutlinedButton(onClick = { vm.openCatalog(name) }) {
            Text(stringResource(R.string.models_add_from_catalog), fontSize = 12.sp)
        }
    }

    ModelsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                ModelsSectionTitle(stringResource(R.string.models_delete_provider_title))
                ModelsHint(stringResource(R.string.models_delete_provider_body, name))
            }
            TextButton(onClick = { deleteOpen = true }) {
                Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.statusError, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.models_remove), color = colors.statusError, fontSize = 12.sp)
            }
        }
    }

    if (deleteOpen) {
        OmpAlertDialog(
            onDismissRequest = { deleteOpen = false },
            title = { Text(stringResource(R.string.models_delete_provider_title)) },
            text = { Text(stringResource(R.string.models_delete_provider_body, name)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleteOpen = false
                        vm.removeProvider(name)
                    },
                ) {
                    Text(stringResource(R.string.models_remove), color = colors.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteOpen = false }) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }
}

@Composable
private fun ModelEditor(
    state: ProvidersModelsState,
    vm: ProvidersModelsViewModel,
    providerName: String,
    index: Int,
) {
    val colors = LocalOmpColors.current
    val provider = state.config.providers[providerName] ?: return
    val model = provider.models.getOrNull(index) ?: return
    var removeOpen by remember { mutableStateOf(false) }
    val testKey = "$providerName:$index:${model.id}"
    val test = state.modelTest.takeIf { it.key == testKey } ?: ModelTestState()
    val apiOptions = (listOf("" to stringResource(R.string.models_inherit_none)) +
        API_PROTOCOLS.map { it to it })

    ModelsDetailHeader(
        title = model.id.ifBlank { stringResource(R.string.models_add_model) },
        subtitle = providerName,
        onBack = { vm.select(ModelsSelection.Provider(providerName)) },
    )

    ModelsTextField(
        label = stringResource(R.string.models_model_id),
        value = model.id,
        onValueChange = { value ->
            vm.updateModel(providerName, index) { it.copy(id = value) }
        },
        placeholder = "model-id",
        mono = true,
    )
    ModelsTextField(
        label = stringResource(R.string.models_model_name),
        value = model.name.orEmpty(),
        onValueChange = { value ->
            vm.updateModel(providerName, index) { it.copy(name = value.ifBlank { null }) }
        },
    )
    ModelsDropdown(
        label = stringResource(R.string.models_api_override),
        value = model.api ?: "",
        options = apiOptions,
        onSelect = { value ->
            vm.updateModel(providerName, index) { it.copy(api = value.ifBlank { null }) }
        },
    )
    ModelsCheckRow(
        checked = model.reasoning == true,
        label = stringResource(R.string.models_reasoning),
        onCheckedChange = { checked ->
            vm.updateModel(providerName, index) { it.copy(reasoning = checked.takeIf { c -> c }) }
        },
    )
    ModelsCheckRow(
        checked = model.hasImageInput,
        label = stringResource(R.string.models_image_input),
        onCheckedChange = { checked ->
            vm.updateModel(providerName, index) {
                it.copy(input = if (checked) listOf("text", "image") else null)
            }
        },
    )

    if (model.reasoning == true) {
        ThinkingEditor(
            thinking = model.thinking,
            onChange = { next ->
                vm.updateModel(providerName, index) { it.copy(thinking = next) }
            },
        )
    }

    ModelsSectionTitle(stringResource(R.string.models_token_limits))
    ModelsTextField(
        label = stringResource(R.string.models_context_window),
        value = model.contextWindow?.toString().orEmpty(),
        onValueChange = { value ->
            vm.updateModel(providerName, index) { it.copy(contextWindow = value.toIntOrNull()) }
        },
        placeholder = "128000",
        keyboard = KeyboardType.Number,
    )
    ModelsTextField(
        label = stringResource(R.string.models_max_tokens),
        value = model.maxTokens?.toString().orEmpty(),
        onValueChange = { value ->
            vm.updateModel(providerName, index) { it.copy(maxTokens = value.toIntOrNull()) }
        },
        placeholder = "16384",
        keyboard = KeyboardType.Number,
    )

    ModelsSectionTitle(stringResource(R.string.models_cost_title))
    val cost = model.cost
    CostField(
        label = stringResource(R.string.models_cost_input),
        fieldKey = "$testKey:input",
        value = cost?.input,
        onCommit = { number ->
            vm.updateModel(providerName, index) {
                it.copy(cost = normalizedModelCost((it.cost ?: ModelCostConfig()).copy(input = number)))
            }
        },
    )
    CostField(
        label = stringResource(R.string.models_cost_output),
        fieldKey = "$testKey:output",
        value = cost?.output,
        onCommit = { number ->
            vm.updateModel(providerName, index) {
                it.copy(cost = normalizedModelCost((it.cost ?: ModelCostConfig()).copy(output = number)))
            }
        },
    )
    CostField(
        label = stringResource(R.string.models_cost_cache_read),
        fieldKey = "$testKey:cacheRead",
        value = cost?.cacheRead,
        onCommit = { number ->
            vm.updateModel(providerName, index) {
                it.copy(cost = normalizedModelCost((it.cost ?: ModelCostConfig()).copy(cacheRead = number)))
            }
        },
    )
    CostField(
        label = stringResource(R.string.models_cost_cache_write),
        fieldKey = "$testKey:cacheWrite",
        value = cost?.cacheWrite,
        onCommit = { number ->
            vm.updateModel(providerName, index) {
                it.copy(cost = normalizedModelCost((it.cost ?: ModelCostConfig()).copy(cacheWrite = number)))
            }
        },
    )
    if (cost != null) {
        val missing = listOfNotNull(
            cost.input ?: "input",
            cost.output ?: "output",
        ).filter { it == "input" || it == "output" }
        if (missing.isNotEmpty()) {
            ModelsError(stringResource(R.string.models_required) + ": " + missing.joinToString(", "))
        }
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(
            onClick = { vm.testModel(providerName, index) },
            enabled = model.id.isNotBlank() && test.phase != ModelTestPhase.TESTING,
        ) {
            Text(
                stringResource(
                    when (test.phase) {
                        ModelTestPhase.TESTING -> R.string.models_testing
                        ModelTestPhase.SUCCESS -> R.string.models_test_ok
                        else -> R.string.models_test
                    },
                ),
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { removeOpen = true }) {
            Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.statusError, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.models_remove), color = colors.statusError, fontSize = 12.sp)
        }
    }
    when (test.phase) {
        ModelTestPhase.TESTING -> ModelsHint(stringResource(R.string.models_testing))
        ModelTestPhase.SUCCESS -> {
            val meta = listOfNotNull(test.latencyMs?.let { "${it}ms" }, test.responseText?.takeIf { it.isNotBlank() })
            Text(
                text = listOfNotNull(stringResource(R.string.models_test_ok), *meta.toTypedArray()).joinToString(" · "),
                color = colors.statusSuccess,
                fontSize = 11.5.sp,
            )
        }
        ModelTestPhase.ERROR -> Text(
            text = listOfNotNull(stringResource(R.string.models_test_failed), test.message).joinToString(" · "),
            color = colors.statusError,
            fontSize = 11.5.sp,
        )
        ModelTestPhase.IDLE -> ModelsHint(stringResource(R.string.models_test_hint))
    }

    if (removeOpen) {
        OmpAlertDialog(
            onDismissRequest = { removeOpen = false },
            title = { Text(stringResource(R.string.models_delete_model_title)) },
            text = { Text(stringResource(R.string.models_delete_model_body, model.id)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        removeOpen = false
                        vm.removeModel(providerName, index)
                    },
                ) {
                    Text(stringResource(R.string.models_remove), color = colors.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { removeOpen = false }) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }
}

/** Keeps its own text so typing `0.5` is not rewritten to `0` after each keystroke. */
@Composable
private fun CostField(
    label: String,
    fieldKey: String,
    value: Double?,
    onCommit: (Double?) -> Unit,
) {
    var text by remember(fieldKey) { mutableStateOf(formatCost(value)) }
    ModelsTextField(
        label = label,
        value = text,
        onValueChange = { next ->
            text = next
            if (next.isBlank() || next.toDoubleOrNull() != null) onCommit(next.toDoubleOrNull())
        },
        placeholder = "0",
        keyboard = KeyboardType.Decimal,
    )
}

private fun formatCost(value: Double?): String =
    if (value == null) "" else value.toString().removeSuffix(".0")

@Composable
private fun ThinkingEditor(
    thinking: ThinkingConfig?,
    onChange: (ThinkingConfig?) -> Unit,
) {
    val colors = LocalOmpColors.current
    ModelsSectionTitle(stringResource(R.string.models_thinking_levels))
    if (thinking != null) {
        TextButton(onClick = { onChange(null) }) {
            Text(stringResource(R.string.models_thinking_reset), fontSize = 11.sp, color = colors.textMuted)
        }
    }
    MODEL_THINKING_LEVELS.forEach { level ->
        val included = thinking?.efforts?.contains(level) ?: true
        val effort = if (included) thinking?.effortMap?.get(level) else null
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = level,
                color = if (included) colors.text else colors.textDim,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                textDecoration = if (included) null else TextDecoration.LineThrough,
                modifier = Modifier.widthIn(min = 64.dp),
            )
            LevelChip(
                label = stringResource(R.string.models_default),
                selected = included && effort == null,
                onClick = { onChange(withThinkingLevel(thinking, level, included = true, customEffort = null)) },
            )
            Spacer(Modifier.width(6.dp))
            LevelChip(
                label = stringResource(R.string.models_thinking_disabled),
                selected = !included,
                danger = true,
                onClick = { onChange(withThinkingLevel(thinking, level, included = false, customEffort = null)) },
            )
            Spacer(Modifier.width(6.dp))
            ModelsTextField(
                label = stringResource(R.string.models_thinking_custom_effort),
                value = effort.orEmpty(),
                onValueChange = { text ->
                    onChange(withThinkingLevel(thinking, level, included = true, customEffort = text))
                },
                placeholder = level,
                mono = true,
                enabled = included,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun LevelChip(label: String, selected: Boolean, onClick: () -> Unit, danger: Boolean = false) {
    val colors = LocalOmpColors.current
    val activeColor = if (danger) colors.statusError else colors.accentStrong
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) activeColor else colors.background)
            .heightIn(min = 28.dp),
    ) {
        Text(
            text = label,
            color = if (selected) colors.onAccent else colors.textMuted,
            fontSize = 10.5.sp,
        )
    }
}

@Composable
private fun CatalogDialog(state: ProvidersModelsState, vm: ProvidersModelsViewModel) {
    val colors = LocalOmpColors.current
    val providerName = state.catalogProvider ?: return
    val existing = state.config.providers[providerName]?.models?.map { it.id }?.toSet().orEmpty()
    OmpAlertDialog(
        onDismissRequest = vm::closeCatalog,
        title = { Text(stringResource(R.string.models_catalog_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ModelsHint(stringResource(R.string.models_catalog_desc))
                ModelsTextField(
                    label = stringResource(R.string.models_catalog_search),
                    value = state.catalogQuery,
                    onValueChange = vm::setCatalogQuery,
                )
                when {
                    state.catalogLoading -> Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(15.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.models_loading), color = colors.textMuted, fontSize = 12.sp)
                    }
                    state.catalogError != null -> ModelsError(state.catalogError)
                    state.catalogResults.isEmpty() && state.catalogQuery.isBlank() -> Unit
                    state.catalogResults.isEmpty() -> ModelsHint(stringResource(R.string.models_catalog_empty))
                    else -> Column(
                        modifier = Modifier
                            .heightIn(max = 360.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        state.catalogResults.forEach { model ->
                            val added = model.id in existing
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(model.id, color = colors.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                                    val details = listOfNotNull(
                                        model.name.takeIf { it.isNotBlank() && it != model.id },
                                        model.contextWindow?.let { "ctx $it" },
                                        model.maxTokens?.let { "max $it" },
                                        if (model.reasoning == true) "reasoning" else null,
                                    ).joinToString(" · ")
                                    if (details.isNotBlank()) {
                                        Text(details, color = colors.textMuted, fontSize = 10.5.sp)
                                    }
                                }
                                if (added) {
                                    Text(stringResource(R.string.models_catalog_already), color = colors.textDim, fontSize = 11.sp)
                                } else {
                                    TextButton(onClick = { vm.addCatalogModel(providerName, model, state.config.providers[providerName]?.baseUrl) }) {
                                        Text(stringResource(R.string.models_add), fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = vm::closeCatalog) {
                Text(stringResource(R.string.models_close))
            }
        },
    )
}

@Composable
private fun urlError(value: String?): String? {
    if (isValidProviderBaseUrl(value)) return null
    return stringResource(R.string.models_error_url)
}
