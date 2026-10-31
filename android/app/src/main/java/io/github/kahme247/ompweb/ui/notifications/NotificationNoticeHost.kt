package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.InAppNotice
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.flow.StateFlow

/** Test tag of one notice card; the tests address the whole card and its actions. */
const val NOTIFICATION_NOTICE_TAG = "notification-notice"
const val NOTIFICATION_NOTICE_OPEN_TAG = "notification-notice-open"
const val NOTIFICATION_NOTICE_DISMISS_TAG = "notification-notice-dismiss"

/**
 * The in-app delivery surface (web `useNotifications.showToast`): cards over
 * the shell for `whenActive:"toast"` events and for every system post Android
 * refused. A card opens its session and marks the history entry read; the X
 * and the dismiss frame remove it.
 *
 * Rendered once by the shell on top of the list and the chat, so a notice
 * works on any view — like the web toast, which is not bound to the chat.
 */
@Composable
fun NotificationNoticeHost(
    notices: StateFlow<List<InAppNotice>>,
    history: NotificationHistoryViewModel,
    onDismiss: (InAppNotice) -> Unit,
    onOpenSession: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val cards by notices.collectAsStateWithLifecycle()
    if (cards.isEmpty()) return
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            cards.forEach { notice ->
                NotificationNoticeCard(
                    notice = notice,
                    onOpen = {
                        // Following a notification is reading it (web toast).
                        history.markRead(listOf(notice.id))
                        onDismiss(notice)
                        if (notice.sessionId.isNotBlank()) onOpenSession(notice.sessionId)
                    },
                    onDismiss = { onDismiss(notice) },
                )
            }
        }
    }
}

@Composable
private fun NotificationNoticeCard(
    notice: InAppNotice,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(
                1.dp,
                if (notice.error) colors.statusError.copy(alpha = 0.7f) else colors.border,
                RoundedCornerShape(10.dp),
            )
            .testTag(NOTIFICATION_NOTICE_TAG)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .clickable(role = Role.Button, onClick = onOpen),
        color = colors.panel,
        shadowElevation = 6.dp,
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp, end = 2.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (notice.error) Icons.Filled.Warning else Icons.Filled.Notifications,
                contentDescription = null,
                tint = if (notice.error) colors.statusError else colors.accent,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = notice.title,
                    color = colors.text,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = notice.body,
                    color = colors.textMuted,
                    fontSize = 12.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 1.dp),
                )
                TextButton(
                    onClick = onOpen,
                    modifier = Modifier.testTag(NOTIFICATION_NOTICE_OPEN_TAG),
                ) {
                    Text(stringResource(R.string.notify_ui_open), color = colors.accent, fontSize = 12.sp)
                }
            }
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.testTag(NOTIFICATION_NOTICE_DISMISS_TAG),
            ) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = stringResource(R.string.notify_ui_dismiss),
                    tint = colors.textDim,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}
