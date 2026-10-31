package io.github.kahme247.ompweb.screenshot

import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.net.SttApi
import io.github.kahme247.ompweb.net.SttAudio
import io.github.kahme247.ompweb.domain.SttClaim
import io.github.kahme247.ompweb.domain.SttJob
import io.github.kahme247.ompweb.net.SttRetryOutcome
import io.github.kahme247.ompweb.net.SttStartOutcome
import io.github.kahme247.ompweb.net.worktreesApi
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.testutil.MemoryDictationStore
import io.github.kahme247.ompweb.testutil.MemoryDrafts
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.sessions.NewSessionPane
import io.github.kahme247.ompweb.ui.sessions.NewSessionViewModel
import io.github.kahme247.ompweb.ui.worktrees.WorktreeCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import org.junit.Test

/**
 * The new-session pane without a picked workspace: workspace dropdown, the
 * empty state and the composer. Nothing loads (no origin), so every cell shows
 * the same stable state instead of a spinner racing the capture.
 */
class ShellNewSessionScreenshotsTest : ScreenshotTest() {

    private val api = ApiClient(OkHttpClient(), { null })

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val viewModel = NewSessionViewModel(
        api = api,
        drafts = MemoryDrafts(),
        composerStrings = ComposerStrings(noSession = "No session"),
        controls = ComposerControlsViewModel(api, FakeChatSettings(), scope),
        dictation = DictationViewModel(NoSttApi, MemoryDictationStore(), scope, clock = { 0L }),
        worktreeCache = WorktreeCache(api.worktreesApi()),
    )

    @Test
    fun newSession() = composeRule.verifyScreenshotMatrix("shell-new-session") {
        NewSessionPane(
            viewModel = viewModel,
            cwd = null,
            projects = emptyList(),
            home = "/home/dev",
            compact = true,
            onBack = {},
            onBrowse = {},
            onCreated = {},
            appVersion = "1.14.0",
            serverVersion = "2.3.1",
        )
    }

    @Test
    fun newSessionPanels() = composeRule.verifyScreenshotMatrix(
        name = "shell-new-session-panels",
        heightDp = 900,
    ) {
        NewSessionPane(
            viewModel = viewModel,
            cwd = null,
            projects = emptyList(),
            home = "/home/dev",
            compact = true,
            onBack = {},
            onBrowse = {},
            onCreated = {},
            appVersion = "1.14.0",
            serverVersion = "2.3.1",
            todoPhases = todoPhases(),
            subagents = subagents(),
        )
    }

    private object NoSttApi : SttApi {
        override suspend fun start(
            scope: String?,
            owner: String,
            after: SttAfter?,
            audio: ByteArray,
            fileName: String,
            mimeType: String,
        ): SttStartOutcome = SttStartOutcome.Rejected("not configured")

        override suspend fun jobs(scope: String): List<SttJob> = emptyList()

        override suspend fun job(jobId: String): SttJob? = null

        override suspend fun claim(jobId: String, claimToken: String, ownerToken: String): SttClaim? = null

        override suspend fun discard(jobId: String) = Unit

        override suspend fun retry(jobId: String, ownerToken: String): SttRetryOutcome =
            error("not used in the screenshot")

        override suspend fun audio(jobId: String): SttAudio? = null
    }
}
