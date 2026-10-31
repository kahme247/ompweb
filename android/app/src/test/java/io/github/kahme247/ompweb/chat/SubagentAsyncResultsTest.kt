package io.github.kahme247.ompweb.chat

import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentSource
import io.github.kahme247.ompweb.domain.SubagentStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A detached `task` is recorded as `started` when it is spawned and gets no
 * lifecycle frame afterwards; the transcript's `async-result` delivery is the
 * only proof that the run ended. Without this the finished chip kept reading
 * "Running" and showed no duration.
 */
class SubagentAsyncResultsTest {

    private fun job(
        id: String,
        type: String,
        status: String,
        durationMs: Long? = null,
    ): JsonObject = buildJsonObject {
        put("jobId", id)
        put("agentId", id)
        put("type", type)
        put("status", status)
        durationMs?.let { put("durationMs", it) }
    }

    private fun asyncResult(vararg jobs: JsonObject): ChatMessage.Custom = ChatMessage.Custom(
        key = "async:${jobs.size}",
        timestamp = 2_000,
        entryId = null,
        customType = "async-result",
        text = "Background job finished",
        details = buildJsonObject {
            putJsonArray("jobs") { jobs.forEach { add(it) } }
        },
    )

    private fun historyEntry(
        id: String,
        status: SubagentStatus = SubagentStatus.STARTED,
    ): SubagentInfo = SubagentInfo(
        id = id,
        agent = "task",
        status = status,
        index = 0,
        source = SubagentSource.HISTORY,
    )

    @Test
    fun `a delivered task settles its roster entry and gains its duration`() {
        val roster = listOf(historyEntry("ProbeRun"))
        val settled = settleSubagentsFromAsyncResults(
            roster,
            listOf(asyncResult(job("ProbeRun", "task", "completed", 71_047))),
        ).single()

        assertEquals(SubagentStatus.COMPLETED, settled.status)
        assertEquals(71_047L, settled.progress?.durationMs)
        assertEquals(SubagentStatus.COMPLETED, settled.progress?.status)
    }

    @Test
    fun `a failed delivery marks the entry failed`() {
        val settled = settleSubagentsFromAsyncResults(
            listOf(historyEntry("ProbeRun")),
            listOf(asyncResult(job("ProbeRun", "task", "failed"))),
        ).single()

        assertEquals(SubagentStatus.FAILED, settled.status)
    }

    @Test
    fun `other job types and unknown ids leave the roster untouched`() {
        val roster = listOf(historyEntry("ProbeRun"))
        val settled = settleSubagentsFromAsyncResults(
            roster,
            listOf(
                asyncResult(job("bg_1", "bash", "completed")),
                asyncResult(job("Someone", "task", "completed")),
            ),
        )

        assertSame(roster, settled)
    }

    @Test
    fun `a status without a terminal state changes nothing`() {
        val roster = listOf(historyEntry("ProbeRun"))
        val settled = settleSubagentsFromAsyncResults(
            roster,
            listOf(asyncResult(job("ProbeRun", "task", "running"))),
        )

        assertSame(roster, settled)
    }

    @Test
    fun `a settled entry is never regressed`() {
        val settled = settleSubagentsFromAsyncResults(
            listOf(historyEntry("ProbeRun", SubagentStatus.ABORTED)),
            listOf(asyncResult(job("ProbeRun", "task", "completed"))),
        ).single()

        assertEquals(SubagentStatus.ABORTED, settled.status)
    }

    @Test
    fun `a transcript without async deliveries leaves the roster untouched`() {
        val roster = listOf(historyEntry("ProbeRun"))
        val settled = settleSubagentsFromAsyncResults(
            roster,
            listOf(ChatMessage.User("u1", 1_000, null, "go")),
        )

        assertSame(roster, settled)
    }
}
