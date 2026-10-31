package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications

/** Web caps the count label at "99+" (`AppShell` mobile badge). */
private const val BADGE_CAP = 99

/**
 * Bell + unread badge for the session list (phone) and the top bar (tablet),
 * mirroring web `NotificationBell.tsx` / `AppShell.tsx`.
 *
 * The first composition loads the count once; the pane refreshes on open and
 * on resume, and the delivery service calls `onDelivered` for live entries.
 */
@Composable
fun NotificationBellButton(
    vm: NotificationHistoryViewModel,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    val unread = state.unreadCount
    val label = if (unread > 0) {
        pluralStringResource(R.plurals.notify_ui_bell_unread, unread, unread)
    } else {
        stringResource(R.string.notify_ui_bell)
    }

    LaunchedEffect(vm) { vm.refresh() }

    IconButton(onClick = onClick, modifier = modifier.testTag("notification-bell")) {
        BadgedBox(
            badge = {
                if (unread > 0) {
                    Badge(containerColor = colors.accent, contentColor = colors.onAccent) {
                        Text(if (unread > BADGE_CAP) "$BADGE_CAP+" else unread.toString())
                    }
                }
            },
        ) {
            Icon(
                imageVector = Icons.Filled.Notifications,
                contentDescription = label,
                tint = colors.textMuted,
            )
        }
    }
}
