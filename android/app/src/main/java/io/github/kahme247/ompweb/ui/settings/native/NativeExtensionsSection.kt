package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.settings.NativeSettingsViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsNotAvailable

/**
 * Extensions tab: native MCP toggles (only with a workspace, matching the web)
 * plus the MCP, Skills and Plugins panels.
 */
@Composable
fun NativeExtensionsSection(
    viewModel: NativeSettingsViewModel,
    cwd: String?,
    sessionId: String?,
    highlight: String?,
) {
    val settings by viewModel.settings.state.collectAsState()
    val mcp by viewModel.mcp.state.collectAsState()
    val skills by viewModel.skills.state.collectAsState()
    val plugins by viewModel.plugins.state.collectAsState()
    val document = settings.document
    val enabled = settings.loaded

    NativeSettingsStatus(settings, onRetry = { viewModel.settings.load(force = true) })

    if (cwd != null) {
        SettingsCard {
            NativeToggleRow(
                id = "load-project-mcp-servers",
                highlight = highlight,
                title = stringResource(R.string.native_mcp_project_config),
                description = stringResource(R.string.native_mcp_project_config_desc),
                checked = document.mcpProjectConfig(),
                enabled = enabled,
                onCheckedChange = { checked ->
                    viewModel.settings.edit { it.withSectionBool("mcp", "enableProjectConfig", checked) }
                },
            )
            NativeToggleRow(
                id = "render-mcp-markdown",
                highlight = highlight,
                title = stringResource(R.string.native_mcp_render_markdown),
                description = stringResource(R.string.native_mcp_render_markdown_desc),
                checked = document.mcpRenderMarkdown(),
                enabled = enabled,
                onCheckedChange = { checked ->
                    viewModel.settings.edit { it.withSectionBool("mcp", "renderMarkdownResults", checked) }
                },
            )
            NativeToggleRow(
                id = "mcp-resource-updates",
                highlight = highlight,
                title = stringResource(R.string.native_mcp_resource_updates),
                description = stringResource(R.string.native_mcp_resource_updates_desc),
                checked = document.mcpNotifications(),
                enabled = enabled,
                onCheckedChange = { checked ->
                    viewModel.settings.edit { it.withSectionBool("mcp", "notifications", checked) }
                },
            )
        }
    }

    LaunchedEffect(cwd, sessionId) { viewModel.mcp.load(cwd, sessionId) }
    LaunchedEffect(cwd) {
        if (cwd != null) {
            viewModel.skills.load(cwd)
            viewModel.plugins.load(cwd)
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HighlightedBlock(id = "mcp-servers", highlight = highlight) {
            McpSection(controller = viewModel.mcp, state = mcp, cwd = cwd, sessionId = sessionId)
        }
        HighlightedBlock(id = "skills", highlight = highlight) {
            if (cwd == null) {
                SettingsNotAvailable(stringResource(R.string.native_settings_select_workspace))
            } else {
                SkillsSection(controller = viewModel.skills, state = skills, cwd = cwd)
            }
        }
        HighlightedBlock(id = "plugins", highlight = highlight) {
            if (cwd == null) {
                SettingsNotAvailable(stringResource(R.string.native_settings_select_workspace))
            } else {
                PluginsSection(
                    controller = viewModel.plugins,
                    state = plugins,
                    cwd = cwd,
                    sessionId = sessionId,
                )
            }
        }
    }
}
