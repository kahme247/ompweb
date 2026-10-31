package io.github.kahme247.ompweb.ui.settings

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.UpdateKind
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
 * P11Sec 2: installing an update stops the live sessions and restarts the
 * server, so it needs the web dialog's explicit confirmation ("Not now" is
 * the safe default) instead of the previous one-tap action.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class UpdateConfirmDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun show(
        kind: UpdateKind,
        version: String = "1.1.0",
        onConfirm: () -> Unit = {},
        onDismiss: () -> Unit = {},
    ) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                UpdateConfirmDialog(
                    kind = kind,
                    version = version,
                    onConfirm = onConfirm,
                    onDismiss = onDismiss,
                )
            }
        }
    }

    private fun text(id: Int, vararg args: Any): String = context.getString(id, *args)

    @Test
    fun appUpdateDialogNamesTheVersionAndOffersBothActions() {
        show(UpdateKind.APP)

        composeRule.onNodeWithText(text(R.string.system_update_confirm_title)).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.system_update_confirm_text, "1.1.0")).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.system_app_update_install)).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.system_update_not_now)).assertIsDisplayed()
    }

    @Test
    fun confirmingStartsTheInstall() {
        var confirmed = 0
        var dismissed = 0
        show(UpdateKind.APP, onConfirm = { confirmed++ }, onDismiss = { dismissed++ })

        composeRule.onNodeWithText(text(R.string.system_app_update_install)).performClick()

        assertEquals(1, confirmed)
        assertEquals(0, dismissed)
    }

    @Test
    fun notNowOnlyClosesTheDialog() {
        var confirmed = 0
        var dismissed = 0
        show(UpdateKind.APP, onConfirm = { confirmed++ }, onDismiss = { dismissed++ })

        composeRule.onNodeWithText(text(R.string.system_update_not_now)).performClick()

        assertEquals(1, dismissed)
        assertEquals(0, confirmed)
    }

    @Test
    fun ompUpdateDialogUsesItsOwnCopy() {
        show(UpdateKind.OMP, version = "0.11.0")

        composeRule.onNodeWithText(text(R.string.system_omp_update_confirm_title)).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.system_omp_update_confirm_text, "0.11.0")).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.system_omp_update_install)).assertIsDisplayed()
    }
}
