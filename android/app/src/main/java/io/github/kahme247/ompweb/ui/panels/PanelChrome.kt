package io.github.kahme247.ompweb.ui.panels

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpCardRadius

/** The composer-attached panels share one card frame (web `bg-bg-subtle` + border). */
@Composable
internal fun PanelCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = colors.backgroundSubtle,
        contentColor = colors.text,
        shape = RoundedCornerShape(OmpCardRadius),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(content = content)
    }
}

/** Collapsible header row: title, live summary, chevron (web panel header). */
@Composable
internal fun PanelHeader(
    title: String,
    collapsed: Boolean,
    onToggle: () -> Unit,
    summary: String,
    modifier: Modifier = Modifier,
    icon: (@Composable () -> Unit)? = null,
) {
    val colors = LocalOmpColors.current
    val rotation by animateFloatAsState(if (collapsed) -90f else 0f, label = "panel-chevron")
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics { heading() }
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        icon?.invoke()
        Text(
            text = title,
            color = colors.text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
        Text(
            text = summary,
            modifier = Modifier.weight(1f),
            color = colors.textMuted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
        )
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = stringResource(
                if (collapsed) R.string.panels_expand_panel else R.string.panels_collapse_panel,
            ),
            tint = colors.textDim,
            modifier = Modifier.size(16.dp).rotate(rotation),
        )
    }
}

/** The body cap both attached panels use (web `max-height: min(30vh, 240px)`). */
@Composable
internal fun panelBodyMaxHeight(): Dp {
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    return (screenHeight * 0.30f).coerceAtMost(240.dp)
}

/** Height-capped, independently scrolling panel body. */
@Composable
internal fun PanelBody(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = panelBodyMaxHeight())
            .verticalScroll(rememberScrollState())
            .padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 10.dp),
        content = content,
    )
}

/** A 1 dp separator line matching the panel borders. */
@Composable
internal fun PanelDivider() {
    val colors = LocalOmpColors.current
    Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
}

/** Small status glyphs; only `material-icons-core` ships, so circles are drawn. */
internal enum class GlyphKind { PENDING, IN_PROGRESS, COMPLETED, BLOCKED, ABANDONED, RUNNING, FAILED, ABORTED }

@Composable
internal fun StatusGlyph(kind: GlyphKind, tint: Color? = null) {
    val colors = LocalOmpColors.current
    val color = tint ?: when (kind) {
        GlyphKind.COMPLETED, GlyphKind.IN_PROGRESS, GlyphKind.RUNNING -> colors.accent
        GlyphKind.BLOCKED -> colors.textMuted
        GlyphKind.FAILED -> colors.statusError
        GlyphKind.ABANDONED, GlyphKind.PENDING, GlyphKind.ABORTED -> colors.textDim
    }
    val background = colors.background
    val strokePx = 1.6.dp
    Canvas(Modifier.size(14.dp)) {
        val stroke = strokePx.toPx()
        val radius = size.minDimension / 2f - stroke / 2f
        val center = Offset(size.width / 2f, size.height / 2f)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float, lineColor: Color = color) {
            drawLine(lineColor, Offset(x1, y1), Offset(x2, y2), strokeWidth = stroke)
        }
        when (kind) {
            GlyphKind.COMPLETED -> {
                drawCircle(color, radius = radius, center = center)
                line(center.x - radius * 0.45f, center.y, center.x - radius * 0.1f, center.y + radius * 0.35f, background)
                line(center.x - radius * 0.1f, center.y + radius * 0.35f, center.x + radius * 0.5f, center.y - radius * 0.4f, background)
            }
            GlyphKind.IN_PROGRESS -> {
                drawCircle(color, radius = radius, center = center, style = Stroke(stroke))
                drawCircle(color, radius = radius * 0.42f, center = center)
            }
            GlyphKind.RUNNING -> drawCircle(color, radius = radius * 0.75f, center = center)
            GlyphKind.FAILED -> {
                drawCircle(color, radius = radius, center = center)
                line(center.x - radius * 0.4f, center.y - radius * 0.4f, center.x + radius * 0.4f, center.y + radius * 0.4f, background)
                line(center.x + radius * 0.4f, center.y - radius * 0.4f, center.x - radius * 0.4f, center.y + radius * 0.4f, background)
            }
            GlyphKind.BLOCKED -> {
                drawCircle(color, radius = radius, center = center, style = Stroke(stroke))
                line(center.x, center.y - radius * 0.55f, center.x, center.y + radius * 0.1f)
                drawCircle(color, radius = stroke * 0.55f, center = Offset(center.x, center.y + radius * 0.55f))
            }
            GlyphKind.ABANDONED -> {
                drawCircle(color, radius = radius, center = center, style = Stroke(stroke))
                line(center.x - radius * 0.6f, center.y + radius * 0.6f, center.x + radius * 0.6f, center.y - radius * 0.6f)
            }
            GlyphKind.ABORTED -> {
                drawCircle(color, radius = radius, center = center, style = Stroke(stroke))
                line(center.x - radius * 0.5f, center.y - radius * 0.5f, center.x + radius * 0.5f, center.y + radius * 0.5f)
            }
            GlyphKind.PENDING -> drawCircle(color, radius = radius, center = center, style = Stroke(stroke))
        }
    }
}

/** A fixed 14 dp slot so glyph rows align with the surrounding text. */
@Composable
internal fun GlyphSlot(kind: GlyphKind) {
    Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) { StatusGlyph(kind) }
}
