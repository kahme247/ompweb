package io.github.kahme247.ompweb.ui.settings.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.AgentDiagnostic
import io.github.kahme247.ompweb.net.AgentInfo
import io.github.kahme247.ompweb.ui.settings.models.ModelsCard
import io.github.kahme247.ompweb.ui.settings.models.ModelsDropdown
import io.github.kahme247.ompweb.ui.settings.models.ModelsHint
import io.github.kahme247.ompweb.ui.settings.models.ModelsMessage
import io.github.kahme247.ompweb.ui.settings.models.ModelsSectionTitle
import io.github.kahme247.ompweb.ui.settings.models.ModelsTextField
import io.github.kahme247.ompweb.ui.settings.models.StatusBadge
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Agents tab: roster and editor (web `AgentsConfig.tsx`).
 *
 * Content-only: the shell renders the app bar. [cwd] is the active workspace;
 * `null` means none, in which case only user agents are editable.
 */
@Composable
fun AgentsTab(
    vm: AgentsViewModel,
    cwd: String?,
    highlight: String? = null,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    LaunchedEffect(cwd) { vm.attach(cwd) }
    LaunchedEffect(highlight) {
        if (!highlight.isNullOrBlank()) vm.applyHighlight(highlight)
    }
    var deleteOpen by remember { mutableStateOf(false) }
    var copiedPath by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                ModelsSectionTitle(
                    stringResource(R.string.agents_title) + " · " + state.counts.total,
                )
                Text(
                    text = "${state.counts.bundled} bundled · ${state.counts.user} user · ${state.counts.project} project",
                    color = colors.textMuted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.5.sp,
                )
            }
            TextButton(onClick = { vm.reload() }, enabled = !state.loading) {
                Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.textMuted, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(3.dp))
                Text(stringResource(R.string.models_reload), fontSize = 11.sp, color = colors.textMuted)
            }
        }
        ModelsHint(stringResource(R.string.agents_desc))

        if (state.workspaceUnavailable) {
            Row(verticalAlignment = Alignment.Top) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = colors.statusWarning, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.agents_workspace_unavailable), color = colors.statusWarning, fontSize = 11.5.sp, lineHeight = 16.sp)
            }
        }

        ModelsMessage(state.message, state.messageIsError, vm::dismissMessage)
        if (copiedPath) {
            Text(stringResource(R.string.models_copied), color = colors.statusSuccess, fontSize = 11.sp)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = vm::startCreate, enabled = !state.workspaceCheckPending) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.agents_new), fontSize = 12.sp)
            }
            OutlinedButton(onClick = vm::unpack, enabled = !state.saving && !state.workspaceCheckPending) {
                Text(stringResource(R.string.agents_unpack), fontSize = 12.sp)
            }
        }

        ModelsTextField(
            label = stringResource(R.string.agents_search),
            value = state.search,
            onValueChange = vm::setSearch,
        )

        if (state.loading && state.agents.isEmpty()) {
            ModelsHint(stringResource(R.string.agents_loading))
        } else if (state.filtered.isEmpty()) {
            ModelsHint(
                stringResource(
                    if (state.agents.isEmpty()) R.string.agents_no_agents else R.string.agents_no_match,
                ),
            )
        } else {
            ModelsCard {
                state.filtered.forEach { agent ->
                    AgentRow(
                        agent = agent,
                        selected = !state.creating && state.selectedName == agent.name,
                        onClick = { vm.select(agent.name) },
                    )
                }
            }
        }

        val active = state.active
        if (state.creating || active != null) {
            ModelsCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ModelsSectionTitle(
                        if (state.creating) stringResource(R.string.agents_new) else active?.name.orEmpty(),
                    )
                    Spacer(Modifier.weight(1f))
                    if (state.creating) {
                        ModelsDropdown(
                            label = stringResource(R.string.agents_scope),
                            value = state.createScope,
                            options = agentWritableScopes(state.canEditProject).map { scope ->
                                scope to stringResource(
                                    if (scope == "project") R.string.agents_scope_project
                                    else R.string.agents_scope_user,
                                )
                            },
                            onSelect = vm::setCreateScope,
                            modifier = Modifier.widthIn(min = 150.dp),
                        )
                    }
                }
                if (!state.creating && active != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = shortenAgentPath(active.filePath),
                            color = colors.textMuted,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.5.sp,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = {
                                copiedPath = copyTextToClipboard(context, "agent path", active.filePath, sensitive = false)
                            },
                        ) {
                            Text(stringResource(R.string.agents_copy_path), fontSize = 11.sp)
                        }
                    }
                }
                if (state.isBundledActive) {
                    Text(
                        text = stringResource(
                            R.string.agents_bundled_readonly,
                            if (state.canEditProject) stringResource(R.string.agents_scope_project)
                            else stringResource(R.string.agents_scope_user),
                        ),
                        color = colors.statusWarning,
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                    )
                }
                if (state.creating) {
                    ModelsHint(stringResource(R.string.agents_create_hint))
                }

                ModelsTextField(
                    label = stringResource(R.string.agents_name),
                    value = state.form.name,
                    onValueChange = { value -> vm.updateForm { it.copy(name = value) } },
                    placeholder = stringResource(R.string.agents_name_placeholder),
                    mono = true,
                )
                ModelsTextField(
                    label = stringResource(R.string.agents_description),
                    value = state.form.description,
                    onValueChange = { value -> vm.updateForm { it.copy(description = value) } },
                    placeholder = stringResource(R.string.agents_description_placeholder),
                    singleLine = false,
                    minLines = 2,
                )
                ModelsTextField(
                    label = stringResource(R.string.agents_model_roles),
                    value = state.form.modelCsv,
                    onValueChange = { value -> vm.updateForm { it.copy(modelCsv = value) } },
                    placeholder = stringResource(R.string.agents_model_roles_placeholder),
                )
                ModelsDropdown(
                    label = stringResource(R.string.agents_thinking),
                    value = state.form.thinkingLevel,
                    options = listOf("" to stringResource(R.string.agents_thinking_default)) +
                        AGENT_THINKING_LEVELS.map { it to it },
                    onSelect = { value -> vm.updateForm { it.copy(thinkingLevel = value) } },
                )
                ModelsTextField(
                    label = stringResource(R.string.agents_spawns),
                    value = state.form.spawnsCsv,
                    onValueChange = { value -> vm.updateForm { it.copy(spawnsCsv = value) } },
                    placeholder = stringResource(R.string.agents_spawns_placeholder),
                )
                ModelsTextField(
                    label = stringResource(R.string.agents_tools),
                    value = state.form.toolsCsv,
                    onValueChange = { value -> vm.updateForm { it.copy(toolsCsv = value) } },
                    placeholder = stringResource(R.string.agents_tools_placeholder),
                )
                ModelsTextField(
                    label = stringResource(R.string.agents_system_prompt),
                    value = state.form.body,
                    onValueChange = { value -> vm.updateForm { it.copy(body = value) } },
                    placeholder = stringResource(R.string.agents_system_prompt_placeholder),
                    singleLine = false,
                    minLines = 6,
                    mono = true,
                )

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = vm::save,
                        enabled = !state.saving && !state.workspaceCheckPending && !state.activeProjectUnavailable,
                    ) {
                        Text(
                            stringResource(
                                if (state.saving) R.string.models_saving
                                else if (state.creating) R.string.agents_create
                                else R.string.agents_save,
                            ),
                        )
                    }
                    if (state.creating) {
                        TextButton(onClick = vm::cancelCreate, enabled = !state.saving) {
                            Text(stringResource(R.string.models_cancel), color = colors.textMuted)
                        }
                    } else {
                        TextButton(
                            onClick = { deleteOpen = true },
                            enabled = !state.saving && !state.isBundledActive && !state.activeProjectUnavailable,
                        ) {
                            Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.statusError, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(4.dp))
                            Text(stringResource(R.string.models_remove), color = colors.statusError, fontSize = 12.sp)
                        }
                    }
                }
                ModelsHint(stringResource(R.string.agents_atomic_notice))
            }
        } else if (!state.loading) {
            ModelsCard {
                ModelsHint(stringResource(R.string.agents_select))
                ModelsHint(stringResource(R.string.agents_templates_notice))
            }
        }

        val diagnostics = state.diagnostics.filter { it.message.isNotBlank() }
        if (diagnostics.isNotEmpty()) {
            ModelsCard {
                ModelsSectionTitle(stringResource(R.string.agents_diagnostics))
                diagnostics.forEach { DiagnosticRow(it) }
            }
        }
    }

    if (deleteOpen && state.active != null) {
        val active = state.active!!
        OmpAlertDialog(
            onDismissRequest = { deleteOpen = false },
            title = { Text(stringResource(R.string.agents_delete_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.agents_delete_body,
                        active.name,
                        if (active.scope == "project") stringResource(R.string.agents_scope_project)
                        else stringResource(R.string.agents_scope_user),
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleteOpen = false
                        vm.remove()
                    },
                ) {
                    Text(stringResource(R.string.models_remove), color = colors.statusError)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteOpen = false }) {
                    Text(stringResource(R.string.models_cancel))
                }
            },
        )
    }
}

@Composable
private fun AgentRow(agent: AgentInfo, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.selected else colors.panel)
            .clickable(onClick = onClick)
            .padding(vertical = 7.dp, horizontal = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 5.dp)
                .size(6.dp)
                .clip(CircleShape)
                .background(
                    when {
                        !agent.valid -> colors.statusError
                        !agent.enabled -> colors.border
                        else -> colors.accent
                    },
                ),
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = agent.name,
                    color = colors.text,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(6.dp))
                StatusBadge(
                    text = stringResource(
                        when {
                            agent.isBundled -> R.string.agents_scope_bundled
                            agent.scope == "project" -> R.string.agents_scope_project
                            else -> R.string.agents_scope_user
                        },
                    ),
                    color = if (agent.isBundled) colors.textMuted else colors.accent,
                )
            }
            if (agent.description.isNotBlank()) {
                Text(
                    text = agent.description,
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                )
            }
            if (!agent.valid) {
                Text(stringResource(R.string.agents_invalid), color = colors.statusError, fontSize = 10.5.sp)
            }
        }
    }
}

@Composable
private fun DiagnosticRow(diagnostic: AgentDiagnostic) {
    val colors = LocalOmpColors.current
    Column {
        Text(
            text = diagnostic.message,
            color = if (diagnostic.type == "error") colors.statusError else colors.textMuted,
            fontSize = 11.sp,
            lineHeight = 15.sp,
        )
        diagnostic.path?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = colors.textDim, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
        }
    }
}
