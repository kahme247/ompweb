package io.github.kahme247.ompweb.ui.sessions

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdateNoticeState
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.settings.UpdateNoticeBanner
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Phase 11 live run found the update banner floating over the whole top
 * bar: with a banner visible, every action (search, new session, files,
 * settings, bell, more) was invisible, absent from the accessibility tree and
 * untappable. The banner is content now — it renders below the app bar — and
 * this pins the layout and the a11y effect, not just the banner's existence.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class UpdateBannerTopBarTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun theBannerSitsBelowTheTopBarAndItsActionsStayTappable() {
        val searchLabel = ApplicationProvider.getApplicationContext<Context>()
            .getString(R.string.home_search)
        var searchTaps = 0

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
                        onOpenSettings = {},
                        onBack = {},
                        onForward = {},
                        onQuickSwitcher = {},
                        onSearchToggle = { searchTaps++ },
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
                        updateBanner = {
                            UpdateNoticeBanner(
                                state = UpdateNoticeState(
                                    kind = UpdateKind.APP,
                                    currentVersion = "0.5.2",
                                    availableVersion = "0.6.0",
                                ),
                                onOpenSettings = {},
                                onDismiss = {},
                            )
                        },
                    )
                }
            }
        }

        val banner = composeRule.onNodeWithTag("update-notice-banner")
        banner.assertIsDisplayed()

        // The top bar must stay in the tree and keep its click action.
        val search = composeRule.onNodeWithContentDescription(searchLabel)
        search.assertIsDisplayed()
        search.assertHasClickAction()

        val bannerTop = banner.getUnclippedBoundsInRoot().top
        val searchBottom = search.getUnclippedBoundsInRoot().bottom
        assertTrue(
            "the banner must start below the top bar (banner top=$bannerTop, " +
                "search action bottom=$searchBottom)",
            bannerTop >= searchBottom,
        )

        // A tap reaches the action instead of the banner.
        search.performClick()
        composeRule.runOnIdle { assertEquals(1, searchTaps) }
        banner.assertIsDisplayed()
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
