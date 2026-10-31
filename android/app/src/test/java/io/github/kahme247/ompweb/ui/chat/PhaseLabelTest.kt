package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AgentPhase
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.chat.RunningTool
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A15: the status line names what the running turn waits on (web
 * `phaseLabel`) instead of a blanket "working".
 */
class PhaseLabelTest {

    private fun busy(phase: AgentPhase?) = ChatState(
        agentRunning = true,
        promptRunning = true,
        agentPhase = phase,
    )

    @Test
    fun anIdleSessionHasNoStatusLine() {
        assertNull(phaseLabel(ChatState()))
        assertNull("a stale phase without a running turn stays silent", phaseLabel(ChatState(agentPhase = AgentPhase.WaitingModel)))
    }

    @Test
    fun compactionWinsOverEveryRunPhase() {
        val label = phaseLabel(
            busy(AgentPhase.RunningTools(listOf(RunningTool("1", "bash")))).copy(compacting = true),
        )
        assertEquals(PhaseLabelKind.Compacting, label?.kind)
    }

    @Test
    fun waitingForTheModelIsNamed() {
        assertEquals(PhaseLabelKind.WaitingModel, phaseLabel(busy(AgentPhase.WaitingModel))?.kind)
    }

    @Test
    fun aRunningShellCommandIsNamed() {
        assertEquals(PhaseLabelKind.RunningCommand, phaseLabel(busy(AgentPhase.RunningCommand))?.kind)
    }

    @Test
    fun runningToolsListsDistinctNamesWithoutDuplicates() {
        val label = phaseLabel(
            busy(
                AgentPhase.RunningTools(
                    listOf(
                        RunningTool("1", "bash"),
                        RunningTool("2", "read"),
                        RunningTool("3", "bash"),
                    ),
                ),
            ),
        )
        assertEquals(PhaseLabelKind.RunningTools, label?.kind)
        assertEquals(listOf("bash", "read"), label?.tools)
    }

    @Test
    fun runningToolsCapLikeTheWeb() {
        // Web `phaseLabel`: three names still list all; more collapse to the
        // first two plus a "(+N)" counter.
        val three = phaseLabel(
            busy(
                AgentPhase.RunningTools(
                    listOf(
                        RunningTool("1", "bash"),
                        RunningTool("2", "read"),
                        RunningTool("3", "edit"),
                    ),
                ),
            ),
        )
        assertEquals(listOf("bash", "read", "edit"), three?.tools)
        assertEquals(0, three?.more)

        val five = phaseLabel(
            busy(
                AgentPhase.RunningTools(
                    listOf(
                        RunningTool("1", ""),
                        RunningTool("2", "read"),
                        RunningTool("3", "edit"),
                        RunningTool("4", "bash"),
                        RunningTool("5", "grep"),
                    ),
                ),
            ),
        )
        assertEquals("blank names fall back to 'tool' and count as one", listOf("tool", "read"), five?.tools)
        assertEquals("the rest is the web's (+N more)", 3, five?.more)
        assertEquals(3, PHASE_MAX_TOOLS)
    }

    @Test
    fun anEmptyToolListIsWaitingForTheModel() {
        val label = phaseLabel(busy(AgentPhase.RunningTools(emptyList())))
        assertEquals(PhaseLabelKind.WaitingModel, label?.kind)
    }

    @Test
    fun aRunningTurnWithoutAPhaseFallsBackToWorking() {
        assertEquals(PhaseLabelKind.Working, phaseLabel(busy(null))?.kind)
    }
}
