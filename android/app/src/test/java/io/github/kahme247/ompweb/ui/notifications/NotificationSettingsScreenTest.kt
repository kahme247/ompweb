package io.github.kahme247.ompweb.ui.notifications

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
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
 * T8-8: the "Send test notification" button on the Notifications settings
 * screen. It only runs the test when notifications are enabled and no prefs
 * save is in flight (web `NotificationSettingsCard`), and its tap reaches
 * `NotificationSettingsActions.sendTest` — the path that ends in
 * [io.github.kahme247.ompweb.notify.NotificationCenter.sendTest].
 *
 * The "Vibrate" switch is covered here too: it renders the stored choice and
 * reports taps to `setVibrate`, and stays disabled while notifications are off.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-mdpi", application = android.app.Application::class)
class NotificationSettingsScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var sendTests = 0
    private val vibrateChanges = mutableListOf<Boolean>()

    private val actions = NotificationSettingsActions(
        setEnabled = {},
        setType = { _, _ -> },
        setWhenActive = {},
        setVibrate = { vibrateChanges += it },
        sendTest = { sendTests += 1 },
        requestPermission = {},
        openNotificationSettings = {},
        requestBatteryExemption = {},
        dismissMessage = {},
    )

    private fun label(): String =
        ApplicationProvider.getApplicationContext<Context>().getString(R.string.notify_ui_send_test)

    private fun render(state: NotificationSettingsUiState) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                NotificationSettingsScreen(state = state, actions = actions)
            }
        }
    }

    @Test
    fun tappingSendTestNotifiesTheAction() {
        render(NotificationSettingsUiState(enabled = true))

        composeRule.onNodeWithText(label()).performScrollTo().assertIsEnabled().performClick()

        assertEquals(1, sendTests)
    }

    @Test
    fun theButtonIsDisabledWhileNotificationsAreOff() {
        render(NotificationSettingsUiState(enabled = false))

        composeRule.onNodeWithText(label()).performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun theButtonIsDisabledWhileAPrefsSaveIsInFlight() {
        render(NotificationSettingsUiState(enabled = true, busy = true))

        composeRule.onNodeWithText(label()).performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun theOutcomeLineRendersTheTestResult() {
        render(
            NotificationSettingsUiState(
                enabled = true,
                message = NotificationSettingsMessage("Test notification sent"),
            ),
        )

        composeRule.onNodeWithText("Test notification sent").performScrollTo().assertIsDisplayed()
    }

    private fun vibrateSwitch() = composeRule.onNodeWithTag("notifications-vibrate-switch")

    @Test
    fun theVibrateSwitchRendersTheStoredChoiceAndReportsTheChange() {
        render(NotificationSettingsUiState(enabled = true, vibrate = false))

        vibrateSwitch().performScrollTo().assertIsOff().performClick()

        assertEquals(listOf(true), vibrateChanges)
    }

    @Test
    fun theVibrateSwitchIsDisabledWhileNotificationsAreOff() {
        render(NotificationSettingsUiState(enabled = false, vibrate = true))

        vibrateSwitch().performScrollTo().assertIsOn().assertIsNotEnabled()
    }
}
