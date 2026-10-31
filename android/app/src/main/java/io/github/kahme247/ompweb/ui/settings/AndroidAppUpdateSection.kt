package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Settings → System & Updates → Android app update.
 *
 * One place for the app's own updater: the source (GitHub Releases or a
 * custom feed), the last check, and the install action with its progress and
 * refusal reasons. The same [AndroidUpdateController] drives the shell banner,
 * so there is only one update path.
 */
@Composable
internal fun AndroidAppUpdateCard(
    controller: AndroidUpdateController,
    appVersion: String,
) {
    val update by controller.state.collectAsStateWithLifecycle()
    LifecycleResumeEffect(controller) {
        // Coming back from Android's "install unknown apps" page continues the
        // install the user already confirmed.
        controller.resumeInstallAfterPermission()
        onPauseOrDispose { }
    }
    val context = LocalContext.current
    val colors = LocalOmpColors.current
    var useCustom by rememberSaveable(update.feedUrl) { mutableStateOf(update.feedUrl != null) }
    var customUrl by rememberSaveable(update.feedUrl) { mutableStateOf(update.feedUrl.orEmpty()) }
    var feedError by remember { mutableStateOf<String?>(null) }
    val notice = update.notice
    val latest = update.latest
    val busy = update.install is AndroidUpdateInstallState.Downloading ||
        update.install == AndroidUpdateInstallState.Verifying ||
        update.install == AndroidUpdateInstallState.Installing ||
        update.install == AndroidUpdateInstallState.AwaitingConfirmation

    SettingsCard(highlighted = false) {
        SettingsSectionTitle(stringResource(R.string.system_android_update_title))
        Text(
            text = stringResource(R.string.system_android_update_installed, appVersion),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
        )
        Text(
            text = stringResource(R.string.system_android_update_source_desc),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
        )
        // Starts and every return to the foreground check in the background;
        // the text tells users they do not have to press the button.
        Text(
            text = stringResource(R.string.system_android_update_auto_checks),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textDim,
        )

        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
                selected = !useCustom,
                onClick = {
                    useCustom = false
                    feedError = null
                    controller.setUpdateFeedUrl(null)
                },
                modifier = Modifier.testTag("android-update-source-github"),
            )
            Text(stringResource(R.string.system_android_update_github))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
                selected = useCustom,
                onClick = { useCustom = true },
                modifier = Modifier.testTag("android-update-source-custom"),
            )
            Text(stringResource(R.string.system_android_update_custom))
        }
        if (useCustom) {
            OutlinedTextField(
                value = customUrl,
                onValueChange = {
                    customUrl = it
                    feedError = null
                },
                singleLine = true,
                isError = feedError != null,
                placeholder = { Text(stringResource(R.string.system_android_update_feed_hint)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("android-update-feed-url"),
            )
            if (feedError != null) {
                Text(
                    text = feedError.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.statusError,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        feedError = controller.setUpdateFeedUrl(customUrl)
                        if (feedError == null) useCustom = true
                    },
                ) {
                    Text(stringResource(R.string.system_android_update_save))
                }
            }
        }

        SettingsDivider()
        val status = when {
            update.checking -> stringResource(R.string.system_android_update_checking)
            latest != null -> stringResource(
                R.string.system_android_update_available,
                latest.versionName,
            )
            update.failed -> stringResource(R.string.system_android_update_failed)
            update.checkedAtMillis != null -> stringResource(R.string.system_android_update_up_to_date)
            else -> null
        }
        if (status != null) {
            Text(
                text = status,
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        if (latest?.notes != null) {
            Text(
                text = latest.notes.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        AndroidUpdateInstallStatusText(update.install)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                update.install == AndroidUpdateInstallState.NeedsPermission -> {
                    Button(onClick = controller::openInstallPermissionSettings) {
                        Text(stringResource(R.string.system_android_update_open_settings))
                    }
                }
                update.install == AndroidUpdateInstallState.AwaitingConfirmation -> {
                    Button(onClick = controller::confirmInstall) {
                        Text(stringResource(R.string.system_android_update_confirm))
                    }
                }
                update.install is AndroidUpdateInstallState.Downloading ||
                    update.install == AndroidUpdateInstallState.Verifying -> {
                    OutlinedButton(onClick = controller::cancelInstall) {
                        Text(stringResource(R.string.system_android_update_cancel))
                    }
                }
                // commit() handed the APK to Android; "Install" would do nothing.
                busy -> Unit
                notice != null && notice.installable -> {
                    Button(onClick = controller::install) {
                        Text(
                            stringResource(
                                if (update.install is AndroidUpdateInstallState.Failed) {
                                    R.string.system_android_update_retry
                                } else {
                                    R.string.system_android_update_install
                                },
                            ),
                        )
                    }
                }
            }
            OutlinedButton(
                onClick = { controller.check(force = true) },
                enabled = !update.checking && !busy,
            ) {
                Text(stringResource(R.string.system_android_update_check))
            }
            if (!busy && notice?.releaseUrl != null) {
                TextButton(onClick = { openExternalUrl(context, notice.releaseUrl) }) {
                    Text(stringResource(R.string.system_android_update_release_page))
                }
            }
            if (!busy && notice != null) {
                TextButton(onClick = { controller.dismiss(notice.availableVersion) }) {
                    Text(stringResource(R.string.system_android_update_dismiss))
                }
            }
        }
        Text(
            text = stringResource(R.string.system_android_update_note),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textDim,
        )
    }
}
