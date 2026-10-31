package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.chat.TranscriptRow
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/**
 * Fast-scroll rail (web `ChatMinimap`): a proportional thumb plus one tick per
 * user turn. Dragging jumps straight to the matching row, so long sessions can
 * be scrubbed without loading every earlier page.
 */
@Composable
internal fun ChatScrollRail(
    listState: LazyListState,
    totalItems: Int,
    userTurns: List<Int>,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val trackWidth = with(density) { 3.dp.toPx() }
    val thumbMin = with(density) { 24.dp.toPx() }

    Box(
        modifier = modifier
            .width(16.dp)
            .fillMaxHeight()
            .pointerInput(totalItems) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    fun jump(y: Float) {
                        if (totalItems <= 1) return
                        val fraction = (y / size.height.toFloat()).coerceIn(0f, 1f)
                        val target = (fraction * (totalItems - 1)).roundToInt()
                        scope.launch { listState.scrollToItem(target) }
                    }
                    jump(down.position.y)
                    down.consume()
                    drag(down.id) { change ->
                        jump(change.position.y)
                        change.consume()
                    }
                }
            },
    ) {
        val layout = listState.layoutInfo
        val visible = layout.visibleItemsInfo
        val first = visible.firstOrNull()?.index
        val last = visible.lastOrNull()?.index
        val drawState = remember(layout, totalItems) {
            if (first == null || last == null || totalItems <= 1) {
                null
            } else {
                Triple(first, last, totalItems)
            }
        }
        Canvas(modifier = Modifier.fillMaxHeight().width(16.dp)) {
            if (totalItems <= 1) return@Canvas
            val height = size.height
            val centerX = size.width / 2f
            drawRoundRect(
                color = colors.border,
                topLeft = Offset(centerX - trackWidth / 2f, 0f),
                size = Size(trackWidth, height),
                cornerRadius = CornerRadius(trackWidth / 2f),
            )
            userTurns.forEach { index ->
                val y = (index.toFloat() / (totalItems - 1)) * height
                drawCircle(
                    color = colors.textDim.copy(alpha = 0.65f),
                    radius = 1.6.dp.toPx(),
                    center = Offset(centerX, y),
                )
            }
            if (drawState != null) {
                val (firstIndex, lastIndex, total) = drawState
                val visibleCount = (lastIndex - firstIndex + 1).coerceAtLeast(1)
                val thumbHeight = (height * visibleCount / total)
                    .coerceAtLeast(thumbMin)
                    .coerceAtMost(height)
                val maxTop = height - thumbHeight
                val top = if (total <= visibleCount) {
                    0f
                } else {
                    (firstIndex.toFloat() / (total - visibleCount)) * maxTop
                }
                drawRoundRect(
                    color = colors.accent.copy(alpha = 0.8f),
                    topLeft = Offset(centerX - 2.dp.toPx(), top),
                    size = Size(4.dp.toPx(), thumbHeight),
                    cornerRadius = CornerRadius(2.dp.toPx()),
                )
            }
        }
    }
}

/** Rendered LazyColumn indices of every row that starts a user turn. */
internal fun userTurnIndices(rows: List<TranscriptRow>, rowsToItem: Int = 1): List<Int> =
    rows.mapIndexedNotNull { index, row ->
        when (row) {
            is TranscriptRow.Message -> if (row.message is io.github.kahme247.ompweb.chat.ChatMessage.User) {
                index + rowsToItem
            } else {
                null
            }

            is TranscriptRow.Group -> index + rowsToItem
        }
    }
