package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.AgentInfo
import io.github.kahme247.ompweb.ui.settings.agents.AGENT_THINKING_LEVELS
import io.github.kahme247.ompweb.ui.settings.agents.AgentCounts
import io.github.kahme247.ompweb.ui.settings.agents.AgentDraft
import io.github.kahme247.ompweb.ui.settings.agents.AgentValidation
import io.github.kahme247.ompweb.ui.settings.agents.agentFileStem
import io.github.kahme247.ompweb.ui.settings.agents.agentSaveScope
import io.github.kahme247.ompweb.ui.settings.agents.agentWritableScopes
import io.github.kahme247.ompweb.ui.settings.agents.buildAgentPayload
import io.github.kahme247.ompweb.ui.settings.agents.filterAgents
import io.github.kahme247.ompweb.ui.settings.agents.joinAgentCsv
import io.github.kahme247.ompweb.ui.settings.agents.shortenAgentPath
import io.github.kahme247.ompweb.ui.settings.agents.splitAgentCsv
import io.github.kahme247.ompweb.ui.settings.agents.validateAgentDraft
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors `AgentsConfig.tsx` helpers and `agents-service.ts` payload rules. */
class AgentsLogicTest {

    @Test
    fun `agent names follow the service regex`() {
        assertTrue(OMP_RESOURCE_NAME_RE.matches("designer"))
        assertTrue(OMP_RESOURCE_NAME_RE.matches("a"))
        assertTrue(OMP_RESOURCE_NAME_RE.matches("Review_2.0-beta"))
        assertFalse(OMP_RESOURCE_NAME_RE.matches(""))
        assertFalse(OMP_RESOURCE_NAME_RE.matches("-leading"))
        assertFalse(OMP_RESOURCE_NAME_RE.matches(".hidden"))
        assertFalse(OMP_RESOURCE_NAME_RE.matches("a/b"))
        assertFalse(OMP_RESOURCE_NAME_RE.matches("a".repeat(129)))
        assertTrue(OMP_RESOURCE_NAME_RE.matches("a".repeat(128)))
    }

    @Test
    fun `csv helpers trim and drop empties but keep order`() {
        assertEquals(listOf("a", "b", "c"), splitAgentCsv(" a , b,,c "))
        assertEquals(emptyList<String>(), splitAgentCsv("   "))
        assertEquals("a, b", joinAgentCsv(listOf(" a ", "b", "")))
        assertEquals("", joinAgentCsv(null))
    }

    @Test
    fun `file stems work with windows and unix paths`() {
        assertEquals("designer", agentFileStem("C:\\Users\\me\\.omp\\agents\\designer.md"))
        assertEquals("designer", agentFileStem("/home/me/.omp/agents/designer.md"))
        assertEquals("UPPER", agentFileStem("/a/UPPER.MD"))
        assertEquals("noext", agentFileStem("/a/noext"))
    }

    @Test
    fun `search matches name and description case-insensitively`() {
        val agents = listOf(
            AgentInfo(name = "designer", description = "UI specialist"),
            AgentInfo(name = "reviewer", description = "Reads diffs"),
        )
        assertEquals(listOf("designer"), filterAgents(agents, "UI").map { it.name })
        assertEquals(listOf("reviewer"), filterAgents(agents, "REVIEW").map { it.name })
        assertEquals(2, filterAgents(agents, "   ").size)
        assertEquals(0, filterAgents(agents, "nope").size)
    }

    @Test
    fun `draft validation reports the first problem`() {
        assertEquals(AgentValidation.NAME_REQUIRED, validateAgentDraft("  ", "desc"))
        assertEquals(AgentValidation.NAME_PATTERN, validateAgentDraft("-bad", "desc"))
        assertEquals(AgentValidation.DESCRIPTION_REQUIRED, validateAgentDraft("ok", "  "))
        assertEquals(AgentValidation.OK, validateAgentDraft(" ok ", "desc"))
    }

    @Test
    fun `payload mirrors the web save body`() {
        val draft = AgentDraft(
            name = "designer",
            description = "  UI specialist  ",
            modelCsv = "@designer, @smol",
            toolsCsv = "read, edit",
            spawnsCsv = "task",
            thinkingLevel = "high",
            body = "You design UIs.",
        )
        val frontmatter = Json.parseToJsonElement("""{"prewalk":true,"enabled":false}""").jsonObject
        val payload = buildAgentPayload(draft, existingFrontmatter = frontmatter)
        assertEquals("UI specialist", (payload["description"] as JsonPrimitive).content)
        assertEquals("You design UIs.", (payload["body"] as JsonPrimitive).content)
        assertEquals(
            listOf("@designer", "@smol"),
            (payload["model"] as JsonArray).map { (it as JsonPrimitive).content },
        )
        assertEquals(listOf("read", "edit"), (payload["tools"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals(listOf("task"), (payload["spawns"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals("high", (payload["thinkingLevel"] as JsonPrimitive).content)
        assertEquals(frontmatter, payload["existingFrontmatter"])
    }

    @Test
    fun `payload omits empty fields and keeps the spawns star`() {
        val payload = buildAgentPayload(AgentDraft(name = "a", description = "d", spawnsCsv = " * "))
        assertEquals(setOf("description", "spawns"), payload.keys)
        assertEquals("*", (payload["spawns"] as JsonPrimitive).content)
        assertNull(payload["body"])
        assertNull(payload["existingFrontmatter"])
        assertNull(payload["model"])
        assertNull(payload["tools"])
        assertNull(payload["thinkingLevel"])

        val built = buildJsonObject { put("description", "d") }
        assertEquals(built, buildAgentPayload(AgentDraft(description = "d")))
    }

    @Test
    fun `a saved agent fills the form back`() {
        val agent = AgentInfo(
            name = "designer",
            description = "UI",
            model = listOf("@designer"),
            tools = listOf("read"),
            spawnsAll = true,
            thinkingLevel = "low",
            body = "Body",
        )
        val draft = AgentDraft.from(agent)
        assertEquals("@designer", draft.modelCsv)
        assertEquals("read", draft.toolsCsv)
        assertEquals("*", draft.spawnsCsv)
        assertEquals("low", draft.thinkingLevel)
        assertEquals("Body", draft.body)
    }

    @Test
    fun `save scope never writes bundled and edits keep their scope`() {
        assertEquals(listOf("project", "user"), agentWritableScopes(canEditProject = true))
        assertEquals(listOf("user"), agentWritableScopes(canEditProject = false))

        assertEquals("project", agentSaveScope(creating = true, active = null, chosen = "project", canEditProject = true))
        assertEquals("user", agentSaveScope(creating = true, active = null, chosen = "project", canEditProject = false))
        assertEquals(
            "user",
            agentSaveScope(creating = false, active = AgentInfo(name = "u", scope = "user"), chosen = "project", canEditProject = true),
        )
        assertEquals(
            "project",
            agentSaveScope(creating = false, active = AgentInfo(name = "p", scope = "project"), chosen = "user", canEditProject = true),
        )
        assertEquals(
            "project",
            agentSaveScope(creating = false, active = AgentInfo(name = "b", scope = "bundled"), chosen = "user", canEditProject = true),
        )
        assertEquals(
            "user",
            agentSaveScope(creating = false, active = AgentInfo(name = "b", scope = "bundled"), chosen = "project", canEditProject = false),
        )
    }

    @Test
    fun `counts split bundled, user and project agents`() {
        val counts = AgentCounts.of(
            listOf(
                AgentInfo(name = "a", source = "bundled", scope = "bundled"),
                AgentInfo(name = "b", source = "user", scope = "user"),
                AgentInfo(name = "c", source = "project", scope = "project"),
                AgentInfo(name = "d", source = "project", scope = "project"),
            ),
        )
        assertEquals(AgentCounts(total = 4, bundled = 1, user = 1, project = 2), counts)
    }

    @Test
    fun `long paths are shortened from the left`() {
        val path = "/home/user/.omp/agents/" + "x".repeat(40) + ".md"
        val shortened = shortenAgentPath(path)
        assertEquals(48, shortened.length)
        assertTrue(shortened.startsWith("…"))
        assertTrue(shortened.endsWith(".md"))
        assertEquals("short", shortenAgentPath("short"))
    }

    @Test
    fun `thinking levels list matches the service`() {
        assertEquals(
            listOf("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"),
            AGENT_THINKING_LEVELS,
        )
    }
}
