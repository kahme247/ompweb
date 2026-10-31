package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The skill-resolution report omp publishes in `get_state.skillDiagnostics`
 * and pushes as `skill_diagnostics_update` (web `lib/skill-diagnostics.ts`).
 *
 * The parser is allowlisted and all-or-nothing: one malformed entry rejects
 * the snapshot, because a half-rendered report would name the wrong skill as
 * the winner. Both the server and the UI treat `null` as "unavailable".
 */
data class SkillEntry(
    val name: String,
    val filePath: String,
    val source: String,
    val pluginName: String? = null,
)

data class SkillDuplicate(
    val skill: SkillEntry,
    val retained: SkillEntry,
)

/** Why a skill name resolved the way it did (wire values are omp's). */
enum class SkillDiagnosticReason(val wireName: String) {
    SOURCE_ORDER("source-order"),
    CUSTOM_DIRECTORY("custom-directory"),
    AUTHORED_OVER_INSTALLED("authored-over-installed"),
    ;

    companion object {
        fun fromWire(value: String?): SkillDiagnosticReason? =
            entries.firstOrNull { it.wireName == value }
    }
}

data class SkillDiagnostic(
    val name: String,
    val reason: SkillDiagnosticReason,
    val skills: List<SkillEntry>,
    val duplicates: List<SkillDuplicate>,
)

data class SkillDiagnosticsSnapshot(
    val cwd: String,
    val showStartupDiagnostics: Boolean,
    val diagnostics: List<SkillDiagnostic>,
) {
    /** Names with more than one candidate, i.e. what the notice calls conflicts. */
    val conflictCount: Int
        get() = diagnostics.count { it.skills.size > 1 }

    val duplicateCount: Int
        get() = diagnostics.sumOf { it.duplicates.size }
}

/** Parse one report; `null` when the payload is absent or not exactly the shape omp documents. */
fun parseSkillDiagnosticsSnapshot(element: JsonElement?): SkillDiagnosticsSnapshot? {
    val root = element as? JsonObject ?: return null
    val cwd = (root["cwd"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val showStartup = (root["showStartupDiagnostics"] as? JsonPrimitive)?.booleanOrNull ?: return null
    val rawDiagnostics = root["diagnostics"] as? JsonArray ?: return null
    val diagnostics = ArrayList<SkillDiagnostic>(rawDiagnostics.size)
    for (raw in rawDiagnostics) {
        diagnostics += parseDiagnostic(raw) ?: return null
    }
    return SkillDiagnosticsSnapshot(
        cwd = cwd,
        showStartupDiagnostics = showStartup,
        diagnostics = diagnostics,
    )
}

private fun parseDiagnostic(element: JsonElement): SkillDiagnostic? {
    val root = element as? JsonObject ?: return null
    val name = (root["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val reason = SkillDiagnosticReason.fromWire(
        (root["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
    ) ?: return null
    val rawSkills = root["skills"] as? JsonArray ?: return null
    val skills = ArrayList<SkillEntry>(rawSkills.size)
    for (rawSkill in rawSkills) {
        skills += parseEntry(rawSkill) ?: return null
    }
    val rawDuplicates = root["duplicates"] as? JsonArray ?: return null
    val duplicates = ArrayList<SkillDuplicate>(rawDuplicates.size)
    for (rawDuplicate in rawDuplicates) {
        val pair = rawDuplicate as? JsonObject ?: return null
        duplicates += SkillDuplicate(
            skill = parseEntry(pair["skill"] ?: return null) ?: return null,
            retained = parseEntry(pair["retained"] ?: return null) ?: return null,
        )
    }
    return SkillDiagnostic(name = name, reason = reason, skills = skills, duplicates = duplicates)
}

private fun parseEntry(element: JsonElement): SkillEntry? {
    val root = element as? JsonObject ?: return null
    val name = (root["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val filePath = (root["filePath"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val source = (root["source"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val rawPlugin = root["pluginName"]
    val pluginName = if (rawPlugin == null) {
        null
    } else {
        (rawPlugin as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    }
    return SkillEntry(name = name, filePath = filePath, source = source, pluginName = pluginName)
}
