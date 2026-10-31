package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.AutoRetry
import io.github.kahme247.ompweb.chat.QueueSnapshot
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.filesApi
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.testutil.FakeComposerApi
import io.github.kahme247.ompweb.testutil.FakeSttApi
import io.github.kahme247.ompweb.testutil.MemoryDictationStore
import io.github.kahme247.ompweb.testutil.MemoryDrafts
import io.github.kahme247.ompweb.ui.composer.ComposerBar
import io.github.kahme247.ompweb.ui.composer.ComposerController
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import org.junit.Test

/**
 * The composer with everything visible at once: two attachment chips, a
 * steering and a follow-up queue entry, a running state (Send becomes Queue +
 * Stop), the tool-preset/model/reasoning controls row and the context ring.
 */
class ComposerScreenshotsTest : ScreenshotTest() {

    @Test
    fun composer() {
        val controllers = composerScreenshotControllers(
            CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        val queue = QueueSnapshot(
            steering = listOf("Also check the 200 % font scale"),
            followUp = listOf("Run verifyScreenshots afterwards"),
        )
        val retry = AutoRetry(attempt = 2, maxAttempts = 3, message = "upstream 502 — retrying")
        composeRule.verifyScreenshotMatrix(name = "composer", heightDp = 900) {
            ComposerFixture(controllers, queue, retry)
        }
    }
}

internal class ComposerControllers(
    val composer: ComposerController,
    val controls: ComposerControlsViewModel,
    val dictation: DictationViewModel,
)

/** Composer bound to a fake session with two chips and seeded text. */
internal fun composerScreenshotControllers(scope: CoroutineScope): ComposerControllers {
    val api = ApiClient(OkHttpClient(), { null })
    val composer = ComposerController(
        drafts = MemoryDrafts(),
        scope = scope,
        api = api,
        files = api.filesApi(),
        strings = ComposerStrings(),
        notice = {},
    )
    val controls = ComposerControlsViewModel(FakeComposerApi(), FakeChatSettings(), scope)
    val dictation = DictationViewModel(FakeSttApi(), MemoryDictationStore(), scope)
    composer.bind("session-1", "/home/omp/ompweb", "session-1")
    composer.setText("Refactor the attach button, then run the screenshot matrix.")
    composer.addTextFiles(
        listOf(AttachedTextFile("notes.txt", "text/plain", "48 dp touch targets", 20)),
    )
    composer.addImages(
        listOf(
            ComposerImage(
                data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                mimeType = "image/png",
            ),
        ),
    )
    controls.bind(sessionId = "session-1", cwd = "/home/omp/ompweb")
    return ComposerControllers(composer, controls, dictation)
}

@Composable
internal fun ComposerFixture(
    controllers: ComposerControllers,
    queue: QueueSnapshot,
    autoRetry: AutoRetry?,
) {
    val composer = controllers.composer
    val controls = controllers.controls
    val dictation = controllers.dictation
    Column(Modifier.fillMaxWidth().padding(8.dp)) {
        ComposerBar(
            composer = composer,
            controls = controls,
            dictation = dictation,
            ghost = null,
            placeholder = stringResource(R.string.composer_placeholder),
            streaming = true,
            stopping = false,
            bashRunning = false,
            queue = queue,
            autoRetry = autoRetry,
            submitDuringRun = SubmitDuringRunBehavior.QUEUE,
            onSend = {},
            onQueue = {},
            onStop = {},
            onAbortRetry = {},
            onAcceptGhost = {},
            onHistory = {},
            onQueueEdit = { _, _ -> },
            onQueueDelete = { _, _ -> },
            onQueueSteer = {},
        )
    }
}
