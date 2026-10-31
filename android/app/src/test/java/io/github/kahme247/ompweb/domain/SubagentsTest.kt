package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `lib/subagent-types.test.mjs`: roster ordering by the file's call
 * ordinal, live-over-history precedence, the stale-snapshot guard, lenient
 * parsing and the chip formatters from `lib/subagent-format.ts`.
 */
class SubagentsTest {

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    /** Restarts per `task` call, so every batch numbers its own children. */
    private fun batch(call: String, agents: List<String>, status: String = "started"): List<SubagentInfo> =
        agents.mapIndexed { index, agent ->
            json(
                """{"id":"${call}_$agent$index","agent":"$agent","status":"$status","index":$index,"parentToolCallId":"$call","source":"live"}""",
            ).let { parseSubagentSnapshot(it, NOW)!!.copy(source = SubagentSource.LIVE) }
        }

    /** The same batch as the session file reports it, carrying the call's ordinal. */
    private fun fromFile(
        call: String,
        batchSeq: Int,
        agents: List<String>,
        status: String = "completed",
    ): List<SubagentInfo> = batch(call, agents, status).map {
        it.copy(source = SubagentSource.HISTORY, status = SubagentStatus.COMPLETED, batchSeq = batchSeq)
    }

    private fun ids(roster: List<SubagentInfo>): List<String> = roster.map { it.id }

    @Test
    fun `roster orders batches by the file's call ordinal, not by index`() {
        val first = mergeSubagentRoster(emptyList(), fromFile("callA", 0, listOf("scout", "scout")))
        val roster = mergeSubagentRoster(first, fromFile("callB", 1, listOf("worker", "worker")))
        assertEquals(
            listOf("callA_scout0", "callA_scout1", "callB_worker0", "callB_worker1"),
            ids(roster),
        )
    }

    @Test
    fun `the file's call order wins over the order a snapshot arrives in`() {
        val connected = mergeSubagentRoster(
            emptyList(),
            listOf(
                parseSubagentSnapshot(
                    json("""{"id":"Alpha","agent":"worker","status":"started","index":0,"parentToolCallId":"call_second"}"""),
                    NOW,
                )!!,
                parseSubagentSnapshot(
                    json("""{"id":"Zebra","agent":"scout","status":"started","index":0,"parentToolCallId":"call_first"}"""),
                    NOW,
                )!!,
            ),
        )
        assertEquals(listOf("Alpha", "Zebra"), ids(connected))
        val corrected = mergeSubagentRoster(
            connected,
            listOf(
                historyEntry("Zebra", "scout", 0, "call_first", 0),
                historyEntry("Alpha", "worker", 0, "call_second", 1),
            ),
        )
        assertEquals(listOf("Zebra", "Alpha"), ids(corrected))
        assertEquals(listOf(SubagentSource.LIVE, SubagentSource.LIVE), corrected.map { it.source })
    }

    @Test
    fun `history arriving in pieces still orders by call, not by what landed first`() {
        val fast = mergeSubagentRoster(emptyList(), fromFile("call_fast", 1, listOf("sonic")))
        val both = mergeSubagentRoster(fast, fromFile("call_slow", 0, listOf("worker")))
        assertEquals(listOf("call_slow_worker0", "call_fast_sonic0"), ids(both))
    }

    @Test
    fun `a batch still missing from disk sits after the calls the file knows`() {
        val onDisk = mergeSubagentRoster(emptyList(), fromFile("call_first", 0, listOf("scout")))
        val running = mergeSubagentRoster(onDisk, batch("call_running", listOf("worker")))
        assertEquals(listOf("call_first_scout0", "call_running_worker0"), ids(running))
        assertNull(running[1].batchSeq)
    }

    @Test
    fun `a terminal frame without an ordinal leaves the card where it was`() {
        val roster = mergeSubagentRoster(
            mergeSubagentRoster(emptyList(), fromFile("callA", 0, listOf("scout"))),
            fromFile("callB", 1, listOf("worker", "sonic")),
        )
        val settled = mergeSubagentRoster(
            roster,
            listOf(
                parseSubagentLifecycle(
                    json("""{"id":"callB_worker0","agent":"worker","status":"completed","index":0,"parentToolCallId":"callB"}"""),
                    NOW,
                )!!,
            ),
        )
        assertEquals(ids(roster), ids(settled))
        assertEquals(SubagentStatus.COMPLETED, settled[1].status)
        assertEquals(1, settled[1].batchSeq)
    }

    @Test
    fun `a stale snapshot cannot regress status but still hands over the ordinal`() {
        val roster = mergeSubagentRoster(
            emptyList(),
            listOf(
                SubagentInfo("a", "scout", SubagentStatus.COMPLETED, 0, lastUpdate = 500),
            ),
        )
        val stale = mergeSubagentRoster(
            roster,
            listOf(historyEntry("a", "scout", 0, null, 3)),
            skipNewerThan = 400,
        )
        assertEquals(SubagentStatus.COMPLETED, stale[0].status)
        assertEquals(3, stale[0].batchSeq)
    }

    @Test
    fun `live frames replace a history entry without moving it`() {
        val history = mergeSubagentRoster(emptyList(), fromFile("callA", 0, listOf("scout", "worker")))
        val live = mergeSubagentRoster(
            history,
            listOf(
                parseSubagentLifecycle(
                    json("""{"id":"callA_worker1","agent":"worker","status":"started","index":1,"parentToolCallId":"callA"}"""),
                    NOW,
                )!!,
            ),
        )
        assertEquals(listOf("callA_scout0", "callA_worker1"), ids(live))
        assertEquals(SubagentSource.LIVE, live[1].source)
        assertEquals(0, live[1].batchSeq)
    }

    @Test
    fun `progress frames keep telemetry and retry state and ignore garbage`() {
        val progress = parseSubagentProgress(
            json(
                """
                {"index":1,"id":"Scout","agent":"scout","agentSource":"bundled","status":"running",
                 "currentTool":"read","lastIntent":"Inspect foo.ts","tokens":1234,"cost":0.004,
                 "contextTokens":8000,"contextWindow":32000,"resolvedModel":"provider/gpt-x:high",
                 "retryState":{"attempt":2,"maxAttempts":5,"delayMs":1000,"errorMessage":"429","startedAtMs":1}}
                """,
            ),
        )!!
        assertEquals("read", progress.currentTool)
        assertEquals("Inspect foo.ts", progress.lastIntent)
        assertEquals(1234L, progress.tokens)
        assertEquals(0.004, progress.cost!!, 0.0)
        assertEquals(32000L, progress.contextWindow)
        assertEquals(2, progress.retryState?.attempt)
        // Garbage fields are ignored, not fatal.
        assertNull(parseSubagentProgress(json("""{"id":"x","tokens":"nope"}"""))?.tokens)
        assertNull(parseSubagentProgress(null))
        assertNull(parseSubagentProgress(json("{}")))
        // A partial retry block is not fabricated into a false "retrying" chip.
        assertNull(
            parseSubagentProgress(json("""{"currentTool":"read","retryState":{"attempt":2}}"""))?.retryState,
        )
    }

    @Test
    fun `snapshots map registry statuses and carry progress`() {
        val snapshot = parseSubagentSnapshot(
            json(
                """
                {"id":"Scout","index":0,"agent":"scout","agentSource":"user","status":"running","task":"Map",
                 "sessionFile":"C:\\work\\artifacts\\Scout.jsonl","lastUpdate":123,
                 "progress":{"id":"Scout","status":"running","tokens":10}}
                """,
            ),
            NOW,
        )!!
        assertEquals("Scout", snapshot.id)
        assertEquals(SubagentStatus.STARTED, snapshot.status)
        assertEquals(SubagentAgentSource.USER, snapshot.agentSource)
        assertEquals(10L, snapshot.progress?.tokens)
        assertEquals("C:\\work\\artifacts\\Scout.jsonl", snapshot.sessionFile)
        assertEquals(123L, snapshot.lastUpdate)
        assertEquals(SubagentStatus.COMPLETED, parseSubagentSnapshot(json("""{"id":"a","agent":"b","status":"completed"}"""), NOW)?.status)
        assertNull(parseSubagentSnapshot(json("""{"id":"a"}"""), NOW))
        // A snapshot without lastUpdate is stamped with the read time.
        assertEquals(NOW, parseSubagentSnapshot(json("""{"id":"a","agent":"b","status":"started"}"""), NOW)?.lastUpdate)
        // Unknown lifecycle statuses never fabricate a live chip.
        assertNull(parseSubagentSnapshot(json("""{"id":"a","agent":"b","status":"zombie"}"""), NOW))
    }

    @Test
    fun `lifecycle frames require id and status and default the agent`() {
        val parsed = parseSubagentLifecycle(json("""{"id":"Scout","status":"started","detached":true}"""), NOW)!!
        assertEquals("subagent", parsed.agent)
        assertTrue(parsed.detached!!)
        assertNull(parseSubagentLifecycle(json("""{"id":"Scout"}"""), NOW))
        assertNull(parseSubagentLifecycle(json("""{"status":"started"}"""), NOW))
        assertNull(parseSubagentLifecycle(json("""{"id":"Scout","status":"running"}"""), NOW))
        assertNull(parseSubagentLifecycle(json("nope"), NOW))
    }

    @Test
    fun `activity events extract tools, text and notices`() {
        val tool = parseSubagentActivityEvent(
            json("""{"id":"s","event":{"type":"tool_execution_start","toolName":"read","intent":"Inspect foo.ts","args":{"path":"foo.ts"}}}"""),
            NOW,
        )!!
        assertEquals(SubagentActivityKind.TOOL, tool.kind)
        assertTrue(tool.label.contains("read"))
        assertTrue(tool.label.contains("Inspect foo.ts"))

        val argsOnly = parseSubagentActivityEvent(
            json("""{"id":"s","event":{"type":"tool_execution_start","toolName":"read","args":{"path":"foo.ts","offset":1,"limit":2,"extra":3}}}"""),
            NOW,
        )!!
        assertEquals("→ read (path, offset, limit)", argsOnly.label)

        val text = parseSubagentActivityEvent(
            json("""{"id":"s","event":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done working"}]}}}"""),
            NOW,
        )!!
        assertEquals(SubagentActivityKind.TEXT, text.kind)
        assertEquals("done working", text.label)

        val notice = parseSubagentActivityEvent(
            json("""{"id":"s","event":{"type":"notice","message":"tool updated"}}"""),
            NOW,
        )!!
        assertEquals(SubagentActivityKind.NOTICE, notice.kind)

        assertNull(parseSubagentActivityEvent(json("""{"id":"s","event":{"type":"message_update"}}"""), NOW))
        assertNull(parseSubagentActivityEvent(json("{}"), NOW))
    }

    @Test
    fun `activity labels are bounded like the web dialog`() {
        val longText = "x".repeat(400)
        val text = parseSubagentActivityEvent(
            json("""{"event":{"type":"message_end","message":{"role":"assistant","content":"$longText"}}}"""),
            NOW,
        )!!
        assertEquals(140, text.label.length)
        val notice = parseSubagentActivityEvent(
            json("""{"event":{"type":"notice","message":"$longText"}}"""),
            NOW,
        )!!
        assertEquals(140, notice.label.length)
    }

    @Test
    fun `history entries map flat telemetry into progress`() {
        val entry = parseSubagentHistoryEntry(
            json(
                """
                {"id":"Scout","agent":"scout","status":"completed","index":1,"batchSeq":2,
                 "task":"Map the surface","detached":true,"tokens":999000,"cost":1.23,
                 "durationMs":360000,"resolvedModel":"provider/gpt-5.6:medium",
                 "transcriptAvailable":true,"result":{"abortReason":"budget"}}
                """,
            ),
        )!!
        assertEquals(SubagentSource.HISTORY, entry.source)
        assertEquals(2, entry.batchSeq)
        assertTrue(entry.detached!!)
        assertEquals(999000L, entry.progress?.tokens)
        assertEquals(360000L, entry.progress?.durationMs)
        assertEquals("budget", entry.result?.abortReason)
        assertEquals("999k", formatTokens(entry.progress?.tokens))
    }

    @Test
    fun `ids are validated against the transcript route grammar`() {
        assertTrue(isValidSubagentId("Scout"))
        assertTrue(isValidSubagentId("Parent.Child-1"))
        assertFalse(isValidSubagentId(""))
        assertFalse(isValidSubagentId("../etc/passwd"))
        assertFalse(isValidSubagentId("a..b"))
        assertFalse(isValidSubagentId("a/b"))
        assertFalse(isValidSubagentId("x".repeat(SUBAGENT_ID_MAX_LENGTH + 1)))
    }

    @Test
    fun `formatters match the chip strings`() {
        assertNull(formatTokens(null))
        assertNull(formatTokens(0))
        assertEquals("999", formatTokens(999))
        assertEquals("1k", formatTokens(1000))
        assertEquals("2.2k", formatTokens(2200))
        assertEquals("999k", formatTokens(999000))
        assertNull(formatCost(null))
        assertNull(formatCost(0.0))
        assertEquals("\$0.0041", formatCost(0.0041))
        assertEquals("\$1.23", formatCost(1.23))
        // The chips use the shared cost formatter from ContextUsage.kt.
        assertNull(formatDuration(null))
        assertNull(formatDuration(900L))
        assertEquals("42s", formatDuration(42_400L))
        assertEquals("6m", formatDuration(360_000L))
        assertNull(shortModel(null))
        assertEquals("gpt-x", shortModel("provider/gpt-x:high"))
        assertEquals("provider/gpt-x", fullModel("provider/gpt-x:high"))
        assertEquals("high", modelEffort("provider/gpt-x:high"))
        assertNull(modelEffort("provider/gpt-x"))
        assertEquals("provider/gpt-x", fullModel("provider/gpt-x"))
    }

    @Test
    fun `nested subagent counts cover both payload shapes`() {
        assertEquals(0, countNestedSubagents(null))
        assertEquals(
            2,
            countNestedSubagents(
                parseSubagentProgress(json("""{"inflightTaskDetails":{"progress":[{},{}]}}""")),
            ),
        )
        assertEquals(
            3,
            countNestedSubagents(
                parseSubagentProgress(
                    json("""{"extractedToolData":{"task":[{"progress":[{}]},{"progress":[{},{}]}]}}"""),
                ),
            ),
        )
        assertEquals(
            3,
            countNestedSubagents(
                parseSubagentProgress(
                    json("""{"inflightTaskDetails":{"progress":[{}]},"extractedToolData":{"task":[{"progress":[{},{}]}]}}"""),
                ),
            ),
        )
    }

    @Test
    fun `terminal history entries are not a running chip`() {
        assertTrue(SubagentInfo("a", "scout", SubagentStatus.STARTED, 0).running)
        assertFalse(SubagentInfo("a", "scout", SubagentStatus.STARTED, 0, source = SubagentSource.HISTORY).running)
        assertFalse(SubagentInfo("a", "scout", SubagentStatus.COMPLETED, 0).running)
        assertNull(SubagentInfo("a", "scout", SubagentStatus.COMPLETED, 0).headline)
        assertEquals("Map", SubagentInfo("a", "scout", SubagentStatus.COMPLETED, 0, task = "Map").headline)
    }

    private fun historyEntry(
        id: String,
        agent: String,
        index: Int,
        parentToolCallId: String?,
        batchSeq: Int,
    ): SubagentInfo = SubagentInfo(
        id = id,
        agent = agent,
        status = SubagentStatus.COMPLETED,
        index = index,
        parentToolCallId = parentToolCallId,
        source = SubagentSource.HISTORY,
        batchSeq = batchSeq,
    )

    private companion object {
        const val NOW = 1_800_000_000_000L
    }
}
