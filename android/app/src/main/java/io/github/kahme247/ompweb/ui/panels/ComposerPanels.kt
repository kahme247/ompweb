package io.github.kahme247.ompweb.ui.panels

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.TodoPhase

/**
 * The session panels pinned above the chat input (web `ComposerPanels`):
 * the active side question first (rendered by Slice B and passed in as
 * [leading]), then the live todo plan, then the subagent roster. Each panel is
 * independently collapsible and unmounts when its input is empty.
 *
 * On phones the whole stack is capped and scrolls, so two expanded panels
 * cannot push the composer off-screen; each body keeps the web's own
 * `min(30vh, 240px)` cap.
 */
@Composable
fun ComposerPanels(
    todoPhases: List<TodoPhase>,
    subagents: List<SubagentInfo>,
    todoCollapsed: Boolean,
    subagentsCollapsed: Boolean,
    onTodoCollapsedChange: (Boolean) -> Unit,
    onSubagentsCollapsedChange: (Boolean) -> Unit,
    onSelectSubagent: (SubagentInfo) -> Unit,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
) {
    val configuration = LocalConfiguration.current
    val compact = configuration.screenWidthDp < 600
    val stackModifier = if (compact) {
        Modifier
            .fillMaxWidth()
            .heightIn(max = (configuration.screenHeightDp * 0.45f).dp)
            .verticalScroll(rememberScrollState())
    } else {
        Modifier.fillMaxWidth()
    }
    Column(
        modifier = modifier.then(stackModifier),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        leading?.invoke()
        TodoPanel(
            phases = todoPhases,
            collapsed = todoCollapsed,
            onCollapsedChange = onTodoCollapsedChange,
        )
        SubagentsPanel(
            subagents = subagents,
            collapsed = subagentsCollapsed,
            onCollapsedChange = onSubagentsCollapsedChange,
            onSelectSubagent = onSelectSubagent,
        )
    }
}
