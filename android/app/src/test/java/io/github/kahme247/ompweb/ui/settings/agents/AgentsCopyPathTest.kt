package io.github.kahme247.ompweb.ui.settings.agents

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.AgentInfo
import io.github.kahme247.ompweb.net.AgentSaveResult
import io.github.kahme247.ompweb.net.AgentUnpackResult
import io.github.kahme247.ompweb.net.AgentsApi
import io.github.kahme247.ompweb.net.AgentsDocument
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * B24 (T7-8) on the device: the "Copy path" button of the open agent puts the
 * real file path on the clipboard — the only place that action is observable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h891dp", application = android.app.Application::class)
class AgentsCopyPathTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private val agent = AgentInfo(
        name = "writer",
        description = "Writes the release notes",
        scope = "user",
        filePath = "/home/dev/.omp/agents/writer.md",
    )

    private val api = object : AgentsApi {
        override suspend fun list(cwd: String?): AgentsDocument = AgentsDocument(agents = listOf(agent))

        override suspend fun save(
            cwd: String?,
            scope: String,
            name: String,
            previousName: String?,
            agent: JsonObject,
            update: Boolean,
        ): AgentSaveResult = error("not used in this test")

        override suspend fun delete(cwd: String?, scope: String, name: String) =
            error("not used in this test")

        override suspend fun unpack(cwd: String?, scope: String): AgentUnpackResult =
            AgentUnpackResult()
    }

    @Test
    fun copiesTheActiveAgentPath() {
        val viewModel = AgentsViewModel(api, CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
        composeRule.setContent {
            AgentsTab(vm = viewModel, cwd = "/home/dev/projects/ompweb")
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText(context.getString(R.string.agents_copy_path))
            .performScrollTo()
            .performClick()
        composeRule.waitForIdle()

        val clipboard = context.getSystemService(ClipboardManager::class.java)
        assertNotNull("the test runtime has a clipboard", clipboard)
        assertEquals(
            agent.filePath,
            clipboard!!.primaryClip?.getItemAt(0)?.text?.toString(),
        )
        composeRule.onNodeWithText(context.getString(R.string.models_copied)).assertExists()
    }
}
