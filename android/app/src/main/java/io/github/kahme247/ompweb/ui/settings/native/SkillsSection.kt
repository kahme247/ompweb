package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.NativeSkillInfo
import io.github.kahme247.ompweb.net.SkillSearchResult
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsLoading
import io.github.kahme247.ompweb.ui.settings.SettingsMessage
import io.github.kahme247.ompweb.ui.settings.SettingsSectionTitle
import io.github.kahme247.ompweb.ui.settings.SettingsSelect
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** The Skills panel of the Extensions tab (`components/SkillsConfig.tsx`). */
@Composable
fun SkillsSection(controller: SkillsController, state: SkillsState, cwd: String?) {
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
                text = stringResource(R.string.native_skills_title),
                modifier = Modifier.weight(1f),
            )
            if (state.canCheckAll) {
                TextButton(
                    onClick = { cwd?.let(controller::checkAll) },
                    enabled = cwd != null && !state.checkingAll,
                ) {
                    Text(
                        text = if (state.checkingAll) {
                            stringResource(R.string.native_skills_checking)
                        } else {
                            stringResource(R.string.native_skills_check_updates)
                        },
                    )
                    if (state.updateCount > 0) {
                        Text(
                            text = " · " + stringResource(R.string.native_skills_update_count, state.updateCount),
                            color = colors.accent,
                        )
                    }
                }
            }
            IconButton(onClick = { cwd?.let { controller.load(it, force = true) } }, enabled = cwd != null) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.native_plugins_refresh))
            }
            IconButton(onClick = controller::openAdd) {
                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.native_skills_add))
            }
        }
        when {
            state.loading && state.skills.isEmpty() -> SettingsLoading(stringResource(R.string.native_settings_loading))
            state.error != null -> SettingsMessage(text = state.error, error = true)
            state.skills.isEmpty() -> Text(
                text = stringResource(R.string.native_skills_none),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textDim,
            )
            else -> {
                for (group in skillGroups(state.skills)) {
                    Text(
                        text = group.label,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textMuted,
                    )
                    var dormantHeaderShown = false
                    for (skill in group.skills) {
                        if (skill.disableModelInvocation && !dormantHeaderShown) {
                            dormantHeaderShown = true
                            Text(
                                text = stringResource(
                                    R.string.native_skills_dormant,
                                    group.skills.count { it.disableModelInvocation },
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textDim,
                            )
                        }
                        SkillRow(
                            skill = skill,
                            selected = state.selected == skill.filePath,
                            busy = skill.filePath in state.busy,
                            cwd = cwd,
                            controller = controller,
                        )
                    }
                }
            }
        }
    }

    val selected = state.selectedSkill
    if (selected != null) {
        SettingsCard {
            SettingsSectionTitle(selected.name)
            if (selected.description.isNotBlank()) {
                Text(
                    text = selected.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                )
            }
            SkillFact(
                label = stringResource(R.string.native_skills_source),
                value = selected.sourceInfo.source ?: skillScopeLabel(selected),
            )
            SkillFact(
                label = stringResource(R.string.native_skills_version),
                value = selected.install?.versionHash ?: stringResource(R.string.native_skills_unknown_version),
            )
            if (!selected.togglable) {
                SettingsMessage(text = stringResource(R.string.native_skills_toggle_readonly), error = false)
            }
            val install = selected.install
            if (install == null || !install.canCheckForUpdates) {
                Text(
                    text = stringResource(R.string.native_skills_checks_unavailable),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textDim,
                )
            } else {
                val update = state.checks[selected.filePath]
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedButton(
                        onClick = { cwd?.let { controller.check(selected, it) } },
                        enabled = cwd != null && selected.filePath !in state.checking,
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null)
                        Text(
                            text = if (selected.filePath in state.checking) {
                                stringResource(R.string.native_skills_checking)
                            } else {
                                stringResource(R.string.native_skills_check)
                            },
                            modifier = Modifier.padding(start = 6.dp),
                        )
                    }
                    if (update?.state == "update-available") {
                        Button(
                            onClick = { controller.update(selected, cwd) },
                            enabled = cwd != null && selected.filePath !in state.busy,
                        ) {
                            Text(
                                if (selected.filePath in state.busy) {
                                    stringResource(R.string.native_skills_updating)
                                } else {
                                    stringResource(R.string.native_skills_update)
                                },
                            )
                        }
                    }
                }
                if (update != null) {
                    Text(
                        text = when (update.state) {
                            "up-to-date" -> stringResource(R.string.native_skills_up_to_date)
                            // The web shows the new version next to the state
                            // (`SkillsConfig.tsx:295`).
                            "update-available" -> buildString {
                                append(stringResource(R.string.native_skills_update_available))
                                append(" · ")
                                append(
                                    update.latestVersion?.take(8)
                                        ?: stringResource(R.string.native_skills_unknown_version),
                                )
                            }
                            "unsupported" -> stringResource(R.string.native_skills_checks_unavailable)
                            else -> update.message?.let { "${stringResource(R.string.native_skills_check_failed)}: $it" }
                                ?: stringResource(R.string.native_skills_check_failed)
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (update.state == "update-available") colors.accent else colors.textMuted,
                    )
                }
            }
        }
    }

    if (state.adding) {
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SettingsSectionTitle(
                    text = stringResource(R.string.native_skills_add_title),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = controller::closeAdd) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.settings_close))
                }
            }
            Text(
                text = stringResource(R.string.native_skills_search_hint),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.searchQuery,
                    onValueChange = controller::setSearchQuery,
                    label = { Text(stringResource(R.string.native_skills_search_skills)) },
                    placeholder = { Text(stringResource(R.string.native_skills_search_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = { controller.search() },
                    enabled = state.searchQuery.isNotBlank() && !state.searching,
                ) {
                    Text(
                        if (state.searching) {
                            stringResource(R.string.native_skills_searching)
                        } else {
                            stringResource(R.string.native_skills_search)
                        },
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = stringResource(R.string.native_skills_scope_label),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                )
                SettingsSelect(
                    options = listOf(
                        "project" to stringResource(R.string.native_skills_scope_project),
                        "global" to stringResource(R.string.native_skills_scope_global),
                    ),
                    selected = state.installScope,
                    onSelect = controller::setInstallScope,
                )
            }
            if (state.searchError != null) {
                SettingsMessage(text = state.searchError, error = true)
            }
            for (result in state.results) {
                SkillSearchRow(
                    result = result,
                    installed = result.packageName in state.installed,
                    installing = state.installing == result.packageName,
                    onInstall = { controller.install(result.packageName, cwd) },
                )
            }
        }
    }
}

@Composable
private fun SkillRow(
    skill: NativeSkillInfo,
    selected: Boolean,
    busy: Boolean,
    cwd: String?,
    controller: SkillsController,
) {
    val colors = LocalOmpColors.current
    val hiddenPrompt = stringResource(R.string.native_skills_hidden_prompt)
    val visiblePrompt = stringResource(R.string.native_skills_visible_prompt)
    NativeListRow(selected = selected, onClick = { controller.select(skill.filePath) }) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = skill.name,
                style = MaterialTheme.typography.bodyMedium,
                color = if (skill.disableModelInvocation) colors.textMuted else colors.text,
            )
            Text(
                text = skillScopeLabel(skill),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
        Switch(
            checked = !skill.disableModelInvocation,
            onCheckedChange = { controller.toggle(skill, cwd) },
            enabled = skill.togglable && !busy,
            modifier = Modifier.semantics {
                contentDescription = if (skill.disableModelInvocation) {
                    hiddenPrompt
                } else {
                    visiblePrompt
                }
            },
        )
    }
}

@Composable
private fun SkillSearchRow(
    result: SkillSearchResult,
    installed: Boolean,
    installing: Boolean,
    onInstall: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = result.packageName,
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace,
                color = colors.text,
            )
            val meta = buildList {
                if (result.installs.isNotBlank()) add(stringResource(R.string.native_skills_installs, result.installs))
                if (result.url.isNotBlank()) add(result.url)
            }.joinToString(" · ")
            Text(
                text = meta,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
            )
        }
        if (installed) {
            Text(
                text = stringResource(R.string.native_skills_installed),
                style = MaterialTheme.typography.labelSmall,
                color = colors.accent,
            )
        } else {
            OutlinedButton(onClick = onInstall, enabled = !installing) {
                Text(
                    if (installing) {
                        stringResource(R.string.native_skills_installing)
                    } else {
                        stringResource(R.string.native_skills_install)
                    },
                )
            }
        }
    }
}

@Composable
private fun SkillFact(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = LocalOmpColors.current.textMuted,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = LocalOmpColors.current.text,
        )
    }
}

private data class SkillGroup(val label: String, val skills: List<NativeSkillInfo>)

/** Web grouping: project/global skills.sh installs first, then folder scopes. */
@Composable
private fun skillGroups(skills: List<NativeSkillInfo>): List<SkillGroup> {
    val projectSh = stringResource(R.string.native_skills_group_project_sh)
    val project = stringResource(R.string.native_skills_scope_project)
    val globalSh = stringResource(R.string.native_skills_group_global_sh)
    val global = stringResource(R.string.native_skills_scope_global)
    val path = stringResource(R.string.native_skills_scope_path)
    val definitions = listOf(
        projectSh to { skill: NativeSkillInfo -> skillScope(skill) == "project" && skill.install?.skillsShUrl != null },
        project to { skill: NativeSkillInfo -> skillScope(skill) == "project" && skill.install?.skillsShUrl == null },
        globalSh to { skill: NativeSkillInfo -> skillScope(skill) == "global" && skill.install?.skillsShUrl != null },
        global to { skill: NativeSkillInfo -> skillScope(skill) == "global" && skill.install?.skillsShUrl == null },
        path to { skill: NativeSkillInfo -> skillScope(skill) == "path" },
    )
    return definitions.mapNotNull { (label, matches) ->
        val grouped = skills.filter(matches)
        if (grouped.isEmpty()) {
            null
        } else {
            SkillGroup(
                label = label,
                skills = grouped.sortedBy { it.disableModelInvocation },
            )
        }
    }
}

/** Web `sourceLabel`: user→global, project→project, everything else→path. */
private fun skillScope(skill: NativeSkillInfo): String {
    val source = skill.sourceInfo.source
    val scope = skill.sourceInfo.scope
    return when {
        scope == "user" || source == "user" -> "global"
        scope == "project" || source == "project" -> "project"
        else -> "path"
    }
}

@Composable
private fun skillScopeLabel(skill: NativeSkillInfo): String = when (skillScope(skill)) {
    "global" -> stringResource(R.string.native_skills_scope_global)
    "project" -> stringResource(R.string.native_skills_scope_project)
    else -> stringResource(R.string.native_skills_scope_path)
}
