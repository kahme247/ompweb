package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NOTIFICATION_DETAIL_MAX
import io.github.kahme247.ompweb.domain.NOTIFICATION_TITLE_MAX
import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.NotificationHistoryEvent
import io.github.kahme247.ompweb.domain.NotificationHistoryType
import io.github.kahme247.ompweb.domain.clipNotificationText
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import java.text.DateFormat
import java.util.Date
import kotlin.math.abs

/** Web dismisses a swipe past 40 px; a touch row uses a slightly larger 48 dp target. */
private val SWIPE_DISMISS = 48.dp

/**
 * The persisted notification history (web `componentNotificationList.tsx`):
 * newest first, unread dot + bold title, read rows dimmed, tap/Enter opens the
 * session and marks that row read, a sideways swipe or the X dismisses it.
 *
 * Shown as the phone's Notifications tab / the tablet's right-panel tab; the
 * caller decides the container. Opening the pane refreshes on resume; closing
 * it marks exactly the entries it showed (see [NotificationHistoryViewModel]).
 */
@Composable
fun NotificationListPane(
    vm: NotificationHistoryViewModel,
    onOpenSession: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    var clearConfirm by remember { mutableStateOf(false) }

    // The list marks read on close, but only the entries it showed.
    DisposableEffect(vm) {
        vm.onListOpened()
        onDispose { vm.onListClosed() }
    }
    // On open and whenever the pane comes back to the foreground.
    LifecycleResumeEffect(vm) {
        vm.refresh()
        onPauseOrDispose { }
    }

    Surface(modifier = modifier.fillMaxSize(), color = colors.panel) {
        Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.notify_ui_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.text,
                    modifier = Modifier
                        .weight(1f)
                        .semantics { heading() },
                )
                IconButton(onClick = vm::markAllRead, enabled = state.unreadCount > 0) {
                    Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = stringResource(R.string.notify_ui_mark_all_read),
                        tint = if (state.unreadCount > 0) colors.textMuted else colors.textDim,
                    )
                }
                IconButton(onClick = { clearConfirm = true }, enabled = state.entries.isNotEmpty()) {
                    Icon(
                        imageVector = Icons.Filled.Delete,
                        contentDescription = stringResource(R.string.notify_ui_clear),
                        tint = if (state.entries.isNotEmpty()) colors.textMuted else colors.textDim,
                    )
                }
            }
            if (state.loading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = colors.accent)
            } else {
                Spacer(Modifier.height(2.dp))
            }
            state.error?.let { message ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { liveRegion = LiveRegionMode.Polite }
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = message,
                        color = colors.statusError,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = vm::refresh) {
                        Text(stringResource(R.string.notify_ui_retry), color = colors.accent)
                    }
                    IconButton(onClick = vm::dismissError) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = stringResource(R.string.notify_ui_dismiss),
                            tint = colors.textMuted,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
            if (state.entries.isEmpty()) {
                if (!state.loading) EmptyNotifications()
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = rememberLazyListState(),
                ) {
                    items(state.entries, key = { it.id }) { entry ->
                        NotificationRow(
                            entry = entry,
                            onOpen = {
                                vm.markRead(listOf(entry.id))
                                entry.event.sessionId.takeIf { it.isNotBlank() }?.let(onOpenSession)
                            },
                            onDismiss = { vm.remove(entry.id) },
                        )
                    }
                }
            }
        }
    }

    if (clearConfirm) {
        OmpAlertDialog(
            onDismissRequest = { clearConfirm = false },
            title = { Text(stringResource(R.string.notify_ui_clear_title)) },
            text = { Text(stringResource(R.string.notify_ui_clear_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        clearConfirm = false
                        vm.clearAll()
                    },
                ) {
                    Text(stringResource(R.string.notify_ui_clear_confirm), color = colors.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { clearConfirm = false }) {
                    Text(stringResource(R.string.notify_ui_cancel))
                }
            },
        )
    }
}

@Composable
private fun EmptyNotifications() {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.Notifications,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(26.dp),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.notify_ui_empty),
            color = colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun NotificationRow(
    entry: NotificationHistoryEntry,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val density = LocalDensity.current
    val threshold = with(density) { SWIPE_DISMISS.toPx() }
    var offsetTarget by remember(entry.id) { mutableFloatStateOf(0f) }
    var dragging by remember(entry.id) { mutableStateOf(false) }
    val offset by animateFloatAsState(
        targetValue = offsetTarget,
        animationSpec = if (dragging) snap() else spring(stiffness = 900f),
        label = "notification-swipe",
    )
    val time = remember(entry.at) {
        DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(entry.at))
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer { translationX = offset; alpha = 1f - minOf(abs(offset) / 800f, 0.5f) }
            .pointerInput(entry.id) {
                detectHorizontalDragGestures(
                    onDragStart = {
                        dragging = true
                        offsetTarget = 0f
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        change.consume()
                        offsetTarget += dragAmount
                    },
                    onDragEnd = {
                        dragging = false
                        if (abs(offsetTarget) >= threshold) onDismiss() else offsetTarget = 0f
                    },
                    onDragCancel = {
                        dragging = false
                        offsetTarget = 0f
                    },
                )
            }
            .background(if (entry.read) colors.panel else colors.backgroundSubtle)
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(start = 8.dp, end = 2.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Unread marker in a fixed leading slot, so read and unread rows align.
        Box(Modifier.width(14.dp).padding(top = 5.dp), contentAlignment = Alignment.Center) {
            if (!entry.read) {
                Box(Modifier.size(8.dp).background(colors.accent, CircleShape))
            }
        }
        Icon(
            imageVector = if (entry.event.type == NotificationHistoryType.ERROR) {
                Icons.Filled.Warning
            } else {
                Icons.Filled.Notifications
            },
            contentDescription = null,
            tint = if (entry.event.type == NotificationHistoryType.ERROR) colors.statusError else colors.textMuted,
            modifier = Modifier.padding(top = 1.dp).size(15.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = notificationTitle(entry.event),
                    color = if (entry.read) colors.textMuted else colors.text,
                    fontSize = 13.sp,
                    fontWeight = if (entry.read) FontWeight.Normal else FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(text = time, color = colors.textDim, fontSize = 11.sp)
            }
            Text(
                text = notificationBody(entry.event),
                color = if (entry.read) colors.textDim else colors.textMuted,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        IconButton(onClick = onDismiss) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = stringResource(R.string.notify_ui_dismiss),
                tint = colors.textDim,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

@Composable
private fun notificationTitle(event: NotificationHistoryEvent): String {
    val name = event.sessionName?.let { clipNotificationText(it, NOTIFICATION_TITLE_MAX) }
    return name?.takeIf { it.isNotEmpty() } ?: stringResource(R.string.notify_ui_untitled_session)
}

@Composable
private fun notificationBody(event: NotificationHistoryEvent): String {
    // Same wording as the web's `renderNotification` (server/notification shade
    // strings live in Slice A; the list has its own resource file by ownership).
    val detail = event.detail?.let { clipNotificationText(it, NOTIFICATION_DETAIL_MAX) }.orEmpty()
    return when (event.type) {
        NotificationHistoryType.COMPLETED -> stringResource(R.string.notify_ui_body_completed)
        NotificationHistoryType.INPUT ->
            if (detail.isNotEmpty()) stringResource(R.string.notify_ui_body_input, detail) else stringResource(R.string.notify_ui_body_input_none)

        NotificationHistoryType.ERROR ->
            if (detail.isNotEmpty()) stringResource(R.string.notify_ui_body_error, detail) else stringResource(R.string.notify_ui_body_error_none)

        NotificationHistoryType.MODEL_SWITCH -> {
            val from = event.from
            val to = event.to
            when {
                from != null && to != null && detail.isNotEmpty() ->
                    stringResource(R.string.notify_ui_body_model_switch, from, to, detail)

                from != null && to != null ->
                    stringResource(R.string.notify_ui_body_model_switch_none, from, to)

                else -> detail
            }
        }

        NotificationHistoryType.TEST -> stringResource(R.string.notify_ui_body_test)
        else -> detail.ifEmpty { stringResource(R.string.notify_ui_body_other) }
    }
}
