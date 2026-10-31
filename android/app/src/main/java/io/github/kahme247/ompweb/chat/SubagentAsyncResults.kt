package io.github.kahme247.ompweb.chat

import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentProgress
import io.github.kahme247.ompweb.domain.SubagentStatus
import kotlinx.serialization.json.JsonObject

/**
 * Settle roster entries from the transcript's background-job deliveries.
 *
 * A detached `task` is recorded as `started` when it is spawned and never gets
 * a lifecycle frame once it outlives its turn, so the on-disk roster would keep
 * calling the finished run "Running" (and show no duration when no progress
 * frame was recorded). The `async-result` message that delivers the job's
 * output carries its terminal state and duration — that is the proof the run
 * ended.
 */
fun settleSubagentsFromAsyncResults(
    subagents: List<SubagentInfo>,
    messages: List<ChatMessage>,
): List<SubagentInfo> {
    if (subagents.isEmpty()) return subagents
    val outcomes = asyncJobOutcomes(messages)
    if (outcomes.isEmpty()) return subagents
    var changed = false
    val settled = subagents.map { entry ->
        val outcome = outcomes[entry.id] ?: return@map entry
        // Never regress an entry a live frame already settled.
        if (entry.status != SubagentStatus.STARTED) return@map entry
        changed = true
        entry.copy(
            status = outcome.status,
            progress = (entry.progress ?: SubagentProgress()).copy(
                status = outcome.status,
                durationMs = outcome.durationMs ?: entry.progress?.durationMs,
            ),
        )
    }
    return if (changed) settled else subagents
}

/** Terminal state of one delivered background job. */
internal data class AsyncJobOutcome(val status: SubagentStatus, val durationMs: Long?)

/**
 * Terminal `task` jobs named by the transcript's `async-result` messages,
 * keyed by the roster id the delivery names (`agentId`, else `jobId`).
 * Running or failed deliveries without a terminal state are not outcomes.
 */
internal fun asyncJobOutcomes(messages: List<ChatMessage>): Map<String, AsyncJobOutcome> {
    val outcomes = LinkedHashMap<String, AsyncJobOutcome>()
    for (message in messages) {
        if (message !is ChatMessage.Custom || message.customType != "async-result") continue
        val jobs = message.details?.array("jobs") ?: continue
        for (element in jobs) {
            val job = element as? JsonObject ?: continue
            if (job.string("type") != "task") continue
            val status = when (job.string("status")) {
                "completed" -> SubagentStatus.COMPLETED
                "failed" -> SubagentStatus.FAILED
                "aborted" -> SubagentStatus.ABORTED
                else -> continue
            }
            val id = job.string("agentId") ?: job.string("jobId") ?: continue
            outcomes[id] = AsyncJobOutcome(status, job.long("durationMs"))
        }
    }
    return outcomes
}
