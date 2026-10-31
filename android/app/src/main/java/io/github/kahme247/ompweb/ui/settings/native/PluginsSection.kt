package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.PluginAction
import io.github.kahme247.ompweb.net.PluginPackageInfo
import io.github.kahme247.ompweb.net.PluginResourceCounts
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsLoading
import io.github.kahme247.ompweb.ui.settings.SettingsMessage
import io.github.kahme247.ompweb.ui.settings.SettingsSectionTitle
import io.github.kahme247.ompweb.ui.settings.SettingsSelect
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** The Plugins panel of the Extensions tab (`components/PluginsConfig.tsx`). */
@Composable
fun PluginsSection(
    controller: PluginsController,
    state: PluginsState,
    cwd: String?,
    sessionId: String?,
) {
    val colors = LocalOmpColors.current
    if (state.notice != null) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SettingsMessage(
                text = state.notice,
                error = state.noticeError,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = controller::dismissNotice) {
                Text(stringResource(R.string.native_settings_dismiss))
            }
        }
    }
    SettingsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SettingsSectionTitle(
                text = stringResource(R.string.native_plugins_title),
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { cwd?.let(controller::refresh) }, enabled = cwd != null) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.native_plugins_refresh))
            }
            IconButton(onClick = controller::openAdd) {
                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.native_plugins_add))
            }
        }
        val snapshot = state.snapshot
        when {
            state.loading && snapshot == null -> SettingsLoading(stringResource(R.string.native_settings_loading))
            state.error != null -> SettingsMessage(text = state.error, error = true)
            snapshot == null || snapshot.packages.isEmpty() -> Text(
                text = stringResource(R.string.native_plugins_none),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textDim,
            )
            else -> {
                for (scope in listOf("project", "global")) {
                    val packages = snapshot.packages.filter { it.scope == scope }
                    if (packages.isEmpty()) continue
                    Text(
                        text = stringResource(
                            if (scope == "project") R.string.native_plugins_scope_project
                            else R.string.native_plugins_scope_global,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textMuted,
                    )
                    for (plugin in packages) {
                        PluginRow(
                            plugin = plugin,
                            selected = state.selected == plugin.source,
                            onClick = { controller.select(plugin.source) },
                        )
                    }
                }
                val diagnostics = snapshot.diagnostics
                if (diagnostics.isNotEmpty()) {
                    Text(
                        text = stringResource(
                            if (diagnostics.size == 1) R.string.native_plugins_diagnostic
                            else R.string.native_plugins_diagnostics,
                            diagnostics.size,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.statusWarning,
                    )
                    for (diagnostic in diagnostics) {
                        Text(
                            text = "${diagnostic.type}: ${diagnostic.message}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (diagnostic.type == "error") colors.statusError else colors.textMuted,
                        )
                    }
                }
            }
        }
    }

    val selected = state.selectedPackage
    if (selected != null) {
        var confirming by remember(selected.source) { mutableStateOf(false) }
        SettingsCard {
            SettingsSectionTitle(selected.packageName ?: selected.source)
            PluginFact(stringResource(R.string.native_plugins_source), selected.source)
            if (selected.packageName != null) {
                PluginFact(stringResource(R.string.native_plugins_package), selected.packageName)
            }
            val version = selected.version ?: stringResource(R.string.native_plugins_unknown)
            val versionText = buildString {
                append(version)
                if (selected.configuredVersion != null && selected.configuredVersion != selected.version) {
                    append(" (")
                    append(stringResource(R.string.native_plugins_configured_version, selected.configuredVersion))
                    append(")")
                }
            }
            PluginFact(stringResource(R.string.native_plugins_version), versionText)
            PluginFact(stringResource(R.string.native_plugins_status), pluginStatusLabel(selected.status))
            PluginFact(stringResource(R.string.native_plugins_resources), pluginCounts(selected.counts))
            if (selected.installedPath != null) {
                PluginFact(stringResource(R.string.native_plugins_installed_path), selected.installedPath)
            }
            if (state.cwd != null) {
                PluginFact(stringResource(R.string.native_plugins_cwd), state.cwd)
            }
            if (selected.disabled) {
                Text(
                    text = stringResource(R.string.native_plugins_package_disabled),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.statusWarning,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = {
                        cwd?.let {
                            controller.action(
                                if (selected.disabled) PluginAction.ENABLE else PluginAction.DISABLE,
                                selected,
                                it,
                            )
                        }
                    },
                    enabled = cwd != null && state.busy == null,
                ) {
                    Text(
                        stringResource(
                            if (selected.disabled) R.string.native_plugins_enable else R.string.native_plugins_disable,
                        ),
                    )
                }
                OutlinedButton(
                    onClick = { cwd?.let { controller.action(PluginAction.UPDATE, selected, it) } },
                    enabled = cwd != null && state.busy == null,
                ) {
                    Text(
                        if (state.busy == PluginAction.UPDATE.wire) {
                            stringResource(R.string.native_plugins_updating)
                        } else {
                            stringResource(R.string.native_plugins_update)
                        },
                    )
                }
                TextButton(
                    onClick = { confirming = true },
                    enabled = cwd != null && state.busy == null,
                ) {
                    Text(
                        if (state.busy == PluginAction.REMOVE.wire) {
                            stringResource(R.string.native_plugins_removing)
                        } else {
                            stringResource(R.string.native_plugins_remove)
                        },
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { sessionId?.let(controller::reload) },
                    enabled = sessionId != null && !state.reloading,
                ) {
                    Text(
                        if (state.reloading) {
                            stringResource(R.string.native_plugins_reloading)
                        } else {
                            stringResource(R.string.native_plugins_reload_session)
                        },
                    )
                }
                if (sessionId == null) {
                    Text(
                        text = stringResource(R.string.native_plugins_open_session_reload),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textDim,
                    )
                }
            }
            val resources = selected.resources
            Text(
                text = stringResource(R.string.native_plugins_resolved_resources),
                style = MaterialTheme.typography.titleSmall,
                color = colors.text,
            )
            if (resources.isEmpty()) {
                Text(
                    text = stringResource(R.string.native_plugins_no_resolved),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textDim,
                )
            } else {
                for (resource in resources) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = resource.kind,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textMuted,
                        )
                        Text(
                            text = resource.name,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.text,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = resource.relativePath,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = colors.textDim,
                        )
                    }
                }
            }
        }
        if (confirming) {
            OmpAlertDialog(
                onDismissRequest = { confirming = false },
                title = { Text(stringResource(R.string.native_plugins_remove_title)) },
                text = { Text(stringResource(R.string.native_plugins_remove_body, selected.source)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirming = false
                            cwd?.let { controller.action(PluginAction.REMOVE, selected, it) }
                        },
                    ) {
                        Text(stringResource(R.string.native_plugins_remove))
                    }
                },
                dismissButton = {
                    TextButton(onClick = { confirming = false }) {
                        Text(stringResource(R.string.native_plugins_cancel))
                    }
                },
            )
        }
    }

    if (state.adding) {
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SettingsSectionTitle(
                    text = stringResource(R.string.native_plugins_add_title),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = controller::closeAdd) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.native_plugins_close))
                }
            }
            OutlinedTextField(
                value = state.source,
                onValueChange = controller::setSource,
                label = { Text(stringResource(R.string.native_plugins_source)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = stringResource(R.string.native_skills_scope_label),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                )
                SettingsSelect(
                    options = listOf(
                        "project" to stringResource(R.string.native_plugins_scope_project),
                        "global" to stringResource(R.string.native_plugins_scope_global),
                    ),
                    selected = state.scope,
                    onSelect = controller::setScope,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { cwd?.let(controller::install) },
                    enabled = cwd != null && state.source.isNotBlank() && state.busy == null,
                ) {
                    Text(
                        if (state.busy == PluginAction.INSTALL.wire) {
                            stringResource(R.string.native_plugins_installing)
                        } else {
                            stringResource(R.string.native_plugins_install)
                        },
                    )
                }
                Text(
                    text = stringResource(R.string.native_plugins_examples) + ": npm:@scope/pkg, github:owner/repo",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
            }
        }
    }
}

@Composable
private fun PluginRow(plugin: PluginPackageInfo, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    NativeListRow(selected = selected, onClick = onClick) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = plugin.packageName ?: plugin.source,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.text,
            )
            val meta = buildList {
                add(pluginStatusLabel(plugin.status))
                if (plugin.disabled) add(stringResource(R.string.native_plugins_badge_disabled))
                if (plugin.filtered) add(stringResource(R.string.native_plugins_badge_filtered))
                add(pluginCounts(plugin.counts))
            }.joinToString(" · ")
            Text(
                text = meta,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
    }
}

@Composable
private fun PluginFact(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = LocalOmpColors.current.textMuted,
            modifier = Modifier.padding(end = 4.dp),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = LocalOmpColors.current.text,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun pluginStatusLabel(status: String): String = when (status) {
    "loaded" -> stringResource(R.string.native_plugins_status_loaded)
    "installed" -> stringResource(R.string.native_plugins_status_installed)
    "missing" -> stringResource(R.string.native_plugins_status_missing)
    "disabled" -> stringResource(R.string.native_plugins_status_disabled)
    else -> status
}

@Composable
private fun pluginCounts(counts: PluginResourceCounts): String = stringResource(
    R.string.native_plugins_counts,
    counts.extensions,
    counts.skills,
    counts.prompts,
    counts.themes,
)
