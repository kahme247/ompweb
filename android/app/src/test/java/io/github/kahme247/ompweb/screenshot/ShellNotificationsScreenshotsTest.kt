package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.NotificationHistoryEvent
import io.github.kahme247.ompweb.domain.NotificationHistoryType
import io.github.kahme247.ompweb.net.NotificationHistoryApi
import io.github.kahme247.ompweb.ui.notifications.NotificationHistoryViewModel
import io.github.kahme247.ompweb.ui.notifications.NotificationListPane
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Test

/** The notification history list: unread/read rows, long names, time column. */
class ShellNotificationsScreenshotsTest : ScreenshotTest() {

    /** 2020-01-05T12:00:00Z — the row formats only the time of day. */
    private val at = 1_578_225_600_000L

    @Test
    fun notificationList() = composeRule.verifyScreenshotMatrix("shell-notifications") {
        NotificationListPane(
            vm = viewModel,
            onOpenSession = {},
            modifier = Modifier.fillMaxSize(),
        )
    }

    private val api = object : NotificationHistoryApi {
        override suspend fun load(): List<NotificationHistoryEntry> = listOf(
            NotificationHistoryEntry(
                id = "s1:input",
                event = NotificationHistoryEvent(
                    type = NotificationHistoryType.INPUT,
                    sessionId = "s1",
                    sessionName = "Fix the Android sidebar layout at 200 % font",
                    detail = "Which provider should the usage bar read from?",
                ),
                at = at,
                read = false,
            ),
            NotificationHistoryEntry(
                id = "s2:error",
                event = NotificationHistoryEvent(
                    type = NotificationHistoryType.ERROR,
                    sessionId = "s2",
                    sessionName = "Provider usage bar",
                    detail = "The server answered 500 while loading the usage report for the sidebar.",
                ),
                at = at - 60_000L,
                read = false,
            ),
            NotificationHistoryEntry(
                id = "s3:completed",
                event = NotificationHistoryEvent(
                    type = NotificationHistoryType.COMPLETED,
                    sessionId = "s3",
                    sessionName = "Landing page screenshots",
                ),
                at = at - 3_600_000L,
                read = true,
            ),
        )

        override suspend fun markRead(ids: List<String>) = Unit

        override suspend fun remove(id: String) = Unit

        override suspend fun clear() = Unit
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val viewModel = NotificationHistoryViewModel(api, scope)
}
