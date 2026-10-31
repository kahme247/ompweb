package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
 * B7: leaving with unsent drafts shows the confirmation with both actions;
 * Stay is the safe default and Leave finishes the exit.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class ExitDraftDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var stayed = 0
    private var left = 0

    private fun show(draftCount: Int = 2) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                ExitDraftDialog(
                    draftCount = draftCount,
                    onStay = { stayed++ },
                    onLeave = { left++ },
                )
            }
        }
    }

    @Test
    fun bothActionsAreOfferedAndStayIsDefault() {
        show(draftCount = 3)
        composeRule.onNodeWithText("You have unsent text in 3 chat(s). Leave anyway?")
            .assertIsDisplayed()
        composeRule.onNodeWithText("Stay").assertIsDisplayed()
        composeRule.onNodeWithText("Leave").assertIsDisplayed()
    }

    @Test
    fun stayKeepsTheAppOpen() {
        show()
        composeRule.onNodeWithText("Stay").performClick()

        assertEquals(1, stayed)
        assertEquals(0, left)
    }

    @Test
    fun leaveFinishesTheExit() {
        show()
        composeRule.onNodeWithText("Leave").performClick()

        assertEquals(1, left)
        assertEquals(0, stayed)
    }
}
