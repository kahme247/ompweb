package io.github.kahme247.ompweb.ui.settings.native

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.APPROVAL_MODES
import io.github.kahme247.ompweb.domain.BASH_APPROVAL_POLICIES
import io.github.kahme247.ompweb.domain.EXTENSION_APPROVAL_POLICIES
import io.github.kahme247.ompweb.domain.MEMORY_BACKENDS
import io.github.kahme247.ompweb.domain.MEMORY_SCOPES
import io.github.kahme247.ompweb.domain.NativeSettingsDocument
import io.github.kahme247.ompweb.domain.PERSONALITIES
import io.github.kahme247.ompweb.domain.RETRY_ATTEMPTS
import io.github.kahme247.ompweb.domain.TEXT_VERBOSITIES
import io.github.kahme247.ompweb.domain.THINKING_LEVELS
import io.github.kahme247.ompweb.domain.compactionMethodRows
import io.github.kahme247.ompweb.domain.moveCompactionMethod
import io.github.kahme247.ompweb.domain.toggleCompactionMethod
import io.github.kahme247.ompweb.ui.settings.NativeSettingsViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsCard
import io.github.kahme247.ompweb.ui.settings.SettingsSectionTitle
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

@Composable
fun NativeGeneralSection(viewModel: NativeSettingsViewModel, highlight: String?) {
    val state by viewModel.settings.state.collectAsState()
    SettingsCard {
        NativeSettingsStatus(state, onRetry = { viewModel.settings.load(force = true) })
        val document = state.document
        NativeToggleRow(
            id = "skill-startup-notices",
            highlight = highlight,
            title = stringResource(R.string.native_skill_notices),
            description = stringResource(R.string.native_skill_notices_desc),
            checked = document.showStartupDiagnostics(),
            enabled = state.loaded,
            onCheckedChange = { checked ->
                viewModel.settings.edit { it.withSectionBool("skills", "showStartupDiagnostics", checked) }
            },
        )
    }
}

@Composable
fun NativeSafetySection(viewModel: NativeSettingsViewModel, highlight: String?) {
    val state by viewModel.settings.state.collectAsState()
    val document = state.document
    val enabled = state.loaded
    NativeSettingsStatus(state, onRetry = { viewModel.settings.load(force = true) })
    NativeSectionCard(
        title = stringResource(R.string.native_safety_title),
        description = stringResource(R.string.native_safety_desc),
    ) {
        NativeChoiceRow(
            id = "approval-mode",
            highlight = highlight,
            title = stringResource(R.string.native_approval_mode),
            description = stringResource(R.string.native_approval_mode_desc),
            options = approvalModeOptions(),
            selected = document.approvalMode(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withSectionString("tools", "approvalMode", value) } },
        )
        NativeChoiceRow(
            id = "bash-override",
            highlight = highlight,
            title = stringResource(R.string.native_bash_override),
            description = stringResource(R.string.native_bash_override_desc),
            options = bashOptions(),
            selected = document.bashApproval(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withNestedSectionString("tools", "approval", "bash", value) } },
        )
        NativeChoiceRow(
            id = "extension-tool-requests",
            highlight = highlight,
            title = stringResource(R.string.native_extension_requests),
            description = stringResource(R.string.native_extension_requests_desc),
            options = extensionOptions(),
            selected = document.extensionApproval(),
            enabled = enabled,
            onSelect = { value ->
                viewModel.settings.edit { it.withNestedSectionString("tools", "approval", "extension", value) }
            },
        )
    }
}

@Composable
fun NativeModelsSection(viewModel: NativeSettingsViewModel, highlight: String?) {
    val state by viewModel.settings.state.collectAsState()
    val document = state.document
    val enabled = state.loaded
    NativeSettingsStatus(state, onRetry = { viewModel.settings.load(force = true) })
    NativeSectionCard(
        title = stringResource(R.string.native_model_defaults_title),
        description = stringResource(R.string.native_model_defaults_desc),
    ) {
        NativeChoiceRow(
            id = "reasoning",
            highlight = highlight,
            title = stringResource(R.string.native_reasoning),
            description = stringResource(R.string.native_reasoning_desc),
            options = THINKING_LEVELS.map { it to it },
            selected = document.thinkingLevel(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withString("defaultThinkingLevel", value) } },
        )
        // The web shows the source row only when the stored level is exactly "auto".
        if (document.string("defaultThinkingLevel") == "auto") {
            NativeChoiceRow(
                id = "auto-thinking-source",
                highlight = highlight,
                title = stringResource(R.string.native_auto_thinking_source),
                description = stringResource(R.string.native_auto_thinking_source_desc),
                options = listOf(
                    "classifier" to stringResource(R.string.native_auto_thinking_classifier),
                    "vendor" to stringResource(R.string.native_auto_thinking_vendor),
                ),
                selected = document.autoThinkingSource(),
                enabled = enabled,
                onSelect = { value ->
                    viewModel.settings.edit { it.withSectionString("providers", "autoThinkingSource", value) }
                },
            )
        }
        NativeChoiceRow(
            id = "verbosity",
            highlight = highlight,
            title = stringResource(R.string.native_verbosity),
            description = stringResource(R.string.native_verbosity_desc),
            options = verbosityOptions(),
            selected = document.textVerbosity(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withString("textVerbosity", value) } },
        )
        NativeChoiceRow(
            id = "personality",
            highlight = highlight,
            title = stringResource(R.string.native_personality),
            description = stringResource(R.string.native_personality_desc),
            options = PERSONALITIES.map { it to it },
            selected = document.personality(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withString("personality", value) } },
        )
        NativeToggleRow(
            id = "thinking-blocks",
            highlight = highlight,
            title = stringResource(R.string.native_thinking_blocks),
            description = stringResource(R.string.native_thinking_blocks_desc),
            checked = document.hideThinkingBlock(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withBool("hideThinkingBlock", checked) } },
        )
        NativeToggleRow(
            id = "external-thinking",
            highlight = highlight,
            title = stringResource(R.string.native_external_thinking),
            description = stringResource(R.string.native_external_thinking_desc),
            checked = document.externalThinking(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withBool("externalThinking", checked) } },
        )
    }
}

@Composable
fun NativeIntelligenceSection(viewModel: NativeSettingsViewModel, highlight: String?) {
    val state by viewModel.settings.state.collectAsState()
    val document = state.document
    val enabled = state.loaded
    NativeSettingsStatus(state, onRetry = { viewModel.settings.load(force = true) })

    NativeSectionCard(
        title = stringResource(R.string.native_context_compaction),
        description = stringResource(R.string.native_context_compaction_desc),
    ) {
        NativeToggleRow(
            id = "automatic-compaction",
            highlight = highlight,
            title = stringResource(R.string.native_automatic_compaction),
            description = stringResource(R.string.native_automatic_compaction_desc),
            checked = document.compactionEnabled(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("compaction", "enabled", checked) } },
        )
        NativeToggleRow(
            id = "continue-after-compaction",
            highlight = highlight,
            title = stringResource(R.string.native_continue_after_compaction),
            description = stringResource(R.string.native_continue_after_compaction_desc),
            checked = document.compactionAutoContinue(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("compaction", "autoContinue", checked) } },
        )
        HighlightedBlock(id = "compaction-method-order", highlight = highlight) {
            SettingsSectionTitle(stringResource(R.string.native_compaction_method_order))
            Text(
                text = stringResource(R.string.native_compaction_method_order_desc),
                style = MaterialTheme.typography.bodySmall,
                color = LocalOmpColors.current.textMuted,
            )
            CompactionOrderEditor(
                order = document.compactionMethodOrder(),
                enabled = enabled,
                onChange = { order ->
                    viewModel.settings.edit { entry -> entry.withCompactionOrder(order) }
                },
            )
        }
        NativeToggleRow(
            id = "compact-mid-turn",
            highlight = highlight,
            title = stringResource(R.string.native_compact_mid_turn),
            description = stringResource(R.string.native_compact_mid_turn_desc),
            checked = document.compactionMidTurn(),
            enabled = enabled,
            onCheckedChange = { checked ->
                viewModel.settings.edit { it.withSectionBool("compaction", "midTurnEnabled", checked) }
            },
        )
    }

    NativeSectionCard(
        title = stringResource(R.string.native_memory_autolearn),
        description = stringResource(R.string.native_memory_autolearn_desc),
    ) {
        NativeChoiceRow(
            id = "memory-backend",
            highlight = highlight,
            title = stringResource(R.string.native_memory_backend),
            description = stringResource(R.string.native_memory_backend_desc),
            options = memoryBackendOptions(),
            selected = document.memoryBackend(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withSectionString("memory", "backend", value) } },
        )
        NativeToggleRow(
            id = "enable-auto-learn",
            highlight = highlight,
            title = stringResource(R.string.native_enable_autolearn),
            description = stringResource(R.string.native_enable_autolearn_desc),
            checked = document.autolearnEnabled(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("autolearn", "enabled", checked) } },
        )
        NativeToggleRow(
            id = "private-capture-turn",
            highlight = highlight,
            title = stringResource(R.string.native_private_capture),
            description = stringResource(R.string.native_private_capture_desc),
            checked = document.autolearnAutoContinue(),
            enabled = enabled,
            onCheckedChange = { checked ->
                viewModel.settings.edit { it.withSectionBool("autolearn", "autoContinue", checked) }
            },
        )
        NativeChoiceRow(
            id = "memory-scope",
            highlight = highlight,
            title = stringResource(R.string.native_memory_scope),
            description = stringResource(R.string.native_memory_scope_desc),
            options = memoryScopeOptions(),
            selected = document.memoryScope(),
            enabled = enabled,
            onSelect = { value -> viewModel.settings.edit { it.withSectionString("mnemopi", "scoping", value) } },
        )
        NativeToggleRow(
            id = "recall-on-session-start",
            highlight = highlight,
            title = stringResource(R.string.native_recall_session_start),
            description = stringResource(R.string.native_recall_session_start_desc),
            checked = document.autoRecall(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("mnemopi", "autoRecall", checked) } },
        )
        NativeToggleRow(
            id = "retain-completed-turns",
            highlight = highlight,
            title = stringResource(R.string.native_retain_turns),
            description = stringResource(R.string.native_retain_turns_desc),
            checked = document.autoRetain(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("mnemopi", "autoRetain", checked) } },
        )
    }

    NativeSectionCard(
        title = stringResource(R.string.native_automatic_retry),
        description = stringResource(R.string.native_automatic_retry_desc),
    ) {
        NativeToggleRow(
            id = "automatic-retry",
            highlight = highlight,
            title = stringResource(R.string.native_retry_toggle),
            description = stringResource(R.string.native_retry_toggle_desc),
            checked = document.retryEnabled(),
            enabled = enabled,
            onCheckedChange = { checked -> viewModel.settings.edit { it.withSectionBool("retry", "enabled", checked) } },
        )
        NativeChoiceRow(
            id = "max-attempts",
            highlight = highlight,
            title = stringResource(R.string.native_max_attempts),
            description = stringResource(R.string.native_max_attempts_desc),
            options = RETRY_ATTEMPTS.map { it.toString() to it.toString() },
            selected = document.maxRetries().toString(),
            enabled = enabled,
            onSelect = { value ->
                value.toIntOrNull()?.let { retries ->
                    viewModel.settings.edit { it.withSectionInt("retry", "maxRetries", retries) }
                }
            },
        )
        NativeToggleRow(
            id = "model-fallback",
            highlight = highlight,
            title = stringResource(R.string.native_model_fallback),
            description = stringResource(R.string.native_model_fallback_desc),
            checked = document.modelFallback(),
            enabled = enabled,
            onCheckedChange = { checked ->
                viewModel.settings.edit { it.withSectionBool("retry", "modelFallback", checked) }
            },
        )
    }
}

@Composable
private fun CompactionOrderEditor(
    order: List<String>,
    enabled: Boolean,
    onChange: (List<String>) -> Unit,
) {
    val colors = LocalOmpColors.current
    val rows = compactionMethodRows(order)
    val checkedCount = rows.count { it.second >= 0 }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (order.isEmpty()) {
            Text(
                text = stringResource(R.string.native_compaction_none),
                style = MaterialTheme.typography.bodySmall,
                color = colors.statusError,
            )
        }
        for ((method, position) in rows) {
            val checked = position >= 0
            val label = compactionMethodLabel(method)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    checked = checked,
                    onCheckedChange = { on -> onChange(toggleCompactionMethod(order, method, on)) },
                    enabled = enabled,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.text,
                    )
                    Text(
                        text = compactionMethodDescription(method),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textMuted,
                    )
                    if (checked) {
                        Text(
                            text = stringResource(R.string.native_compaction_position, label, position + 1),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textDim,
                        )
                    }
                }
                IconButton(
                    onClick = { onChange(moveCompactionMethod(order, method, -1)) },
                    enabled = enabled && checked && position > 0,
                ) {
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowUp,
                        contentDescription = stringResource(R.string.native_move_up, label),
                    )
                }
                IconButton(
                    onClick = { onChange(moveCompactionMethod(order, method, 1)) },
                    enabled = enabled && checked && position < checkedCount - 1,
                ) {
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = stringResource(R.string.native_move_down, label),
                    )
                }
            }
        }
    }
}

@Composable
private fun compactionMethodLabel(method: String): String = when (method) {
    "remote" -> stringResource(R.string.native_compaction_remote)
    "snapcompact" -> stringResource(R.string.native_compaction_snapcompact)
    "handoff" -> stringResource(R.string.native_compaction_handoff)
    "soft" -> stringResource(R.string.native_compaction_soft)
    "shake" -> stringResource(R.string.native_compaction_shake)
    else -> method
}

@Composable
private fun compactionMethodDescription(method: String): String = when (method) {
    "remote" -> stringResource(R.string.native_compaction_remote_desc)
    "snapcompact" -> stringResource(R.string.native_compaction_snapcompact_desc)
    "handoff" -> stringResource(R.string.native_compaction_handoff_desc)
    "soft" -> stringResource(R.string.native_compaction_soft_desc)
    "shake" -> stringResource(R.string.native_compaction_shake_desc)
    else -> ""
}

@Composable
private fun approvalModeOptions(): List<Pair<String, String>> = APPROVAL_MODES.map { value ->
    value to when (value) {
        "always-ask" -> stringResource(R.string.native_always_ask)
        "write" -> stringResource(R.string.native_allow_writes)
        "yolo" -> stringResource(R.string.native_auto_approve_yolo)
        else -> value
    }
}

@Composable
private fun bashOptions(): List<Pair<String, String>> = BASH_APPROVAL_POLICIES.map { value ->
    value to when (value) {
        "allow" -> stringResource(R.string.native_allow)
        "prompt" -> stringResource(R.string.native_always_ask)
        "deny" -> stringResource(R.string.native_deny)
        else -> value
    }
}

@Composable
private fun extensionOptions(): List<Pair<String, String>> = EXTENSION_APPROVAL_POLICIES.map { value ->
    value to when (value) {
        "prompt" -> stringResource(R.string.native_always_ask)
        "allow" -> stringResource(R.string.native_auto_approve)
        else -> value
    }
}

@Composable
private fun verbosityOptions(): List<Pair<String, String>> = TEXT_VERBOSITIES.map { value ->
    value to when (value) {
        "low" -> stringResource(R.string.native_verbosity_low)
        "medium" -> stringResource(R.string.native_verbosity_medium)
        "high" -> stringResource(R.string.native_verbosity_high)
        else -> value
    }
}

@Composable
private fun memoryBackendOptions(): List<Pair<String, String>> = MEMORY_BACKENDS.map { value ->
    value to when (value) {
        "off" -> stringResource(R.string.native_memory_backend_off)
        "local" -> stringResource(R.string.native_memory_backend_local)
        "mnemopi" -> stringResource(R.string.native_memory_backend_mnemopi)
        "hindsight" -> stringResource(R.string.native_memory_backend_hindsight)
        else -> value
    }
}

@Composable
private fun memoryScopeOptions(): List<Pair<String, String>> = MEMORY_SCOPES.map { value ->
    value to when (value) {
        "per-project" -> stringResource(R.string.native_memory_scope_per_project)
        "per-project-tagged" -> stringResource(R.string.native_memory_scope_tagged)
        "global" -> stringResource(R.string.native_memory_scope_global)
        else -> value
    }
}

private fun NativeSettingsDocument.withCompactionOrder(order: List<String>): NativeSettingsDocument =
    withSectionValue("compaction", "methodOrder", JsonArray(order.map(::JsonPrimitive)))
