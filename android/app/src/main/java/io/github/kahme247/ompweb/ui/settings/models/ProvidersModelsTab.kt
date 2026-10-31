package io.github.kahme247.ompweb.ui.settings.models

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ApiKeyProvider
import io.github.kahme247.ompweb.net.OAuthProvider
import io.github.kahme247.ompweb.ui.settings.CopyableValue
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Providers & models: Connected, Custom and System (web `ModelsConfig.tsx`).
 *
 * Content-only: the settings shell renders the tab bar and app bar; this
 * composable owns the three sub-tabs, details and save flow.
 */
@Composable
fun ProvidersModelsTab(
    vm: ProvidersModelsViewModel,
    highlight: String? = null,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.onOpen() }
    LaunchedEffect(highlight) {
        if (!highlight.isNullOrBlank()) vm.applyHighlight(highlight)
    }
    var addProviderOpen by remember { mutableStateOf(false) }
    var overwriteOpen by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (state.parseError != null) {
            ParseErrorCard(
                message = state.parseError.orEmpty(),
                path = state.configPath,
                loading = state.loading,
                onReload = vm::reloadModelsConfig,
                onOverwrite = { overwriteOpen = true },
            )
            return@Column
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            ModelsSegmented(
                options = listOf(
                    ModelsSubTab.CONNECTED to stringResource(R.string.models_tab_connected),
                    ModelsSubTab.CUSTOM to stringResource(R.string.models_tab_custom),
                    ModelsSubTab.SYSTEM to stringResource(R.string.models_tab_system),
                ),
                selected = state.subTab,
                onSelect = vm::selectSubTab,
                modifier = Modifier.weight(1f),
            )
        }

        ModelsMessage(state.message, state.messageIsError, vm::dismissMessage)
        if (state.config.unparsedEntries.isNotEmpty()) {
            ModelsError(
                stringResource(
                    R.string.models_unparsed_entries,
                    state.config.unparsedEntries.joinToString(", "),
                ),
            )
        }

        if (state.loading && state.oauthProviders.isEmpty() && state.apiKeyProviders.isEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.models_loading), color = LocalOmpColors.current.textMuted, fontSize = 12.sp)
            }
            return@Column
        }

        when (state.subTab) {
            ModelsSubTab.CONNECTED -> ConnectedContent(
                state = state,
                vm = vm,
                onAddProvider = { addProviderOpen = true },
            )
            ModelsSubTab.CUSTOM -> {
                CustomProvidersContent(state = state, vm = vm)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = vm::refresh, enabled = !state.savingConfig) {
                        Text(stringResource(R.string.models_cancel), color = LocalOmpColors.current.textMuted)
                    }
                    Spacer(Modifier.width(6.dp))
                    Button(
                        onClick = vm::saveConfig,
                        enabled = state.dirty && !state.savingConfig && state.config.unparsedEntries.isEmpty(),
                    ) {
                        Text(
                            stringResource(
                                if (state.savingConfig) R.string.models_saving else R.string.models_save,
                            ),
                        )
                    }
                }
            }
            ModelsSubTab.SYSTEM -> SystemModelsContent(state = state, vm = vm)
        }
    }

    if (addProviderOpen) {
        AddProviderDialog(
            oauthProviders = state.oauthProviders,
            apiKeyProviders = state.apiKeyProviders,
            onDismiss = { addProviderOpen = false },
            onSelectOAuth = { id ->
                addProviderOpen = false
                vm.selectSubTab(ModelsSubTab.CONNECTED)
                vm.select(ModelsSelection.OAuth(id))
            },
            onSelectApiKey = { id ->
                addProviderOpen = false
                vm.selectSubTab(ModelsSubTab.CONNECTED)
                vm.select(ModelsSelection.ApiKey(id))
            },
            onSelectCustom = {
                addProviderOpen = false
                vm.addProvider()
            },
        )
    }

    if (overwriteOpen) {
        OmpAlertDialog(
            onDismissRequest = { overwriteOpen = false },
            title = { Text(stringResource(R.string.models_parse_error_confirm_title)) },
            text = { Text(stringResource(R.string.models_parse_error_confirm_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        overwriteOpen = false
                        vm.overwriteUnparseable()
                    },
                ) {
                    Text(stringResource(R.string.models_parse_error_overwrite), color = LocalOmpColors.current.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { overwriteOpen = false }) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }

    if (state.configConflict) {
        OmpAlertDialog(
            onDismissRequest = vm::dismissConflict,
            title = { Text(stringResource(R.string.models_conflict_title)) },
            text = { Text(stringResource(R.string.models_conflict_body)) },
            confirmButton = {
                TextButton(onClick = vm::reloadAfterConflict) {
                    Text(stringResource(R.string.models_conflict_reload))
                }
            },
            dismissButton = {
                TextButton(onClick = vm::dismissConflict) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }
}

@Composable
private fun ParseErrorCard(
    message: String,
    path: String?,
    loading: Boolean,
    onReload: () -> Unit,
    onOverwrite: () -> Unit,
) {
    val colors = LocalOmpColors.current
    ModelsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = colors.statusError, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            ModelsSectionTitle(stringResource(R.string.models_parse_error_title))
        }
        ModelsHint(stringResource(R.string.models_parse_error_body))
        path?.let { CopyableValue(it) }
        Text(
            text = message,
            color = colors.textMuted,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(colors.background)
                .padding(8.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onReload, enabled = !loading) {
                Text(stringResource(if (loading) R.string.models_loading else R.string.models_reload))
            }
            TextButton(onClick = onOverwrite, enabled = !loading) {
                Text(stringResource(R.string.models_parse_error_overwrite), color = colors.statusError)
            }
        }
    }
}

@Composable
private fun ConnectedContent(
    state: ProvidersModelsState,
    vm: ProvidersModelsViewModel,
    onAddProvider: () -> Unit,
) {
    when (val selection = state.selection) {
        is ModelsSelection.OAuth -> OAuthProviderDetail(
            state = state,
            providerId = selection.providerId,
            onBack = vm::back,
            onStartOver = { vm.startLogin(selection.providerId) },
            onCancel = vm::cancelLogin,
            onSubmit = vm::submitLogin,
            onSelectOption = vm::submitLoginOption,
            onRefreshAccounts = { vm.refreshAccounts(selection.providerId) },
            onDisconnect = { credentialId -> vm.disconnectAccount(selection.providerId, credentialId) },
        )
        is ModelsSelection.ApiKey -> ApiKeyDetail(
            state = state,
            providerId = selection.providerId,
            onBack = vm::back,
            onRefresh = { vm.refreshAccounts(selection.providerId) },
            onDisconnect = { credentialId -> vm.disconnectAccount(selection.providerId, credentialId) },
        )
        else -> ConnectedList(
            state = state,
            onOpenOAuth = { vm.select(ModelsSelection.OAuth(it)) },
            onOpenApiKey = { vm.select(ModelsSelection.ApiKey(it)) },
            onFilter = vm::setConnectFilter,
            onAddProvider = onAddProvider,
        )
    }
}

@Composable
private fun ConnectedList(
    state: ProvidersModelsState,
    onOpenOAuth: (String) -> Unit,
    onOpenApiKey: (String) -> Unit,
    onFilter: (String) -> Unit,
    onAddProvider: () -> Unit,
) {
    ModelsTextField(
        label = stringResource(R.string.models_search_providers),
        value = state.connectFilter,
        onValueChange = onFilter,
        singleLine = true,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            ModelsSectionTitle(stringResource(R.string.models_connected_title))
            ModelsHint(stringResource(R.string.models_connected_desc))
        }
        Button(onClick = onAddProvider) {
            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.models_add_provider), fontSize = 12.sp)
        }
    }

    val filter = state.connectFilter.trim().lowercase()
    fun matches(id: String, name: String): Boolean =
        filter.isEmpty() || id.lowercase().contains(filter) || name.lowercase().contains(filter)

    val oauthActive = state.activeOAuth.filter { matches(it.id, it.name) }
    val apiKeyActive = state.activeApiKeys.filter { matches(it.id, it.displayName) }
    val oauthOther = state.oauthProviders.filter { !it.loggedIn && matches(it.id, it.name) }
    val apiKeyOther = state.apiKeyProviders.filter { !it.configured && matches(it.id, it.displayName) }
    val hasActive = oauthActive.isNotEmpty() || apiKeyActive.isNotEmpty()
    val hasOther = oauthOther.isNotEmpty() || apiKeyOther.isNotEmpty()

    if (!hasActive && !hasOther) {
        ModelsHint(stringResource(R.string.models_no_providers_match))
    }

    if (hasActive) {
        ModelsSectionTitle(stringResource(R.string.models_section_logged_in))
        ModelsCard {
            oauthActive.forEach { provider ->
                ConnectedRow(
                    id = provider.id,
                    name = provider.name.ifBlank { provider.id },
                    badge = stringResource(R.string.models_badge_oauth),
                    badgeColor = LocalOmpColors.current.statusSuccess,
                    onClick = { onOpenOAuth(provider.id) },
                )
            }
            apiKeyActive.forEach { provider ->
                ConnectedRow(
                    id = provider.id,
                    name = provider.displayName.ifBlank { provider.id },
                    badge = stringResource(R.string.models_badge_api_key),
                    badgeColor = LocalOmpColors.current.textMuted,
                    caption = if (provider.modelCount > 0) {
                        stringResource(R.string.models_model_count, provider.modelCount)
                    } else {
                        stringResource(R.string.models_signed_in)
                    },
                    onClick = { onOpenApiKey(provider.id) },
                )
            }
        }
    }

    if (hasOther) {
        ModelsSectionTitle(stringResource(R.string.models_section_other_providers))
        ModelsCard {
            oauthOther.forEach { provider ->
                ConnectedRow(
                    id = provider.id,
                    name = provider.name.ifBlank { provider.id },
                    badge = stringResource(R.string.models_badge_oauth),
                    badgeColor = LocalOmpColors.current.textMuted,
                    caption = stringResource(R.string.models_not_signed_in),
                    onClick = { onOpenOAuth(provider.id) },
                )
            }
            apiKeyOther.forEach { provider ->
                ConnectedRow(
                    id = provider.id,
                    name = provider.displayName.ifBlank { provider.id },
                    badge = stringResource(R.string.models_badge_api_key),
                    badgeColor = LocalOmpColors.current.textMuted,
                    caption = stringResource(R.string.models_not_signed_in),
                    onClick = { onOpenApiKey(provider.id) },
                )
            }
        }
    }
}

@Composable
private fun ConnectedRow(
    id: String,
    name: String,
    badge: String,
    badgeColor: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
    caption: String? = null,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProviderAvatar(id)
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = colors.text, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
            Text(
                text = caption ?: id,
                color = colors.textMuted,
                fontSize = 11.sp,
            )
        }
        StatusBadge(badge, badgeColor)
    }
}

@Composable
private fun AddProviderDialog(
    oauthProviders: List<OAuthProvider>,
    apiKeyProviders: List<ApiKeyProvider>,
    onDismiss: () -> Unit,
    onSelectOAuth: (String) -> Unit,
    onSelectApiKey: (String) -> Unit,
    onSelectCustom: () -> Unit,
) {
    val colors = LocalOmpColors.current
    var query by remember { mutableStateOf("") }
    val filter = query.trim().lowercase()
    val oauth = oauthProviders.filter { filter.isEmpty() || it.id.lowercase().contains(filter) || it.name.lowercase().contains(filter) }
    val apiKeys = apiKeyProviders.filter { filter.isEmpty() || it.id.lowercase().contains(filter) || it.displayName.lowercase().contains(filter) }
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.models_add_provider_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ModelsHint(stringResource(R.string.models_add_provider_desc))
                ModelsTextField(
                    label = stringResource(R.string.models_search_providers),
                    value = query,
                    onValueChange = { query = it },
                )
                Column(
                    modifier = Modifier
                        .heightIn(max = 340.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    if (oauth.isNotEmpty()) {
                        ModelsSectionTitle(stringResource(R.string.models_badge_oauth), Modifier.padding(top = 6.dp))
                        oauth.forEach { provider ->
                            DialogRow(provider.id, provider.name.ifBlank { provider.id }) { onSelectOAuth(provider.id) }
                        }
                    }
                    if (apiKeys.isNotEmpty()) {
                        ModelsSectionTitle(stringResource(R.string.models_badge_api_key), Modifier.padding(top = 6.dp))
                        apiKeys.forEach { provider ->
                            DialogRow(provider.id, provider.displayName.ifBlank { provider.id }) { onSelectApiKey(provider.id) }
                        }
                    }
                    if (!oauth.isNotEmpty() && !apiKeys.isNotEmpty()) {
                        ModelsHint(stringResource(R.string.models_no_providers_match))
                    }
                    TextButton(onClick = onSelectCustom, modifier = Modifier.padding(top = 6.dp)) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(15.dp), tint = colors.accent)
                        Spacer(Modifier.width(4.dp))
                        Text(stringResource(R.string.models_add_custom_provider), color = colors.accent, fontSize = 12.sp)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.models_close))
            }
        },
    )
}

@Composable
private fun DialogRow(id: String, name: String, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 7.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProviderAvatar(id, size = 22)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = colors.text, fontSize = 12.5.sp)
            if (name != id) Text(id, color = colors.textMuted, fontSize = 10.5.sp)
        }
        Icon(Icons.Filled.Check, contentDescription = null, tint = colors.textDim, modifier = Modifier.size(0.dp))
    }
}
