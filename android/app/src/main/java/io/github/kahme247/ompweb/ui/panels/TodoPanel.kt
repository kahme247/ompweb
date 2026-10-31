package io.github.kahme247.ompweb.ui.panels

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.TodoItem
import io.github.kahme247.ompweb.domain.TodoPhase
import io.github.kahme247.ompweb.domain.TodoStatus
import io.github.kahme247.ompweb.domain.todoPreview
import io.github.kahme247.ompweb.domain.todoProgress
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The live todo plan attached above the composer (web `components/TodoList.tsx`):
 * header with `done/total`, a capped preview of four phases and five tasks, and
 * a "Show all tasks" footer. Collapse state is owned (and persisted) by the
 * caller; the show-all expansion is per-mount, like the web component.
 */
@Composable
fun TodoPanel(
    phases: List<TodoPhase>,
    collapsed: Boolean,
    onCollapsedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (phases.isEmpty()) return
    val colors = LocalOmpColors.current
    var expanded by remember { mutableStateOf(false) }
    val progress = todoProgress(phases)
    val preview = todoPreview(phases, expanded)
    val planScrollLabel = stringResource(R.string.panels_todo_plan_scroll)

    PanelCard(modifier = modifier) {
        PanelHeader(
            title = stringResource(R.string.panels_todo_title),
            collapsed = collapsed,
            onToggle = { onCollapsedChange(!collapsed) },
            summary = stringResource(R.string.panels_todo_progress, progress.done, progress.total),
            icon = {
                Icon(
                    imageVector = Icons.Filled.List,
                    contentDescription = null,
                    tint = colors.textMuted,
                    modifier = Modifier.size(15.dp),
                )
            },
        )
        if (!collapsed) {
            PanelDivider()
            PanelBody(modifier = Modifier.semantics { contentDescription = planScrollLabel }) {
                preview.phases.forEachIndexed { phaseIndex, phase ->
                    if (phaseIndex > 0) Spacer(Modifier.height(8.dp))
                    Text(
                        text = phase.name,
                        color = colors.textMuted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        phase.tasks.forEach { task -> TodoRow(task) }
                    }
                }
            }
            if (preview.truncated || expanded) {
                PanelDivider()
                Text(
                    text = stringResource(
                        if (expanded) R.string.panels_todo_show_less else R.string.panels_todo_show_all,
                    ),
                    color = colors.accent,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { expanded = !expanded }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun TodoRow(task: TodoItem) {
    val colors = LocalOmpColors.current
    val statusLabel = stringResource(
        when (task.status) {
            TodoStatus.PENDING -> R.string.panels_todo_status_pending
            TodoStatus.IN_PROGRESS -> R.string.panels_todo_status_in_progress
            TodoStatus.COMPLETED -> R.string.panels_todo_status_completed
            TodoStatus.BLOCKED -> R.string.panels_todo_status_blocked
            TodoStatus.ABANDONED -> R.string.panels_todo_status_abandoned
            TodoStatus.UNKNOWN -> R.string.panels_todo_status_pending
        },
    )
    val finished = task.status == TodoStatus.COMPLETED || task.status == TodoStatus.ABANDONED
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = "$statusLabel: ${task.content}" }
            .padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GlyphSlot(
            when (task.status) {
                TodoStatus.COMPLETED -> GlyphKind.COMPLETED
                TodoStatus.IN_PROGRESS -> GlyphKind.IN_PROGRESS
                TodoStatus.BLOCKED -> GlyphKind.BLOCKED
                TodoStatus.ABANDONED -> GlyphKind.ABANDONED
                TodoStatus.PENDING, TodoStatus.UNKNOWN -> GlyphKind.PENDING
            },
        )
        Column(Modifier.weight(1f)) {
            Text(
                text = task.content,
                color = if (finished) colors.textDim else colors.text,
                fontSize = 13.sp,
                textDecoration = if (finished) TextDecoration.LineThrough else null,
            )
            task.blocker?.takeIf { it.isNotBlank() }?.let { blocker ->
                Text(
                    text = stringResource(R.string.panels_todo_blocker, blocker),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            }
        }
    }
}
