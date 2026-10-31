package io.github.kahme247.ompweb.ui.panels.btw

import io.github.kahme247.ompweb.chat.FlushScheduler
import io.github.kahme247.ompweb.domain.BtwStatus
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.BtwApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of `hooks/useBtw.test.mjs`. `domain/BtwTest.kt` covers the pure merges;
 * the ordering decisions the view model makes live here. The one that matters
 * most is when queued SSE frames are applied relative to a history snapshot —
 * get it wrong and streamed text is applied twice.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BtwViewModelTest {

    private val t0 = 1_700_000_000_000L

    /** Holds the scheduled display-rate flush so a test decides when it runs. */
    private class ManualScheduler {
        private var pending: (() -> Unit)? = null

        val scheduler: FlushScheduler = { flush ->
            pending = flush
            { if (pending === flush) pending = null }
        }

        val isPending: Boolean get() = pending != null

        fun run() {
            val flush = pending
            pending = null
            flush?.invoke()
        }
    }

    private class FakeBtwApi : BtwApi {
        val commands = mutableListOf<JsonObject>()
        var history: () -> JsonElement? = { jsonObject("records" to JsonArray(emptyList())) }
        var reply: (JsonObject) -> JsonElement? = { null }

        override suspend fun send(sessionId: String, command: JsonObject): JsonElement? {
            assertEquals("s1", sessionId)
            commands += command
            return if (commandType(command) == "get_btw_history") history() else reply(command)
        }

        fun types(): List<String?> = commands.map(::commandType)
    }

    private fun recordJson(
        id: String = "r1",
        question: String = "2+2?",
        answer: String = "",
        status: BtwStatus = BtwStatus.RUNNING,
        createdAt: Long = 1_700_000_000_000L,
        updatedAt: Long = 1_700_000_000_000L,
        followUps: List<JsonObject> = emptyList(),
    ): JsonObject = buildJsonObject {
        put("id", id)
        put("leafId", JsonPrimitive("leaf-1"))
        put("question", question)
        put("answer", answer)
        put("status", status.wire())
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        if (followUps.isNotEmpty()) put("followUps", JsonArray(followUps))
    }

    private fun recordFrame(record: JsonObject): JsonObject = jsonObject(
        "type" to JsonPrimitive("btw_record"),
        "record" to record,
    )

    private fun deltaFrame(text: String, recordId: String = "r1"): JsonObject = jsonObject(
        "type" to JsonPrimitive("btw_delta"),
        "recordId" to JsonPrimitive(recordId),
        "delta" to JsonPrimitive(text),
    )

    private fun historyJson(vararg records: JsonObject): JsonObject =
        jsonObject("records" to JsonArray(records.toList()))

    /** Fresh per test: the production gate is shared process-wide by design. */
    private val support = BtwSupportGate()

    private fun sideQuestionVm(api: BtwApi, scope: CoroutineScope) =
        BtwViewModel(api, scope, { flush -> flush(); {} }, support)

    private fun queuedVm(api: BtwApi, scheduler: ManualScheduler, scope: CoroutineScope) =
        BtwViewModel(api, scope, scheduler.scheduler, support)

    private fun apply(vm: BtwViewModel, scheduler: ManualScheduler, vararg frames: JsonObject) {
        frames.forEach { assertTrue("not consumed: $it", vm.onFrame(it)) }
        scheduler.run()
    }

    @Test
    fun `a history snapshot never re-applies frames the queue is still holding`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            val scheduler = ManualScheduler()
            val vm = queuedVm(api, scheduler, this)
            vm.bind("s1")
            // Frames arrive and queue; the display-rate flush has not fired yet.
            assertTrue(vm.onFrame(recordFrame(recordJson())))
            assertTrue(vm.onFrame(deltaFrame("Hel")))
            assertTrue(scheduler.isPending)
            // omp is further ahead than the queued delta: its snapshot already holds it.
            api.history = { historyJson(recordJson(answer = "Hello world", updatedAt = t0 + 50)) }

            vm.onStreamOpen()

            assertEquals("snapshot wins over older text", "Hello world", vm.state.value.records[0].answer)
            // Now let any queued flush fire. If the snapshot were merged BEFORE the
            // queue was drained, the delta would append onto the snapshot's text
            // instead of being superseded by it — "Hello worldHel".
            scheduler.run()
            assertEquals("queued delta was applied twice", "Hello world", vm.state.value.records[0].answer)
            assertEquals(1, vm.state.value.records.size)
        }

    @Test
    fun `deltas stream into a running record and stop once it settles`() =
        runTest(UnconfinedTestDispatcher()) {
            val scheduler = ManualScheduler()
            val vm = queuedVm(FakeBtwApi(), scheduler, this)
            vm.bind("s1")

            apply(vm, scheduler, recordFrame(recordJson()), deltaFrame("4"))
            assertEquals("4", vm.state.value.records[0].answer)

            // A settled turn is history, not a live stream: a late frame must not
            // keep appending to an answer the user has already read.
            apply(
                vm,
                scheduler,
                recordFrame(recordJson(answer = "4", status = BtwStatus.COMPLETE, updatedAt = t0 + 10)),
                deltaFrame(" more"),
            )
            assertEquals("a delta appended past a settled answer", "4", vm.state.value.records[0].answer)
            assertEquals(BtwStatus.COMPLETE, vm.state.value.records[0].status)
        }

    @Test
    fun `asking opens the panel and a follow-up answers in its own turn`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            api.reply = { reply ->
                if (commandType(reply) == "btw") {
                    jsonObject(
                        "record" to recordJson(
                            answer = "4",
                            status = BtwStatus.COMPLETE,
                            updatedAt = t0 + 5,
                        ),
                    )
                } else {
                    null
                }
            }
            val vm = sideQuestionVm(api, this)
            vm.bind("s1")

            assertEquals(BtwAskResult.Started, vm.ask("2+2?", null))
            assertEquals("asking a new topic opens its panel", "r1", vm.state.value.activeId)
            assertTrue(vm.state.value.expanded)
            assertEquals("4", vm.state.value.records[0].answer)

            assertTrue(
                vm.onFrame(
                    recordFrame(
                        recordJson(
                            answer = "4",
                            status = BtwStatus.COMPLETE,
                            updatedAt = t0 + 10,
                            followUps = listOf(
                                jsonObject(
                                    "question" to JsonPrimitive("and 3+3?"),
                                    "answer" to JsonPrimitive("6"),
                                    "status" to JsonPrimitive("complete"),
                                    "createdAt" to JsonPrimitive(t0 + 10),
                                    "updatedAt" to JsonPrimitive(t0 + 10),
                                ),
                            ),
                        ),
                    ),
                ),
            )
            val latest = vm.state.value.records[0].followUps.last()
            assertEquals("a follow-up answers in its own turn", "6", latest.answer)
            assertEquals("the first answer stays intact", "4", vm.state.value.records[0].answer)
        }

    @Test
    fun `an unknown running record opens the panel and a known closed topic stays closed`() =
        runTest(UnconfinedTestDispatcher()) {
            val scheduler = ManualScheduler()
            val vm = queuedVm(FakeBtwApi(), scheduler, this)
            vm.bind("s1")

            apply(vm, scheduler, recordFrame(recordJson()))
            assertEquals("r1", vm.state.value.activeId)
            assertTrue(vm.state.value.expanded)

            vm.toggle()
            assertFalse(vm.state.value.expanded)
            vm.close()
            assertNull(vm.state.value.activeId)

            apply(vm, scheduler, recordFrame(recordJson(answer = "4", status = BtwStatus.COMPLETE, updatedAt = t0 + 1)))
            assertNull("a known topic never reopens a closed panel", vm.state.value.activeId)

            apply(
                vm,
                scheduler,
                recordFrame(recordJson(id = "r2", question = "next", createdAt = t0 + 2, updatedAt = t0 + 2)),
            )
            assertEquals("a running record this client did not know opens it", "r2", vm.state.value.activeId)
            assertTrue(vm.state.value.expanded)
        }

    @Test
    fun `only side-question frames are consumed`() = runTest(UnconfinedTestDispatcher()) {
        val scheduler = ManualScheduler()
        val vm = queuedVm(FakeBtwApi(), scheduler, this)
        vm.bind("s1")

        assertFalse(vm.onFrame(jsonObject("type" to JsonPrimitive("message_update"))))
        assertFalse(scheduler.isPending)
        assertTrue("malformed btw frames are still routed away from the transcript", vm.onFrame(jsonObject("type" to JsonPrimitive("btw_delta"))))
        scheduler.run()
        assertNull(vm.state.value.activeId)
    }

    @Test
    fun `a cancelled before it started ask stays silent and does not open the panel`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            api.reply = { throw IllegalStateException("btw cancelled before it started") }
            val vm = sideQuestionVm(api, this)
            vm.bind("s1")
            val errors = mutableListOf<BtwFailure>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.errors.collect { errors += it } }

            assertEquals(BtwAskResult.Started, vm.ask("2+2?"))
            assertNull(vm.state.value.activeId)
            assertTrue(errors.isEmpty())
        }

    @Test
    fun `an omp without btw reports the upgrade hint and a background refresh pauses`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            api.reply = { throw ApiError.ServerResponse(400, null, "Unknown command: btw") }
            api.history = { throw ApiError.ServerResponse(400, null, "Unknown command: get_btw_history") }
            val vm = sideQuestionVm(api, this)
            vm.bind("s1")
            val errors = mutableListOf<BtwFailure>()
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.errors.collect { errors += it } }

            assertEquals(BtwAskResult.Refused(BtwRefusal.UNSUPPORTED), vm.ask("2+2?"))
            assertEquals(BtwFailureKind.UNSUPPORTED, errors.single().kind)

            // Background reads pause, so every SSE reconnect cannot re-ask an old omp.
            vm.onStreamOpen()
            vm.onStreamOpen()
            assertEquals(1, api.types().count { it == "get_btw_history" })
            assertEquals("background reads stay silent", 1, errors.size)

            // The pause is shared with every chat on the same server.
            val otherApi = FakeBtwApi()
            val other = sideQuestionVm(otherApi, this)
            other.bind("s1")
            other.onStreamOpen()
            assertTrue("another chat re-asked the same old omp", otherApi.types().isEmpty())

            // A restarted omp answers again: an explicit read lifts the pause.
            api.reply = { null }
            api.history = { historyJson() }
            vm.openHistory()
            val reads = api.types().count { it == "get_btw_history" }
            vm.onStreamOpen()
            assertEquals("the successful read did not lift the pause", reads + 1, api.types().count { it == "get_btw_history" })
        }

    @Test
    fun `ask refuses without a session and bind resets the panel`() =
        runTest(UnconfinedTestDispatcher()) {
            val scheduler = ManualScheduler()
            val vm = queuedVm(FakeBtwApi(), scheduler, this)
            vm.bind(null)
            assertEquals(BtwAskResult.Refused(BtwRefusal.NO_SESSION), vm.ask("2+2?"))
            assertEquals(
                BtwRefusal.EMPTY_QUESTION,
                (vm.ask("   ") as BtwAskResult.Refused).reason,
            )

            vm.bind("s1")
            apply(vm, scheduler, recordFrame(recordJson()))
            assertEquals("r1", vm.state.value.activeId)
            vm.bind("s2")
            assertTrue(vm.state.value.records.isEmpty())
            assertNull(vm.state.value.activeId)
        }

    @Test
    fun `history no longer holding a running record interrupts it`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            val scheduler = ManualScheduler()
            val vm = queuedVm(api, scheduler, this)
            vm.bind("s1")
            apply(vm, scheduler, recordFrame(recordJson()))
            assertEquals(BtwStatus.RUNNING, vm.state.value.records[0].status)

            api.history = { historyJson() }
            vm.onStreamOpen()
            assertEquals(BtwStatus.INTERRUPTED, vm.state.value.records[0].status)
        }

    @Test
    fun `the history dialog starts omp before reading and opens a topic on follow up`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            val scheduler = ManualScheduler()
            val vm = queuedVm(api, scheduler, this)
            vm.bind("s1")
            apply(
                vm,
                scheduler,
                recordFrame(recordJson(answer = "4", status = BtwStatus.COMPLETE)),
                recordFrame(recordJson(id = "r2", question = "next", createdAt = t0 + 2, updatedAt = t0 + 2)),
            )

            vm.openHistory()

            assertEquals("get_state starts a wrapper, get_btw_history never does", listOf("get_state", "get_btw_history"), api.types())
            assertTrue(vm.state.value.historyOpen)

            vm.openRecord("r1")
            assertEquals("r1", vm.state.value.activeId)
            assertFalse(vm.state.value.historyOpen)
            assertTrue(vm.state.value.expanded)

            vm.openHistory()
            vm.closeHistory()
            assertFalse(vm.state.value.historyOpen)
        }

    @Test
    fun `reconcile reads the history only while an answer runs`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            val scheduler = ManualScheduler()
            val vm = queuedVm(api, scheduler, this)
            vm.bind("s1")
            apply(vm, scheduler, recordFrame(recordJson()))

            vm.onReconcile()
            assertEquals(1, api.types().count { it == "get_btw_history" })

            apply(vm, scheduler, recordFrame(recordJson(answer = "4", status = BtwStatus.COMPLETE, updatedAt = t0 + 5)))
            vm.onReconcile()
            assertEquals("nothing is running: no half-open recovery read", 1, api.types().count { it == "get_btw_history" })
        }

    @Test
    fun `a cancel that found nothing running re-reads the history`() =
        runTest(UnconfinedTestDispatcher()) {
            val api = FakeBtwApi()
            val scheduler = ManualScheduler()
            val vm = queuedVm(api, scheduler, this)
            vm.bind("s1")
            apply(vm, scheduler, recordFrame(recordJson()))
            api.reply = { command ->
                if (commandType(command) == "btw_cancel") jsonObject("cancelled" to JsonPrimitive(false)) else null
            }
            api.history = { historyJson() }

            vm.cancel()

            assertEquals(listOf("btw_cancel", "get_btw_history"), api.types())
            assertEquals("the shown state was stale: omp lost the record", BtwStatus.INTERRUPTED, vm.state.value.records[0].status)
        }
}

private fun commandType(command: JsonObject): String? =
    (command["type"] as? JsonPrimitive)?.contentOrNull

private fun jsonObject(vararg entries: Pair<String, JsonElement>): JsonObject = buildJsonObject {
    for ((key, value) in entries) put(key, value)
}

private fun BtwStatus.wire(): String = when (this) {
    BtwStatus.RUNNING -> "running"
    BtwStatus.COMPLETE -> "complete"
    BtwStatus.CANCELLED -> "cancelled"
    BtwStatus.ERROR -> "error"
    BtwStatus.INTERRUPTED -> "interrupted"
}
