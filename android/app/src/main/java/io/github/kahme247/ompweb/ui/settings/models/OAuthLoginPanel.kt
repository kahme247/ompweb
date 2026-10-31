package io.github.kahme247.ompweb.ui.settings.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.OAuthLoginState
import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import io.github.kahme247.ompweb.domain.isWorking
import io.github.kahme247.ompweb.domain.loopbackTarget
import io.github.kahme247.ompweb.domain.submitToken
import io.github.kahme247.ompweb.net.ProviderAccounts
import io.github.kahme247.ompweb.net.ProviderAccount
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.settings.CopyableValue
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * OAuth provider detail: the login flow (`OAuthLoginState`) plus omp's stored
 * accounts. The flow starts as soon as the detail opens, like the web's
 * `OAuthDetail` effect.
 */
@Composable
fun OAuthProviderDetail(
    state: ProvidersModelsState,
    providerId: String,
    onBack: () -> Unit,
    onStartOver: () -> Unit,
    onCancel: () -> Unit,
    onSubmit: (String) -> Unit,
    onSelectOption: (String) -> Unit,
    onRefreshAccounts: () -> Unit,
    onDisconnect: (Long) -> Unit,
) {
    val provider = state.oauthProviders.firstOrNull { it.id == providerId }
    ModelsDetailHeader(
        title = provider?.name?.ifBlank { providerId } ?: providerId,
        subtitle = providerId,
        onBack = onBack,
    )
    LoginPanel(
        login = state.login,
        providerId = providerId,
        onStartOver = onStartOver,
        onCancel = onCancel,
        onSubmit = onSubmit,
        onSelectOption = onSelectOption,
    )
    AccountsCard(
        accounts = state.accounts,
        loading = state.accountsLoading,
        onRefresh = onRefreshAccounts,
        onDisconnect = onDisconnect,
    )
}

/** API-key provider detail: status only, with the server's write guidance. */
@Composable
fun ApiKeyDetail(
    state: ProvidersModelsState,
    providerId: String,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onDisconnect: (Long) -> Unit,
) {
    val colors = LocalOmpColors.current
    val status = state.apiKeyStatus
    ModelsDetailHeader(
        title = status?.displayName?.ifBlank { providerId } ?: providerId,
        subtitle = providerId,
        onBack = onBack,
    )
    ModelsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ModelsSectionTitle(stringResource(R.string.models_api_key_title))
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onRefresh, enabled = !state.accountsLoading) {
                Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.textMuted, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(3.dp))
                Text(stringResource(R.string.models_refresh), fontSize = 11.sp, color = colors.textMuted)
            }
        }
        if (state.accountsLoading && status == null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(15.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.models_loading), color = colors.textMuted, fontSize = 12.sp)
            }
        } else {
            Text(
                text = if (status?.configured == true) {
                    stringResource(R.string.models_api_key_configured, status.models)
                } else {
                    stringResource(R.string.models_api_key_missing)
                },
                color = if (status?.configured == true) colors.statusSuccess else colors.textMuted,
                fontSize = 12.sp,
            )
        }
        ModelsSectionTitle(stringResource(R.string.models_api_key_readonly))
        ModelsHint(state.apiKeyGuidance ?: stringResource(R.string.models_api_key_guidance_fallback))
    }
    AccountsCard(
        accounts = state.accounts,
        loading = state.accountsLoading,
        onRefresh = onRefresh,
        onDisconnect = onDisconnect,
    )
}

@Composable
private fun LoginPanel(
    login: io.github.kahme247.ompweb.domain.OAuthLoginMachine,
    providerId: String,
    onStartOver: () -> Unit,
    onCancel: () -> Unit,
    onSubmit: (String) -> Unit,
    onSelectOption: (String) -> Unit,
) {
    val state = login.state
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    // OAuth URLs and device codes are credentials: the clip stays sensitive,
    // and the opener validates the scheme before launching a Custom Tab.
    val copy: (String) -> Unit = { text -> copyTextToClipboard(context, "OAuth value", text, sensitive = true) }
    val openUrl: (String) -> Unit = { url -> openExternalUrl(context, url) }
    // Cleared whenever the flow asks for a different value, so a submit never
    // reuses the answer for a previous step.
    var input by remember(providerId, state.submitToken, state::class) { mutableStateOf("") }
    val loopback = state.loopbackTarget()

    ModelsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ModelsSectionTitle(stringResource(R.string.models_login_title))
            Spacer(Modifier.weight(1f))
            when {
                state.isWorking -> TextButton(onClick = onCancel) {
                    Text(stringResource(R.string.models_login_stop), color = colors.textMuted, fontSize = 11.sp)
                }
                state == OAuthLoginState.Success || state is OAuthLoginState.Error ||
                    state == OAuthLoginState.TransportLost -> TextButton(onClick = onStartOver) {
                    Text(stringResource(R.string.models_login_start_over), color = colors.accent, fontSize = 11.sp)
                }
                state == OAuthLoginState.Idle -> Button(onClick = onStartOver) {
                    Text(stringResource(R.string.models_login_title))
                }
            }
        }

        when (state) {
            OAuthLoginState.Idle -> ModelsHint(stringResource(R.string.models_login_connecting))
            OAuthLoginState.Connecting -> WorkingRow(stringResource(R.string.models_login_connecting))
            OAuthLoginState.Submitting -> WorkingRow(stringResource(R.string.models_login_submitting))
            is OAuthLoginState.Progress ->
                WorkingRow(state.message.ifBlank { stringResource(R.string.models_login_connecting) })
            is OAuthLoginState.Auth -> {
                val urlAllowed = isSafeOpenUrl(state.url)
                if (loopback != null) {
                    DesktopFlowNote(host = loopback.host, port = loopback.port)
                } else {
                    ModelsHint(stringResource(R.string.models_login_step_1))
                    ModelsHint(stringResource(R.string.models_login_step_2))
                    Button(onClick = { openUrl(state.url) }, enabled = urlAllowed) {
                        Text(stringResource(R.string.models_login_open_browser), fontSize = 12.sp)
                    }
                }
                if (!urlAllowed) ModelsError(stringResource(R.string.models_login_url_blocked))
                state.instructions?.let { ModelsHint(it) }
                CopyableValue(state.url, sensitive = true)
                if (state.token.isNotBlank()) {
                    PasteSubmit(
                        label = stringResource(R.string.models_login_paste_label),
                        placeholder = stringResource(R.string.models_login_paste_placeholder),
                        value = input,
                        onValueChange = { input = it },
                        onSubmit = { onSubmit(input.trim()) },
                    )
                }
            }
            is OAuthLoginState.DeviceCode -> {
                ModelsHint(stringResource(R.string.models_login_device_code))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = state.userCode,
                        color = colors.text,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(onClick = { copy(state.userCode) }) {
                        Text(stringResource(R.string.models_copy), fontSize = 12.sp)
                    }
                }
                state.expiresInSeconds?.let { seconds ->
                    ModelsHint(
                        stringResource(R.string.models_login_device_expires, (seconds / 60).coerceAtLeast(1)),
                    )
                }
                val verificationAllowed = isSafeOpenUrl(state.verificationUri)
                Button(onClick = { openUrl(state.verificationUri) }, enabled = verificationAllowed) {
                    Text(stringResource(R.string.models_login_open_browser), fontSize = 12.sp)
                }
                if (!verificationAllowed) ModelsError(stringResource(R.string.models_login_url_blocked))
                CopyableValue(state.verificationUri, sensitive = true)
                if (state.submitToken != null) {
                    PasteSubmit(
                        label = stringResource(R.string.models_login_paste_label),
                        placeholder = stringResource(R.string.models_login_paste_placeholder),
                        value = input,
                        onValueChange = { input = it },
                        onSubmit = { onSubmit(input.trim()) },
                    )
                }
            }
            is OAuthLoginState.Prompt -> {
                ModelsHint(state.message)
                state.placeholder?.let { ModelsHint(it) }
                PasteSubmit(
                    label = stringResource(R.string.models_login_paste_label),
                    placeholder = state.placeholder ?: stringResource(R.string.models_login_paste_placeholder),
                    value = input,
                    onValueChange = { input = it },
                    onSubmit = { onSubmit(input.trim()) },
                )
            }
            is OAuthLoginState.Select -> {
                ModelsHint(state.message)
                ModelsHint(stringResource(R.string.models_login_select_hint))
                state.options.forEach { option ->
                    OutlinedButton(
                        onClick = { onSelectOption(option.id) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(option.label, fontSize = 12.sp)
                    }
                }
            }
            OAuthLoginState.Success -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = colors.statusSuccess, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.models_login_success), color = colors.statusSuccess, fontSize = 12.sp)
            }
            is OAuthLoginState.Error -> Row(verticalAlignment = Alignment.Top) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = colors.statusError, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    text = state.message.ifBlank { stringResource(R.string.models_login_failed) },
                    color = colors.statusError,
                    fontSize = 12.sp,
                )
            }
            OAuthLoginState.TransportLost -> ModelsError(stringResource(R.string.models_login_transport_lost))
        }
    }
}

@Composable
private fun WorkingRow(text: String) {
    val colors = LocalOmpColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(15.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(8.dp))
        Text(text, color = colors.textMuted, fontSize = 12.sp)
    }
}

/** The phone cannot reach the PC's loopback callback server; explain and keep paste available. */
@Composable
private fun DesktopFlowNote(host: String, port: Int?) {
    val colors = LocalOmpColors.current
    val target = if (port != null) "$host:$port" else host
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = colors.statusWarning, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                text = stringResource(R.string.models_login_desktop_title),
                color = colors.text,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        ModelsHint(stringResource(R.string.models_login_desktop_body, target))
        CopyableValue(
            stringResource(R.string.models_login_callback_unreachable, target),
            sensitive = true,
        )
    }
}

@Composable
private fun PasteSubmit(
    label: String,
    placeholder: String,
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ModelsTextField(
            label = label,
            value = value,
            onValueChange = onValueChange,
            placeholder = placeholder,
            singleLine = false,
            minLines = 1,
        )
        Row {
            Button(onClick = onSubmit, enabled = value.isNotBlank()) {
                Text(stringResource(R.string.models_login_submit), fontSize = 12.sp)
            }
        }
    }
}

/** omp's stored accounts for one provider with the disconnect action. */
@Composable
fun AccountsCard(
    accounts: ProviderAccounts?,
    loading: Boolean,
    onRefresh: () -> Unit,
    onDisconnect: (Long) -> Unit,
    showRefresh: Boolean = true,
) {
    val colors = LocalOmpColors.current
    ModelsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ModelsSectionTitle(stringResource(R.string.models_accounts_title))
            Spacer(Modifier.weight(1f))
            if (showRefresh) {
                TextButton(onClick = onRefresh, enabled = !loading) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.textMuted, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(3.dp))
                    Text(stringResource(R.string.models_refresh), fontSize = 11.sp, color = colors.textMuted)
                }
            }
        }
        ModelsHint(stringResource(R.string.models_accounts_desc))
        when {
            loading && accounts == null -> WorkingRow(stringResource(R.string.models_loading))
            accounts == null -> Unit
            !accounts.supported -> ModelsHint(stringResource(R.string.models_accounts_unsupported))
            accounts.accounts.isEmpty() -> ModelsHint(stringResource(R.string.models_accounts_empty))
            else -> accounts.accounts.forEach { account ->
                AccountRow(account = account, onDisconnect = { onDisconnect(account.credentialId) })
            }
        }
    }
}

@Composable
private fun AccountRow(account: ProviderAccount, onDisconnect: () -> Unit) {
    val colors = LocalOmpColors.current
    var confirm by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = account.label.ifBlank { account.type },
                color = colors.text,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
            if (account.detail.isNotBlank()) {
                Text(account.detail, color = colors.textMuted, fontSize = 11.sp)
            }
            Text(account.type, color = colors.textDim, fontSize = 10.sp)
        }
        TextButton(onClick = { confirm = true }) {
            Text(stringResource(R.string.models_disconnect), color = colors.statusError, fontSize = 11.sp)
        }
    }
    if (confirm) {
        OmpAlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.models_disconnect_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.models_disconnect_body,
                        account.label.ifBlank { account.type },
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        onDisconnect()
                    },
                ) {
                    Text(stringResource(R.string.models_disconnect), color = colors.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirm = false }) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }
}
