package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A21: the rename prompt commits on Enter and on blur, cancels on Esc and
 * treats an unchanged/empty name as a no-op (web `SessionSidebar-rows.tsx`).
 *
 * The field is rendered inline instead of inside the dialog window: a Compose
 * `Dialog` hosting a text field never reports idle under Robolectric
 * (upstream Compose bug 503993979), so every wait would time out. [NameField]
 * is the exact composable the dialog puts into its text slot, and
 * [renamedValue] is the dialog's commit rule.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class NameDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var committed = 0
    private var cancelled = 0
    private lateinit var clearFocus: () -> Unit

    private fun show(initial: String = "Old title") {
        val value = mutableStateOf(initial)
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                val focusManager = LocalFocusManager.current
                clearFocus = { focusManager.clearFocus() }
                Column {
                    NameField(
                        value = value.value,
                        onValueChange = { value.value = it },
                        label = "Name",
                        onCommit = { committed++ },
                        onCancel = { cancelled++ },
                    )
                }
            }
        }
        composeRule.onNodeWithTag("name-dialog-field").assertIsDisplayed()
    }

    @Test
    fun enterCommits() {
        show()
        val field = composeRule.onNodeWithTag("name-dialog-field")
        field.performClick()
        field.performTextInput(" edited")
        field.performKeyInput { pressKey(Key.Enter) }

        assertEquals(1, committed)
        assertEquals(0, cancelled)
    }

    @Test
    fun escapeCancelsWithoutCommitting() {
        show()
        val field = composeRule.onNodeWithTag("name-dialog-field")
        field.performClick()
        field.performTextInput(" edited")
        field.performKeyInput { pressKey(Key.Escape) }

        assertEquals("Esc never commits", 0, committed)
        assertEquals(1, cancelled)
    }

    @Test
    fun leavingTheFieldCommits() {
        show()
        composeRule.onNodeWithTag("name-dialog-field").performClick()
        composeRule.onNodeWithTag("name-dialog-field").performTextInput(" edited")
        composeRule.runOnIdle { clearFocus() }

        assertEquals("blur commits like the web", 1, committed)
    }

    @Test
    fun anUnchangedNameIsANoOp() {
        assertNull(renamedValue("Old title", "Old title"))
        assertNull("whitespace around the same name is unchanged", renamedValue("Old title", "  Old title  "))
    }

    @Test
    fun anEmptyNameIsANoOp() {
        assertNull(renamedValue("Old title", ""))
        assertNull(renamedValue("Old title", "   "))
    }

    @Test
    fun aChangedNameIsTrimmed() {
        assertEquals("New title", renamedValue("Old title", "  New title  "))
    }
}
