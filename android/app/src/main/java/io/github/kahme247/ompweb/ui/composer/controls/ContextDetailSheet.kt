package io.github.kahme247.ompweb.ui.composer.controls

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.ContextTone
import io.github.kahme247.ompweb.domain.ContextUsageInfo
import io.github.kahme247.ompweb.domain.SessionStats
import io.github.kahme247.ompweb.domain.cacheHitRate
import io.github.kahme247.ompweb.domain.contextTone
import io.github.kahme247.ompweb.domain.formatCost
import io.github.kahme247.ompweb.domain.formatPercent
import io.github.kahme247.ompweb.domain.formatTokenCount
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.LocalOmpDisplayPreferences
import io.github.kahme247.ompweb.ui.theme.OmpDialogContent
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import java.util.Locale

/**
 * The context bottom sheet: `ContextDetailPanel` from
 * `components/ComposerPanels.tsx` — context bar, window/capacity, speed, then
 * session totals from `get_session_stats`, with the compact action
 * (and its abort) in the footer.
 *
 * [streaming] only disables Compact while the agent is mid-turn, matching the
 * web's `disabled={isStreaming && !isCompacting}`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContextDetailSheet(
    vm: ComposerControlsViewModel,
    onDismiss: () -> Unit,
    streaming: Boolean = false,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    val context = LocalContext.current
    val displayPreferences = LocalOmpDisplayPreferences.current
    val copiedText = stringResource(R.string.controls_copied)
    var copied by remember { mutableStateOf<String?>(null) }

    fun copy(label: String, text: String) {
        if (copyTextToClipboard(context, label, text, sensitive = false)) copied = label
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.panel,
        contentColor = colors.text,
    ) {
        OmpDialogContent(displayPreferences) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 620.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, bottom = 20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.controls_context_title),
                        color = colors.text,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    if (copied != null) {
                        Text(
                            text = copiedText,
                            color = colors.accent,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(end = 6.dp),
                        )
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = stringResource(R.string.controls_close),
                            tint = colors.textDim,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }

                val sessionId = state.sessionId
                if (sessionId == null) {
                    Text(
                        text = stringResource(R.string.controls_context_empty),
                        color = colors.textDim,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 16.dp),
                    )
                    return@Column
                }

                ContextSummary(
                    usage = state.shownContextUsage,
                    window = state.modelCapacity?.contextWindow ?: state.shownContextUsage?.contextWindow,
                    maxTokens = state.modelCapacity?.maxTokens,
                    tokensPerSecond = state.tokensPerSecond,
                    speedAverage = state.speedAverage,
                )

                state.sessionStats?.let { stats ->
                    val sections = listOf<@Composable () -> Unit>(
                        {
                            StatsSection(title = stringResource(R.string.controls_section_session_info)) {
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_name),
                                    value = stats.sessionName?.takeIf { it.isNotBlank() }
                                        ?: stringResource(R.string.controls_in_memory),
                                )
                                val file = stats.sessionFile
                                if (file != null) {
                                    InfoRow(
                                        label = stringResource(R.string.controls_stat_file),
                                        value = file,
                                        mono = true,
                                        onCopy = { copy(file, file) },
                                        copyLabel = stringResource(R.string.controls_copy_file),
                                    )
                                }
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_id),
                                    value = stats.sessionId.ifBlank { sessionId },
                                    mono = true,
                                    onCopy = {
                                        copy(stats.sessionId.ifBlank { sessionId }, stats.sessionId.ifBlank { sessionId })
                                    },
                                    copyLabel = stringResource(R.string.controls_copy_id),
                                )
                            }
                        },
                        {
                            StatsSection(title = stringResource(R.string.controls_section_messages)) {
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_user),
                                    value = stats.userMessages.toString(),
                                )
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_assistant),
                                    value = stats.assistantMessages.toString(),
                                )
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_tool_calls),
                                    value = stats.toolCalls.toString(),
                                )
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_tool_results),
                                    value = stats.toolResults.toString(),
                                )
                                InfoRow(
                                    label = stringResource(R.string.controls_stat_total),
                                    value = stats.totalMessages.toString(),
                                    emphasize = true,
                                )
                            }
                        },
                        {
                            StatsSection(title = stringResource(R.string.controls_section_tokens)) {
                                TokenRows(stats = stats)
                            }
                        },
                    )
                    if (wide) {
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Column(modifier = Modifier.weight(1f)) {
                                sections[0]()
                                Spacer(Modifier.height(6.dp))
                            }
                            Column(modifier = Modifier.weight(1f)) {
                                sections[1]()
                                Spacer(Modifier.height(6.dp))
                            }
                        }
                        sections[2]()
                    } else {
                        sections.forEach { it() }
                    }
                } ?: if (state.statsLoading) {
                    Text(
                        text = stringResource(R.string.controls_context_loading),
                        color = colors.textDim,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 16.dp),
                    )
                } else {
                    Spacer(Modifier.height(8.dp))
                }

                state.compactResult?.let { result ->
                    val verb = if (result.reason.isBlank()) {
                        stringResource(R.string.controls_compacted)
                    } else {
                        stringResource(R.string.controls_compacted_with_reason, result.reason)
                    }
                    Text(
                        text = stringResource(
                            R.string.controls_compact_result,
                            verb,
                            formatTokenCount(result.tokensBefore),
                            formatTokenCount(result.estimatedTokensAfter),
                            formatTokenCount(result.savedTokens),
                        ),
                        color = colors.textMuted,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }
                state.compactError?.let { error ->
                    Text(
                        text = error,
                        color = colors.statusError,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }

                val compactEnabled = !streaming || state.isCompacting
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (state.isCompacting) {
                        Button(
                            onClick = { vm.abortCompaction() },
                            shape = RoundedCornerShape(8.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.selected,
                                contentColor = colors.text,
                            ),
                        ) {
                            Text(stringResource(R.string.controls_stop_compaction), fontSize = 12.sp)
                        }
                    } else {
                        Button(
                            onClick = { vm.compact() },
                            enabled = compactEnabled,
                            shape = RoundedCornerShape(8.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.accent,
                                contentColor = colors.onAccent,
                            ),
                        ) {
                            Text(stringResource(R.string.controls_compact), fontSize = 12.sp)
                        }
                    }
                    TextButton(onClick = onDismiss) {
                        Text(
                            text = stringResource(R.string.controls_close),
                            color = colors.textMuted,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ContextSummary(
    usage: ContextUsageInfo?,
    window: Int?,
    maxTokens: Int?,
    tokensPerSecond: Double?,
    speedAverage: Double?,
) {
    val colors = LocalOmpColors.current
    val percent = usage?.percent
    val tone = when (contextTone(percent)) {
        ContextTone.ERROR -> colors.statusError
        ContextTone.WARNING -> colors.statusWarning
        ContextTone.NORMAL -> colors.accent
    }
    Column(modifier = Modifier.padding(top = 10.dp)) {
        if (usage != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = buildString {
                        append(formatTokenCount(usage.tokens ?: 0))
                        append(" / ")
                        append(formatTokenCount(usage.contextWindow))
                        if (percent != null) {
                            append(" (")
                            append(formatPercent(percent))
                            append(')')
                        }
                    },
                    color = colors.text,
                    fontSize = 12.sp,
                    fontFamily = OmpMonoFontFamily,
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .height(5.dp)
                    .background(colors.border, RoundedCornerShape(3.dp)),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(((percent ?: 0.0).coerceIn(0.0, 100.0) / 100.0).toFloat())
                        .height(5.dp)
                        .background(tone, RoundedCornerShape(3.dp)),
                )
            }
        }
        val chips = buildList {
            window?.let { add(stringResource(R.string.controls_window_size, formatTokenCount(it))) }
            maxTokens?.let { add(stringResource(R.string.controls_max_output, formatTokenCount(it))) }
            val speed = tokensPerSecond
            if (speed != null && speed > 0) {
                val current = formatSpeed(speed)
                add(
                    if (speedAverage != null && speedAverage > 0) {
                        stringResource(R.string.controls_speed, current, formatSpeed(speedAverage))
                    } else {
                        stringResource(R.string.controls_speed_current, current)
                    },
                )
            }
        }
        if (chips.isNotEmpty()) {
            Text(
                text = chips.joinToString("  ·  "),
                color = colors.textDim,
                fontSize = 10.5.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun StatsSection(title: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.padding(top = 12.dp)) {
        Text(
            text = title,
            color = LocalOmpColors.current.textDim,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Column(modifier = Modifier.padding(top = 2.dp)) { content() }
    }
}

@Composable
private fun TokenRows(stats: SessionStats) {
    val colors = LocalOmpColors.current
    val tokens = stats.tokens
    InfoRow(label = stringResource(R.string.controls_stat_input), value = formatTokenCount(tokens.input))
    InfoRow(label = stringResource(R.string.controls_stat_output), value = formatTokenCount(tokens.output))
    if (tokens.cacheRead > 0) {
        InfoRow(
            label = stringResource(R.string.controls_stat_cache_read),
            value = formatTokenCount(tokens.cacheRead),
        )
    }
    if (tokens.cacheWrite > 0) {
        InfoRow(
            label = stringResource(R.string.controls_stat_cache_write),
            value = formatTokenCount(tokens.cacheWrite),
        )
    }
    InfoRow(
        label = stringResource(R.string.controls_stat_total),
        value = formatTokenCount(tokens.total),
        emphasize = true,
    )
    val hitRate = cacheHitRate(tokens.input, tokens.cacheRead)
    if (hitRate != null) {
        InfoRow(
            label = stringResource(R.string.controls_stat_cache_rate),
            value = String.format(Locale.US, "%.1f%%", hitRate),
        )
    }
    formatCost(stats.cost)?.let { cost ->
        InfoRow(
            label = stringResource(R.string.controls_stat_cost),
            value = cost,
            mono = true,
            valueColor = colors.textMuted,
        )
    }
}

@Composable
private fun InfoRow(
    label: String,
    value: String,
    mono: Boolean = false,
    emphasize: Boolean = false,
    valueColor: Color? = null,
    onCopy: (() -> Unit)? = null,
    copyLabel: String? = null,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onCopy != null) {
                    Modifier
                        .clickable(onClick = onCopy)
                        .semantics { if (copyLabel != null) contentDescription = copyLabel }
                } else {
                    Modifier
                },
            )
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = colors.textDim,
            fontSize = 11.sp,
            modifier = Modifier.width(96.dp),
        )
        Text(
            text = value,
            color = valueColor ?: if (emphasize) colors.text else colors.textMuted,
            fontSize = 11.sp,
            fontWeight = if (emphasize) FontWeight.SemiBold else FontWeight.Normal,
            fontFamily = if (mono) OmpMonoFontFamily else null,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/** `formatSpeed` from the web panel: one decimal below 10, none above. */
private fun formatSpeed(value: Double): String =
    if (value >= 10) {
        String.format(Locale.US, "%.0f", value)
    } else {
        String.format(Locale.US, "%.1f", value)
    }
