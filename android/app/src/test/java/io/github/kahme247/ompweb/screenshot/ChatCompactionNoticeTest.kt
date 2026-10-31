package io.github.kahme247.ompweb.screenshot

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.ui.chat.ChatBanners
import io.github.kahme247.ompweb.ui.chat.ChatUiState
import io.github.kahme247.ompweb.ui.chat.CompactionNotice
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Test

/**
 * The compacted-history notice belongs to the transcript (web `ChatWindow`
 * renders it inside the scroll container, above the first message), never to
 * the composer column:
 *
 * - as a list item it scrolls away with the messages (a pinned copy would stay);
 * - the composer's banner stack does not render it at all.
 */
class ChatCompactionNoticeTest : ScreenshotTest() {

    private val noticeText: String
        get() = ApplicationProvider.getApplicationContext<Context>()
            .getString(R.string.chat_branch_banner_compacted)

    @Test
    fun theNoticeScrollsAwayWithTheTranscript() {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                LazyColumn(
                    modifier = Modifier
                        .size(360.dp, 240.dp)
                        .testTag("transcript"),
                ) {
                    item(key = "compaction-notice") {
                        CompactionNotice(includePreCompaction = false, onToggle = {})
                    }
                    items(40) { index ->
                        Text("row $index", Modifier.fillMaxWidth().height(40.dp))
                    }
                }
            }
        }
        composeRule.onNodeWithText(noticeText).assertIsDisplayed()
        composeRule.onNodeWithTag("transcript").performScrollToIndex(40)
        composeRule.waitForIdle()
        composeRule.onNodeWithText(noticeText).assertDoesNotExist()
    }

    @Test
    fun theComposerBannersDoNotPinIt() {
        val ui = ChatUiState(
            engine = ChatState(includePreCompaction = false),
            hasCompaction = true,
            connection = ConnectionState.Connected,
        )
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                Column(Modifier.fillMaxWidth()) {
                    ChatBanners(ui = ui, onRetryHistory = {})
                }
            }
        }
        composeRule.onNodeWithText(noticeText).assertDoesNotExist()
    }
}
