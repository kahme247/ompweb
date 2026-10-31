package io.github.kahme247.ompweb.ui.settings

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.ProviderUsageWindow
import io.github.kahme247.ompweb.net.systemApi
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Settings block is now the only full provider usage view (the sessions
 * list keeps just the warning row), so it always renders: one line per account
 * with its worst window, and tapping the account expands every window.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-mdpi", application = android.app.Application::class)
class ProviderUsageBarTest {

    @get:Rule
    val composeRule = createComposeRule()

    private class FakePrefs : SettingsViewPreferences {
        private val state = MutableStateFlow(SettingsSnapshot(loaded = true))
        override val snapshot: StateFlow<SettingsSnapshot> = state.asStateFlow()

        override suspend fun setDismissedUpdate(kind: UpdateKind, version: String?) = Unit

        override suspend fun setCompletedAppUpdate(version: String?) = Unit

        override suspend fun setDictationEngine(wire: String) = Unit

        override suspend fun setDictationLanguage(tag: String?) = Unit
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun theFullBlockShowsTheWorstWindowAndExpandsEveryWindow() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val title = context.getString(R.string.provider_usage_title)
        val poller = ProviderUsagePoller(
            load = {
                ProviderUsageSnapshot(
                    generatedAt = null,
                    reports = listOf(
                        ProviderUsageReport(
                            provider = "anthropic",
                            accountLabel = "work",
                            plan = "Max",
                            fiveHour = ProviderUsageWindow(percent = 82.0, resetHours = 2),
                            sevenDay = ProviderUsageWindow(percent = 41.0, resetHours = 30),
                        ),
                    ),
                )
            },
            scope = scope,
        )
        val viewModel = SettingsViewModel(
            system = ApiClient(OkHttpClient(), { null }).systemApi(),
            settings = FakePrefs(),
            poller = poller,
        )

        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                ProviderUsageBar(viewModel = viewModel)
            }
        }
        poller.refresh()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithText("work · Max").assertIsDisplayed()
        composeRule.onNodeWithText("5H 82%").assertIsDisplayed()

        composeRule.onNodeWithText("work · Max").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("7D").assertIsDisplayed()
        composeRule.onNodeWithText("41%").assertIsDisplayed()
    }
}
