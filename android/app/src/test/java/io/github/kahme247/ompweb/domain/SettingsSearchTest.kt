package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsSearchTest {

    // ------------------------------------------------------------- search

    private val entries = listOf(
        SettingsSearchEntry(
            "completion-sound",
            SettingsTab.GENERAL,
            "Interface & Behavior",
            "Completion sound",
            "Play a tone when the agent completes a run.",
            SettingsScope.UI,
        ),
        SettingsSearchEntry(
            "approval-mode",
            SettingsTab.SAFETY,
            "Tool Safety & Approvals",
            "Approval Mode",
            "Choose when OMP asks before tool calls.",
            SettingsScope.NATIVE_OMP,
        ),
        SettingsSearchEntry(
            "mcp-servers",
            SettingsTab.MCP,
            "Extensions & Tools",
            "MCP servers",
            "Manage Model Context Protocol servers.",
            SettingsScope.WORKSPACE,
        ),
    )

    /** Mirrors `strings_settings.xml`; the UI builds these at runtime. */
    private val categories = listOf(
        SettingsCategory(SettingsTab.GENERAL, "Interface & Behavior", "UI preferences, completion sound, submission mode"),
        SettingsCategory(SettingsTab.SAFETY, "Safety & Approvals", "Tool safety rules, YOLO mode, terminal permissions"),
        SettingsCategory(SettingsTab.MODELS, "AI Model Defaults", "Reasoning budget, verbosity, personality, scratchpad"),
        SettingsCategory(SettingsTab.PROVIDERS, "API Keys & Providers", "Connected OAuth accounts, API keys, and model registry"),
        SettingsCategory(SettingsTab.USAGE, "Usage", "Tokens, costs, cache analytics, and model breakdown"),
        SettingsCategory(SettingsTab.INTELLIGENCE, "Agent & Intelligence", "Advisor, memory, autolearn, compaction and retry"),
        SettingsCategory(SettingsTab.AGENTS, "Agents", "Task agents, model settings, and tool policy"),
        SettingsCategory(SettingsTab.MCP, "Extensions & Tools", "MCP servers, managed skills, and OMP plugins"),
        SettingsCategory(SettingsTab.NOTIFICATIONS, "Notifications", "Desktop and mobile notifications for your sessions"),
        SettingsCategory(SettingsTab.SYSTEM, "System & Updates", "App updates, runtime version, and active session restart"),
    )

    @Test
    fun `search is case insensitive over label description and section`() {
        assertEquals(listOf("completion-sound"), searchSettings("COMPLETION", entries).map { it.id })
        assertEquals(listOf("completion-sound"), searchSettings("tone", entries).map { it.id })
        assertEquals(listOf("approval-mode"), searchSettings("tool safety", entries).map { it.id })
        assertTrue(searchSettings("   ", entries).isEmpty())
        assertTrue(searchSettings("nothing-matches", entries).isEmpty())
    }

    @Test
    fun `category search matches the sidebar labels`() {
        assertEquals(listOf(SettingsTab.GENERAL), searchSettingsCategories("interface", categories).map { it.tab })
        assertEquals(listOf(SettingsTab.NOTIFICATIONS), searchSettingsCategories("notifications", categories).map { it.tab })
        assertTrue(searchSettingsCategories("no category matches this", categories).isEmpty())
        assertEquals(listOf(SettingsTab.AGENTS), searchSettingsCategories("task agents", categories).map { it.tab })
        assertEquals(
            listOf(SettingsTab.PROVIDERS),
            searchSettingsCategories("api keys", categories).map { it.tab },
        )
    }

    @Test
    fun `phone layout shows a detail pane only with a tab or a query`() {
        assertTrue(settingsShowsDetail(wide = true, selected = null, query = ""))
        assertTrue(settingsShowsDetail(wide = false, selected = SettingsTab.SYSTEM, query = ""))
        assertTrue(settingsShowsDetail(wide = false, selected = null, query = "theme"))
        assertTrue(!settingsShowsDetail(wide = false, selected = null, query = ""))
    }

    @Test
    fun `merging slices drops duplicate ids and keeps the first`() {
        val extra = listOf(
            entries[0].copy(description = "duplicate from another slice"),
            entries[1].copy(scope = SettingsScope.NATIVE_OMP),
            SettingsSearchEntry(
                "skills",
                SettingsTab.MCP,
                "Extensions & Tools",
                "Skills",
                "Managed skills.",
                SettingsScope.WORKSPACE,
            ),
        )
        val merged = settingsSearchEntries(LOCAL_SETTINGS_SEARCH_ENTRIES, extra)
        assertEquals(merged.size, merged.map { it.id }.toSet().size)
        assertEquals(
            "Play a tone when the agent completes a run.",
            merged.firstOrNull { it.id == "completion-sound" }?.description,
        )
        assertNull(merged.firstOrNull { it.id == "does-not-exist" })
    }

    @Test
    fun `workspace-bound tabs are flagged for the shell`() {
        assertTrue(SettingsTab.AGENTS.needsWorkspace)
        assertTrue(!SettingsTab.MCP.needsWorkspace)
        assertTrue(!SettingsTab.GENERAL.needsWorkspace)
        assertTrue(!SettingsTab.SYSTEM.needsWorkspace)
        assertEquals(SettingsTab.MCP, SettingsTab.fromWire("mcp"))
        assertNull(SettingsTab.fromWire("extensions"))
    }

    @Test
    fun `the local index covers every tab slice A owns`() {
        val tabs = LOCAL_SETTINGS_SEARCH_ENTRIES.map { it.tab }.toSet()
        assertTrue(tabs.contains(SettingsTab.GENERAL))
        assertTrue(tabs.contains(SettingsTab.USAGE))
        assertTrue(tabs.contains(SettingsTab.NOTIFICATIONS))
        assertTrue(tabs.contains(SettingsTab.SYSTEM))
        assertEquals(
            "Settings rows must belong to a slice-A tab",
            emptyList<SettingsTab>(),
            tabs.filter { it in setOf(SettingsTab.SAFETY, SettingsTab.MODELS, SettingsTab.INTELLIGENCE, SettingsTab.AGENTS, SettingsTab.MCP, SettingsTab.PROVIDERS) },
        )
        assertTrue(LOCAL_SETTINGS_SEARCH_ENTRIES.none { it.id == "scope-native-select-all" })
        assertTrue(SETTINGS_CATEGORIES == SettingsTab.entries)
    }
}
