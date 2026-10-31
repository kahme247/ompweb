package io.github.kahme247.ompweb.ui.settings.agents

import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.domain.SettingsSearchEntry
import io.github.kahme247.ompweb.domain.SettingsTab

/**
 * Search rows of the Agents tab (web `SettingsConfig.tsx` index).
 * [SettingsSearchEntry.id] values are handled by `AgentsViewModel.applyHighlight`.
 */
fun agentsSearchEntries(): List<SettingsSearchEntry> = listOf(
    SettingsSearchEntry(
        id = "agent-roster",
        tab = SettingsTab.AGENTS,
        section = "Agents",
        label = "Agent roster",
        description = "Agents omp finds: bundled templates, user agents and project agents",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "agent-model",
        tab = SettingsTab.AGENTS,
        section = "Agents",
        label = "Agent model roles",
        description = "Model role selectors such as @designer or @smol for a subagent",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "agent-tools",
        tab = SettingsTab.AGENTS,
        section = "Agents",
        label = "Agent tools and spawns",
        description = "Tools a subagent may call and which agents it can spawn",
        scope = SettingsScope.WORKSPACE,
    ),
    SettingsSearchEntry(
        id = "agent-scope",
        tab = SettingsTab.AGENTS,
        section = "Agents",
        label = "Agent scope",
        description = "Write an agent for this user or for the current workspace",
        scope = SettingsScope.WORKSPACE,
    ),
    SettingsSearchEntry(
        id = "agent-thinking",
        tab = SettingsTab.AGENTS,
        section = "Agents",
        label = "Agent thinking level",
        description = "Default reasoning effort for a subagent",
        scope = SettingsScope.NATIVE_OMP,
    ),
)
