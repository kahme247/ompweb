package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.AndroidUpdateNotice
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The app's own update announcement. The APK is distributed on GitHub Releases
 * or the custom feed the user configured, so this never depends on the server.
 * Non-blocking like [UpdateNoticeBanner]; "Install update" downloads and
 * verifies the APK, "Release page" opens the GitHub release in a Custom Tab
 * (only when the source has one) and "Dismiss" hides exactly that version
 * until a newer release appears.
 */
@Composable
fun AndroidUpdateBanner(
    notice: AndroidUpdateNotice?,
    install: AndroidUpdateInstallState,
    onInstall: (AndroidUpdateNotice) -> Unit,
    onOpenInstallSettings: () -> Unit,
    onConfirmInstall: () -> Unit,
    onCancelInstall: () -> Unit,
    onOpenRelease: (AndroidUpdateNotice) -> Unit,
    onDismiss: (AndroidUpdateNotice) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (notice == null) return
    val colors = LocalOmpColors.current
    val busy = install is AndroidUpdateInstallState.Downloading ||
        install == AndroidUpdateInstallState.Verifying ||
        install == AndroidUpdateInstallState.Installing ||
        install == AndroidUpdateInstallState.AwaitingConfirmation
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .testTag("android-update-banner")
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = colors.panel,
        border = BorderStroke(1.dp, colors.accent),
        shape = RoundedCornerShape(12.dp),
    ) {
        BoxWithConstraints {
            // Same rule as UpdateNoticeBanner: two actions beside a long
            // version line leave nothing for the text on narrow panes or at
            // large font scales.
            val narrow = maxWidth < NARROW_ANDROID_BANNER_MAX_WIDTH
            if (narrow) {
                Column(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    AndroidUpdateTexts(notice)
                    AndroidUpdateInstallStatusText(install)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        AndroidUpdateActions(
                            notice = notice,
                            install = install,
                            busy = busy,
                            onInstall = onInstall,
                            onOpenInstallSettings = onOpenInstallSettings,
                            onConfirmInstall = onConfirmInstall,
                            onCancelInstall = onCancelInstall,
                            onOpenRelease = onOpenRelease,
                            onDismiss = onDismiss,
                        )
                    }
                }
            } else {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        AndroidUpdateTexts(notice)
                        AndroidUpdateInstallStatusText(install)
                    }
                    AndroidUpdateActions(
                        notice = notice,
                        install = install,
                        busy = busy,
                        onInstall = onInstall,
                        onOpenInstallSettings = onOpenInstallSettings,
                        onConfirmInstall = onConfirmInstall,
                        onCancelInstall = onCancelInstall,
                        onOpenRelease = onOpenRelease,
                        onDismiss = onDismiss,
                    )
                }
            }
        }
    }
}

/** The install controls, shared by the wide and narrow banner layouts. */
@Composable
private fun AndroidUpdateActions(
    notice: AndroidUpdateNotice,
    install: AndroidUpdateInstallState,
    busy: Boolean,
    onInstall: (AndroidUpdateNotice) -> Unit,
    onOpenInstallSettings: () -> Unit,
    onConfirmInstall: () -> Unit,
    onCancelInstall: () -> Unit,
    onOpenRelease: (AndroidUpdateNotice) -> Unit,
    onDismiss: (AndroidUpdateNotice) -> Unit,
) {
    when {
        install == AndroidUpdateInstallState.NeedsPermission -> {
            TextButton(onClick = onOpenInstallSettings) {
                Text(stringResource(R.string.android_update_banner_open_settings))
            }
        }
        install == AndroidUpdateInstallState.AwaitingConfirmation -> {
            TextButton(onClick = onConfirmInstall) {
                Text(stringResource(R.string.android_update_banner_confirm))
            }
        }
        // The APK is on its way to Android; "Install" would do nothing.
        install is AndroidUpdateInstallState.Downloading ||
            install == AndroidUpdateInstallState.Verifying -> {
            TextButton(onClick = onCancelInstall) {
                Text(stringResource(R.string.android_update_banner_cancel))
            }
        }
        busy -> Unit
        notice.installable -> {
            val retry = install is AndroidUpdateInstallState.Failed
            TextButton(onClick = { onInstall(notice) }) {
                Text(
                    stringResource(
                        if (retry) R.string.android_update_banner_retry
                        else R.string.android_update_banner_install,
                    ),
                )
            }
        }
    }
    if (!busy && notice.releaseUrl != null) {
        TextButton(onClick = { onOpenRelease(notice) }) {
            Text(stringResource(R.string.android_update_banner_release))
        }
    }
    if (!busy) {
        TextButton(onClick = { onDismiss(notice) }) {
            Text(stringResource(R.string.android_update_banner_dismiss))
        }
    }
}

@Composable
private fun AndroidUpdateTexts(notice: AndroidUpdateNotice) {
    val colors = LocalOmpColors.current
    Text(
        text = stringResource(R.string.android_update_banner_title),
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = colors.text,
    )
    Text(
        text = stringResource(
            R.string.android_update_banner_version,
            notice.currentVersion,
            notice.availableVersion,
        ),
        style = MaterialTheme.typography.bodySmall,
        color = colors.textMuted,
    )
}

/** Progress, permission hint or the reason an install was refused. */
@Composable
internal fun AndroidUpdateInstallStatusText(
    install: AndroidUpdateInstallState,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val text = when (install) {
        AndroidUpdateInstallState.Idle -> null
        is AndroidUpdateInstallState.Downloading -> if (install.total > 0) {
            stringResource(
                R.string.android_update_banner_downloading,
                ((install.received * 100) / install.total).toInt(),
            )
        } else {
            stringResource(R.string.android_update_banner_downloading_unknown)
        }
        AndroidUpdateInstallState.Verifying -> stringResource(R.string.android_update_banner_verifying)
        AndroidUpdateInstallState.Installing -> stringResource(R.string.android_update_banner_installing)
        AndroidUpdateInstallState.AwaitingConfirmation ->
            stringResource(R.string.android_update_banner_confirming)
        AndroidUpdateInstallState.NeedsPermission ->
            stringResource(R.string.android_update_banner_permission)
        is AndroidUpdateInstallState.Failed -> install.message
    } ?: return
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = if (install is AndroidUpdateInstallState.Failed) {
            colors.statusError
        } else {
            colors.textMuted
        },
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

private val NARROW_ANDROID_BANNER_MAX_WIDTH = 480.dp
