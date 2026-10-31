package io.github.kahme247.ompweb.ui.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.click
import io.github.kahme247.ompweb.domain.InAppNotice
import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.NotificationHistoryEvent
import io.github.kahme247.ompweb.net.NotificationHistoryApi
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.MainShellLayers
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * B1/A12: the notice cards are the shell's top layer. Before the fix the host
 * was composed *before* the shell box, so the opaque panes painted over it and
 * took its taps. The shell panes are opaque and full-size, which makes the
 * input a real z-order check: a tap at the card's pixels only reaches the card
 * when it is painted last (`MainShellLayers`).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class NotificationNoticeLayersTest {

    @get:Rule
    val composeRule = createComposeRule()

    private class FakeHistoryApi : NotificationHistoryApi {
        override suspend fun load(): List<NotificationHistoryEntry> = emptyList()

        override suspend fun markRead(ids: List<String>) = Unit

        override suspend fun remove(id: String) = Unit

        override suspend fun clear() = Unit
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val history = NotificationHistoryViewModel(FakeHistoryApi(), scope)

    @Test
    fun `a tap on a notice card reaches it instead of the shell below`() {
        val notices = MutableStateFlow(
            listOf(
                InAppNotice(
                    id = "s1:input",
                    sessionId = "s1",
                    title = "Fix build",
                    body = "Waiting for your answer",
                    error = false,
                    requestId = "req-1",
                ),
            ),
        )
        val opened = mutableListOf<String>()
        var shellClicks = 0

        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                MainShellLayers(
                    notices = {
                        NotificationNoticeHost(
                            notices = notices,
                            history = history,
                            onDismiss = {},
                            onOpenSession = { opened += it },
                        )
                    },
                ) {
                    // The real shell panes are opaque and consume every touch.
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(LocalOmpColors.current.background)
                            .testTag("opaque-shell")
                            .clickable { shellClicks++ },
                    )
                }
            }
        }

        composeRule.onNodeWithTag(NOTIFICATION_NOTICE_TAG).assertIsDisplayed()
        val open = composeRule.onNodeWithTag(NOTIFICATION_NOTICE_OPEN_TAG)
            .getUnclippedBoundsInRoot()
        val centerX = (open.left.value + open.right.value) / 2f
        val centerY = (open.top.value + open.bottom.value) / 2f
        composeRule.onRoot().performTouchInput {
            click(Offset(centerX.dp.toPx(), centerY.dp.toPx()))
        }
        composeRule.runOnIdle {
            assertEquals("the card owns the top layer", listOf("s1"), opened)
            assertEquals("the shell below never sees the tap", 0, shellClicks)
        }
    }
}
