package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.summarizeMcpServer
import io.github.kahme247.ompweb.net.McpLiveServer
import io.github.kahme247.ompweb.net.McpServerEntry
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsDivider
import io.github.kahme247.ompweb.ui.settings.SettingsLoading
import io.github.kahme247.ompweb.ui.settings.SettingsMessage
import io.github.kahme247.ompweb.ui.settings.SettingsSectionTitle
import io.github.kahme247.ompweb.ui.settings.SettingsTextArea
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** The MCP part of the Extensions tab (`components/McpConfig.tsx`). */
@Composable
fun McpSection(
    controller: McpController,
    state: McpState,
    cwd: String?,
    sessionId: String?,
) {
    val colors = LocalOmpColors.current
    val displayed = state.liveServers ?: state.inventory
    SettingsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SettingsSectionTitle(
                text = stringResource(R.string.native_mcp_configured),
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { controller.refresh(cwd, sessionId) },
                enabled = !state.loading,
            ) {
                Icon(
                    imageVector = Icons.Default.Refresh,
                    contentDescription = stringResource(R.string.native_mcp_refresh_live),
                )
            }
        }
        if (state.error != null) SettingsMessage(state.error, error = true)
        if (state.liveError != null) {
            Text(
                text = stringResource(R.string.native_mcp_live_unavailable, state.liveError),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        if (state.loading && displayed.isEmpty()) {
            SettingsLoading(stringResource(R.string.native_settings_loading))
        } else if (displayed.isEmpty()) {
            Text(
                text = stringResource(R.string.native_mcp_none),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textDim,
            )
        } else {
            for ((source, servers) in displayed.groupBy { it.source }) {
                Text(
                    text = source,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                )
                for (server in servers) {
                    McpLiveRow(server)
                }
            }
        }
    }

    if (cwd != null) {
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SettingsSectionTitle(
                    text = stringResource(R.string.native_mcp_project),
                    modifier = Modifier.weight(1f),
                )
                if (state.servers.isNotEmpty()) {
                    Text(
                        text = mcpCounts(state.servers),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textDim,
                    )
                }
            }
            if (state.path != null) {
                Text(
                    text = state.path,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = colors.textDim,
                )
            }
            if (state.servers.isEmpty()) {
                Text(
                    text = stringResource(R.string.native_mcp_no_servers),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textDim,
                )
            } else {
                for (server in state.servers) {
                    McpServerButton(
                        server = server,
                        selected = state.selected == server.name,
                        onClick = { controller.select(server.name) },
                    )
                }
            }
            TextButton(onClick = { controller.select(null) }) {
                Icon(Icons.Default.Add, contentDescription = null)
                Text(stringResource(R.string.native_mcp_add), modifier = Modifier.padding(start = 6.dp))
            }
            SettingsDivider()
            Text(
                text = if (state.adding) {
                    stringResource(R.string.native_mcp_add)
                } else {
                    state.editorName.ifBlank { stringResource(R.string.native_mcp_add) }
                },
                style = MaterialTheme.typography.titleSmall,
                color = colors.text,
            )
            OutlinedTextField(
                value = state.editorName,
                onValueChange = controller::setEditorName,
                label = { Text(stringResource(R.string.native_mcp_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                text = stringResource(R.string.native_mcp_config_json),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textMuted,
            )
            SettingsTextArea(
                value = state.editorText,
                onValueChange = controller::setEditorText,
                minLines = 8,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = { controller.check() },
                    enabled = !state.checking && !state.saving,
                ) {
                    Icon(Icons.Default.Check, contentDescription = null)
                    Text(stringResource(R.string.native_mcp_check), modifier = Modifier.padding(start = 6.dp))
                }
                Button(
                    onClick = { controller.save(cwd, sessionId) },
                    enabled = !state.saving && state.editorName.isNotBlank(),
                ) {
                    Text(
                        stringResource(
                            if (state.saving) R.string.native_settings_saving else R.string.native_mcp_save,
                        ),
                    )
                }
                if (state.selected != null) {
                    TextButton(
                        onClick = { controller.remove(cwd, sessionId) },
                        enabled = !state.saving,
                    ) {
                        Icon(Icons.Default.Delete, contentDescription = null)
                        Text(stringResource(R.string.native_mcp_remove), modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
            val message = state.message
            if (message != null) {
                SettingsMessage(text = message.text, error = message.error)
            }
        }
    } else {
        SettingsMessage(
            text = stringResource(R.string.native_settings_select_workspace),
            error = false,
        )
    }

    val user = state.user
    if (user != null) {
        SettingsCard {
            SettingsSectionTitle(stringResource(R.string.native_mcp_user_level, user.path))
            if (user.error != null) {
                SettingsMessage(text = user.error, error = true)
            } else {
                if (user.servers.isEmpty() && user.disabledServers.isEmpty()) {
                    Text(
                        text = stringResource(R.string.native_mcp_no_live),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textDim,
                    )
                }
                for (server in user.servers) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        StatusDot(active = server.valid && server.enabled)
                        Text(
                            text = server.name,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = colors.text,
                        )
                        Text(
                            text = "${if (server.enabled) stringResource(R.string.native_mcp_status_configured) else stringResource(R.string.native_mcp_status_disabled)} [${server.type}]",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textMuted,
                        )
                    }
                }
                for (name in user.disabledServers) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        StatusDot(active = false)
                        Text(
                            text = name,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = colors.textDim,
                        )
                        Text(
                            text = stringResource(R.string.native_mcp_status_disabled),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textDim,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun McpLiveRow(server: McpLiveServer) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(active = server.status == "connected")
        Text(
            text = server.name,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = if (server.status == "connected") colors.text else colors.textMuted,
        )
        Text(
            text = mcpStatusText(server.status, server.type),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textMuted,
        )
    }
}

@Composable
private fun McpServerButton(server: McpServerEntry, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    val summary = summarizeMcpServer(server.config)
    NativeListRow(selected = selected, onClick = onClick) {
        StatusDot(active = summary.valid && summary.enabled, error = !summary.valid)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = server.name,
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace,
                color = colors.text,
            )
            val details = buildList {
                add(summary.type)
                if (!summary.enabled) add(stringResource(R.string.native_mcp_status_off))
                if (!summary.valid) add(stringResource(R.string.native_mcp_status_invalid))
                if (summary.target.isNotEmpty()) add(summary.target)
            }.joinToString(" · ")
            Text(
                text = details,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
    }
}

@Composable
private fun StatusDot(active: Boolean, error: Boolean = false) {
    val colors = LocalOmpColors.current
    Box(
        modifier = Modifier
            .size(6.dp)
            .background(
                color = when {
                    error -> colors.statusError
                    active -> colors.accent
                    else -> colors.border
                },
                shape = CircleShape,
            ),
    )
}

@Composable
private fun mcpStatusText(status: String, type: String?): String {
    val label = when (status) {
        "connected" -> stringResource(R.string.native_mcp_status_connected)
        "connecting" -> stringResource(R.string.native_mcp_status_connecting)
        "disabled" -> stringResource(R.string.native_mcp_status_disabled)
        "configured" -> stringResource(R.string.native_mcp_status_configured)
        else -> stringResource(R.string.native_mcp_status_not_connected)
    }
    return if (type != null) "$label [$type]" else label
}

@Composable
private fun mcpCounts(servers: List<McpServerEntry>): String {
    val summaries = servers.map { summarizeMcpServer(it.config) }
    val enabled = summaries.count { it.valid && it.enabled }
    val invalid = summaries.count { !it.valid }
    val base = stringResource(R.string.native_mcp_counts, enabled, servers.size)
    return if (invalid > 0) base + stringResource(R.string.native_mcp_invalid_suffix, invalid) else base
}
