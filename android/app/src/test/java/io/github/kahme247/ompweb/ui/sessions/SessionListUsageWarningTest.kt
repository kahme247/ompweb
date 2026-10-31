package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.ProviderUsageWindow
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.net.systemApi
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.settings.ProviderUsagePoller
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The sessions list no longer carries the provider block; it adds one slim
 * warning row only while a window is at or above 80 %. The row is a footer: it
 * sits on the bottom edge and, without a tight window, emits nothing at all so
 * the list keeps its whole height.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class SessionListUsageWarningTest {

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

    /** One provider account whose 7D window uses [percent] of its limit. */
    private class Usage(percent: Double) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val poller = ProviderUsagePoller(
            load = {
                ProviderUsageSnapshot(
                    generatedAt = null,
                    reports = listOf(
                        ProviderUsageReport(
                            provider = "anthropic",
                            accountLabel = "work",
                            plan = "Max",
                            sevenDay = ProviderUsageWindow(percent = percent, resetHours = 30),
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
    }

    private var usage: Usage? = null

    @After
    fun tearDown() {
        usage?.scope?.cancel()
    }

    @Test
    fun aTightWindowAddsOneSlimRowOnTheBottomEdge() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        // Robolectric's resource table is the real one; read the strings the row
        // builds so a wording change cannot silently break the matcher.
        val label = context.getString(R.string.sessions_usage_warning_label, "work · Max")
        val value = context.getString(R.string.sessions_usage_warning_value, "7D", 85)
        val current = Usage(percent = 85.0)
        usage = current
        val clicks = AtomicInteger()

        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                Box(modifier = Modifier.size(411.dp, 890.dp)) {
                    SessionListPane(
                        state = state,
                        historyCanBack = false,
                        historyCanForward = false,
                        themeId = ScreenshotMatrix.LIGHT_THEME_ID,
                        onRefresh = {},
                        onRetryConnection = {},
                        onThemeSelected = {},
                        onSignOut = {},
                        onChangeServer = {},
                        notificationBell = {},
                        usageWarning = {
                            ProviderUsageWarningRow(
                                viewModel = current.viewModel,
                                onClick = { clicks.incrementAndGet() },
                            )
                        },
                        onOpenSettings = {},
                        onBack = {},
                        onForward = {},
                        onQuickSwitcher = {},
                        onSearchToggle = {},
                        onSearchQueryChange = {},
                        onSearchClose = {},
                        onSearchModeChange = {},
                        onOpenMessageHit = {},
                        onLoadMoreMessageResults = {},
                        onRetryMessageSearch = {},
                        onRunningOnlyToggle = {},
                        onNewSession = {},
                        onAddProject = {},
                        onOpenFiles = {},
                        onImport = {},
                        onOpenArchive = {},
                        onOpenSession = {},
                        onTogglePin = {},
                        onToggleProject = {},
                        onActivateProject = {},
                        onNewSessionInProject = {},
                        onRenameProject = {},
                        onLaunchConfig = {},
                        onHideProject = {},
                        onMoveProject = { _, _ -> },
                        onMoveProjectTo = { _, _ -> },
                        onRenameSession = {},
                        onArchiveSession = {},
                        onAutoNameSession = {},
                        onCopyTranscript = {},
                        onExportSession = {},
                        onDeleteSession = {},
                        onCopyId = {},
                    )
                }
            }
        }
        current.poller.refresh()
        composeRule.waitForIdle()

        val row = composeRule.onNodeWithTag("usage-warning")
        row.assertIsDisplayed()
        assertTrue(
            "the warning row must not collapse to zero height",
            row.getUnclippedBoundsInRoot().height > 0.dp,
        )
        // The row is a footer: its bottom edge sits on the pane's bottom edge,
        // the list keeps everything above it.
        val rowBounds = row.getUnclippedBoundsInRoot()
        val paneBottom = composeRule.onRoot().getUnclippedBoundsInRoot().bottom
        assertEquals(
            "the warning row must sit on the bottom edge (gap was ${paneBottom - rowBounds.bottom})",
            0f,
            (paneBottom - rowBounds.bottom).value,
            0.5f,
        )
        composeRule.onNodeWithText(label).assertIsDisplayed()
        composeRule.onNodeWithText(value).assertIsDisplayed()
        // The full block is not duplicated into the list.
        composeRule.onNodeWithText("Provider usage").assertDoesNotExist()
        composeRule.onNodeWithText("Fix the Android sidebar layout").assertIsDisplayed()

        row.performClick()
        assertEquals("the row opens Settings", 1, clicks.get())
    }

    @Test
    fun noRowExistsWhileEveryWindowStaysBelowTheThreshold() {
        val current = Usage(percent = 79.0)
        usage = current

        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                Box(modifier = Modifier.size(411.dp, 890.dp)) {
                    SessionListPane(
                        state = state,
                        historyCanBack = false,
                        historyCanForward = false,
                        themeId = ScreenshotMatrix.LIGHT_THEME_ID,
                        onRefresh = {},
                        onRetryConnection = {},
                        onThemeSelected = {},
                        onSignOut = {},
                        onChangeServer = {},
                        notificationBell = {},
                        usageWarning = {
                            ProviderUsageWarningRow(viewModel = current.viewModel, onClick = {})
                        },
                        onOpenSettings = {},
                        onBack = {},
                        onForward = {},
                        onQuickSwitcher = {},
                        onSearchToggle = {},
                        onSearchQueryChange = {},
                        onSearchClose = {},
                        onSearchModeChange = {},
                        onOpenMessageHit = {},
                        onLoadMoreMessageResults = {},
                        onRetryMessageSearch = {},
                        onRunningOnlyToggle = {},
                        onNewSession = {},
                        onAddProject = {},
                        onOpenFiles = {},
                        onImport = {},
                        onOpenArchive = {},
                        onOpenSession = {},
                        onTogglePin = {},
                        onToggleProject = {},
                        onActivateProject = {},
                        onNewSessionInProject = {},
                        onRenameProject = {},
                        onLaunchConfig = {},
                        onHideProject = {},
                        onMoveProject = { _, _ -> },
                        onMoveProjectTo = { _, _ -> },
                        onRenameSession = {},
                        onArchiveSession = {},
                        onAutoNameSession = {},
                        onCopyTranscript = {},
                        onExportSession = {},
                        onDeleteSession = {},
                        onCopyId = {},
                    )
                }
            }
        }
        current.poller.refresh()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("usage-warning").assertDoesNotExist()
        composeRule.onNodeWithText("Fix the Android sidebar layout").assertIsDisplayed()
    }

    private companion object {
        val state = SessionsUiState(
            loading = false,
            projectsLoaded = true,
            connection = ConnectionState.Connected,
            projects = listOf(ManagedProject("/home/dev/projects/ompweb")),
            sessions = listOf(
                SessionSummary(
                    id = "s1",
                    cwd = "/home/dev/projects/ompweb",
                    name = "Fix the Android sidebar layout",
                    modified = "2020-01-05T10:00:00Z",
                    messageCount = 42,
                ),
            ),
            expandedProjects = setOf("/home/dev/projects/ompweb"),
            activeCwd = "/home/dev/projects/ompweb",
            home = "/home/dev",
        )
    }
}
