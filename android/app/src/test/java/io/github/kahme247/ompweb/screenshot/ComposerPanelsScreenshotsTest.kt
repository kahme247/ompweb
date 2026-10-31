package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentSource
import io.github.kahme247.ompweb.domain.SubagentStatus
import io.github.kahme247.ompweb.domain.TodoItem
import io.github.kahme247.ompweb.domain.TodoPhase
import io.github.kahme247.ompweb.domain.TodoStatus
import io.github.kahme247.ompweb.ui.panels.ComposerPanels
import org.junit.Test

/**
 * The composer-attached panel stack in its expanded state: the todo plan (three
 * phases, all glyph states) and the subagent roster (running + completed).
 */
class ComposerPanelsScreenshotsTest : ScreenshotTest() {

    @Test
    fun panels() = composeRule.verifyScreenshotMatrix(name = "panels", heightDp = 620) {
        ComposerPanelsFixture()
    }
}

@Composable
internal fun ComposerPanelsFixture() {
    var todoCollapsed by remember { mutableStateOf(false) }
    var subagentsCollapsed by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(8.dp)) {
        ComposerPanels(
            todoPhases = todoPhases(),
            subagents = subagents(),
            todoCollapsed = todoCollapsed,
            subagentsCollapsed = subagentsCollapsed,
            onTodoCollapsedChange = { todoCollapsed = it },
            onSubagentsCollapsedChange = { subagentsCollapsed = it },
            onSelectSubagent = {},
        )
    }
}

internal fun todoPhases(): List<TodoPhase> = listOf(
    TodoPhase(
        id = "phase-1",
        name = "Screenshot matrix",
        tasks = listOf(
            TodoItem("1", "Add the Robolectric render harness", TodoStatus.COMPLETED, null),
            TodoItem("2", "Record the 30-cell goldens", TodoStatus.COMPLETED, null),
            TodoItem("3", "Wire verifyScreenshots into the gate", TodoStatus.IN_PROGRESS, null),
        ),
    ),
    TodoPhase(
        id = "phase-2",
        name = "Accessibility",
        tasks = listOf(
            TodoItem("4", "Label every icon-only control", TodoStatus.COMPLETED, null),
            TodoItem("5", "Live region for run status", TodoStatus.IN_PROGRESS, null),
            TodoItem("6", "48 dp touch targets at 200 % font", TodoStatus.BLOCKED, "Waiting for the composer diff"),
            TodoItem("7", "Retest TalkBack navigation", TodoStatus.PENDING, null),
        ),
    ),
    TodoPhase(
        id = "phase-3",
        name = "Parity audit",
        tasks = listOf(
            TodoItem("8", "Walk every inventory row", TodoStatus.PENDING, null),
            TodoItem("9", "Retired duplicate copy action", TodoStatus.ABANDONED, null),
        ),
    ),
)

internal fun subagents(): List<SubagentInfo> = listOf(
    SubagentInfo(
        id = "agent-1",
        agent = "reviewer",
        status = SubagentStatus.STARTED,
        index = 0,
        task = "Review the screenshot goldens",
        source = SubagentSource.LIVE,
    ),
    SubagentInfo(
        id = "agent-2",
        agent = "verifier",
        status = SubagentStatus.STARTED,
        index = 1,
        task = "Verify the 320 dp layout",
        source = SubagentSource.LIVE,
    ),
    SubagentInfo(
        id = "agent-3",
        agent = "coder",
        status = SubagentStatus.COMPLETED,
        index = 2,
        task = "Expose the screenshot helper",
        source = SubagentSource.LIVE,
    ),
)
