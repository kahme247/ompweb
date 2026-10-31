package io.github.kahme247.ompweb.ui.settings

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.AppContainer
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NotifyType
import io.github.kahme247.ompweb.domain.NotifyWhenActive
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.notify.NotificationPermissionStatus
import io.github.kahme247.ompweb.notify.NotificationTestOutcome
import io.github.kahme247.ompweb.ui.notifications.NotificationBatteryState
import io.github.kahme247.ompweb.ui.notifications.NotificationConnectionState
import io.github.kahme247.ompweb.ui.notifications.NotificationPermissionState
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsActions
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsMessage
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsScreen
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsUiState
import io.github.kahme247.ompweb.ui.notifications.NotificationTypeToggle
import io.github.kahme247.ompweb.ui.notifications.NotificationWhenActive
import kotlinx.coroutines.launch

/**
 * Settings → Notifications: the Phase-8 screen, moved into the settings
 * surface instead of being copied. This adapter maps the process-wide
 * [io.github.kahme247.ompweb.notify.NotificationCenter] state onto the pure
 * UI contract; every action lands in the notification center or the
 * activity-level permission host.
 */
@Composable
fun NotificationSettingsTab(
    container: AppContainer,
    modifier: Modifier = Modifier,
    highlight: String? = null,
) {
    val snapshot by container.settings.snapshot.collectAsStateWithLifecycle()
    val permissionRevision by container.notifications.permissionRevision.collectAsStateWithLifecycle()
    val connection by container.notifications.connection.collectAsStateWithLifecycle()
    val runtimeActive by container.notifications.runtimeActive.collectAsStateWithLifecycle()
    val running by container.notifications.runningCount.collectAsStateWithLifecycle()
    val registrationError by container.notifications.registrationError.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<NotificationSettingsMessage?>(null) }

    val testSent = stringResource(R.string.notify_test_sent)
    val testShown = stringResource(R.string.notify_test_shown)
    val testBlocked = stringResource(R.string.notify_test_blocked)
    val testFailed = stringResource(R.string.notify_test_failed)
    val syncFailed = stringResource(R.string.notify_sync_failed)

    // Returning from the system notification/battery screens re-reads the
    // permission state instead of showing a stale "blocked".
    LifecycleResumeEffect(Unit) {
        container.notifications.refreshPermissions()
        onPauseOrDispose { }
    }

    val status = remember(permissionRevision, snapshot.notifyPermissionPrompted) {
        container.notifications.permissionStatus()
    }
    val prefs = snapshot.notifyPrefs
    val uiState = NotificationSettingsUiState(
        enabled = prefs.enabled,
        types = mapOf(
            NotificationTypeToggle.COMPLETED to prefs.isEnabled(NotifyType.Completed),
            NotificationTypeToggle.INPUT to prefs.isEnabled(NotifyType.Input),
            NotificationTypeToggle.ERROR to prefs.isEnabled(NotifyType.Error),
            NotificationTypeToggle.MODEL_SWITCH to prefs.isEnabled(NotifyType.ModelSwitch),
        ),
        whenActive = when (prefs.whenActive) {
            NotifyWhenActive.System -> NotificationWhenActive.SYSTEM
            NotifyWhenActive.Toast -> NotificationWhenActive.TOAST
        },
        vibrate = prefs.vibrate,
        permission = permissionState(status, snapshot.notifyPermissionPrompted),
        battery = when {
            status.batteryUnrestricted -> NotificationBatteryState.EXEMPT
            else -> NotificationBatteryState.NOT_EXEMPT
        },
        connection = when {
            !prefs.enabled -> NotificationConnectionState.DISABLED
            !runtimeActive -> NotificationConnectionState.CONNECTING
            connection == ConnectionState.Connected -> NotificationConnectionState.CONNECTED
            connection == ConnectionState.Reconnecting -> NotificationConnectionState.CONNECTING
            else -> NotificationConnectionState.OFFLINE
        },
        connectionDetail = if (connection == ConnectionState.Connected && running > 0) {
            pluralStringResource(R.plurals.notify_running_agents, running, running)
        } else {
            null
        },
        busy = busy,
        message = message,
    )

    fun showMessage(text: String, error: Boolean = false) {
        message = NotificationSettingsMessage(text, error)
    }

    LaunchedEffect(registrationError) {
        registrationError?.let { showMessage("$syncFailed: $it", error = true) }
    }

    NotificationSettingsScreen(
        state = uiState,
        modifier = modifier,
        highlight = highlight,
        actions = NotificationSettingsActions(
            setEnabled = { enabled ->
                if (enabled) {
                    val current = container.notifications.permissionStatus()
                    if (!current.appNotificationsEnabled || !current.postNotificationsGranted) {
                        if (current.canRequestPostNotifications) {
                            container.notifications.requestPostNotificationPermission()
                        } else {
                            container.notifications.openSystemNotificationSettings()
                        }
                    }
                }
                container.notifications.setEnabled(enabled)
            },
            setType = { toggle, enabled ->
                val type = when (toggle) {
                    NotificationTypeToggle.COMPLETED -> NotifyType.Completed
                    NotificationTypeToggle.INPUT -> NotifyType.Input
                    NotificationTypeToggle.ERROR -> NotifyType.Error
                    NotificationTypeToggle.MODEL_SWITCH -> NotifyType.ModelSwitch
                }
                container.notifications.setTypeEnabled(type, enabled)
            },
            setWhenActive = { choice ->
                container.notifications.setWhenActive(
                    when (choice) {
                        NotificationWhenActive.SYSTEM -> NotifyWhenActive.System
                        NotificationWhenActive.TOAST -> NotifyWhenActive.Toast
                    },
                )
            },
            setVibrate = { container.notifications.setVibrate(it) },
            sendTest = {
                if (!busy) {
                    busy = true
                    scope.launch {
                        val outcome = container.notifications.sendTest()
                        busy = false
                        val testMessage = notificationTestMessage(outcome, testSent, testShown, testBlocked, testFailed)
                        showMessage(testMessage.text, testMessage.error)
                    }
                }
            },
            requestPermission = { container.notifications.requestPostNotificationPermission() },
            openNotificationSettings = { container.notifications.openSystemNotificationSettings() },
            requestBatteryExemption = { container.notifications.requestBatteryExemption() },
            dismissMessage = { message = null },
        ),
    )
}

/**
 * Maps the "Send test" answer onto the visible message (web
 * `NotificationSettingsCard.tsx`: sent / shown locally / permission blocked /
 * failed with the reason). Extracted so the four branches are covered by a
 * JVM test instead of a screenshot.
 */
internal fun notificationTestMessage(
    outcome: NotificationTestOutcome,
    sent: String,
    shown: String,
    blocked: String,
    failed: String,
): NotificationSettingsMessage = when (outcome) {
    NotificationTestOutcome.Sent -> NotificationSettingsMessage(sent)
    NotificationTestOutcome.LocalShown -> NotificationSettingsMessage(shown)
    NotificationTestOutcome.Blocked -> NotificationSettingsMessage(blocked, error = true)
    is NotificationTestOutcome.Failed -> NotificationSettingsMessage("$failed: ${outcome.message}", error = true)
}

private fun permissionState(
    status: NotificationPermissionStatus,
    prompted: Boolean,
): NotificationPermissionState = when {
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ->
        if (status.appNotificationsEnabled) {
            NotificationPermissionState.UNSUPPORTED
        } else {
            NotificationPermissionState.DENIED
        }
    !status.postNotificationsGranted ->
        if (prompted) NotificationPermissionState.DENIED else NotificationPermissionState.NOT_ASKED
    !status.appNotificationsEnabled -> NotificationPermissionState.DENIED
    else -> NotificationPermissionState.GRANTED
}
