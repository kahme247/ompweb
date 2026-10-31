package io.github.kahme247.ompweb.ui.composer.dictation

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.DictationEngine
import io.github.kahme247.ompweb.domain.DictationMachine
import io.github.kahme247.ompweb.domain.DictationPlayback
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import java.util.Locale
import kotlin.math.max

/**
 * The composer's mic button (web `ChatInput` dictation toggle). It requests
 * `RECORD_AUDIO` with a rationale before the first recording; screen
 * visibility (adoption loop, ON_STOP for live dictation) is reported by the
 * composer shell, which stays mounted in every dictation state.
 */
@Composable
fun MicButton(
    vm: DictationViewModel,
    enabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val colors = LocalOmpColors.current
    var asking by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.start(SttAfter.Insert) else vm.onPermissionDenied()
    }
    val busy = state !is DictationState.Idle && state !is DictationState.Gone
    val available = enabled && !busy
    val label = stringResource(R.string.dictation_start)

    Box(
        modifier = modifier
            .size(28.dp)
            .clip(RoundedCornerShape(7.dp))
            .clickable(enabled = available, role = Role.Button, onClickLabel = label) {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                if (granted) vm.start(SttAfter.Insert) else asking = true
            }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = MicIcon,
            contentDescription = null,
            tint = if (available) colors.textMuted else colors.textDim,
            modifier = Modifier.size(16.dp),
        )
    }

    if (asking) {
        val usesPhone = vm.nextEngine() == DictationEngine.ON_DEVICE
        // "On this phone" without an installed model fails on start, so the
        // dialog shows that error instead of promising on-device processing
        // and asking for a microphone it cannot use.
        val missingModel = usesPhone && !vm.onDeviceReady
        val rationale = when {
            !usesPhone -> R.string.dictation_permission_rationale
            missingModel -> R.string.dictation_error_no_recognizer
            else -> R.string.dictation_permission_rationale_on_device
        }
        OmpAlertDialog(
            onDismissRequest = { asking = false },
            title = { Text(stringResource(R.string.dictation_permission_title)) },
            text = { Text(stringResource(rationale)) },
            confirmButton = {
                if (missingModel) {
                    TextButton(onClick = { asking = false }) {
                        Text(stringResource(R.string.common_close))
                    }
                } else {
                    TextButton(
                        onClick = {
                            asking = false
                            launcher.launch(Manifest.permission.RECORD_AUDIO)
                        },
                    ) { Text(stringResource(R.string.dictation_permission_allow)) }
                }
            },
            dismissButton = if (missingModel) {
                null
            } else {
                {
                    TextButton(
                        onClick = {
                            asking = false
                            vm.onPermissionDenied()
                        },
                    ) { Text(stringResource(R.string.dictation_permission_later)) }
                }
            },
        )
    }
}

/**
 * The recording deck that replaces the text field while dictation is active
 * (web `components/RecordingDeck.tsx`): timer + level waveform + pause/stop/
 * cancel while capturing, an indeterminate bar while uploading/transcribing
 * (with playback), and message + play/retry/discard after a failure.
 */
@Composable
fun RecordingDeck(vm: DictationViewModel, modifier: Modifier = Modifier) {
    val state by vm.state.collectAsStateWithLifecycle()
    val playback by vm.playback.collectAsStateWithLifecycle()
    // Delegated state cannot be smart-cast; the failed row needs both fields.
    val playing = playback as? DictationPlayback.Playing
    val levels = remember { mutableStateListOf<Float>() }

    LaunchedEffect(state) {
        when (val current = state) {
            is DictationState.Recording -> {
                levels.add(current.level)
                while (levels.size > MAX_WAVE_BARS) levels.removeAt(0)
            }
            DictationState.Idle, DictationState.Gone -> levels.clear()
            else -> Unit
        }
    }

    when (val current = state) {
        DictationState.Idle, DictationState.Gone -> Unit
        is DictationState.Live -> Unit
        is DictationState.Recording -> DeckShell(modifier) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (current.paused) LocalOmpColors.current.textMuted else LocalOmpColors.current.statusError),
                )
                Text(
                    text = formatTime(current.elapsedMs),
                    color = LocalOmpColors.current.text,
                    fontFamily = OmpMonoFontFamily,
                    fontSize = 12.sp,
                )
                Waveform(levels, current.paused, Modifier.weight(1f).height(24.dp))
                DeckButton(
                    description = stringResource(
                        if (current.paused) R.string.dictation_resume else R.string.dictation_pause,
                    ),
                    tone = if (current.paused) DeckTone.Accent else DeckTone.Neutral,
                    onClick = { if (current.paused) vm.resume() else vm.pause() },
                ) {
                    if (current.paused) {
                        Icon(MicIcon, contentDescription = null, tint = LocalOmpColors.current.accent, modifier = Modifier.size(14.dp))
                    } else {
                        PauseGlyph(LocalOmpColors.current.textMuted)
                    }
                }
                DeckButton(
                    description = stringResource(R.string.dictation_stop),
                    onClick = { vm.stop() },
                ) {
                    StopGlyph(LocalOmpColors.current.textMuted)
                }
                DeckButton(
                    description = stringResource(R.string.dictation_cancel),
                    tone = DeckTone.Danger,
                    onClick = { vm.cancel() },
                ) {
                    Icon(Icons.Filled.Close, contentDescription = null, tint = LocalOmpColors.current.statusError, modifier = Modifier.size(14.dp))
                }
            }
            CaptureProgress(current.elapsedMs)
        }

        is DictationState.Uploading -> DeckShell(modifier) {
            BusyRow(
                label = stringResource(R.string.dictation_uploading),
                vm = vm,
                playback = playback,
                trailing = formatTime(current.elapsedMs),
            )
        }

        is DictationState.Transcribing -> DeckShell(modifier) {
            BusyRow(
                label = stringResource(R.string.dictation_transcribing),
                vm = vm,
                playback = playback,
                trailing = formatTime(current.elapsedMs),
            )
        }

        is DictationState.Failed -> DeckShell(modifier) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (vm.canPlay()) {
                    DeckButton(
                        description = stringResource(
                            if (playing?.paused == false) {
                                R.string.dictation_pause_playback
                            } else {
                                R.string.dictation_play
                            },
                        ),
                        onClick = { vm.playPause() },
                    ) {
                        PlayGlyph(playback, LocalOmpColors.current.textMuted)
                    }
                }
                Icon(
                    Icons.Filled.Warning,
                    contentDescription = null,
                    tint = LocalOmpColors.current.statusError,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = current.message,
                    color = LocalOmpColors.current.text,
                    fontSize = 12.sp,
                    maxLines = 2,
                    modifier = Modifier.weight(1f),
                )
                DeckButton(
                    description = stringResource(R.string.dictation_discard),
                    tone = DeckTone.Danger,
                    onClick = { vm.discard() },
                ) {
                    Icon(Icons.Filled.Delete, contentDescription = null, tint = LocalOmpColors.current.statusError, modifier = Modifier.size(14.dp))
                }
                if (current.canRetry) {
                    DeckButton(
                        description = stringResource(R.string.dictation_retry),
                        tone = DeckTone.Accent,
                        onClick = { vm.retry() },
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = null, tint = LocalOmpColors.current.accent, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun BusyRow(
    label: String,
    vm: DictationViewModel,
    playback: DictationPlayback,
    trailing: String,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (vm.canPlay()) {
                DeckButton(
                    description = stringResource(
                        if (playback is DictationPlayback.Playing && !playback.paused) {
                            R.string.dictation_pause_playback
                        } else {
                            R.string.dictation_play
                        },
                    ),
                    onClick = { vm.playPause() },
                ) {
                    PlayGlyph(playback, LocalOmpColors.current.textMuted)
                }
            }
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 1.8.dp,
                color = LocalOmpColors.current.accent,
            )
            Text(text = label, color = LocalOmpColors.current.textMuted, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(
                text = if (playback is DictationPlayback.Playing) {
                    stringResource(
                        R.string.dictation_progress,
                        formatTime(playback.positionMs),
                        formatTime(playback.durationMs),
                    )
                } else {
                    trailing
                },
                color = LocalOmpColors.current.text,
                fontFamily = OmpMonoFontFamily,
                fontSize = 12.sp,
            )
            DeckButton(
                description = stringResource(R.string.dictation_cancel),
                tone = DeckTone.Danger,
                onClick = { vm.cancel() },
            ) {
                Icon(Icons.Filled.Close, contentDescription = null, tint = LocalOmpColors.current.statusError, modifier = Modifier.size(14.dp))
            }
        }
        LinearProgressIndicator(
            modifier = Modifier.fillMaxWidth().height(2.dp),
            color = LocalOmpColors.current.accent,
            trackColor = LocalOmpColors.current.border,
        )
    }
}

@Composable
private fun CaptureProgress(elapsedMs: Long) {
    val fraction = (elapsedMs.toFloat() / DictationMachine.MAX_RECORDING_MS).coerceIn(0f, 1f)
    Column(Modifier.fillMaxWidth()) {
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth().height(2.dp),
            color = LocalOmpColors.current.statusError,
            trackColor = LocalOmpColors.current.border,
        )
    }
}

@Composable
private fun DeckShell(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

private enum class DeckTone { Neutral, Accent, Danger }

@Composable
private fun DeckButton(
    description: String,
    onClick: () -> Unit,
    tone: DeckTone = DeckTone.Neutral,
    content: @Composable () -> Unit,
) {
    val colors = LocalOmpColors.current
    val shape = RoundedCornerShape(7.dp)
    val borderColor = when (tone) {
        DeckTone.Danger -> colors.statusError
        DeckTone.Accent -> colors.accent
        DeckTone.Neutral -> colors.border
    }
    val background = when (tone) {
        DeckTone.Danger -> colors.statusError.copy(alpha = 0.15f)
        DeckTone.Accent -> colors.accent.copy(alpha = 0.15f)
        DeckTone.Neutral -> Color.Transparent
    }
    Box(
        modifier = Modifier
            .size(28.dp)
            .clip(shape)
            .background(background)
            .border(1.dp, borderColor, shape)
            .clickable(role = Role.Button, onClickLabel = description, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun Waveform(levels: List<Float>, paused: Boolean, modifier: Modifier) {
    val color = if (paused) LocalOmpColors.current.textMuted else LocalOmpColors.current.statusError
    Canvas(modifier) {
        val gap = 2.dp.toPx()
        val barWidth = 3.dp.toPx()
        val count = max(1, ((size.width + gap) / (barWidth + gap)).toInt()).coerceAtMost(MAX_WAVE_BARS)
        val visible = levels.takeLast(count)
        val offset = size.width - visible.size * (barWidth + gap) + gap
        visible.forEachIndexed { index, level ->
            val barHeight = max(2.dp.toPx(), level * size.height)
            drawRoundRect(
                color = color,
                topLeft = Offset(offset + index * (barWidth + gap), (size.height - barHeight) / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = CornerRadius(barWidth / 2f),
            )
        }
    }
}

@Composable
private fun PlayGlyph(playback: DictationPlayback, tint: Color) {
    val playing = playback is DictationPlayback.Playing && !playback.paused
    if (playing) {
        PauseGlyph(tint)
    } else {
        Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = tint, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun PauseGlyph(tint: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(Modifier.width(2.dp).height(9.dp).background(tint))
        Box(Modifier.width(2.dp).height(9.dp).background(tint))
    }
}

@Composable
private fun StopGlyph(tint: Color) {
    Box(Modifier.size(8.dp).clip(RoundedCornerShape(1.5.dp)).background(tint))
}

/**
 * Screen visibility for the adoption loop and for ending a live capture when
 * the composer leaves the foreground ([DictationViewModel.setVisible]).
 * Composed once by the composer shell, which stays mounted for every dictation
 * state — including `Live`, where neither the mic button nor the deck exists.
 */
@Composable
internal fun ReportVisibility(vm: DictationViewModel) {
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> vm.setVisible(true)
                Lifecycle.Event.ON_STOP -> {
                    // A backgrounded recorder keeps capturing without a UI;
                    // finish the capture so it uploads instead of leaking.
                    if (vm.state.value is DictationState.Recording) vm.stop()
                    vm.setVisible(false)
                }
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        vm.setVisible(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
}

internal fun formatTime(ms: Long): String {
    val total = (ms.coerceAtLeast(0) / 1000).toInt()
    val minutes = total / 60
    val seconds = total % 60
    return String.format(Locale.ROOT, "%d:%02d", minutes, seconds)
}

private const val MAX_WAVE_BARS = 64

/** Material's microphone glyph (the core icon set ships no `Mic`). */
private val MicIcon: ImageVector = ImageVector.Builder(
    name = "Mic",
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(fill = SolidColor(Color.Black)) {
        moveTo(12f, 14f)
        curveTo(13.66f, 14f, 15f, 12.66f, 15f, 11f)
        verticalLineTo(5f)
        curveTo(15f, 3.34f, 13.66f, 2f, 12f, 2f)
        curveTo(10.34f, 2f, 9f, 3.34f, 9f, 5f)
        verticalLineTo(11f)
        curveTo(9f, 12.66f, 10.34f, 14f, 12f, 14f)
        close()
        moveTo(17f, 11f)
        curveTo(17f, 13.76f, 14.76f, 16f, 12f, 16f)
        curveTo(9.24f, 16f, 7f, 13.76f, 7f, 11f)
        lineTo(5f, 11f)
        curveTo(5f, 14.53f, 7.61f, 17.43f, 11f, 17.92f)
        verticalLineTo(21f)
        lineTo(13f, 21f)
        verticalLineTo(17.92f)
        curveTo(16.39f, 17.43f, 19f, 14.53f, 19f, 11f)
        close()
    }
}.build()
