package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NativeCategory
import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.domain.SettingsSearchEntry
import io.github.kahme247.ompweb.domain.SettingsTab
import io.github.kahme247.ompweb.ui.settings.LocalNativeSettingsDependencies
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The native OMP rows of one settings tab (Slice B). Content only: the shell
 * owns the page title and scrolling.
 *
 * [cwd] is the selected project workspace; the Extensions tab needs it for
 * project MCP servers, skills and plugins (user-level MCP data still loads
 * without one). [highlight] is a search entry id; the matching row or block is
 * scrolled into view and outlined.
 */
@Composable
fun NativeSettingsTab(
    category: NativeCategory,
    cwd: String?,
    highlight: String? = null,
    modifier: Modifier = Modifier,
) {
    val dependencies = LocalNativeSettingsDependencies.current
    if (dependencies == null) {
        Text(
            text = stringResource(R.string.native_settings_unavailable),
            style = MaterialTheme.typography.bodyMedium,
            color = LocalOmpColors.current.textMuted,
            modifier = modifier,
        )
        return
    }
    val viewModel = dependencies.viewModel
    LaunchedEffect(Unit) { viewModel.settings.load() }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (category) {
            NativeCategory.GENERAL -> NativeGeneralSection(viewModel, highlight)
            NativeCategory.SAFETY -> NativeSafetySection(viewModel, highlight)
            NativeCategory.MODELS -> NativeModelsSection(viewModel, highlight)
            NativeCategory.INTELLIGENCE -> NativeIntelligenceSection(viewModel, highlight)
            NativeCategory.EXTENSIONS -> NativeExtensionsSection(
                viewModel = viewModel,
                cwd = cwd,
                sessionId = dependencies.sessionId,
                highlight = highlight,
            )
        }
    }
}

/** Search index entries for the native rows (Slice A merges them by id). */
fun nativeSettingsSearchEntries(): List<SettingsSearchEntry> = listOf(
    entry("skill-startup-notices", SettingsTab.GENERAL, "Interface & Behavior", "Skill startup notices", "Show conflicts and redundant skill copies when an OMP session starts."),
    entry("approval-mode", SettingsTab.SAFETY, "Tool Safety & Approvals", "Approval Mode", "Choose when OMP asks before tool calls."),
    entry("bash-override", SettingsTab.SAFETY, "Tool Safety & Approvals", "Bash Override", "Override default approval policy specifically for terminal commands."),
    entry("extension-tool-requests", SettingsTab.SAFETY, "Tool Safety & Approvals", "Extension Tool Requests", "Automatically approve extension tool authorization requests."),
    entry("reasoning", SettingsTab.MODELS, "AI Model Defaults", "Reasoning", "Default effort level for thinking-capable models."),
    entry("auto-thinking-source", SettingsTab.MODELS, "AI Model Defaults", "Auto Thinking Source", "How automatic reasoning effort is chosen."),
    entry("verbosity", SettingsTab.MODELS, "AI Model Defaults", "Verbosity", "Response detail level for supporting providers."),
    entry("personality", SettingsTab.MODELS, "AI Model Defaults", "Personality", "Style included in OMP's system prompt."),
    entry("thinking-blocks", SettingsTab.MODELS, "AI Model Defaults", "Hide Thinking Blocks", "Hide model reasoning from output view."),
    entry("external-thinking", SettingsTab.MODELS, "AI Model Defaults", "External Thinking", "Private scratchpad reasoning via think tool."),
    entry("automatic-compaction", SettingsTab.INTELLIGENCE, "Context Compaction", "Automatic Compaction", "Compact context before model context limit is hit."),
    entry("continue-after-compaction", SettingsTab.INTELLIGENCE, "Context Compaction", "Continue After Compaction", "Resume task execution after compaction completes."),
    entry("compaction-method-order", SettingsTab.INTELLIGENCE, "Context Compaction", "Compaction Method Order", "Preferred fallback order for automatic context maintenance."),
    entry("compact-mid-turn", SettingsTab.INTELLIGENCE, "Context Compaction", "Compact Mid-Turn", "Check context limits between tool execution steps."),
    entry("memory-backend", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Memory Backend", "Where durable knowledge is stored across sessions."),
    entry("enable-auto-learn", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Enable Auto-Learn", "Capture reusable lessons after completed runs."),
    entry("private-capture-turn", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Private Capture Turn", "Run private lesson-capture turn at completion."),
    entry("memory-scope", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Memory Scope", "Scoping for Mnemopi knowledge storage."),
    entry("recall-on-session-start", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Recall on Session Start", "Load relevant memories into first turn."),
    entry("retain-completed-turns", SettingsTab.INTELLIGENCE, "Memory & Auto-Learn", "Retain Completed Turns", "Store completed conversation turns in memory."),
    entry("automatic-retry", SettingsTab.INTELLIGENCE, "Automatic Retry", "Automatic Retry", "Retry failed turns automatically."),
    entry("max-attempts", SettingsTab.INTELLIGENCE, "Automatic Retry", "Max Attempts", "Retry limit before giving up."),
    entry("model-fallback", SettingsTab.INTELLIGENCE, "Automatic Retry", "Model Fallback", "Fall back to alternative model when retries exhaust."),
    entry("load-project-mcp-servers", SettingsTab.MCP, "Extensions & Tools", "Load Project MCP Servers", "Allow project-root MCP configuration to be discovered."),
    entry("render-mcp-markdown", SettingsTab.MCP, "Extensions & Tools", "Render MCP Markdown", "Render non-JSON MCP results as Markdown in transcript."),
    entry("mcp-resource-updates", SettingsTab.MCP, "Extensions & Tools", "MCP Resource Updates", "Inject server resource updates into conversation."),
    entry("mcp-servers", SettingsTab.MCP, "Extensions & Tools", "MCP servers", "Configure Model Context Protocol servers from the project and user level."),
    entry("skills", SettingsTab.MCP, "Extensions & Tools", "Skills", "Manage skill folders, model visibility and skills.sh installs."),
    entry("plugins", SettingsTab.MCP, "Extensions & Tools", "Plugins", "Install, update and remove OMP plugin packages."),
)

private fun entry(
    id: String,
    tab: SettingsTab,
    section: String,
    label: String,
    description: String,
): SettingsSearchEntry = SettingsSearchEntry(
    id = id,
    tab = tab,
    section = section,
    label = label,
    description = description,
    scope = SettingsScope.NATIVE_OMP,
)
