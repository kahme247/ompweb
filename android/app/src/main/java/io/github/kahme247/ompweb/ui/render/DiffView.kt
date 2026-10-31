package io.github.kahme247.ompweb.ui.render

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

private val SPLIT_BREAKPOINT = 600.dp

/**
 * Diff preview identical in spirit to `MessageView-diff-view.tsx`: a unified
 * patch is paired into split cells and shown side by side on wide screens,
 * stacked on phones. Without a patch, `oldText`/`newText` are diffed locally.
 * Hunk headers and unchanged-line gaps are rendered as separators; there is no
 * nested vertical scroller.
 */
@Composable
fun DiffView(
    path: String?,
    oldText: String?,
    newText: String?,
    unifiedPatch: String?,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val files = remember(unifiedPatch, oldText, newText) {
        when {
            !unifiedPatch.isNullOrBlank() -> UnifiedPatchParser.parse(unifiedPatch)
            oldText != null && newText != null -> ComputedDiff.split(oldText, newText)?.map { file ->
                file.copy(oldPath = path, newPath = path)
            }
            else -> null
        }
    }
    val plainPatch = unifiedPatch?.takeIf { !it.isBlank() && files == null }

    BoxWithConstraints(modifier.fillMaxWidth()) {
        val split = maxWidth >= SPLIT_BREAKPOINT
        SelectionContainer {
            Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .border(1.dp, colors.border, RoundedCornerShape(8.dp))
                .background(colors.background),
        ) {
            when {
                files != null -> files.forEachIndexed { index, file ->
                    if (index > 0) {
                        Text(
                            text = "",
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.border)
                                .padding(top = 1.dp),
                        )
                    }
                    if (split) {
                        SplitFile(file, colors)
                    } else {
                        UnifiedFile(file, colors)
                    }
                }
                plainPatch != null -> PlainPatch(plainPatch, colors)
                else -> Text(
                    text = "No changes",
                    color = colors.textDim,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(10.dp),
                )
            }
        }
        }
    }
}

@Composable
private fun SplitFile(file: SplitDiffFile, colors: OmpColors) {
    val title = file.newPath ?: file.oldPath
    if (title != null) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(colors.panel),
        ) {
            Text(
                text = file.oldPath ?: title,
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
            Text(
                text = file.newPath ?: title,
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .border(width = 1.dp, color = colors.border)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
    }
    for (row in file.rows) {
        when (row) {
            is SplitDiffRow.Hunk -> HunkHeader(row.text, colors)
            is SplitDiffRow.Line -> Row(Modifier.fillMaxWidth()) {
                SplitCell(row.left, colors, Modifier.weight(1f))
                SplitCell(row.right, colors, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun SplitCell(cell: SplitDiffCell, colors: OmpColors, modifier: Modifier = Modifier) {
    val background = when (cell.type) {
        DiffCellType.Added -> colors.statusSuccess.copy(alpha = 0.12f)
        DiffCellType.Removed -> colors.statusError.copy(alpha = 0.13f)
        DiffCellType.Empty -> colors.backgroundSubtle
        DiffCellType.Context -> Color.Transparent
    }
    val marker = when (cell.type) {
        DiffCellType.Added -> "+"
        DiffCellType.Removed -> "-"
        else -> " "
    }
    val markerColor = when (cell.type) {
        DiffCellType.Added -> colors.statusSuccess
        DiffCellType.Removed -> colors.statusError
        else -> colors.textDim
    }
    Row(modifier.background(background)) {
        Text(
            text = cell.lineNo?.toString().orEmpty(),
            modifier = Modifier
                .width(38.dp)
                .background(colors.panel)
                .padding(horizontal = 4.dp),
            color = colors.textDim,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            textAlign = TextAlign.End,
            maxLines = 1,
        )
        Text(
            text = marker,
            modifier = Modifier.width(16.dp),
            color = markerColor,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
        Text(
            text = cell.text.ifEmpty { " " },
            modifier = Modifier
                .weight(1f)
                .padding(end = 8.dp),
            color = if (cell.type == DiffCellType.Empty) colors.textDim else colors.text,
            fontSize = 11.sp,
            lineHeight = 17.sp,
            fontFamily = OmpMonoFontFamily,
        )
    }
}

@Composable
private fun UnifiedFile(file: SplitDiffFile, colors: OmpColors) {
    val title = file.newPath ?: file.oldPath
    if (title != null) {
        Text(
            text = title,
            color = colors.textDim,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.panel)
                .padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
    for (row in file.rows) {
        when (row) {
            is SplitDiffRow.Hunk -> HunkHeader(row.text, colors)
            is SplitDiffRow.Line -> {
                if (row.left.type == DiffCellType.Context && row.right.type == DiffCellType.Context) {
                    UnifiedCell(" ", row.left, colors)
                } else {
                    if (row.left.type != DiffCellType.Empty) UnifiedCell("-", row.left, colors)
                    if (row.right.type != DiffCellType.Empty) UnifiedCell("+", row.right, colors)
                }
            }
        }
    }
}

@Composable
private fun UnifiedCell(marker: String, cell: SplitDiffCell, colors: OmpColors) {
    val background = when (cell.type) {
        DiffCellType.Added -> colors.statusSuccess.copy(alpha = 0.12f)
        DiffCellType.Removed -> colors.statusError.copy(alpha = 0.13f)
        else -> Color.Transparent
    }
    val markerColor = when (cell.type) {
        DiffCellType.Added -> colors.statusSuccess
        DiffCellType.Removed -> colors.statusError
        else -> colors.textDim
    }
    Row(Modifier.fillMaxWidth().background(background)) {
        Text(
            text = cell.lineNo?.toString().orEmpty(),
            modifier = Modifier
                .width(40.dp)
                .background(colors.panel)
                .padding(horizontal = 4.dp),
            color = colors.textDim,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            textAlign = TextAlign.End,
            maxLines = 1,
        )
        Text(
            text = marker,
            modifier = Modifier.width(16.dp),
            color = markerColor,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
        Text(
            text = cell.text.ifEmpty { " " },
            modifier = Modifier
                .weight(1f)
                .padding(end = 8.dp),
            color = colors.text,
            fontSize = 11.sp,
            lineHeight = 17.sp,
            fontFamily = OmpMonoFontFamily,
        )
    }
}

@Composable
private fun HunkHeader(text: String, colors: OmpColors) {
    Text(
        text = text,
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.backgroundSubtle)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        color = colors.accent,
        fontSize = 11.sp,
        fontFamily = OmpMonoFontFamily,
    )
}

@Composable
private fun PlainPatch(patch: String, colors: OmpColors) {
    Column(Modifier.fillMaxWidth()) {
        patch.split(Regex("\r?\n")).forEachIndexed { index, line ->
            val kind = when {
                line.startsWith("@@") -> 1
                line.startsWith("+") && !line.startsWith("+++") -> 2
                line.startsWith("-") && !line.startsWith("---") -> 3
                else -> 0
            }
            val background = when (kind) {
                1 -> colors.accent.copy(alpha = 0.10f)
                2 -> colors.statusSuccess.copy(alpha = 0.12f)
                3 -> colors.statusError.copy(alpha = 0.13f)
                else -> Color.Transparent
            }
            val color = when (kind) {
                1 -> colors.accent
                2 -> colors.statusSuccess
                3 -> colors.statusError
                else -> colors.text
            }
            Row(Modifier.fillMaxWidth().background(background)) {
                Text(
                    text = (index + 1).toString(),
                    modifier = Modifier
                        .width(44.dp)
                        .background(colors.panel)
                        .padding(horizontal = 6.dp),
                    color = colors.textDim,
                    fontSize = 11.sp,
                    fontFamily = OmpMonoFontFamily,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                )
                Text(
                    text = line.ifEmpty { " " },
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 8.dp),
                    color = color,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                    fontFamily = OmpMonoFontFamily,
                )
            }
        }
    }
}
