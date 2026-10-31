package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AgentPhase
import io.github.kahme247.ompweb.chat.ChatState

/** What the composer status line names (web `phaseLabel`). */
enum class PhaseLabelKind { Compacting, WaitingModel, RunningTools, RunningCommand, Working }

data class PhaseLabel(
    val kind: PhaseLabelKind,
    /** Distinct tool names the label lists; empty for every other kind. */
    val tools: List<String> = emptyList(),
    /** Names the label folds into "(+N more)" (web `runningNamedMore`). */
    val more: Int = 0,
)

/** Up to this many names the status line lists them all (web `names.length <= 3`). */
const val PHASE_MAX_TOOLS = 3

/** Above [PHASE_MAX_TOOLS] the web shows the first two names plus a counter. */
private const val PHASE_NAMED_TOOLS = 2

/**
 * The status line for the current turn. `null` means "nothing runs", so the
 * line shows nothing (web `phaseLabel` returning null).
 *
 * The cap follows `components/ChatWindow.tsx` exactly: up to three tool names
 * are listed; beyond that the first two are named and the rest collapse into
 * [PhaseLabel.more].
 */
fun phaseLabel(state: ChatState): PhaseLabel? {
    if (state.compacting) return PhaseLabel(PhaseLabelKind.Compacting)
    if (!state.busy) return null
    val phase = state.agentPhase
    if (phase is AgentPhase.RunningTools) {
        val names = phase.tools.map { it.name.ifBlank { "tool" } }.distinct()
        if (names.isEmpty()) return PhaseLabel(PhaseLabelKind.WaitingModel)
        val shown = if (names.size <= PHASE_MAX_TOOLS) names else names.take(PHASE_NAMED_TOOLS)
        return PhaseLabel(
            kind = PhaseLabelKind.RunningTools,
            tools = shown,
            more = (names.size - shown.size).coerceAtLeast(0),
        )
    }
    if (phase is AgentPhase.RunningCommand) return PhaseLabel(PhaseLabelKind.RunningCommand)
    if (phase is AgentPhase.WaitingModel) return PhaseLabel(PhaseLabelKind.WaitingModel)
    return PhaseLabel(PhaseLabelKind.Working)
}
