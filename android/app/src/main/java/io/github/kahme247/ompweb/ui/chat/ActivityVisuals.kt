package io.github.kahme247.ompweb.ui.chat

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import io.github.kahme247.ompweb.chat.TranscriptFormat
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.delay

/**
 * The pulse that marks a running activity (tool card, folded process row,
 * subagent chip, composer status line). A static dot when the platform asks
 * for reduced motion.
 */
@Composable
internal fun LivePulseDot(
    modifier: Modifier = Modifier,
    size: Dp = 7.dp,
    color: Color = LocalOmpColors.current.accent,
    animate: Boolean = LocalChatMotion.current,
) {
    val alpha = if (animate) {
        val transition = rememberInfiniteTransition(label = "live-pulse")
        val pulse by transition.animateFloat(
            initialValue = 0.3f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 900, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "live-pulse-alpha",
        )
        pulse
    } else {
        1f
    }
    Box(
        modifier
            .size(size)
            .background(color.copy(alpha = alpha), CircleShape),
    )
}

/**
 * The tool family's icon and tint, mirroring the web `ToolCategoryIcon`: the
 * same nine families, each in the palette token the web uses for it. Only
 * `material-icons-core` ships with the app, so the nearest core glyph stands
 * in for the web's lucide icon.
 */
@Composable
internal fun ToolCategoryIcon(
    toolName: String,
    modifier: Modifier = Modifier,
    size: Dp = 13.dp,
) {
    val colors = LocalOmpColors.current
    val category = getToolCategory(toolName)
    val (icon, tint) = when (category) {
        ToolCategory.Read -> Icons.AutoMirrored.Filled.List to colors.statusRenamed
        ToolCategory.Search -> Icons.Filled.Search to colors.accent
        ToolCategory.Edit -> Icons.Filled.Edit to colors.statusModified
        ToolCategory.Terminal -> Icons.Filled.PlayArrow to colors.statusSuccess
        ToolCategory.Todo -> Icons.Filled.CheckCircle to colors.accent
        ToolCategory.Task -> Icons.Filled.Person to (colors.secondaryAccent ?: colors.accent)
        ToolCategory.Code -> Icons.Filled.Settings to colors.accent
        ToolCategory.Web -> Icons.Filled.Place to (colors.secondaryAccent ?: colors.accent)
        ToolCategory.Hub -> Icons.Filled.Email to (colors.secondaryAccent ?: colors.accent)
        ToolCategory.Other -> Icons.Filled.Build to colors.textMuted
    }
    ToolIcon(icon = icon, tint = tint, modifier = modifier, size = size)
}

@Composable
private fun ToolIcon(icon: ImageVector, tint: Color, modifier: Modifier, size: Dp) {
    Icon(
        imageVector = icon,
        contentDescription = null,
        modifier = modifier.size(size),
        tint = tint,
    )
}

/**
 * Elapsed time of a running activity, ticking once a second while [running].
 * Null while it is not running, so a settled row uses its recorded duration.
 * The ticker only runs while the screen is STARTED: a card that stays composed
 * in the background no longer wakes the compositor every second.
 */
@Composable
private fun rememberElapsedMs(startedAt: Long?, running: Boolean): Long? {
    if (!running || startedAt == null) return null
    val clock = LocalChatClock.current
    val started = LocalLifecycleOwner.current.lifecycle
        .currentStateAsState()
        .value
        .isAtLeast(Lifecycle.State.STARTED)
    var now by remember(startedAt, clock) { mutableLongStateOf(clock()) }
    LaunchedEffect(startedAt, clock, started) {
        if (!started) return@LaunchedEffect
        while (true) {
            now = clock()
            delay(1_000)
        }
    }
    return (now - startedAt).coerceAtLeast(0)
}

/**
 * A duration that ticks while [running] and shows [settledMs] once settled.
 * The tick is read inside this composable, so only this text recomposes every
 * second — the tool card, fold or footer around it stays skippable.
 */
@Composable
internal fun ElapsedText(
    startedAt: Long?,
    running: Boolean,
    settledMs: Long? = null,
    modifier: Modifier = Modifier,
    color: Color = LocalOmpColors.current.textDim,
    fontSize: TextUnit = 10.sp,
    textAlign: TextAlign? = null,
    prefix: String = "",
) {
    val elapsed = rememberElapsedMs(startedAt, running)
    val text = when {
        running -> elapsed?.let(TranscriptFormat::formatElapsedShort)
        else -> settledMs?.let(TranscriptFormat::formatElapsedShort)
    } ?: return
    Text(
        text = prefix + text,
        modifier = modifier,
        color = color,
        fontSize = fontSize,
        textAlign = textAlign,
        maxLines = 1,
    )
}
