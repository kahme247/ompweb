package io.github.kahme247.ompweb.ui.composer

import io.github.kahme247.ompweb.data.ChatDraft
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.filesApi
import io.github.kahme247.ompweb.testutil.MemoryDrafts
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Test

/** Composer state shared by the chat and the new-session pane. */
@OptIn(ExperimentalCoroutinesApi::class)
class ComposerControllerTest {

    private fun TestScope.controller(drafts: MemoryDrafts): ComposerController {
        // No request is issued by these tests; the client only satisfies the seams.
        val api = ApiClient(OkHttpClient(), { null })
        return ComposerController(
            drafts = drafts,
            scope = backgroundScope,
            api = api,
            files = api.filesApi(),
            strings = ComposerStrings(),
            notice = { },
        )
    }

    @Test
    fun `a draft written by another owner lands in the open composer`() = runTest(UnconfinedTestDispatcher()) {
        val drafts = MemoryDrafts()
        val composer = controller(drafts)
        composer.bind("s1", null, null)
        assertEquals("", composer.state.value.text)

        // A share (or a recovered queue entry) writes the draft store directly.
        drafts.setDraft(
            "s1",
            ChatDraft(
                value = "shared text",
                files = listOf(AttachedTextFile("notes.txt", "text/plain", "body", 4)),
            ),
        )
        composer.applyStoredDraft()

        assertEquals("the open pane reloads the shared draft", "shared text", composer.state.value.text)
        assertEquals(1, composer.state.value.files.size)
        assertEquals(
            "the reload carries an edit id so the field repaints",
            "shared text",
            composer.state.value.edit?.text,
        )
    }

    @Test
    fun `usage errors show the localized hint instead of the resource key`() {
        val strings = ComposerStrings(
            commandRequiresArgs = "Usage: %1\$s %2\$s",
            usageHints = mapOf("composer_cmd_plan_arg" to "[task]"),
        )

        assertEquals("Usage: /plan [task]", strings.requiresArgs("/plan", "composer_cmd_plan_arg"))
    }
}
