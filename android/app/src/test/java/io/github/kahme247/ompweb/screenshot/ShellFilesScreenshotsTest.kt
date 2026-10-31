package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.ui.files.FileOpenMode
import io.github.kahme247.ompweb.domain.GitFileDiff
import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.GitFileStatusKind
import io.github.kahme247.ompweb.domain.GitStatusResponse
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.GitApi
import io.github.kahme247.ompweb.testutil.FakeFilesApi
import io.github.kahme247.ompweb.ui.files.ExplorerUiState
import io.github.kahme247.ompweb.ui.files.FileExplorerPane
import io.github.kahme247.ompweb.ui.files.FileTab
import io.github.kahme247.ompweb.ui.files.FileViewerPane
import io.github.kahme247.ompweb.ui.files.FilesViewModel
import io.github.kahme247.ompweb.ui.files.MemoryFileTabStore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonObject
import org.junit.Test

/**
 * The Files panel's explorer and source viewer with a fixed tree and file.
 * The view model is only the action sink here — the shown state is a fixture,
 * so the capture does not depend on a load finishing.
 */
class ShellFilesScreenshotsTest : ScreenshotTest() {

    private val viewModel = FilesViewModel(
        api = FakeFilesApi(),
        git = NoGitApi,
        events = NoEvents,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        tabStore = MemoryFileTabStore(),
        cacheDir = File(System.getProperty("java.io.tmpdir"), "ompweb-screenshot-cache"),
        origin = { null },
    )

    @Test
    fun explorer() = composeRule.verifyScreenshotMatrix("shell-files-explorer") {
        FileExplorerPane(
            state = explorerState,
            vm = viewModel,
            onOpenFile = {},
            onMention = {},
            onCopyPath = {},
            onDownload = {},
            onShare = {},
            modifier = Modifier.fillMaxSize(),
        )
    }

    @Test
    fun viewer() = composeRule.verifyScreenshotMatrix("shell-files-viewer") {
        FileViewerPane(
            tab = FileTab(
                path = "/home/dev/projects/ompweb/src/sidebar/Layout.kt",
                mode = FileOpenMode.Source,
                content = """
                    package sidebar

                    /** Pins the provider usage strip above the Settings row. */
                    @Composable
                    fun Sidebar(usageVisible: Boolean, onOpenSettings: () -> Unit) {
                        Column(Modifier.fillMaxSize()) {
                            Sessions()
                            if (usageVisible) ProviderUsageBar()
                            SettingsRow(onOpenSettings)
                        }
                    }
                """.trimIndent(),
                language = "kotlin",
                size = 1_234,
            ),
            cwd = "/home/dev/projects/ompweb",
            githubRepo = null,
            vm = viewModel,
            onLink = {},
            onMention = {},
            onCopyPath = {},
            onDownload = {},
            onShare = {},
            onReveal = {},
            modifier = Modifier.fillMaxSize(),
        )
    }

    private companion object {

        const val ROOT = "/home/dev/projects/ompweb"

        val gitFiles = listOf(
            GitFileStatus("$ROOT/src/sidebar/Layout.kt", GitFileStatusKind.MODIFIED, "M"),
            GitFileStatus("$ROOT/src/sidebar/UsageBar.kt", GitFileStatusKind.ADDED, "A"),
        )

        val explorerState = ExplorerUiState(
            cwd = ROOT,
            rootLoaded = true,
            children = mapOf(
                ROOT to listOf(
                    FileEntry("src", isDir = true),
                    FileEntry("README.md", isDir = false, size = 4_096),
                    FileEntry("build.gradle.kts", isDir = false, size = 812),
                ),
                "$ROOT/src" to listOf(
                    FileEntry("sidebar", isDir = true),
                    FileEntry("Main.kt", isDir = false, size = 3_210),
                ),
                "$ROOT/src/sidebar" to listOf(
                    FileEntry("Layout.kt", isDir = false, size = 1_234),
                    FileEntry("UsageBar.kt", isDir = false, size = 960),
                ),
            ),
            expanded = setOf(ROOT, "$ROOT/src", "$ROOT/src/sidebar"),
            gitFiles = gitFiles,
        )

        object NoGitApi : GitApi {
            override suspend fun status(cwd: String): GitStatusResponse =
                GitStatusResponse(isGitRepository = false, repositoryRoot = null, files = emptyList())

            override suspend fun diff(cwd: String, path: String): GitFileDiff = GitFileDiff(supported = false)
        }

        object NoEvents : SessionEventSource {
            override val state = MutableStateFlow(ConnectionState.Connected)

            override fun subscribe(channel: EventChannel): Flow<JsonObject> = emptyFlow()
        }
    }
}
