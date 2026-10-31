package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.SettingsTab
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ArchiveEntry
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.ProbeResult
import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.ProviderUsageWindow
import io.github.kahme247.ompweb.net.ServerProbe
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.SessionInfo
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.systemApi
import io.github.kahme247.ompweb.ui.PasswordError
import io.github.kahme247.ompweb.ui.connect.ConnectScreen
import io.github.kahme247.ompweb.ui.connect.ConnectViewModel
import io.github.kahme247.ompweb.ui.onboarding.PasswordScreen
import io.github.kahme247.ompweb.ui.sessions.ArchiveBrowserContent
import io.github.kahme247.ompweb.ui.sessions.ExitDraftContent
import io.github.kahme247.ompweb.ui.sessions.ArchiveUiState
import io.github.kahme247.ompweb.ui.sessions.QuickSwitcherContent
import io.github.kahme247.ompweb.ui.sessions.SessionBreadcrumb
import io.github.kahme247.ompweb.ui.sessions.SessionHeaderTitle
import io.github.kahme247.ompweb.ui.sessions.SessionListPane
import io.github.kahme247.ompweb.ui.sessions.SessionsUiState
import io.github.kahme247.ompweb.ui.sessions.sessionBreadcrumb
import io.github.kahme247.ompweb.ui.sessions.ProviderUsageWarningRow
import io.github.kahme247.ompweb.ui.settings.ProviderUsagePoller
import io.github.kahme247.ompweb.ui.settings.SettingsNavigation
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import io.github.kahme247.ompweb.ui.worktrees.WorktreeActions
import io.github.kahme247.ompweb.ui.worktrees.WorktreeContextState
import io.github.kahme247.ompweb.ui.worktrees.WorktreesPane
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import org.junit.Test

/**
 * Phase 11's shell matrices: the pre-connection screens, the drawer, the
 * Settings category list and the Worktrees tab — every width × font scale ×
 * theme cell from `ScreenshotMatrix`.
 *
 * Data is fixed (timestamps in 2020 render as an absolute date) so a golden
 * does not depend on when it was recorded.
 */
class ShellScreensScreenshotsTest : ScreenshotTest() {

    @Test
    fun password() = composeRule.verifyScreenshotMatrix("shell-password") {
        PasswordScreen(
            origin = ServerAddress("http", "192.168.1.20", 30177),
            error = PasswordError.WrongPassword,
            signingIn = false,
            onSubmit = {},
            onChangeServer = {},
        )
    }

    @Test
    fun connect() {
        // Constructed outside the composable so lint's
        // ViewModelConstructorInComposable stays clean (the VM owns the probe
        // and must not be recreated on every recomposition of a cell).
        val viewModel = ConnectViewModel(ServerProbe())
        composeRule.verifyScreenshotMatrix("shell-connect") {
            ConnectScreen(
                viewModel = viewModel,
                onAccepted = { _, _ -> },
                onTooOld = { _, _ -> },
                initialAddress = ServerAddress("http", "192.168.1.20", 30177),
                initialResult = ProbeResult.REACHABLE,
            )
        }
    }

    @Test
    fun sessionList() = composeRule.verifyScreenshotMatrix("shell-session-list") {
        SessionListPane(
            state = sessionsState,
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

    @Test
    fun sessionUsage() {
        // A1: the drawer footer warns while a provider window is tight. The
        // real row runs the real decision against a fixed snapshot (no
        // network), so every cell renders the same warning instead of a
        // spinner — and no block takes the list's height.
        val poller = ProviderUsagePoller(
            load = { providerUsageSnapshot },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        )
        val settings = SettingsViewModel(
            system = ApiClient(OkHttpClient(), { null }).systemApi(),
            settings = object : SettingsViewPreferences {
                private val state = MutableStateFlow(SettingsSnapshot(loaded = true))
                override val snapshot: StateFlow<SettingsSnapshot> = state

                override suspend fun setDismissedUpdate(kind: UpdateKind, version: String?) = Unit

                override suspend fun setCompletedAppUpdate(version: String?) = Unit

                override suspend fun setDictationEngine(wire: String) = Unit

                override suspend fun setDictationLanguage(tag: String?) = Unit
            },
            poller = poller,
        )
        poller.refresh()
        composeRule.verifyScreenshotMatrix("shell-session-usage") {
            SessionListPane(
                state = sessionsState,
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
                        viewModel = settings,
                        onClick = {},
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

    @Test
    fun emptySessions() = composeRule.verifyScreenshotMatrix("shell-empty-sessions") {
        SessionListPane(
            state = SessionsUiState(
                loading = false,
                projectsLoaded = true,
                connection = ConnectionState.Connected,
                home = "/home/dev",
            ),
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

    @Test
    fun quickSwitcher() = composeRule.verifyScreenshotMatrix(
        name = "shell-quick-switcher",
        heightDp = 560,
    ) {
        Surface(color = LocalOmpColors.current.background) {
            QuickSwitcherContent(
                sessions = sessionsState.sessions,
                runningIds = sessionsState.runningIds,
                home = sessionsState.home,
                currentModel = "claude-sonnet-4",
                onSelectSession = {},
                onNewSession = {},
                onChangeTheme = {},
                onDismiss = {},
            )
        }
    }

    @Test
    fun sessionBreadcrumb() = composeRule.verifyScreenshotMatrix(
        name = "shell-session-breadcrumb",
        heightDp = 96,
    ) {
        Surface(color = LocalOmpColors.current.background) {
            SessionHeaderTitle(
                title = "Fix the Android sidebar layout",
                breadcrumb = sessionBreadcrumb(
                    info = SessionInfo(
                        id = "s1",
                        name = "Fix the Android sidebar layout",
                        cwd = "/home/dev/projects/ompweb/worktrees/phase-11",
                        projectKey = "/home/dev/projects/ompweb",
                    ),
                    projects = sessionsState.projects,
                    home = "/home/dev",
                    branch = "phase-11-hardening",
                ),
            )
        }
    }

    @Test
    fun breadcrumbRendersProjectCwdAndBranch() {
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                SessionHeaderTitle(
                    title = "Fix the Android sidebar layout",
                    breadcrumb = SessionBreadcrumb(
                        project = "ompweb",
                        cwd = "~/projects/ompweb",
                        branch = "phase-11-hardening",
                    ),
                )
            }
        }
        composeRule.onNodeWithTag("session-breadcrumb").assertIsDisplayed()
        composeRule.onNodeWithTag("session-breadcrumb")
            .assertTextEquals("ompweb · ~/projects/ompweb · phase-11-hardening")
        composeRule.onNodeWithText("Fix the Android sidebar layout").assertIsDisplayed()
    }

    @Test
    fun archiveBrowser() = composeRule.verifyScreenshotMatrix(
        name = "shell-archive-browser",
        heightDp = 760,
    ) {
        Surface(color = LocalOmpColors.current.background) {
            ArchiveBrowserContent(
                state = ArchiveUiState(
                    open = true,
                    entries = archiveEntries,
                    search = "drawer",
                    selectedKey = "arch-key-1",
                    restoringKey = "arch-key-1",
                ),
                onClose = {},
                onRefresh = {},
                onSearch = {},
                onSelect = {},
                onRestore = {},
                onCopyId = {},
            )
        }
    }

    @Test
    fun settingsList() = composeRule.verifyScreenshotMatrix("shell-settings-list") {
        SettingsNavigation(
            modifier = Modifier.fillMaxSize(),
            selected = SettingsTab.GENERAL,
            cwd = "/home/dev/projects/ompweb",
            query = "",
            onQueryChange = {},
            onSelect = {},
        )
    }

    @Test
    fun worktrees() = composeRule.verifyScreenshotMatrix("shell-worktrees") {
        WorktreesPane(
            context = WorktreeContextState(
                projectRoot = "/home/dev/projects/ompweb",
                worktrees = listOf(
                    WorktreeEntry("/home/dev/projects/ompweb", branch = "main", isMain = true),
                    WorktreeEntry(
                        "/home/dev/projects/ompweb-worktrees/phase-11-hardening",
                        branch = "phase-11-hardening",
                    ),
                ),
                currentPath = "/home/dev/projects/ompweb-worktrees/phase-11-hardening",
                ready = true,
            ),
            actions = WorktreeActions(
                onSwitch = {},
                onCreate = {},
                onRemove = { _, _ -> },
                onCancelRemove = {},
                onRefresh = {},
                onClearError = {},
            ),
            modifier = Modifier.fillMaxSize(),
        )
    }

    /**
     * B7: the "unsent drafts" prompt the shell shows before leaving. The body
     * is captured instead of the dialog window (which the matrix cannot
     * render); both actions must be offered.
     */
    @Test
    fun exitConfirm() = composeRule.verifyScreenshotMatrix(name = "shell-exit-confirm", heightDp = 260) {
        Surface(color = LocalOmpColors.current.panel) {
            Column(Modifier.fillMaxWidth().padding(20.dp)) {
                ExitDraftContent(draftCount = 2, onStay = {}, onLeave = {})
            }
        }
    }

    private companion object {

        /** A1: two accounts, one with a tight five-hour window. */
        val providerUsageSnapshot = ProviderUsageSnapshot(
            generatedAt = 1_577_930_400_000L,
            reports = listOf(
                ProviderUsageReport(
                    provider = "anthropic",
                    accountLabel = "work",
                    plan = "Max",
                    fiveHour = ProviderUsageWindow(percent = 82.0, resetHours = 2),
                    sevenDay = ProviderUsageWindow(percent = 41.0, resetHours = 30),
                ),
                ProviderUsageReport(
                    provider = "openai",
                    accountLabel = "personal",
                    plan = "Plus",
                    fiveHour = ProviderUsageWindow(percent = 12.0, resetMinutes = 47),
                    sevenDay = ProviderUsageWindow(percent = 63.0, resetHours = 72),
                ),
            ),
        )

        val sessionsState = SessionsUiState(
            loading = false,
            projectsLoaded = true,
            connection = ConnectionState.Connected,
            projects = listOf(
                ManagedProject("/home/dev/projects/ompweb"),
                ManagedProject("/home/dev/work/ompweb-site", alias = "landing page"),
            ),
            sessions = listOf(
                SessionSummary(
                    id = "s1",
                    cwd = "/home/dev/projects/ompweb",
                    name = "Fix the Android sidebar layout",
                    modified = "2020-01-05T10:00:00Z",
                    messageCount = 42,
                    firstMessage = "The sidebar clips at 200 % font",
                ),
                SessionSummary(
                    id = "s2",
                    cwd = "/home/dev/projects/ompweb",
                    name = "Add provider usage bar back",
                    modified = "2020-01-04T10:00:00Z",
                    messageCount = 7,
                ),
                SessionSummary(
                    id = "s3",
                    cwd = "/home/dev/work/ompweb-site",
                    modified = "2020-01-03T10:00:00Z",
                    messageCount = 3,
                    firstMessage = "Refresh the landing page screenshots",
                ),
            ),
            runningIds = setOf("s1"),
            // A settled list: the fixture shows the server-confirmed badges,
            // not the cache-first "Updating…" window.
            runningKnown = true,
            unreadIds = setOf("s2"),
            expandedProjects = setOf("/home/dev/projects/ompweb"),
            activeCwd = "/home/dev/projects/ompweb",
            home = "/home/dev",
        )

        val archiveEntries = listOf(
            ArchiveEntry(
                key = "arch-key-1",
                id = "sess-archived-1",
                cwd = "/home/dev/projects/ompweb",
                name = "Drawer keyboard shortcuts",
                created = "2019-12-28T09:00:00Z",
                archivedAt = "2020-01-02T10:00:00Z",
                messageCount = 18,
                firstMessage = "The drawer closes on Esc while a draft is open.",
                size = 48_256,
                status = "archived",
            ),
            ArchiveEntry(
                key = "arch-key-2",
                id = "sess-archived-2",
                cwd = "/home/dev/work/ompweb-site",
                name = "Landing page screenshots",
                created = "2019-12-20T09:00:00Z",
                archivedAt = "2019-12-31T10:00:00Z",
                messageCount = 6,
                firstMessage = "Refresh the marketing screenshots.",
                size = 12_800,
                status = "restored",
            ),
        )
    }
}
