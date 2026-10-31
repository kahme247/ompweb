package io.github.kahme247.ompweb.ui.panels

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SubagentAgentSource
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentSource
import io.github.kahme247.ompweb.domain.SubagentStatus
import io.github.kahme247.ompweb.domain.countNestedSubagents
import io.github.kahme247.ompweb.domain.formatCost
import io.github.kahme247.ompweb.domain.formatTokens
import io.github.kahme247.ompweb.domain.shortModel
import io.github.kahme247.ompweb.ui.chat.ElapsedText
import io.github.kahme247.ompweb.ui.chat.LivePulseDot
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpCardRadius
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * The subagent roster attached above the composer (web `SubagentsPanel`):
 * running children as live chips, finished ones behind a per-mount
 * "Completed (N)" toggle (never persisted — finished runs pile up).
 */
@Composable
fun SubagentsPanel(
    subagents: List<SubagentInfo>,
    collapsed: Boolean,
    onCollapsedChange: (Boolean) -> Unit,
    onSelectSubagent: (SubagentInfo) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (subagents.isEmpty()) return
    val colors = LocalOmpColors.current
    var completedExpanded by remember { mutableStateOf(false) }
    val running = subagents.filter { it.running }
    val completed = subagents.filterNot { it.running }
    val summary = stringResource(R.string.panels_subagents_summary, running.size, subagents.size)

    PanelCard(modifier = modifier) {
        PanelHeader(
            title = stringResource(R.string.panels_subagents_title),
            collapsed = collapsed,
            onToggle = { onCollapsedChange(!collapsed) },
            summary = "${running.size}/${subagents.size}",
            modifier = Modifier.semantics { contentDescription = summary },
        )
        if (!collapsed) {
            PanelDivider()
            PanelBody {
                if (running.isNotEmpty()) {
                    SubagentChips(running, onSelectSubagent)
                }
                if (completed.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) { completedExpanded = !completedExpanded }
                            .padding(top = if (running.isNotEmpty()) 6.dp else 0.dp, start = 2.dp, end = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(
                            imageVector = androidx.compose.material.icons.Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                            tint = colors.textDim,
                            modifier = Modifier
                                .size(12.dp)
                                .rotate(
                                    androidx.compose.animation.core.animateFloatAsState(
                                        if (completedExpanded) 0f else -90f,
                                        label = "completed-chevron",
                                    ).value,
                                ),
                        )
                        Text(
                            text = stringResource(R.string.panels_subagents_completed, completed.size),
                            color = colors.textMuted,
                            fontSize = 11.sp,
                        )
                    }
                    if (completedExpanded) {
                        SubagentChips(completed, onSelectSubagent)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SubagentChips(
    subagents: List<SubagentInfo>,
    onSelectSubagent: (SubagentInfo) -> Unit,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        subagents.forEach { subagent ->
            SubagentChip(subagent, onClick = { onSelectSubagent(subagent) })
        }
    }
}

@Composable
private fun SubagentChip(subagent: SubagentInfo, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    val live = subagent.source != SubagentSource.HISTORY
    val running = subagent.running
    val stateLabel = stringResource(
        when (subagent.status) {
            SubagentStatus.STARTED -> R.string.panels_subagent_state_started
            SubagentStatus.COMPLETED -> R.string.panels_subagent_state_completed
            SubagentStatus.FAILED -> R.string.panels_subagent_state_failed
            SubagentStatus.ABORTED -> R.string.panels_subagent_state_aborted
        },
    )
    val headline = subagent.headline.orEmpty()
    val label = buildString {
        append(subagent.agent)
        append(" · ")
        append(stateLabel)
        if (headline.isNotEmpty()) {
            append(" · ")
            append(headline)
        }
    }
    // The last progress frame reports how long this run already lasted; the
    // chip keeps that number moving instead of freezing between frames.
    val progressDuration = subagent.progress?.durationMs
    val startedAt = remember(subagent.lastUpdate, progressDuration) {
        val lastUpdate = subagent.lastUpdate
        if (lastUpdate != null && progressDuration != null) lastUpdate - progressDuration else null
    }
    Surface(
        modifier = Modifier
            .widthIn(max = 320.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        color = colors.background,
        contentColor = if (live && running) colors.text else colors.textDim,
        shape = RoundedCornerShape(OmpCardRadius),
        border = BorderStroke(
            1.dp,
            if (running) colors.accent.copy(alpha = 0.55f) else colors.border,
        ),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (running) {
                    LivePulseDot(size = 9.dp)
                } else {
                    StatusGlyph(
                        kind = when (subagent.status) {
                            SubagentStatus.STARTED -> GlyphKind.RUNNING
                            SubagentStatus.COMPLETED -> GlyphKind.COMPLETED
                            SubagentStatus.FAILED -> GlyphKind.FAILED
                            SubagentStatus.ABORTED -> GlyphKind.ABORTED
                        },
                        tint = when (subagent.status) {
                            SubagentStatus.FAILED -> colors.statusError
                            else -> colors.textDim
                        },
                    )
                }
                Text(
                    text = subagent.agent,
                    color = if (running) colors.accent else colors.textMuted,
                    fontSize = 10.5.sp,
                    fontFamily = OmpMonoFontFamily,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Text(
                    text = headline.ifEmpty { stateLabel },
                    modifier = Modifier.weight(1f, fill = false),
                    color = if (live && running) colors.text else colors.textDim,
                    fontSize = 11.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                ElapsedText(
                    startedAt = startedAt,
                    running = running,
                    settledMs = progressDuration?.takeIf { it > 0 },
                    color = if (running) colors.accent else colors.textDim,
                    fontSize = 10.sp,
                )
                if (subagent.detached == true) {
                    val detachedLabel = stringResource(R.string.panels_subagent_detached)
                    Text(
                        text = "⤴",
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontFamily = OmpMonoFontFamily,
                        modifier = Modifier.semantics {
                            contentDescription = detachedLabel
                        },
                    )
                }
            }
            SubagentActivityLine(subagent)
        }
    }
}

/**
 * Icon-first telemetry under the chip label (web `SubagentActivityLine`):
 * retry state while backing off, work intent while running, and the compact
 * token/cost/context/model/duration metrics.
 */
@Composable
private fun SubagentActivityLine(subagent: SubagentInfo) {
    val colors = LocalOmpColors.current
    val progress = subagent.progress
    val retryState = progress?.retryState
    val retryFailure = progress?.retryFailure
    val retryActive = retryState != null || retryFailure != null
    val metrics = ArrayList<String>(7)
    if (retryActive) {
        val attempt = retryState?.attempt ?: retryFailure?.attempt ?: 0
        val max = retryState?.maxAttempts ?: 0
        metrics += if (max > 0) {
            stringResource(R.string.panels_subagent_retrying, attempt, max)
        } else {
            stringResource(R.string.panels_subagent_retry_attempt, attempt)
        }
    } else if (subagent.status == SubagentStatus.STARTED) {
        val activity = when {
            progress?.currentTool != null && progress.lastIntent != null ->
                "${progress.currentTool} — ${progress.lastIntent}"
            progress?.currentTool != null -> progress.currentTool
            else -> progress?.lastIntent
        }
        if (!activity.isNullOrBlank()) metrics += activity
    }
    // Web `SubagentActivityLine`: the origin chip is shown unless the agent is
    // bundled. Text-only here, so the wire label stands in for its icon.
    subagent.agentSource
        ?.takeIf { it != SubagentAgentSource.BUNDLED }
        ?.let { metrics += it.wireName }
    val nested = countNestedSubagents(progress)
    if (nested > 0) metrics += stringResource(R.string.panels_subagent_nested, nested)
    formatTokens(progress?.tokens)?.let { tokens ->
        metrics += stringResource(R.string.panels_tokens_unit, tokens)
    }
    formatCost(progress?.cost)?.let { metrics += it }
    val contextTokens = formatTokens(progress?.contextTokens)
    if (contextTokens != null) {
        metrics += stringResource(
            R.string.panels_context_gauge,
            contextTokens,
            formatTokens(progress?.contextWindow) ?: "?",
        )
    }
    shortModel(progress?.resolvedModel)?.let { metrics += it }
    if (metrics.isEmpty()) return
    Text(
        text = metrics.joinToString(" · "),
        color = if (retryActive) colors.accent else colors.textDim,
        fontSize = 10.5.sp,
        fontFamily = OmpMonoFontFamily,
        lineHeight = 15.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 20.dp, top = 1.dp),
    )
}
