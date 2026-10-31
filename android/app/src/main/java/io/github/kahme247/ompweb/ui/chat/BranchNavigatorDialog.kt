package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.chat.BranchRow
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import io.github.kahme247.ompweb.ui.theme.PickerDialogKey
import io.github.kahme247.ompweb.ui.theme.pickerDialogKeyFor
import io.github.kahme247.ompweb.ui.theme.pickerDialogTarget
import kotlinx.coroutines.launch

/** Branch picker (web `BranchNavigator`): one selectable row per branch node. */
@Composable
internal fun BranchNavigatorDialog(
    state: BranchNavigatorState,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_branches_title), fontSize = 17.sp) },
        text = {
            BranchNavigatorContent(
                state = state,
                onSelect = onSelect,
                onDismiss = onDismiss,
            )
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) }
        },
    )
}

/**
 * The branch list with the web navigator's keyboard contract (A21):
 * Up/Down/Home/End move the highlight (starting on the active branch),
 * Enter/Space select it and Escape cancels. Focus leaving the picker closes it
 * without switching, mirroring the web dropdown's blur/outside-click close.
 */
@Composable
internal fun BranchNavigatorContent(
    state: BranchNavigatorState,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val flat = remember(state.rows) { flatten(state.rows) }
    val initialIndex = remember(flat) { flat.indexOfFirst { it.first.active }.coerceAtLeast(0) }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = initialIndex)
    val rootFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var hadFocus by remember { mutableStateOf(false) }
    // A row that took focus (Tab/click) wins over the arrow-driven highlight.
    var activeIndex by remember { mutableIntStateOf(initialIndex) }
    var focusedIndex by remember { mutableStateOf<Int?>(null) }

    fun choose(index: Int) {
        val id = flat.getOrNull(index)?.first?.selectId ?: return
        onSelect(id)
        // The web navigator closes on a pick (`BranchNavigator.tsx:
        // onLeafChange(id); setOpenInternal(false)`); without this the dialog
        // stayed open over the reloaded transcript.
        onDismiss()
    }

    fun moveTo(index: Int) {
        activeIndex = index
        scope.launch { listState.scrollToItem(index) }
    }

    LaunchedEffect(Unit) { rootFocus.requestFocus() }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("branch-picker")
            .focusRequester(rootFocus)
            .onFocusChanged { focus ->
                if (focus.hasFocus) hadFocus = true else if (hadFocus) onDismiss()
            }
            // Preview: the list would otherwise consume the arrows for scrolling.
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val key = pickerDialogKeyFor(event.key)
                when (key) {
                    PickerDialogKey.CHOOSE -> {
                        if (flat.isEmpty()) return@onPreviewKeyEvent false
                        choose(focusedIndex ?: activeIndex)
                        true
                    }
                    PickerDialogKey.CANCEL -> {
                        onDismiss()
                        true
                    }
                    null -> false
                    else -> {
                        val target = pickerDialogTarget(activeIndex, key, flat.size)
                        if (target == null) false else {
                            moveTo(target)
                            true
                        }
                    }
                }
            }
            .focusable(),
    ) {
        if (flat.isEmpty()) {
            Text(stringResource(R.string.chat_no_branches), color = colors.textDim, fontSize = 12.sp)
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.heightIn(max = 420.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                itemsIndexed(
                    items = flat,
                    key = { _, entry -> entry.first.selectId + "@" + entry.first.depth + ":" + entry.first.label },
                ) { index, entry ->
                    val (row, parentLines) = entry
                    BranchNodeRow(
                        row = row,
                        parentLines = parentLines,
                        modifier = Modifier.testTag("branch-row-$index"),
                        onFocus = { focusedIndex = index },
                        onChoose = { choose(index) },
                    )
                }
            }
        }
    }
}

@Composable
private fun BranchNodeRow(
    row: BranchRow,
    parentLines: List<Boolean>,
    modifier: Modifier = Modifier,
    onFocus: () -> Unit,
    onChoose: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { if (it.isFocused) onFocus() }
            .background(
                if (row.active) colors.selected else androidx.compose.ui.graphics.Color.Transparent,
                RoundedCornerShape(5.dp),
            )
            .clickable(onClick = onChoose)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.Top,
    ) {
        parentLines.forEachIndexed { depth, drawLine ->
            Box(Modifier.width(12.dp)) {
                if (drawLine) {
                    Box(
                        Modifier
                            .padding(start = 6.dp)
                            .width(1.dp)
                            .heightIn(min = 20.dp)
                            .background(colors.border),
                    )
                }
                if (depth == parentLines.lastIndex) {
                    Text(
                        text = if (row.isLast) "└" else "├",
                        color = colors.border,
                        fontSize = 11.sp,
                        fontFamily = OmpMonoFontFamily,
                    )
                }
            }
        }
        Box(Modifier.width(6.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                row.role?.let { role ->
                    Text(
                        text = role,
                        color = colors.accent,
                        fontSize = 9.5.sp,
                        fontFamily = OmpMonoFontFamily,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .background(colors.backgroundSubtle, RoundedCornerShape(3.dp))
                            .padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                }
                Text(
                    text = row.label.ifBlank { "(empty)" },
                    color = if (row.active) colors.text else colors.textMuted,
                    fontSize = 11.5.sp,
                    fontFamily = OmpMonoFontFamily,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (row.active) {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = stringResource(R.string.chat_active_branch),
                        modifier = Modifier.size(14.dp),
                        tint = colors.accent,
                    )
                }
            }
            if (row.skipped > 0) {
                Text(
                    text = stringResource(R.string.chat_branch_more, row.skipped),
                    color = colors.textDim,
                    fontSize = 9.5.sp,
                    modifier = Modifier.padding(start = 2.dp, top = 1.dp),
                )
            }
        }
    }
}

/** Depth-first flattening with the ancestor-line flags each row draws. */
private fun flatten(rows: List<BranchRow>): List<Pair<BranchRow, List<Boolean>>> {
    val out = ArrayList<Pair<BranchRow, List<Boolean>>>()
    fun walk(nodes: List<BranchRow>, parentLines: List<Boolean>) {
        for (node in nodes) {
            out += node to parentLines
            walk(node.children, parentLines + !node.isLast)
        }
    }
    walk(rows, emptyList())
    return out
}
