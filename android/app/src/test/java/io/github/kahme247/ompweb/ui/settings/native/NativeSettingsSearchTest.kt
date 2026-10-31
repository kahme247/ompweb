package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.domain.SettingsTab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Guards the ids the shell's search uses to highlight native rows. */
class NativeSettingsSearchTest {

    private val entries = nativeSettingsSearchEntries()

    @Test
    fun `ids are unique`() {
        assertEquals(entries.size, entries.map { it.id }.distinct().size)
    }

    @Test
    fun `every native entry is tagged native omp`() {
        assertTrue(entries.all { it.scope == SettingsScope.NATIVE_OMP })
    }

    @Test
    fun `all native tabs are indexed`() {
        val tabs = entries.map { it.tab }.toSet()
        assertEquals(
            setOf(
                SettingsTab.GENERAL,
                SettingsTab.SAFETY,
                SettingsTab.MODELS,
                SettingsTab.INTELLIGENCE,
                SettingsTab.MCP,
            ),
            tabs,
        )
    }

    @Test
    fun `web highlight ids are indexed`() {
        val webIds = listOf(
            "skill-startup-notices",
            "approval-mode",
            "bash-override",
            "extension-tool-requests",
            "reasoning",
            "auto-thinking-source",
            "verbosity",
            "personality",
            "thinking-blocks",
            "external-thinking",
            "automatic-compaction",
            "continue-after-compaction",
            "compaction-method-order",
            "compact-mid-turn",
            "memory-backend",
            "enable-auto-learn",
            "private-capture-turn",
            "memory-scope",
            "recall-on-session-start",
            "retain-completed-turns",
            "automatic-retry",
            "max-attempts",
            "model-fallback",
            "load-project-mcp-servers",
            "render-mcp-markdown",
            "mcp-resource-updates",
        )
        val ids = entries.map { it.id }
        assertTrue(webIds.filterNot(ids::contains).toString(), ids.containsAll(webIds))
    }
}
