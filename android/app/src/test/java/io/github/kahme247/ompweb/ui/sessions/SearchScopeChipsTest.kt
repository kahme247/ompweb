package io.github.kahme247.ompweb.ui.sessions

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * "Search in messages" needs `GET /api/sessions/messages/search`, which an
 * older server does not serve (it answers 404). The server advertises that in
 * `GET /api/app-info` as `capabilities.messageSearch`; without the flag the
 * mode must not be offered at all — the title filter stays usable.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class SearchScopeChipsTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val sessionsChip = context.getString(R.string.sessions_search_scope_sessions)
    private val messagesChip = context.getString(R.string.sessions_search_scope_messages)

    @Test
    fun anOlderServerWithoutTheCapabilityShowsNoMessageSearch() {
        render(messageSearchSupported = false)

        composeRule.onNodeWithText(sessionsChip).assertIsDisplayed()
        composeRule.onNodeWithText(messagesChip).assertDoesNotExist()
        // The title filter and its running-only chip stay, so the row is not empty.
        composeRule.onNodeWithText(context.getString(R.string.home_running_only)).assertIsDisplayed()
    }

    @Test
    fun aServerWithTheCapabilityOffersTheMessageSearch() {
        render(messageSearchSupported = true)

        composeRule.onNodeWithText(sessionsChip).assertIsDisplayed()
        composeRule.onNodeWithText(messagesChip).assertIsDisplayed()
    }

    private fun render(messageSearchSupported: Boolean) {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                Box(modifier = Modifier.size(411.dp, 890.dp)) {
                    SessionListPane(
                        state = state(messageSearchSupported),
                        historyCanBack = false,
                        historyCanForward = false,
                        themeId = ScreenshotMatrix.LIGHT_THEME_ID,
                        onRefresh = {},
                        onRetryConnection = {},
                        onThemeSelected = {},
                        onSignOut = {},
                        onChangeServer = {},
                        notificationBell = {},
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
    }

    private companion object {
        fun state(messageSearchSupported: Boolean) = SessionsUiState(
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
            searchOpen = true,
            messageSearchSupported = messageSearchSupported,
        )
    }
}
