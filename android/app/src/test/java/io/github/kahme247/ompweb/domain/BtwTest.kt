package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Port of `lib/btw.test.mjs`: the pure state transitions of `/btw` records fed
 * by frames, responses and history snapshots that can arrive in any order.
 */
class BtwTest {

    private fun recordJson(
        id: String = "r1",
        question: String = "what is 2+2",
        answer: String = "",
        status: BtwStatus = BtwStatus.RUNNING,
        createdAt: Long = 1,
        updatedAt: Long = 1,
        followUps: List<JsonObject>? = null,
    ): JsonObject = buildJsonObject {
        put("id", id)
        put("leafId", JsonPrimitive("leaf-1"))
        put("question", question)
        put("answer", answer)
        put("status", status.wire)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        if (followUps != null) put("followUps", kotlinx.serialization.json.JsonArray(followUps))
    }

    private fun record(
        id: String = "r1",
        question: String = "what is 2+2",
        answer: String = "",
        status: BtwStatus = BtwStatus.RUNNING,
        createdAt: Long = 1,
        updatedAt: Long = 1,
        followUps: List<BtwTurn> = emptyList(),
    ): BtwRecord = BtwRecord(
        id = id,
        leafId = "leaf-1",
        question = question,
        answer = answer,
        status = status,
        createdAt = createdAt,
        updatedAt = updatedAt,
        followUps = followUps,
    )

    private fun delta(text: String, recordId: String = "r1"): JsonObject = buildJsonObject {
        put("type", "btw_delta")
        put("recordId", recordId)
        put("delta", text)
    }

    private fun recordFrame(record: JsonObject): JsonObject = buildJsonObject {
        put("type", "btw_record")
        put("record", record)
    }

    @Test
    fun `deltas stream into a running record and stop once it settles`() {
        var records = applyBtwEvent(emptyList(), recordFrame(recordJson()))
        records = applyBtwEvent(records, delta("It is "))
        records = applyBtwEvent(records, delta("4."))
        assertEquals("It is 4.", records[0].answer)

        records = applyBtwEvent(
            records,
            recordFrame(recordJson(answer = "It is 4.", status = BtwStatus.COMPLETE, updatedAt = 2)),
        )
        records = applyBtwEvent(records, delta(" late"))
        assertEquals("It is 4.", records[0].answer)
        assertEquals(BtwStatus.COMPLETE, records[0].status)
    }

    @Test
    fun `a late btw response never wipes streamed text or resurrects a finished answer`() {
        // SSE can beat the HTTP response: deltas land before the `btw` command's running snapshot.
        var records = applyBtwEvent(emptyList(), recordFrame(recordJson()))
        records = applyBtwEvent(records, delta("It is 4."))
        records = upsertBtwRecord(records, record())
        assertEquals("It is 4.", records[0].answer)

        records = applyBtwEvent(
            records,
            recordFrame(recordJson(answer = "It is 4.", status = BtwStatus.COMPLETE)),
        )
        records = upsertBtwRecord(records, record(answer = "It is"))
        assertEquals(BtwStatus.COMPLETE, records[0].status)
        assertEquals("It is 4.", records[0].answer)
    }

    @Test
    fun `follow-up deltas extend the latest turn, not the original answer`() {
        val first = record(answer = "4", status = BtwStatus.COMPLETE)
        val followUp = BtwTurn(
            question = "and 3+3?",
            answer = "",
            status = BtwStatus.RUNNING,
            createdAt = 3,
            updatedAt = 3,
        )
        var records = upsertBtwRecord(listOf(first), first.copy(followUps = listOf(followUp)))
        records = applyBtwEvent(records, delta("6"))
        assertEquals("4", records[0].answer)
        assertEquals("6", latestBtwTurn(records[0]).answer)
        // A snapshot from before the follow-up started is stale.
        assertSame(records, upsertBtwRecord(records, first))
    }

    @Test
    fun `a new topic goes first, ahead of older ones`() {
        var records = applyBtwEvent(
            emptyList(),
            recordFrame(recordJson(status = BtwStatus.COMPLETE)),
        )
        records = applyBtwEvent(
            records,
            recordFrame(recordJson(id = "r2", question = "next", createdAt = 5, updatedAt = 5)),
        )
        assertEquals(listOf("r2", "r1"), records.map { it.id })
    }

    @Test
    fun `an authoritative snapshot heals streamed text that diverged from omps`() {
        // Deltas applied twice (e.g. replayed after a snapshot that already held them).
        val records = listOf(record(answer = "abcdcd"))
        assertEquals("abcde", upsertBtwRecord(records, record(answer = "abcde"))[0].answer)
        assertEquals(
            "abcdcd!",
            upsertBtwRecord(records, record(answer = "abcdcd!", status = BtwStatus.COMPLETE))[0].answer,
        )
    }

    @Test
    fun `malformed frames leave the records untouched`() {
        val records = listOf(record(answer = "4"))
        val withoutUpdatedAt = buildJsonObject {
            put("id", "r9")
            put("question", "q")
            put("answer", "")
            put("status", "running")
            put("createdAt", 1)
        }
        val frames = listOf(
            recordFrame(withoutUpdatedAt),
            recordFrame(recordJson(id = "r9", status = BtwStatus.RUNNING).withStatus("finished")),
            recordFrame(
                buildJsonObject {
                    put("id", "r9")
                    put("question", "q")
                    put("answer", "")
                    put("status", "running")
                    put("createdAt", 1)
                    put("updatedAt", 1)
                    put("followUps", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject { put("question", "q") })))
                },
            ),
            // Finite but outside the Date range: the history dialog would throw formatting it.
            recordFrame(recordJson(id = "r9", updatedAt = 10_000_000_000_000_000L)),
            recordFrame(recordJson(id = "r9", createdAt = -1)),
            buildJsonObject { put("type", "btw_record") },
            buildJsonObject {
                put("type", "btw_delta")
                put("recordId", "r1")
                put("delta", 4)
            },
            buildJsonObject {
                put("type", "btw_delta")
                put("delta", "x")
            },
            delta("x", recordId = "unknown"),
        )
        for (frame in frames) {
            assertSame(frame.toString(), records, applyBtwEvent(records, frame))
        }
    }

    @Test
    fun `history snapshots keep newer local state and merge newest first`() {
        val streaming = record(answer = "It is 4", createdAt = 2)
        val local = listOf(
            record(id = "r2", question = "new", createdAt = 3, updatedAt = 3),
            streaming,
        )
        val merged = mergeBtwHistory(
            local,
            listOf(
                record(answer = "It", createdAt = 2),
                record(id = "r0", status = BtwStatus.COMPLETE, answer = "old", createdAt = 9),
            ),
            setOf("r1"),
        )
        assertEquals(listOf("r0", "r2", "r1"), merged.map { it.id })
        assertEquals("It is 4", merged.first { it.id == "r1" }.answer)
        assertEquals(
            "started after the request: the snapshot predates it",
            BtwStatus.RUNNING,
            merged.first { it.id == "r2" }.status,
        )
    }

    @Test
    fun `a running record omp no longer knows becomes interrupted, not a spinner forever`() {
        val followUp = BtwTurn(
            question = "and 3+3?",
            answer = "6",
            status = BtwStatus.RUNNING,
            createdAt = 3,
            updatedAt = 3,
        )
        val local = listOf(
            record(answer = "4", status = BtwStatus.COMPLETE, followUps = listOf(followUp)),
            record(id = "r0", status = BtwStatus.COMPLETE, createdAt = 0),
        )
        val merged = mergeBtwHistory(local, emptyList(), setOf("r1", "r0"))
        assertEquals(BtwStatus.INTERRUPTED, latestBtwTurn(merged[0]).status)
        assertEquals("earlier turns keep their status", BtwStatus.COMPLETE, merged[0].status)
        assertEquals("the partial answer stays readable", "6", latestBtwTurn(merged[0]).answer)
        assertSame("finished records the snapshot lacks are kept as they are", local[1], merged[1])
    }

    private fun JsonObject.withStatus(status: String): JsonObject {
        val source = this
        return buildJsonObject {
            for ((key, value) in source) {
                if (key != "status") put(key, value)
            }
            put("status", status)
        }
    }
}

/** The wire spelling of [BtwStatus] (omp's `btw_record.status`). */
private val BtwStatus.wire: String
    get() = when (this) {
        BtwStatus.RUNNING -> "running"
        BtwStatus.COMPLETE -> "complete"
        BtwStatus.CANCELLED -> "cancelled"
        BtwStatus.ERROR -> "error"
        BtwStatus.INTERRUPTED -> "interrupted"
    }
