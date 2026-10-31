package io.github.kahme247.ompweb.ui.files

import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.domain.GitFileDiff
import io.github.kahme247.ompweb.domain.GitStatusResponse
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.GitApi
import io.github.kahme247.ompweb.testutil.FakeFilesApi
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A19 on the device: hardware keys reach the explorer tree and the tab strip.
 * The rules themselves are covered by [FileKeyNavTest]; this proves the panes
 * are wired to them (focus the row/chip, press the key, observe the callback).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class FileKeyNavComposeTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val root = "/root"

    private val state = ExplorerUiState(
        cwd = root,
        rootLoaded = true,
        children = mapOf(
            root to listOf(FileEntry("src", isDir = true), FileEntry("a.kt", isDir = false, size = 10)),
            "$root/src" to listOf(FileEntry("b.kt", isDir = false, size = 20)),
        ),
        // src expanded, so its child b.kt is the row after it.
        expanded = setOf(root, "$root/src"),
    )

    private val viewModel = FilesViewModel(
        api = FakeFilesApi(),
        git = NoGitApi,
        events = NoEvents,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        tabStore = MemoryFileTabStore(),
        cacheDir = File(System.getProperty("java.io.tmpdir"), "ompweb-keynav-cache"),
        origin = { null },
    )

    private val opened = mutableListOf<String>()

    @Test
    fun `down moves the tree cursor and enter opens the next file`() {
        composeRule.setContent {
            FileExplorerPane(
                state = state,
                vm = viewModel,
                onOpenFile = { opened += it },
                onMention = {},
                onCopyPath = {},
                onDownload = {},
                onShare = {},
                modifier = Modifier,
            )
        }
        // Rows: src (0), b.kt (1), a.kt (2).
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src").requestFocus()
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src")
            .performKeyInput { pressKey(Key.DirectionDown) }
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src")
            .performKeyInput { pressKey(Key.Enter) }
        assertEquals(listOf("$root/src/b.kt"), opened)
    }

    @Test
    fun `right enters an expanded folder and enter opens its first child`() {
        composeRule.setContent {
            FileExplorerPane(
                state = state,
                vm = viewModel,
                onOpenFile = { opened += it },
                onMention = {},
                onCopyPath = {},
                onDownload = {},
                onShare = {},
                modifier = Modifier,
            )
        }
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src").requestFocus()
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src")
            .performKeyInput { pressKey(Key.DirectionRight) }
        composeRule.onNodeWithTag(FILE_ROW_TAG_PREFIX + "$root/src")
            .performKeyInput { pressKey(Key.Enter) }
        assertEquals(listOf("$root/src/b.kt"), opened)
    }

    @Test
    fun `tab strip arrows select the next tab and delete closes a file tab`() {
        val first = FileTab(path = "$root/a.kt")
        val second = FileTab(path = "$root/b.kt")
        var selectedView: FilesPanelView? = null
        var selectedTab: String? = null
        val closed = mutableListOf<String>()
        composeRule.setContent {
            FileTabStrip(
                view = FilesPanelView.Explorer,
                tabs = listOf(first, second),
                activeTabId = null,
                hasNotifications = false,
                onSelectView = { selectedView = it },
                onSelectTab = { selectedTab = it },
                onCloseTab = { closed += it },
            )
        }
        // Entries: explorer, git, worktrees, a.kt, b.kt — Left from the first wraps.
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "explorer").requestFocus()
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "explorer")
            .performKeyInput { pressKey(Key.DirectionLeft) }
        assertEquals(second.id, selectedTab)

        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + second.id)
            .performKeyInput { pressKey(Key.Delete) }
        assertEquals(listOf(second.id), closed)
    }

    @Test
    fun `arrows start from the focused tab not the active one`() {
        val selectedViews = mutableListOf<FilesPanelView>()
        composeRule.setContent {
            FileTabStrip(
                // Explorer is the *active* view; the keyboard focus wanders to
                // "git" without selecting it (web `TabBar.handleTabKeyDown`
                // takes the index of the focused tab).
                view = FilesPanelView.Explorer,
                tabs = emptyList(),
                activeTabId = null,
                hasNotifications = false,
                onSelectView = { selectedViews += it },
                onSelectTab = {},
                onCloseTab = {},
            )
        }
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "git").requestFocus()
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "git")
            .performKeyInput { pressKey(Key.DirectionRight) }
        assertEquals(
            "Right from the focused 'git' reaches 'worktrees', not the tab after 'explorer'",
            listOf(FilesPanelView.Worktrees),
            selectedViews,
        )
    }

    @Test
    fun `enter activates the focused fixed tab`() {
        var selectedView: FilesPanelView? = null
        composeRule.setContent {
            FileTabStrip(
                view = FilesPanelView.Explorer,
                tabs = emptyList(),
                activeTabId = null,
                hasNotifications = false,
                onSelectView = { selectedView = it },
                onSelectTab = {},
                onCloseTab = {},
            )
        }
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "git").requestFocus()
        composeRule.onNodeWithTag(FILE_TAB_TAG_PREFIX + "git")
            .performKeyInput { pressKey(Key.Enter) }
        assertEquals(FilesPanelView.Git, selectedView)
    }

    private object NoGitApi : GitApi {
        override suspend fun status(cwd: String): GitStatusResponse =
            GitStatusResponse(isGitRepository = false, repositoryRoot = null, files = emptyList())

        override suspend fun diff(cwd: String, path: String): GitFileDiff = GitFileDiff(supported = false)
    }

    private object NoEvents : SessionEventSource {
        override val state = MutableStateFlow(ConnectionState.Connected)

        override fun subscribe(channel: EventChannel): Flow<JsonObject> = emptyFlow()
    }
}
