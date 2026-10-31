package io.github.kahme247.ompweb.ui.settings

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpTheme
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import io.github.kahme247.ompweb.ui.theme.PickerDialogKey
import io.github.kahme247.ompweb.ui.theme.SYSTEM_THEME_ID
import io.github.kahme247.ompweb.ui.theme.pickerDialogKeyFor
import io.github.kahme247.ompweb.ui.theme.pickerDialogTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A21: the theme picker takes the web theme menu's keyboard contract —
 * Up/Down/Home/End move the highlight, Enter/Space choose it, Escape cancels,
 * blur closes without a choice.
 *
 * The list is rendered inline (like [io.github.kahme247.ompweb.ui.sessions.NameDialogTest]):
 * the content is exactly what [ThemePickerDialog] puts into its text slot.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class ThemePickerDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val chosen = mutableListOf<String>()
    private var dismissed = 0
    private lateinit var clearFocus: () -> Unit

    private fun show(selectedThemeId: String = ScreenshotMatrix.LIGHT_THEME_ID) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                val focusManager = LocalFocusManager.current
                clearFocus = { focusManager.clearFocus() }
                ThemePickerContent(
                    selectedThemeId = selectedThemeId,
                    onSelect = { chosen += it },
                    onDismiss = { dismissed++ },
                )
            }
        }
        composeRule.onNodeWithTag("theme-picker").assertIsDisplayed()
        composeRule.waitForIdle()
    }

    private fun press(key: Key) {
        composeRule.onNodeWithTag("theme-picker").performKeyInput { pressKey(key) }
    }

    @Test
    fun enterChoosesTheSelectedTheme() {
        show()
        composeRule.onNodeWithTag("theme-picker").requestFocus()
        press(Key.Enter)

        assertEquals(listOf(ScreenshotMatrix.LIGHT_THEME_ID), chosen)
        assertEquals(1, dismissed)
    }

    @Test
    fun downThenEnterChoosesTheNextTheme() {
        show(selectedThemeId = SYSTEM_THEME_ID)
        val next = OmpTheme.entries.first().id
        composeRule.onNodeWithTag("theme-picker").requestFocus()
        press(Key.DirectionDown)
        press(Key.Enter)

        assertEquals(listOf(next), chosen)
        assertEquals(1, dismissed)
    }

    @Test
    fun endChoosesTheLastTheme() {
        show(selectedThemeId = SYSTEM_THEME_ID)
        val last = OmpTheme.entries.last().id
        composeRule.onNodeWithTag("theme-picker").requestFocus()
        press(Key.MoveEnd)
        press(Key.Spacebar)

        assertEquals(listOf(last), chosen)
    }

    @Test
    fun escapeCancelsWithoutChoosing() {
        show()
        composeRule.onNodeWithTag("theme-picker").requestFocus()
        press(Key.Escape)

        assertEquals("Esc never chooses", emptyList<String>(), chosen)
        assertEquals(1, dismissed)
    }

    @Test
    fun losingFocusClosesWithoutChoosing() {
        show()
        composeRule.runOnIdle { clearFocus() }

        assertEquals("blur closes the web menu without picking", 1, dismissed)
        assertEquals(emptyList<String>(), chosen)
    }

    @Test
    fun onlyEnterSpaceAndEscapeArePickerKeys() {
        assertEquals(PickerDialogKey.CHOOSE, pickerDialogKeyFor(Key.Enter))
        assertEquals(PickerDialogKey.CHOOSE, pickerDialogKeyFor(Key.NumPadEnter))
        assertEquals(PickerDialogKey.CHOOSE, pickerDialogKeyFor(Key.Spacebar))
        assertEquals(PickerDialogKey.CANCEL, pickerDialogKeyFor(Key.Escape))
        assertEquals(PickerDialogKey.NEXT, pickerDialogKeyFor(Key.DirectionDown))
        assertEquals(PickerDialogKey.PREVIOUS, pickerDialogKeyFor(Key.DirectionUp))
        assertEquals(PickerDialogKey.FIRST, pickerDialogKeyFor(Key.MoveHome))
        assertEquals(PickerDialogKey.LAST, pickerDialogKeyFor(Key.MoveEnd))
        assertNull(pickerDialogKeyFor(Key.DirectionLeft))
    }

    @Test
    fun navigationWrapsAndClamps() {
        assertEquals(4, pickerDialogTarget(0, PickerDialogKey.PREVIOUS, 5))
        assertEquals(0, pickerDialogTarget(4, PickerDialogKey.NEXT, 5))
        assertEquals(0, pickerDialogTarget(3, PickerDialogKey.FIRST, 5))
        assertEquals(4, pickerDialogTarget(1, PickerDialogKey.LAST, 5))
        assertNull(pickerDialogTarget(1, PickerDialogKey.CHOOSE, 5))
        assertNull(pickerDialogTarget(1, PickerDialogKey.NEXT, 0))
    }
}
