package io.github.kahme247.ompweb.ui.chat

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import io.github.kahme247.ompweb.chat.BranchRow
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
 * A21: the branch navigator takes the web `BranchNavigator` keyboard contract —
 * Up/Down/Home/End move the highlight, Enter/Space select it, Escape cancels,
 * blur closes without switching.
 *
 * The list is rendered inline (like [io.github.kahme247.ompweb.ui.sessions.NameDialogTest]):
 * the content is exactly what [BranchNavigatorDialog] puts into its text slot.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class BranchNavigatorDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val selected = mutableListOf<String>()
    private var dismissed = 0
    private lateinit var clearFocus: () -> Unit

    private fun row(
        id: String,
        label: String,
        active: Boolean = false,
        isLast: Boolean = false,
        children: List<BranchRow> = emptyList(),
    ) = BranchRow(
        selectId = id,
        label = label,
        role = "user",
        depth = 0,
        isLast = isLast,
        parentLines = emptyList(),
        skipped = 0,
        active = active,
        onPath = true,
        children = children,
    )

    private val state = BranchNavigatorState(
        rows = listOf(
            row(
                id = "a",
                label = "First turn",
                active = true,
                children = listOf(row(id = "b", label = "Second branch", isLast = true)),
            ),
        ),
    )

    private fun show() {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                val focusManager = LocalFocusManager.current
                clearFocus = { focusManager.clearFocus() }
                BranchNavigatorContent(
                    state = state,
                    onSelect = { selected += it },
                    onDismiss = { dismissed++ },
                )
            }
        }
        composeRule.onNodeWithTag("branch-picker").assertIsDisplayed()
        composeRule.waitForIdle()
    }

    private fun press(key: Key) {
        composeRule.onNodeWithTag("branch-picker").performKeyInput { pressKey(key) }
    }

    @Test
    fun enterSelectsTheActiveBranch() {
        show()
        composeRule.onNodeWithTag("branch-picker").requestFocus()
        press(Key.Enter)

        assertEquals(listOf("a"), selected)
        assertEquals("a pick closes the navigator like the web dropdown", 1, dismissed)
    }

    @Test
    fun downThenEnterSelectsTheNextBranch() {
        show()
        composeRule.onNodeWithTag("branch-picker").requestFocus()
        press(Key.DirectionDown)
        press(Key.Enter)

        assertEquals(listOf("b"), selected)
    }

    @Test
    fun endThenSpaceSelectsTheLastBranch() {
        show()
        composeRule.onNodeWithTag("branch-picker").requestFocus()
        press(Key.MoveEnd)
        press(Key.Spacebar)

        assertEquals(listOf("b"), selected)
        assertEquals(1, dismissed)
    }

    @Test
    fun clickingARowSelectsAndCloses() {
        show()
        composeRule.onNodeWithTag("branch-row-1").performClick()

        assertEquals(listOf("b"), selected)
        assertEquals(1, dismissed)
    }

    @Test
    fun escapeCancelsWithoutSelecting() {
        show()
        composeRule.onNodeWithTag("branch-picker").requestFocus()
        press(Key.Escape)

        assertEquals("Esc never switches", emptyList<String>(), selected)
        assertEquals(1, dismissed)
    }

    @Test
    fun losingFocusClosesWithoutSelecting() {
        show()
        composeRule.runOnIdle { clearFocus() }

        assertEquals("blur closes the web dropdown without switching", 1, dismissed)
        assertEquals(emptyList<String>(), selected)
    }
}
