package io.github.kahme247.ompweb.ui.settings.agents

import io.github.kahme247.ompweb.net.AgentDiagnostic
import io.github.kahme247.ompweb.net.AgentInfo
import io.github.kahme247.ompweb.net.AgentSaveResult
import io.github.kahme247.ompweb.net.AgentUnpackResult
import io.github.kahme247.ompweb.net.AgentsApi
import io.github.kahme247.ompweb.net.AgentsDocument
import io.github.kahme247.ompweb.net.ApiError
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B24: the Agents tab's actions — reloading the roster, unpacking omp's
 * templates, the active agent's file path (the row the copy button reads) and
 * the scan diagnostics — against a fake `AgentsApi`.
 */
class AgentsViewModelTest {

    private val api = FakeAgentsApi()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val viewModel = AgentsViewModel(api, scope)

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun attach() {
        viewModel.attach("/home/dev/projects/ompweb")
        waitFor("the roster") { !viewModel.state.value.loading && viewModel.state.value.agents.isNotEmpty() }
    }

    // ------------------------------------------------------------------ reload

    @Test
    fun `attach loads the roster and selects the first agent`() {
        attach()

        val state = viewModel.state.value
        assertEquals(listOf("/home/dev/projects/ompweb"), api.listCalls)
        assertEquals(listOf("bundled-one", "user-one", "project-one"), state.agents.map { it.name })
        assertEquals(AgentCounts(total = 3, bundled = 1, user = 1, project = 1), state.counts)
        assertEquals("bundled-one", state.selectedName)
        assertEquals("bundled-one", state.active?.name)
        assertEquals("Bundled helper", state.form.description)
        assertTrue("a live workspace allows project agents", state.canEditProject)

        // The same workspace is not fetched twice.
        viewModel.attach("/home/dev/projects/ompweb")
        assertEquals(1, api.listCalls.size)

        viewModel.setSearch("project")
        assertEquals(listOf("project-one"), viewModel.state.value.filtered.map { it.name })
    }

    @Test
    fun `reload keeps the open agent and falls back to the first one when it vanished`() {
        attach()
        viewModel.select("user-one")
        assertEquals("user-one", viewModel.state.value.selectedName)

        api.document = document(listOf(agent("user-one"), agent("new-one", scope = "user")))
        viewModel.reload()
        waitFor("the changed roster") { viewModel.state.value.agents.size == 2 }
        assertEquals("the still-present agent stays open", "user-one", viewModel.state.value.selectedName)
        assertEquals("user-one", viewModel.state.value.form.name)

        api.document = document(listOf(agent("new-one", scope = "user")))
        viewModel.reload()
        waitFor("the roster without the open agent") { viewModel.state.value.agents.map { it.name } == listOf("new-one") }
        assertEquals("new-one", viewModel.state.value.selectedName)
        assertFalse(viewModel.state.value.loading)
    }

    // ------------------------------------------------------------------ unpack

    @Test
    fun `unpack copies the templates into the project scope and reports the count`() {
        attach()
        api.unpackResult = AgentUnpackResult(total = 3, written = 3, skipped = 0)

        viewModel.unpack()

        waitFor("the refreshed roster") { api.listCalls.size == 2 && !viewModel.state.value.loading }
        assertEquals("Unpacked 3 agent(s).", viewModel.state.value.message)
        assertFalse(viewModel.state.value.messageIsError)
        assertEquals(listOf("/home/dev/projects/ompweb" to "project"), api.unpackCalls)
        assertFalse(viewModel.state.value.saving)
    }

    @Test
    fun `saving keeps the confirmation while the roster refreshes`() {
        attach()
        viewModel.select("user-one")

        viewModel.save()

        waitFor("the saved roster") { api.listCalls.size == 2 && !viewModel.state.value.loading }
        assertEquals("the confirmation survives the reload", "Agent saved.", viewModel.state.value.message)
        assertFalse(viewModel.state.value.messageIsError)
        assertEquals(listOf("user-one"), api.saveCalls)
    }

    @Test
    fun `a forbidden unpack marks the workspace unavailable instead of crashing`() {
        attach()
        api.unpackError = ApiError.Forbidden("workspace outside the allowed roots")

        viewModel.unpack()

        waitFor("the unpack failure") { viewModel.state.value.messageIsError }
        assertEquals("Not allowed", viewModel.state.value.message)
        assertTrue(viewModel.state.value.workspaceUnavailable)
        assertFalse(viewModel.state.value.saving)
    }

    // -------------------------------------------------------------- diagnostics

    @Test
    fun `scan errors are shown and become the message when no agent loads`() {
        api.document = AgentsDocument(
            agents = emptyList(),
            diagnostics = listOf(
                AgentDiagnostic(type = "error", message = "Agent file has no frontmatter", path = "/home/dev/.omp/agents/broken.md"),
                AgentDiagnostic(type = "warning", message = "Duplicate agent name", path = "/home/dev/.omp/agents/dup.md"),
            ),
        )

        viewModel.attach("/home/dev/projects/ompweb")

        waitFor("the scan diagnostics") { viewModel.state.value.diagnostics.size == 2 }
        val state = viewModel.state.value
        assertEquals(2, state.diagnostics.size)
        assertNull("no agent to open", state.active)
        assertEquals("Agent file has no frontmatter", state.message)
        assertTrue(state.messageIsError)
    }

    @Test
    fun `diagnostics stay listed next to a usable roster without an error banner`() {
        api.document = AgentsDocument(
            agents = listOf(agent("user-one")),
            diagnostics = listOf(AgentDiagnostic(type = "warning", message = "Skipped legacy file", path = "/legacy.md")),
        )

        viewModel.attach("/home/dev/projects/ompweb")

        waitFor("the roster") { viewModel.state.value.agents.size == 1 }
        val state = viewModel.state.value
        assertEquals(listOf("Skipped legacy file"), state.diagnostics.map { it.message })
        assertNull("a warning next to a usable roster is not an error banner", state.message)
        assertFalse(state.messageIsError)
    }

    // ------------------------------------------------------------ file path row

    @Test
    fun `the active agent exposes the absolute path the copy button reads`() {
        attach()

        viewModel.select("user-one")

        val active = viewModel.state.value.active!!
        assertEquals("/home/dev/.omp/agents/user-one.md", active.filePath)
        assertEquals("user-one", agentFileStem(active.filePath))
        assertEquals("/home/dev/.omp/agents/user-one.md", shortenAgentPath(active.filePath))
    }

    // ---------------------------------------------------------------- fixtures

    private fun agent(name: String, scope: String = "user") = AgentInfo(
        name = name,
        description = when (name) {
            "bundled-one" -> "Bundled helper"
            else -> "Agent $name"
        },
        scope = scope,
        filePath = if (scope == "bundled") "/home/dev/.omp/bundled/$name.md" else "/home/dev/.omp/agents/$name.md",
    )

    private fun document(agents: List<AgentInfo>) = AgentsDocument(agents = agents)

    private class FakeAgentsApi : AgentsApi {
        var document: AgentsDocument = AgentsDocument(
            agents = listOf(
                AgentInfo(name = "bundled-one", description = "Bundled helper", scope = "bundled", filePath = "/home/dev/.omp/bundled/bundled-one.md"),
                AgentInfo(name = "user-one", description = "Agent user-one", scope = "user", filePath = "/home/dev/.omp/agents/user-one.md"),
                AgentInfo(name = "project-one", description = "Agent project-one", scope = "project", filePath = "/home/dev/projects/ompweb/.omp/agents/project-one.md"),
            ),
        )
        val listCalls = CopyOnWriteArrayList<String?>()
        val unpackCalls = CopyOnWriteArrayList<Pair<String?, String>>()
        val saveCalls = CopyOnWriteArrayList<String>()
        var unpackResult = AgentUnpackResult()
        var unpackError: Throwable? = null

        override suspend fun list(cwd: String?): AgentsDocument {
            listCalls += cwd
            return document
        }

        override suspend fun save(
            cwd: String?,
            scope: String,
            name: String,
            previousName: String?,
            agent: JsonObject,
            update: Boolean,
        ): AgentSaveResult {
            saveCalls += name
            return AgentSaveResult()
        }

        override suspend fun delete(cwd: String?, scope: String, name: String) =
            error("not used in this test")

        override suspend fun unpack(cwd: String?, scope: String): AgentUnpackResult {
            unpackCalls += cwd to scope
            unpackError?.let { throw it }
            return unpackResult
        }
    }
}
