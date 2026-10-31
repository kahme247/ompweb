package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.kahme247.ompweb.domain.InAppNotice
import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.NotificationHistoryEvent
import io.github.kahme247.ompweb.net.NotificationHistoryApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A12: the in-app notice is actionable — tapping it marks the history entry
 * read and opens the session through the shell's callback (web
 * `useNotifications.ts:56-108`), and its X dismisses it without navigating.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class NotificationNoticeHostTest {

    @get:Rule
    val composeRule = createComposeRule()

    private class FakeHistoryApi : NotificationHistoryApi {
        var entries: List<NotificationHistoryEntry> = emptyList()
        val reads = mutableListOf<List<String>>()

        override suspend fun load(): List<NotificationHistoryEntry> = entries

        override suspend fun markRead(ids: List<String>) {
            reads += ids
        }

        override suspend fun remove(id: String) = Unit

        override suspend fun clear() = Unit
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = FakeHistoryApi().apply {
        entries = listOf(
            NotificationHistoryEntry(
                id = "s1:input",
                event = NotificationHistoryEvent(
                    type = "input",
                    sessionId = "s1",
                    sessionName = "Fix build",
                ),
                at = 1L,
                read = false,
            ),
        )
    }

    private val history = NotificationHistoryViewModel(api, scope)

    private fun notice(requestId: String = "req-1") = InAppNotice(
        id = "s1:input",
        sessionId = "s1",
        title = "Fix build",
        body = "Waiting for your answer: Approve the patch?",
        error = false,
        requestId = requestId,
    )

    @Test
    fun `open marks the entry read, dismisses the notice and opens the session`() {
        history.refresh()
        val notices = MutableStateFlow(listOf(notice()))
        val opened = mutableListOf<String>()
        val dismissed = mutableListOf<InAppNotice>()
        composeRule.setContent {
            NotificationNoticeHost(
                notices = notices,
                history = history,
                onDismiss = { dismissed += it },
                onOpenSession = { opened += it },
            )
        }

        composeRule.onNodeWithText("Fix build").assertExists()
        composeRule.onNodeWithTag(NOTIFICATION_NOTICE_OPEN_TAG).performClick()
        composeRule.runOnIdle {
            assertEquals(listOf(listOf("s1:input")), api.reads)
            assertTrue(history.state.value.entries.single().read)
            assertEquals(listOf("s1"), opened)
            assertEquals(1, dismissed.size)
        }
    }

    @Test
    fun `the close button dismisses without opening`() {
        history.refresh()
        val notices = MutableStateFlow(listOf(notice()))
        val opened = mutableListOf<String>()
        val dismissed = mutableListOf<InAppNotice>()
        composeRule.setContent {
            NotificationNoticeHost(
                notices = notices,
                history = history,
                onDismiss = { dismissed += it },
                onOpenSession = { opened += it },
            )
        }

        composeRule.onNodeWithTag(NOTIFICATION_NOTICE_DISMISS_TAG).performClick()
        composeRule.runOnIdle {
            assertTrue(opened.isEmpty())
            assertTrue(api.reads.isEmpty())
            assertEquals(listOf(notice()), dismissed)
        }
    }
}
