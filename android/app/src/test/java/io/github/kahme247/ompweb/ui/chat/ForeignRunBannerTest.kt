package io.github.kahme247.ompweb.ui.chat

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.ContentionCopy
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The composer's foreign-owner banners. Two review findings live here: the
 * "send anyway" action used to be a dead button on an empty composer (the
 * click resolved no draft, so nothing happened, not even a hint), and a
 * contention fork (a forced send that still raced the owner) was invisible.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w400dp-h800dp-mdpi", application = android.app.Application::class)
class ForeignRunBannerTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun text(id: Int): String = context.getString(id)

    private fun show(content: @Composable () -> Unit) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) { content() }
        }
        composeRule.waitForIdle()
    }

    private val owner = ElsewhereSession(kind = "terminal", source = "process", active = true)

    @Test
    fun anEmptyComposerCannotOfferTheCopy() {
        show {
            ForeignRunBanner(elsewhere = owner, sendAnywayEnabled = false, onSendAnyway = {})
        }

        composeRule.onNodeWithText(text(R.string.composer_elsewhere_send_anyway)).assertIsNotEnabled()
    }

    @Test
    fun aDraftEnablesTheCopyConfirmation() {
        var clicked = 0
        show {
            ForeignRunBanner(
                elsewhere = owner,
                sendAnywayEnabled = true,
                onSendAnyway = { clicked++ },
            )
        }

        composeRule
            .onNodeWithText(text(R.string.composer_elsewhere_send_anyway))
            .assertIsEnabled()
            .performClick()
        assertEquals("the banner hands the confirmed draft to the dialog", 1, clicked)
    }

    @Test
    fun theContentionBannerLinksTheOriginalChat() {
        var opened: String? = null
        show {
            ContentionForkBanner(
                copy = ContentionCopy(originalId = "original-1", copyId = "copy-1"),
                onOpen = { opened = it },
                onDismiss = {},
            )
        }

        composeRule.onNodeWithText(text(R.string.composer_contention_title)).assertExists()
        composeRule.onNodeWithText(text(R.string.composer_contention_open_original)).performClick()
        assertEquals("the link names the chat that stayed behind", "original-1", opened)
    }

    @Test
    fun theContentionBannerLinksTheCopy() {
        var opened: String? = null
        show {
            ContentionForkBanner(
                copy = ContentionCopy(originalId = "original-1", copyId = "copy-1"),
                onOpen = { opened = it },
                onDismiss = {},
            )
        }

        composeRule.onNodeWithText(text(R.string.composer_contention_open_copy)).performClick()
        assertEquals("the copy keeps its own chat id", "copy-1", opened)
    }

    @Test
    fun withoutACopyIdThereIsNoCopyLink() {
        show {
            ContentionForkBanner(
                copy = ContentionCopy(originalId = "original-1", copyId = null),
                onOpen = {},
                onDismiss = {},
            )
        }

        composeRule.onNodeWithText(text(R.string.composer_contention_open_original)).assertExists()
        composeRule.onNodeWithText(text(R.string.composer_contention_open_copy)).assertDoesNotExist()
    }

    @Test
    fun theContentionBannerCanBeDismissed() {
        var dismissed = 0
        show {
            ContentionForkBanner(
                copy = ContentionCopy(originalId = "original-1", copyId = "copy-1"),
                onOpen = {},
                onDismiss = { dismissed++ },
            )
        }

        composeRule.onNodeWithText(text(R.string.composer_contention_dismiss)).performClick()
        assertEquals("dismissing must not open anything", 1, dismissed)
    }

    @Test
    fun noBannerWithoutAnOwnerOrACopy() {
        show {
            ForeignRunBanner(elsewhere = null, sendAnywayEnabled = true, onSendAnyway = {})
            ContentionForkBanner(copy = null, onOpen = {}, onDismiss = {})
        }

        composeRule.onNodeWithText(text(R.string.composer_elsewhere_send_anyway)).assertDoesNotExist()
        composeRule.onNodeWithText(text(R.string.composer_contention_title)).assertDoesNotExist()
    }
}
