package io.github.kahme247.ompweb.ui.composer.controls

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.ContextTone
import io.github.kahme247.ompweb.domain.ContextUsageInfo
import io.github.kahme247.ompweb.domain.UsageLimit
import io.github.kahme247.ompweb.domain.contextTone
import io.github.kahme247.ompweb.domain.formatAllowancePercent
import io.github.kahme247.ompweb.domain.formatSlowModeResetClock
import io.github.kahme247.ompweb.domain.usageLimitLabel
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import kotlin.math.round

/**
 * The composer's controls row: model picker trigger, reasoning ladder, Fast /
 * Slow / Advisor toggles, the provider usage-limit badge and the context ring
 * that opens [ContextDetailSheet].
 *
 * Everything is read from [ComposerControlsViewModel]; the row never issues a
 * server call itself. While [streaming] the model and reasoning controls are
 * disabled, exactly like the web (`modelSelectorDisabled = isStreaming`).
 */
@Composable
fun ComposerControlsRow(
    vm: ComposerControlsViewModel,
    streaming: Boolean,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    var pickerOpen by rememberSaveable { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            RowControl(
                onClick = { pickerOpen = true },
                enabled = !streaming && !(state.modelsLoading && state.models.isEmpty()),
                active = false,
                contentDescription = stringResource(R.string.controls_change_model),
            ) {
                Text(
                    text = state.modelLabel ?: stringResource(R.string.controls_select_model),
                    color = if (state.modelLabel != null) colors.textMuted else colors.textDim,
                    fontSize = 11.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 150.dp),
                )
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = colors.textDim,
                    modifier = Modifier.size(12.dp),
                )
            }

            if (state.thinkingSupported) {
                ThinkingLevelControl(state = state, streaming = streaming, onSelect = vm::onThinkingLevelChange)
            }

            if (state.fastModeSupported) {
                val inert = state.fastModeEnabled && state.fastModeActive == false
                RowControl(
                    onClick = { if (!streaming) vm.onFastModeChange(!state.fastModeEnabled) },
                    enabled = !streaming,
                    active = state.fastModeEnabled,
                    tint = if (inert) colors.statusWarning else null,
                    contentDescription = stringResource(R.string.controls_fast_title),
                ) {
                    Text(
                        text = stringResource(R.string.controls_fast),
                        color = when {
                            inert -> colors.statusWarning
                            state.fastModeEnabled -> colors.accent
                            else -> colors.textMuted
                        },
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }

            if (state.slowModeSupported) {
                RowControl(
                    onClick = { if (!streaming) vm.onSlowModeChange(!state.slowModeEnabled) },
                    enabled = !streaming,
                    active = state.slowModeEnabled,
                    contentDescription = stringResource(
                        if (state.slowModeScope == "global") {
                            R.string.controls_slow_title_global
                        } else {
                            R.string.controls_slow_title_session
                        },
                    ),
                ) {
                    Text(
                        text = stringResource(R.string.controls_slow),
                        color = if (state.slowModeEnabled) colors.accent else colors.textMuted,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }

            RowControl(
                onClick = { vm.onAdvisorChange(!state.advisorEnabled) },
                enabled = true,
                active = state.advisorEnabled,
                contentDescription = stringResource(
                    if (state.advisorEnabled) {
                        R.string.controls_advisor_disable
                    } else {
                        R.string.controls_advisor_enable
                    },
                ),
            ) {
                Text(
                    text = stringResource(R.string.controls_advisor),
                    color = if (state.advisorEnabled) colors.accent else colors.textMuted,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.Medium,
                )
            }

            state.usageLimit?.let { limit ->
                UsageLimitBadge(limit = limit, modifier = Modifier.padding(start = 2.dp))
            }
        }

        ContextRingButton(
            usage = state.shownContextUsage,
            compacting = state.isCompacting,
            onClick = vm::openContextSheet,
        )
    }

    if (pickerOpen) {
        ModelPickerDialog(
            state = state,
            onDismiss = { pickerOpen = false },
            onSelect = { provider, modelId ->
                pickerOpen = false
                vm.onSelectModel(provider, modelId)
            },
        )
    }
}

/** The reasoning ladder: trigger label + a card menu, hidden by the caller when unsupported. */
@Composable
private fun ThinkingLevelControl(
    state: ComposerControlsState,
    streaming: Boolean,
    onSelect: (String) -> Unit,
) {
    val colors = LocalOmpColors.current
    var open by remember { mutableStateOf(false) }
    Box {
        RowControl(
            onClick = { if (!streaming) open = true },
            enabled = !streaming,
            active = open,
            contentDescription = stringResource(R.string.controls_change_reasoning),
        ) {
            Text(
                text = levelLabel(state.thinkingLevel),
                color = colors.textMuted,
                fontSize = 11.5.sp,
                maxLines = 1,
            )
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = colors.textDim,
                modifier = Modifier.size(12.dp),
            )
        }
        OmpDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = colors.panel,
            modifier = Modifier.widthIn(min = 170.dp),
        ) {
            Text(
                text = stringResource(R.string.controls_reasoning),
                color = colors.textDim,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            )
            state.thinkingLevelOptions.forEach { level ->
                val active = state.thinkingLevel == level
                DropdownMenuItem(
                    text = {
                        Text(
                            text = levelLabel(level),
                            color = if (active) colors.text else colors.textMuted,
                            fontSize = 12.sp,
                        )
                    },
                    leadingIcon = if (active) {
                        {
                            Icon(
                                imageVector = Icons.Filled.Check,
                                contentDescription = null,
                                tint = colors.accent,
                                modifier = Modifier.size(13.dp),
                            )
                        }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        if (!active && !streaming) onSelect(level)
                    },
                )
            }
            Text(
                text = stringResource(R.string.controls_applies_next_prompt),
                color = colors.textDim,
                fontSize = 10.sp,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun UsageLimitBadge(limit: UsageLimit, modifier: Modifier = Modifier) {
    val colors = LocalOmpColors.current
    val now = remember(limit) { System.currentTimeMillis() }
    val label = usageLimitLabel(limit, now)
    val text = when (label) {
        is io.github.kahme247.ompweb.domain.UsageLimitLabel.LowPriority -> {
            val time = label.resetAtMillis?.let(::resetClock)
            val percent = label.allowancePercent?.let(::formatAllowancePercent)
            when {
                time != null && percent != null ->
                    stringResource(R.string.controls_usage_low_priority_allowance, time, percent)

                time != null -> stringResource(R.string.controls_usage_low_priority, time)
                percent != null ->
                    stringResource(R.string.controls_usage_low_priority_allowance_only, percent)

                else -> stringResource(R.string.controls_usage_low_priority_no_reset)
            }
        }

        is io.github.kahme247.ompweb.domain.UsageLimitLabel.WrapUp -> {
            val time = label.resetAtMillis?.let(::resetClock)
            when {
                label.extraUsage -> stringResource(R.string.controls_usage_wrap_up_extra)
                time != null -> stringResource(R.string.controls_usage_wrap_up_reset, time)
                else -> stringResource(R.string.controls_usage_wrap_up)
            }
        }
    }
    Surface(
        color = colors.statusWarning.copy(alpha = 0.12f),
        shape = RoundedCornerShape(7.dp),
        modifier = modifier.heightIn(min = 24.dp),
    ) {
        Box(modifier = Modifier.padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
            Text(
                text = text,
                color = colors.statusWarning,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** The session-information ring: percent inside, compacting spinner, tap opens the sheet. */
@Composable
private fun ContextRingButton(
    usage: ContextUsageInfo?,
    compacting: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val percent = usage?.percent
    val tone = when (contextTone(percent)) {
        ContextTone.ERROR -> colors.statusError
        ContextTone.WARNING -> colors.statusWarning
        ContextTone.NORMAL -> colors.textDim
    }
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (compacting) {
            CircularProgressIndicator(
                modifier = Modifier.size(15.dp),
                strokeWidth = 2.dp,
                color = colors.accent,
            )
        } else {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = 2.5.dp.toPx()
                val radius = (size.minDimension - stroke) / 2f
                val center = Offset(size.width / 2f, size.height / 2f)
                drawCircle(
                    color = colors.border,
                    radius = radius,
                    center = center,
                    style = Stroke(width = stroke),
                )
                if (percent != null) {
                    val sweep = 360f * (percent.coerceIn(0.0, 100.0) / 100.0).toFloat()
                    drawArc(
                        color = tone,
                        startAngle = -90f,
                        sweepAngle = sweep,
                        useCenter = false,
                        topLeft = Offset(
                            center.x - radius,
                            center.y - radius,
                        ),
                        size = Size(radius * 2, radius * 2),
                        style = Stroke(width = stroke, cap = StrokeCap.Round),
                    )
                }
            }
            if (percent != null) {
                Text(
                    text = round(percent).toInt().toString(),
                    color = tone,
                    fontSize = 7.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = OmpMonoFontFamily,
                )
            }
        }
    }
}

/** One flat control: a compact tappable label with an active tint. */
@Composable
private fun RowControl(
    onClick: () -> Unit,
    enabled: Boolean,
    active: Boolean,
    contentDescription: String,
    tint: Color? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalOmpColors.current
    Surface(
        color = if (active) colors.selected else Color.Transparent,
        shape = RoundedCornerShape(7.dp),
        modifier = Modifier
            // 48 dp: the web row is compact, but the Android touch target and
            // a 200 % font scale need the full minimum height.
            .heightIn(min = 48.dp)
            .clickable(
                enabled = enabled,
                onClickLabel = contentDescription,
                onClick = onClick,
            ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            content()
        }
    }
}

/** Web `thinkingDisplayLabel`: the level name, headline-cased. */
private fun levelLabel(level: String): String =
    level.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }

private fun resetClock(millis: Long): String =
    formatSlowModeResetClock(millis, System.currentTimeMillis())

/** A provider avatar with the provider's initials (`ProviderBadge`). */
@Composable
internal fun ProviderBadge(id: String, size: Int = 16) {
    val colors = LocalOmpColors.current
    Box(
        modifier = Modifier
            .size(size.dp)
            .border(1.dp, colors.border, RoundedCornerShape(4.dp))
            .background(colors.background),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = io.github.kahme247.ompweb.domain.providerInitials(id),
            color = colors.textDim,
            fontSize = (size * 0.42f).sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}
