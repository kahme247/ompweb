package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsMessage
import io.github.kahme247.ompweb.ui.settings.SettingsRow
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The settings surface Slice A implements (prefs, permission, service state).
 * Every field is driven by A; this screen only renders it and calls the
 * actions, which keeps the permission request inside the user's tap.
 */
enum class NotificationTypeToggle {
    COMPLETED,
    INPUT,
    ERROR,
    MODEL_SWITCH,
}

/** Web `prefs.whenActive`: in-app toast vs. system notification while active elsewhere. */
enum class NotificationWhenActive { TOAST, SYSTEM }

/** `POST_NOTIFICATIONS` (API 33+) runtime permission state. */
enum class NotificationPermissionState { NOT_ASKED, GRANTED, DENIED, UNSUPPORTED }

/** Battery-optimisation exemption; doze without it delays the foreground service. */
enum class NotificationBatteryState { EXEMPT, NOT_EXEMPT }

/** The foreground service's connection, shown as a status row. */
enum class NotificationConnectionState { DISABLED, CONNECTING, CONNECTED, OFFLINE }

/** One-shot result line (test sent, save failed, server's 502 answer). */
data class NotificationSettingsMessage(
    val text: String,
    val error: Boolean = false,
)

/** Web defaults: enabled off, completed/input/error on, model switch off, when-active toast. */
val DEFAULT_NOTIFICATION_TYPES: Map<NotificationTypeToggle, Boolean> = mapOf(
    NotificationTypeToggle.COMPLETED to true,
    NotificationTypeToggle.INPUT to true,
    NotificationTypeToggle.ERROR to true,
    NotificationTypeToggle.MODEL_SWITCH to false,
)

data class NotificationSettingsUiState(
    val enabled: Boolean = false,
    val types: Map<NotificationTypeToggle, Boolean> = DEFAULT_NOTIFICATION_TYPES,
    val whenActive: NotificationWhenActive = NotificationWhenActive.TOAST,
    /** The user's vibration choice: on by default, independent of the type list. */
    val vibrate: Boolean = true,
    val permission: NotificationPermissionState = NotificationPermissionState.NOT_ASKED,
    val battery: NotificationBatteryState = NotificationBatteryState.EXEMPT,
    val connection: NotificationConnectionState = NotificationConnectionState.DISABLED,
    /** e.g. "2 agents running" / the service's last failure; null uses the plain state label. */
    val connectionDetail: String? = null,
    /** A prefs save or permission request is running; switches stay disabled. */
    val busy: Boolean = false,
    val message: NotificationSettingsMessage? = null,
) {
    fun typeEnabled(type: NotificationTypeToggle): Boolean = types[type] ?: false
}

/**
 * What the screen can ask for. Slice A owns prefs and permissions:
 * `setEnabled(true)` must request `POST_NOTIFICATIONS` inside that tap
 * (invariant 14), `sendTest` posts `/api/notifications/test` and falls back to
 * a local notification through A's renderer when this install is not subscribed.
 */
data class NotificationSettingsActions(
    val setEnabled: (Boolean) -> Unit,
    val setType: (NotificationTypeToggle, Boolean) -> Unit,
    val setWhenActive: (NotificationWhenActive) -> Unit,
    val setVibrate: (Boolean) -> Unit,
    val sendTest: () -> Unit,
    val requestPermission: () -> Unit,
    val openNotificationSettings: () -> Unit,
    val requestBatteryExemption: () -> Unit,
    val dismissMessage: () -> Unit,
)

/**
 * Notifications settings (web `NotificationSettingsPanel`): enable, per-type
 * toggles, when-active choice, test notification, permission/battery fix rows
 * and the service's connection state.
 *
 * Content only — the shell provides the surrounding screen and back affordance.
 */
@Composable
fun NotificationSettingsScreen(
    state: NotificationSettingsUiState,
    actions: NotificationSettingsActions,
    modifier: Modifier = Modifier,
    highlight: String? = null,
) {
    val colors = LocalOmpColors.current
    val controlsEnabled = state.enabled && !state.busy
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.notify_ui_settings_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            color = colors.text,
        )
        Text(
            text = stringResource(R.string.notify_ui_settings_subtitle),
            color = colors.textMuted,
            fontSize = 12.sp,
        )

        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.notify_ui_enable),
                description = stringResource(R.string.notify_ui_enable_desc),
                highlighted = highlight == "notifications-enable",
                trailing = {
                    Switch(
                        checked = state.enabled,
                        onCheckedChange = actions.setEnabled,
                        enabled = !state.busy,
                    )
                },
            )
            if (state.enabled && state.permission != NotificationPermissionState.GRANTED) {
                PermissionNote(state.permission)
            }
            PermissionRow(state.permission, actions)
        }

        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.notify_ui_connection),
                trailing = {
                    Text(
                        text = connectionLabel(state),
                        color = when (state.connection) {
                            NotificationConnectionState.CONNECTED -> colors.statusSuccess
                            NotificationConnectionState.OFFLINE -> colors.statusError
                            NotificationConnectionState.CONNECTING -> colors.statusWarning
                            NotificationConnectionState.DISABLED -> colors.textDim
                        },
                        fontSize = 12.sp,
                    )
                },
            )
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.notify_ui_battery),
                        color = colors.text,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = batteryLabel(state.battery),
                        color = if (state.battery == NotificationBatteryState.NOT_EXEMPT) colors.statusWarning else colors.textMuted,
                        fontSize = 11.5.sp,
                    )
                }
                if (state.battery != NotificationBatteryState.EXEMPT) {
                    Button(onClick = actions.requestBatteryExemption) {
                        Text(stringResource(R.string.notify_ui_battery_fix))
                    }
                }
            }
        }

        Text(
            text = stringResource(R.string.notify_ui_types_title),
            color = colors.textMuted,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 4.dp),
        )
        SettingsCard {
            NotificationTypeToggle.entries.forEach { type ->
                SettingsRow(
                    title = typeLabel(type),
                    description = typeDescription(type),
                    enabled = controlsEnabled,
                    highlighted = highlight == typePreferenceId(type),
                    trailing = {
                        Switch(
                            checked = state.typeEnabled(type),
                            onCheckedChange = { actions.setType(type, it) },
                            enabled = controlsEnabled,
                        )
                    },
                )
            }
        }

        Text(
            text = stringResource(R.string.notify_ui_feedback_title),
            color = colors.textMuted,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 4.dp),
        )
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.notify_ui_vibrate),
                description = stringResource(R.string.notify_ui_vibrate_desc),
                enabled = controlsEnabled,
                highlighted = highlight == "notifications-vibrate",
                trailing = {
                    Switch(
                        checked = state.vibrate,
                        onCheckedChange = actions.setVibrate,
                        enabled = controlsEnabled,
                        modifier = Modifier.testTag("notifications-vibrate-switch"),
                    )
                },
            )
        }

        Text(
            text = stringResource(R.string.notify_ui_when_active),
            color = colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
        SettingsCard(highlighted = highlight == "notifications-when-active") {
            WhenActiveOption(
                label = stringResource(R.string.notify_ui_when_active_toast),
                selected = state.whenActive == NotificationWhenActive.TOAST,
                enabled = controlsEnabled,
                onSelect = { actions.setWhenActive(NotificationWhenActive.TOAST) },
            )
            WhenActiveOption(
                label = stringResource(R.string.notify_ui_when_active_system),
                selected = state.whenActive == NotificationWhenActive.SYSTEM,
                enabled = controlsEnabled,
                onSelect = { actions.setWhenActive(NotificationWhenActive.SYSTEM) },
            )
        }

        Button(
            onClick = actions.sendTest,
            enabled = state.enabled && !state.busy,
        ) {
            Text(stringResource(R.string.notify_ui_send_test))
        }

        state.message?.let { message ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                SettingsMessage(
                    text = message.text,
                    error = message.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = actions.dismissMessage) {
                    Text(stringResource(R.string.notify_ui_dismiss_message), color = colors.textMuted)
                }
            }
        }
    }
}

@Composable
private fun PermissionRow(
    permission: NotificationPermissionState,
    actions: NotificationSettingsActions,
) {
    val colors = LocalOmpColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.notify_ui_permission),
                color = colors.text,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = when (permission) {
                    NotificationPermissionState.NOT_ASKED -> stringResource(R.string.notify_ui_permission_not_asked)
                    NotificationPermissionState.GRANTED -> stringResource(R.string.notify_ui_permission_granted)
                    NotificationPermissionState.DENIED -> stringResource(R.string.notify_ui_permission_denied)
                    NotificationPermissionState.UNSUPPORTED -> stringResource(R.string.notify_ui_permission_unsupported)
                },
                color = if (permission == NotificationPermissionState.DENIED) colors.statusWarning else colors.textMuted,
                fontSize = 11.5.sp,
            )
        }
        when (permission) {
            NotificationPermissionState.NOT_ASKED ->
                Button(onClick = actions.requestPermission) {
                    Text(stringResource(R.string.notify_ui_permission_allow))
                }

            NotificationPermissionState.DENIED ->
                Button(onClick = actions.openNotificationSettings) {
                    Text(stringResource(R.string.notify_ui_permission_open_settings))
                }

            NotificationPermissionState.GRANTED, NotificationPermissionState.UNSUPPORTED -> Unit
        }
    }
}

/** Web `notifications.statusPermission`: explains why nothing is delivered yet. */
@Composable
private fun PermissionNote(permission: NotificationPermissionState) {
    if (permission == NotificationPermissionState.GRANTED) return
    val colors = LocalOmpColors.current
    Text(
        text = if (permission == NotificationPermissionState.DENIED) {
            stringResource(R.string.notify_ui_status_permission_denied)
        } else {
            stringResource(R.string.notify_ui_status_permission)
        },
        color = colors.statusWarning,
        fontSize = 11.5.sp,
    )
}

@Composable
private fun connectionLabel(state: NotificationSettingsUiState): String = when (state.connection) {
    NotificationConnectionState.DISABLED -> stringResource(R.string.notify_ui_connection_off)
    NotificationConnectionState.CONNECTING -> stringResource(R.string.notify_ui_connection_connecting)
    NotificationConnectionState.CONNECTED -> state.connectionDetail?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.notify_ui_connection_connected)

    NotificationConnectionState.OFFLINE -> state.connectionDetail?.takeIf { it.isNotBlank() }
        ?: stringResource(R.string.notify_ui_connection_offline)
}

@Composable
private fun batteryLabel(state: NotificationBatteryState): String = when (state) {
    NotificationBatteryState.EXEMPT -> stringResource(R.string.notify_ui_battery_exempt)
    NotificationBatteryState.NOT_EXEMPT -> stringResource(R.string.notify_ui_battery_restricted)
}

@Composable
private fun typeLabel(type: NotificationTypeToggle): String = when (type) {
    NotificationTypeToggle.COMPLETED -> stringResource(R.string.notify_ui_type_completed)
    NotificationTypeToggle.INPUT -> stringResource(R.string.notify_ui_type_input)
    NotificationTypeToggle.ERROR -> stringResource(R.string.notify_ui_type_error)
    NotificationTypeToggle.MODEL_SWITCH -> stringResource(R.string.notify_ui_type_model_switch)
}

/** The settings-search row id the web attaches to each notification type. */
private fun typePreferenceId(type: NotificationTypeToggle): String = when (type) {
    NotificationTypeToggle.COMPLETED -> "notifications-completed"
    NotificationTypeToggle.INPUT -> "notifications-input"
    NotificationTypeToggle.ERROR -> "notifications-error"
    NotificationTypeToggle.MODEL_SWITCH -> "notifications-modelSwitch"
}

@Composable
private fun typeDescription(type: NotificationTypeToggle): String = when (type) {
    NotificationTypeToggle.COMPLETED -> stringResource(R.string.notify_ui_type_completed_desc)
    NotificationTypeToggle.INPUT -> stringResource(R.string.notify_ui_type_input_desc)
    NotificationTypeToggle.ERROR -> stringResource(R.string.notify_ui_type_error_desc)
    NotificationTypeToggle.MODEL_SWITCH -> stringResource(R.string.notify_ui_type_model_switch_desc)
}

@Composable
private fun WhenActiveOption(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Spacer(Modifier.width(8.dp))
        Text(text = label, color = if (enabled) colors.text else colors.textDim, fontSize = 12.5.sp)
    }
}
