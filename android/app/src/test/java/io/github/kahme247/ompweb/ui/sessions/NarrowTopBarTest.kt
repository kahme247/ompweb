package io.github.kahme247.ompweb.ui.sessions

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Phase 11 small-screen pass (320 dp pane, font scale 2.0) found the list's
 * top bar overflowing: eight 48 dp actions need 384 dp, so the bell was clipped
 * to 4 px, the overflow menu was off the screen, and the title — squeezed into
 * an 80 px column — wrapped one character per line and grew the bar to 405 dp,
 * which left ~12 px for the session list (a blank screen).
 *
 * The bar is width-aware now: below 480 dp it keeps Search, New session, the
 * bell and the overflow menu, and Back/Forward/Files move into that menu. The
 * title is single-line with an ellipsis, so it can never grow the bar again.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w320dp-h568dp-mdpi", application = android.app.Application::class)
class NarrowTopBarTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun aPhonePaneKeepsEveryActionAndLeavesRoomForTheList() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val searchLabel = context.getString(R.string.home_search)
        val filesLabel = context.getString(R.string.files_open_in_session)
        val moreLabel = context.getString(R.string.sessions_menu)

        composeRule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 1f, fontScale = 2f)) {
                OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                    Box(modifier = Modifier.size(320.dp, 568.dp)) {
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

        // The bar keeps its Material height in dp (64 dp) instead of growing
        // with the wrapped title, so the list below it has the screen.
        val search = composeRule.onNodeWithContentDescription(searchLabel)
        search.assertIsDisplayed()
        search.assertHasClickAction()
        val searchBounds = search.getUnclippedBoundsInRoot()
        assertTrue(
            "the search action must stay inside the pane (right=${searchBounds.right})",
            searchBounds.right <= 320.dp,
        )
        assertTrue(
            "the top bar must stay 64 dp tall (search bottom=${searchBounds.bottom})",
            searchBounds.bottom <= 64.dp,
        )

        // The overflow menu is reachable instead of being clipped away.
        composeRule.onNodeWithContentDescription(moreLabel).assertIsDisplayed().assertHasClickAction()

        // The statistics row the reader came for is on screen.
        composeRule.onAllNodesWithText("Fix the Android sidebar layout")[0].assertIsDisplayed()

        // The two actions that no longer fit are in the menu, not gone.
        composeRule.onNodeWithContentDescription(moreLabel).performClick()
        composeRule.onAllNodesWithText(filesLabel)[0].assertIsDisplayed()
        composeRule.onAllNodesWithText(context.getString(R.string.nav_back))[0].assertIsDisplayed()
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
