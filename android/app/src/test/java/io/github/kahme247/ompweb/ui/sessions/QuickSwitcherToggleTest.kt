package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
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
 * Bug 8/B17: Ctrl+K is a toggle on the web (`CommandPalette` flips its open
 * flag with a window-level listener). On Android the palette is its own dialog
 * window, so the shell's root handler cannot see the key while it is open; the
 * palette body must close itself — and only with the modifier.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class QuickSwitcherToggleTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var dismissed = 0

    private fun show() {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                QuickSwitcherContent(
                    sessions = emptyList(),
                    runningIds = emptySet(),
                    home = null,
                    currentModel = null,
                    onSelectSession = {},
                    onNewSession = {},
                    onChangeTheme = {},
                    onDismiss = { dismissed++ },
                )
            }
        }
        composeRule.waitForIdle()
    }

    @Test
    fun `Ctrl+K closes the open palette`() {
        show()
        composeRule.onNode(hasSetTextAction()).performKeyInput {
            withKeyDown(Key.CtrlLeft) { pressKey(Key.K) }
        }

        assertEquals(1, dismissed)
    }

    @Test
    fun `plain K stays text`() {
        show()
        composeRule.onNode(hasSetTextAction()).performKeyInput { pressKey(Key.K) }

        assertEquals("a bare K is typed into the query, not a shortcut", 0, dismissed)
    }
}
