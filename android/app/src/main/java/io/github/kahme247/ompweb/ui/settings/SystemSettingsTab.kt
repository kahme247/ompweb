package io.github.kahme247.ompweb.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdatePhase
import io.github.kahme247.ompweb.net.WindowsServiceInfo
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import io.github.kahme247.ompweb.net.MobileAccessInfo
import io.github.kahme247.ompweb.net.ReleaseNotes
import io.github.kahme247.ompweb.net.WindowsServiceAction
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Settings → System & Updates: server settings, the two update cards, the
 * Mobile app card, the Windows service card (only when the server reports
 * Windows), About, and the sign-out/change-server entries.
 */
@Composable
fun SystemSettingsTab(
    viewModel: SettingsViewModel,
    onSignOut: () -> Unit,
    onChangeServer: () -> Unit,
    modifier: Modifier = Modifier,
    highlight: String? = null,
    /** The installed APK's own update check; null keeps the About card version-only (tests). */
    androidUpdates: AndroidUpdateController? = null,
    /** The installed app's `versionName`, from the one container lookup. */
    appVersion: String = "—",
) {
    val state by viewModel.systemState.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.loadSystem() }

    var confirmUninstall by remember { mutableStateOf(false) }
    // P11Sec 2: an install stops the live sessions and restarts the server, so
    // it needs the web dialog's explicit confirmation (not a one-tap action).
    var confirmUpdate by remember { mutableStateOf<UpdateKind?>(null) }

    SettingsPage(
        title = stringResource(R.string.settings_tab_system),
        modifier = modifier,
    ) {
        if (state.message != null) {
            item(key = "system-message") {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SettingsMessage(
                        text = state.message.orEmpty(),
                        error = state.messageIsError,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = viewModel::clearMessage) {
                        Text(stringResource(R.string.settings_dismiss))
                    }
                }
            }
        }

        item(key = "system-server") {
            SettingsCard(
                highlighted = highlight in setOf(
                    "auto-resume-sessions",
                    "agent-env",
                ),
            ) {
                SettingsSectionTitle(stringResource(R.string.system_server_title))
                if (state.webSettings == null) {
                    if (state.webSettingsError != null) {
                        SettingsMessage(state.webSettingsError.orEmpty(), error = true)
                        TextButton(onClick = { viewModel.loadSystem(force = true) }) {
                            Text(stringResource(R.string.settings_retry))
                        }
                    } else {
                        SettingsLoading(stringResource(R.string.system_loading))
                    }
                } else {
                    val web = state.webSettings!!
                    SettingsRow(
                        title = stringResource(R.string.system_auto_resume),
                        description = stringResource(R.string.system_auto_resume_desc),
                        highlighted = highlight == "auto-resume-sessions",
                        trailing = {
                            SettingsSwitch(
                                checked = web.autoResumeSessions,
                                onCheckedChange = viewModel::setAutoResumeSessions,
                                enabled = !state.savingWebSettings,
                            )
                        },
                    )
                    SettingsRow(
                        title = stringResource(R.string.system_agent_env),
                        description = stringResource(R.string.system_agent_env_desc),
                        highlighted = highlight == "agent-env",
                    )
                    SettingsTextArea(
                        value = state.agentEnvDraft,
                        onValueChange = viewModel::updateAgentEnvDraft,
                        placeholder = stringResource(R.string.system_agent_env_hint),
                        minLines = 4,
                    )
                    // Web `parseAgentEnvText`: one message per rejected line,
                    // and the save button stays disabled while any exists.
                    if (state.agentEnvErrors.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                text = stringResource(
                                    R.string.system_agent_env_errors,
                                    state.agentEnvErrors.size,
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = LocalOmpColors.current.statusError,
                            )
                            for (error in state.agentEnvErrors) {
                                Text(
                                    text = error,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = LocalOmpColors.current.statusError,
                                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                                )
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = viewModel::saveAgentEnv,
                            enabled = state.agentEnvDirty && state.agentEnvValid && !state.savingWebSettings,
                        ) {
                            Text(stringResource(R.string.system_save_env))
                        }
                        if (state.webSettingsError != null) {
                            SettingsMessage(state.webSettingsError.orEmpty(), error = true)
                        }
                    }
                }
            }
        }

        item(key = "system-updates") {
            SettingsCard(
                highlighted = highlight in setOf(
                    "system-app-update",
                    "system-omp-update",
                    "system-restart-sessions",
                ),
            ) {
                SettingsSectionTitle(stringResource(R.string.system_app_update))
                val appUpdate = state.appUpdate
                if (appUpdate == null) {
                    Text(
                        stringResource(R.string.system_loading),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalOmpColors.current.textMuted,
                    )
                } else {
                    if (appUpdate.updatesDisabled) {
                        Text(
                            stringResource(R.string.system_app_update_disabled),
                            style = MaterialTheme.typography.bodySmall,
                            color = LocalOmpColors.current.textMuted,
                        )
                    } else {
                        Text(
                            text = appUpdate.currentVersion?.let {
                                stringResource(R.string.system_app_update_current, it)
                            } ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = LocalOmpColors.current.textMuted,
                        )
                        Text(
                            text = if (appUpdate.updateAvailable) {
                                stringResource(
                                    R.string.system_app_update_available,
                                    appUpdate.availableVersion ?: "",
                                )
                            } else {
                                stringResource(R.string.system_app_update_up_to_date)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (appUpdate.updateAvailable) {
                                LocalOmpColors.current.statusWarning
                            } else {
                                LocalOmpColors.current.text
                            },
                        )
                        Text(
                            stringResource(R.string.system_update_command),
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalOmpColors.current.textDim,
                        )
                        CopyableValue(appUpdate.updateCommand)
                        if (appUpdate.updateAvailable) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (appUpdate.selfUpdateSupported) {
                                    Button(
                                        onClick = { confirmUpdate = UpdateKind.APP },
                                        enabled = !state.appUpdateRun.busy,
                                    ) {
                                        Text(stringResource(R.string.system_app_update_install))
                                    }
                                }
                                TextButton(onClick = viewModel::openReleaseNotes) {
                                    Text(stringResource(R.string.system_update_notes))
                                }
                            }
                        }
                    }
                }
                UpdateRunStatus(state.appUpdateRun, viewModel = viewModel)

                SettingsDivider()
                SettingsSectionTitle(stringResource(R.string.system_omp_update))
                val ompUpdate = state.ompUpdate
                if (ompUpdate == null) {
                    Text(
                        stringResource(R.string.system_omp_unknown),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalOmpColors.current.textMuted,
                    )
                } else {
                    Text(
                        text = ompUpdate.currentVersion?.let {
                            stringResource(R.string.system_omp_current, it)
                        } ?: stringResource(R.string.system_omp_unknown),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalOmpColors.current.textMuted,
                    )
                    if (ompUpdate.updateAvailable) {
                        Text(
                            stringResource(R.string.system_omp_available, ompUpdate.availableVersion ?: ""),
                            style = MaterialTheme.typography.bodyMedium,
                            color = LocalOmpColors.current.statusWarning,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = { confirmUpdate = UpdateKind.OMP },
                                enabled = !state.ompUpdateRun.busy,
                            ) {
                                Text(stringResource(R.string.system_omp_update_install))
                            }
                        }
                    }
                    CopyableValue(ompUpdate.updateCommand)
                }
                UpdateRunStatus(state.ompUpdateRun, viewModel = viewModel)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { viewModel.checkAppUpdate(force = true) },
                        enabled = !state.checkingAppUpdate,
                    ) {
                        Text(stringResource(R.string.system_check_updates))
                    }
                    OutlinedButton(
                        onClick = { viewModel.checkOmpUpdate(force = true) },
                        enabled = !state.checkingOmpUpdate,
                    ) {
                        Text(stringResource(R.string.system_omp_update))
                    }
                }
                SettingsDivider()
                SettingsRow(
                    title = stringResource(R.string.system_restart_sessions),
                    description = stringResource(R.string.system_restart_sessions_desc),
                    trailing = {
                        OutlinedButton(
                            onClick = viewModel::restartSessions,
                            enabled = !state.restartingSessions,
                        ) {
                            Text(stringResource(R.string.system_restart_sessions))
                        }
                    },
                )
            }
        }

        item(key = "system-mobile") {
            SettingsCard(highlighted = highlight == "system-mobile") {
                SettingsSectionTitle(stringResource(R.string.system_mobile_title))
                val mobile = state.mobileAccess
                if (mobile == null) {
                    if (state.mobileAccessError != null) {
                        SettingsMessage(state.mobileAccessError.orEmpty(), error = true)
                    } else {
                        SettingsLoading(stringResource(R.string.system_loading))
                    }
                } else {
                    MobileAccessContent(mobile)
                }
            }
        }

        val windows = state.windowsService
        if (windows != null && windows.isWindows) {
            item(key = "system-windows") {
                WindowsServiceCard(
                    windows = windows,
                    pending = state.windowsActionPending,
                    error = state.windowsError,
                    highlighted = highlight in setOf(
                        "windows-service-autostart",
                        "windows-service-shortcuts",
                    ),
                    onAction = viewModel::runWindowsAction,
                    onUninstallRequest = { confirmUninstall = true },
                )
            }
        }

        if (androidUpdates != null) {
            item(key = "system-android-update") {
                AndroidAppUpdateCard(
                    controller = androidUpdates,
                    appVersion = appVersion,
                )
            }
        }

        item(key = "system-about") {
            SettingsCard(highlighted = highlight == "about-app") {
                SettingsSectionTitle(stringResource(R.string.system_about_title))
                SettingsFact(
                    label = stringResource(R.string.system_about_app),
                    value = appVersion,
                )
                val info = state.appInfo
                if (info != null) {
                    SettingsFact(
                        label = stringResource(R.string.system_about_server),
                        value = "${info.name} ${info.version}",
                    )
                    SettingsFact(
                        label = stringResource(R.string.system_about_api, info.api),
                        value = info.api.toString(),
                    )
                }
                SettingsDivider()
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onSignOut) {
                        Text(stringResource(R.string.menu_sign_out))
                    }
                    OutlinedButton(onClick = onChangeServer) {
                        Text(stringResource(R.string.menu_change_server))
                    }
                }
            }
        }
    }

    if (state.releaseNotesOpen) {
        val context = LocalContext.current
        ReleaseNotesDialog(
            state = state,
            onClose = viewModel::closeReleaseNotes,
            onOpenUrl = { url ->
                // The release notes travel over the (possibly compromised)
                // server; only the same schemes every other link accepts.
                if (isSafeOpenUrl(url)) {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                }
                viewModel.closeReleaseNotes()
            },
        )
    }

    val pendingUpdate = confirmUpdate
    if (pendingUpdate != null) {
        val version = when (pendingUpdate) {
            UpdateKind.APP -> state.appUpdate?.availableVersion
            UpdateKind.OMP -> state.ompUpdate?.availableVersion
        }
        UpdateConfirmDialog(
            kind = pendingUpdate,
            version = version,
            onConfirm = {
                confirmUpdate = null
                viewModel.startUpdate(pendingUpdate)
            },
            onDismiss = { confirmUpdate = null },
        )
    }

    if (confirmUninstall) {
        OmpAlertDialog(
            onDismissRequest = { confirmUninstall = false },
            title = { Text(stringResource(R.string.system_windows_uninstall)) },
            text = { Text(stringResource(R.string.system_windows_uninstall_confirm)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmUninstall = false
                        viewModel.runWindowsAction(WindowsServiceAction.UNINSTALL)
                    },
                ) { Text(stringResource(R.string.system_windows_uninstall)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmUninstall = false }) {
                    Text(stringResource(R.string.settings_cancel))
                }
            },
        )
    }
}

@Composable
internal fun WindowsServiceCard(
    windows: WindowsServiceInfo,
    pending: Boolean,
    error: String?,
    highlighted: Boolean,
    onAction: (WindowsServiceAction) -> Unit,
    onUninstallRequest: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsCard(modifier = modifier, highlighted = highlighted) {
        SettingsSectionTitle(stringResource(R.string.system_windows_title))
        SettingsFact(
            label = stringResource(R.string.system_windows_title),
            value = if (windows.isRunning) {
                stringResource(R.string.system_windows_running, windows.port ?: 0)
            } else {
                stringResource(R.string.system_windows_stopped)
            },
        )
        SettingsFact(
            label = stringResource(R.string.settings_tab_system),
            value = if (windows.isInstalled) {
                stringResource(R.string.system_windows_installed)
            } else {
                stringResource(R.string.system_windows_not_installed)
            },
        )
        SettingsFact(
            label = stringResource(R.string.system_windows_autostart),
            value = if (windows.autostart) "On" else "Off",
        )
        SettingsFact(
            label = stringResource(R.string.system_windows_shortcut),
            value = if (windows.desktopShortcutExists) {
                stringResource(R.string.system_windows_present)
            } else {
                stringResource(R.string.system_windows_missing)
            },
        )
        if (error != null) {
            SettingsMessage(error, error = true)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!windows.isInstalled) {
                Button(
                    onClick = { onAction(WindowsServiceAction.INSTALL) },
                    enabled = !pending,
                ) {
                    Text(stringResource(R.string.system_windows_install))
                }
            } else {
                OutlinedButton(
                    onClick = { onAction(WindowsServiceAction.TOGGLE_AUTOSTART) },
                    enabled = !pending,
                ) {
                    Text(stringResource(R.string.system_windows_autostart))
                }
                if (windows.isRunning) {
                    OutlinedButton(
                        onClick = { onAction(WindowsServiceAction.STOP) },
                        enabled = !pending,
                    ) {
                        Text(stringResource(R.string.system_windows_stop))
                    }
                } else {
                    OutlinedButton(
                        onClick = { onAction(WindowsServiceAction.START) },
                        enabled = !pending,
                    ) {
                        Text(stringResource(R.string.system_windows_start))
                    }
                }
                OutlinedButton(
                    onClick = { onAction(WindowsServiceAction.RESTART) },
                    enabled = !pending,
                ) {
                    Text(stringResource(R.string.system_windows_restart))
                }
                TextButton(
                    onClick = onUninstallRequest,
                    enabled = !pending,
                ) {
                    Text(stringResource(R.string.system_windows_uninstall))
                }
            }
        }
        windows.serviceUrl?.takeIf { it.isNotBlank() }?.let { CopyableValue(it) }
    }
}

/**
 * The phase line of an in-app update (web `AppUpdateDialog` steps /
 * `settingsConfig.ompUpdateSuccess`): running phases narrate, a terminal one
 * reports the version or the server's error.
 */
@Composable
private fun UpdateRunStatus(run: UpdateRunState, viewModel: SettingsViewModel) {
    val colors = LocalOmpColors.current
    val text: String? = when (run.phase) {
        UpdatePhase.IDLE -> null
        UpdatePhase.PREPARING -> stringResource(R.string.system_update_phase_preparing)
        UpdatePhase.RESTARTING -> stringResource(R.string.system_update_phase_restarting)
        UpdatePhase.INSTALLING -> stringResource(R.string.system_update_phase_installing)
        UpdatePhase.FINALIZING -> stringResource(R.string.system_update_phase_finalizing)
        UpdatePhase.COMPLETED -> stringResource(
            R.string.system_update_completed,
            run.targetVersion ?: "?",
        )
        UpdatePhase.FAILED -> when {
            run.timedOut -> stringResource(R.string.system_update_timeout)
            run.error != null -> stringResource(R.string.system_update_failed, run.error)
            else -> stringResource(R.string.system_update_failed_generic)
        }
    }
    if (text == null) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = if (run.phase == UpdatePhase.FAILED) colors.statusError else colors.textMuted,
            modifier = Modifier
                .weight(1f)
                .semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (run.phase == UpdatePhase.FAILED) {
            TextButton(onClick = { viewModel.startUpdate(run.kind ?: return@TextButton) }) {
                Text(stringResource(R.string.settings_retry))
            }
        }
    }
}

/** The web's release-notes dialog (`/api/app-update/notes`, 204 = nothing to show). */
@Composable
private fun ReleaseNotesDialog(
    state: SystemSettingsState,
    onClose: () -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val notes = state.releaseNotes
    val url = releaseNotesUrl(notes)
    OmpAlertDialog(
        onDismissRequest = onClose,
        title = {
            Text(
                if (notes != null) {
                    stringResource(R.string.system_update_notes_title, notes.version)
                } else {
                    stringResource(R.string.system_update_notes)
                },
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 360.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                when {
                    state.releaseNotesLoading -> Text(stringResource(R.string.system_update_notes_loading))
                    state.releaseNotesError != null -> Text(
                        stringResource(R.string.system_update_notes_failed) + ": " + state.releaseNotesError,
                    )
                    notes == null -> Text(stringResource(R.string.system_update_notes_empty))
                    else -> Text(notes.body)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onClose) { Text(stringResource(R.string.settings_close)) }
        },
        dismissButton = url?.let { target ->
            {
                TextButton(onClick = { onOpenUrl(target) }) {
                    Text(stringResource(R.string.system_update_notes_open))
                }
            }
        },
    )
}

/**
 * The link the release-notes dialog offers. The server controls `htmlUrl`, so
 * it goes through the same http/https/mailto allowlist as every other external
 * link; anything else simply hides the button (P11Sec 3).
 */
internal fun releaseNotesUrl(notes: ReleaseNotes?): String? =
    notes?.htmlUrl?.trim()?.takeIf { it.isNotEmpty() && isSafeOpenUrl(it) }

/**
 * The web `AppUpdateDialog`'s idle confirmation: the install replaces files,
 * stops the live ompweb-managed sessions and restarts the server, so the user
 * opts in explicitly ("Not now" is the safe default).
 */
@Composable
internal fun UpdateConfirmDialog(
    kind: UpdateKind,
    version: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val label = version?.takeIf { it.isNotBlank() } ?: "?"
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (kind == UpdateKind.APP) {
                        R.string.system_update_confirm_title
                    } else {
                        R.string.system_omp_update_confirm_title
                    },
                ),
            )
        },
        text = {
            Text(
                stringResource(
                    if (kind == UpdateKind.APP) {
                        R.string.system_update_confirm_text
                    } else {
                        R.string.system_omp_update_confirm_text
                    },
                    label,
                ),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    stringResource(
                        if (kind == UpdateKind.APP) {
                            R.string.system_app_update_install
                        } else {
                            R.string.system_omp_update_install
                        },
                    ),
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.system_update_not_now))
            }
        },
    )
}

@Composable
private fun MobileAccessContent(mobile: MobileAccessInfo) {
    val colors = LocalOmpColors.current
    val exposure = when (mobile.binding.exposure) {
        "loopback" -> stringResource(R.string.system_mobile_exposure_loopback)
        "network" -> stringResource(R.string.system_mobile_exposure_network)
        else -> stringResource(R.string.system_mobile_exposure_unknown)
    }
    SettingsFact(
        label = stringResource(R.string.system_mobile_addresses),
        value = stringResource(
            R.string.system_mobile_binding,
            mobile.binding.hostname ?: "-",
            exposure,
            mobile.binding.port,
        ),
    )
    if (!mobile.passwordConfigured) {
        Text(
            stringResource(R.string.system_mobile_password_missing),
            style = MaterialTheme.typography.bodySmall,
            color = colors.statusWarning,
        )
    } else if (mobile.passwordProblem) {
        Text(
            stringResource(R.string.system_mobile_password_problem),
            style = MaterialTheme.typography.bodySmall,
            color = colors.statusError,
        )
    }
    if (mobile.addresses.isEmpty()) {
        Text(
            stringResource(R.string.system_mobile_no_addresses),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
        )
    } else {
        for (address in mobile.addresses) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = address.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
                CopyableValue(address.url)
            }
        }
    }
    SettingsDivider()
    Text(
        stringResource(R.string.system_mobile_methods),
        style = MaterialTheme.typography.titleSmall,
        color = colors.text,
    )
    for (method in mobile.methods) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(method.id, style = MaterialTheme.typography.bodySmall, color = colors.textMuted)
            for (command in method.commands) CopyableValue(command)
        }
    }
}
