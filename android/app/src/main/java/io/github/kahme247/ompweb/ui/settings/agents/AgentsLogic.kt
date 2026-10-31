package io.github.kahme247.ompweb.ui.settings.agents

import io.github.kahme247.ompweb.domain.OMP_RESOURCE_NAME_RE
import io.github.kahme247.ompweb.net.AgentInfo
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pure rules of the Agents tab, ported from `components/AgentsConfig.tsx` and
 * `lib/omp/agents-service.ts`.
 *
 * The editor never sends YAML: the route takes the compact payload below and
 * rewrites the frontmatter, preserving unknown keys through
 * `existingFrontmatter`.
 */

/** `THINKING_LEVELS` of the agents service; the empty string means "default". */
val AGENT_THINKING_LEVELS: List<String> =
    listOf("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max")

/** The editable fields of one agent, mirroring the web form's state. */
data class AgentDraft(
    val name: String = "",
    val description: String = "",
    val modelCsv: String = "",
    val toolsCsv: String = "",
    val spawnsCsv: String = "",
    val thinkingLevel: String = "",
    val body: String = "",
) {
    companion object {
        fun from(agent: AgentInfo): AgentDraft = AgentDraft(
            name = agent.name,
            description = agent.description,
            modelCsv = joinAgentCsv(agent.model),
            toolsCsv = joinAgentCsv(agent.tools),
            spawnsCsv = if (agent.spawnsAll) "*" else joinAgentCsv(agent.spawns),
            thinkingLevel = agent.thinkingLevel.orEmpty(),
            body = agent.body.orEmpty(),
        )
    }
}

enum class AgentValidation { OK, NAME_REQUIRED, NAME_PATTERN, DESCRIPTION_REQUIRED }

/** `splitCsv`: trims, drops empties and keeps the user's order. */
fun splitAgentCsv(raw: String): List<String> =
    raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }

fun joinAgentCsv(values: List<String>?): String =
    values.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }.joinToString(", ")

/** The file stem the DELETE and `previousName` fields need (web `fileStem`). */
fun agentFileStem(filePath: String): String {
    val normalized = filePath.replace('\\', '/')
    val fileName = normalized.substringAfterLast('/')
    return if (fileName.lowercase().endsWith(".md")) fileName.dropLast(3) else fileName
}

/** Case-insensitive name/description search (web `filtered`). */
fun filterAgents(agents: List<AgentInfo>, query: String): List<AgentInfo> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return agents
    return agents.filter {
        it.name.lowercase().contains(needle) || it.description.lowercase().contains(needle)
    }
}

fun validateAgentDraft(name: String, description: String): AgentValidation {
    val trimmedName = name.trim()
    if (trimmedName.isEmpty()) return AgentValidation.NAME_REQUIRED
    if (!OMP_RESOURCE_NAME_RE.matches(trimmedName)) return AgentValidation.NAME_PATTERN
    if (description.trim().isEmpty()) return AgentValidation.DESCRIPTION_REQUIRED
    return AgentValidation.OK
}

/**
 * The `agent` object of `POST/PUT /api/agents` (web `save()` payload).
 *
 * Empty fields are omitted, never sent as empty arrays; `spawns` accepts the
 * literal `*`. [existingFrontmatter] is only sent for an edit so the service
 * can preserve keys this editor does not expose.
 */
fun buildAgentPayload(
    draft: AgentDraft,
    existingFrontmatter: JsonObject? = null,
): JsonObject = buildJsonObject {
    put("description", draft.description.trim())
    draft.body.takeIf { it.isNotEmpty() }?.let { put("body", it) }
    existingFrontmatter?.let { put("existingFrontmatter", it) }
    splitAgentCsv(draft.modelCsv).takeIf { it.isNotEmpty() }?.let { values ->
        put("model", buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
    }
    splitAgentCsv(draft.toolsCsv).takeIf { it.isNotEmpty() }?.let { values ->
        put("tools", buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
    }
    val spawns = draft.spawnsCsv.trim()
    if (spawns.isNotEmpty()) {
        if (spawns == "*") {
            put("spawns", "*")
        } else {
            put("spawns", buildJsonArray { splitAgentCsv(spawns).forEach { add(JsonPrimitive(it)) } })
        }
    }
    draft.thinkingLevel.trim().takeIf { it.isNotEmpty() }?.let { put("thinkingLevel", it) }
}

/** Scopes the editor can write (`bundled` is read-only). */
fun agentWritableScopes(canEditProject: Boolean): List<String> =
    if (canEditProject) listOf("project", "user") else listOf("user")

/** `AgentInfo.scope` for a save: a new agent uses the form's choice, an edit keeps its scope. */
fun agentSaveScope(creating: Boolean, active: AgentInfo?, chosen: String, canEditProject: Boolean): String {
    if (creating) return if (chosen == "project" && canEditProject) "project" else "user"
    val existing = active?.scope
    if (existing == "user" || existing == "project") return existing
    return if (canEditProject) "project" else "user"
}

/** Counts used by the roster header (`countsSummary`). */
data class AgentCounts(val total: Int, val bundled: Int, val user: Int, val project: Int) {
    companion object {
        fun of(agents: List<AgentInfo>): AgentCounts = AgentCounts(
            total = agents.size,
            bundled = agents.count { it.isBundled },
            user = agents.count { !it.isBundled && it.scope == "user" },
            project = agents.count { !it.isBundled && it.scope == "project" },
        )
    }
}

/** Shortens a long path from the left for the file row (web `shorten`). */
fun shortenAgentPath(path: String, max: Int = 48): String =
    if (path.length <= max) path else "…" + path.takeLast(max - 1)
