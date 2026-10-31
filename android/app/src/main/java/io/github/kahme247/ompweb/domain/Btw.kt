package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Side questions (omp's `/btw`): record shapes and the pure state transitions
 * applied to `btw_record`/`btw_delta` frames, `btw` responses and
 * `get_btw_history` snapshots (web `lib/btw.ts`).
 *
 * These can arrive in any order relative to each other (SSE vs. HTTP), so a
 * snapshot never rolls back what is already shown.
 */
enum class BtwStatus { RUNNING, COMPLETE, CANCELLED, ERROR, INTERRUPTED }

/** One question/answer exchange; follow-ups of a topic are [BtwTurn]s too. */
data class BtwTurn(
    val question: String,
    val answer: String,
    val status: BtwStatus,
    val createdAt: Long,
    val updatedAt: Long,
    val error: String? = null,
)

/** A topic: the first turn's fields inline plus every follow-up after it. */
data class BtwRecord(
    val id: String,
    val leafId: String?,
    val question: String,
    val answer: String,
    val status: BtwStatus,
    val createdAt: Long,
    val updatedAt: Long,
    val error: String? = null,
    val followUps: List<BtwTurn> = emptyList(),
) {
    val rootTurn: BtwTurn
        get() = BtwTurn(question, answer, status, createdAt, updatedAt, error)
}

fun btwTurns(record: BtwRecord): List<BtwTurn> = listOf(record.rootTurn) + record.followUps

fun latestBtwTurn(record: BtwRecord): BtwTurn = record.followUps.lastOrNull() ?: record.rootTurn

/**
 * What Copy copies: the newest answer with text. A follow-up that was
 * cancelled or failed before writing anything leaves the earlier answer
 * visible, so it stays copyable.
 */
fun latestBtwAnswer(record: BtwRecord): String =
    btwTurns(record).lastOrNull { it.answer.trim().isNotEmpty() }?.answer.orEmpty()

/** Epoch ms a `Date` can hold (omp's schema range); outside it nothing renders. */
private const val MAX_EPOCH_MS: Double = 8.64e15

private fun JsonPrimitive.isPlainString(): Boolean = isString

private fun JsonObject.stringField(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf(JsonPrimitive::isPlainString)?.content

/** The frame's `type`, tolerant of a missing/non-string field. */
internal fun JsonObject.btwType(): String? = stringField("type")

internal fun JsonObject.btwString(key: String): String? = stringField(key)

/** A JSON number inside omp's epoch range; a quoted number or anything else is not. */
private fun JsonElement?.epochMs(): Long? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    val value = primitive.doubleOrNull ?: return null
    if (value < 0 || value > MAX_EPOCH_MS) return null
    return value.toLong()
}

internal fun parseBtwStatus(value: String?): BtwStatus? = when (value) {
    "running" -> BtwStatus.RUNNING
    "complete" -> BtwStatus.COMPLETE
    "cancelled" -> BtwStatus.CANCELLED
    "error" -> BtwStatus.ERROR
    "interrupted" -> BtwStatus.INTERRUPTED
    else -> null
}

private fun parseTurn(element: JsonElement?): BtwTurn? {
    val obj = element as? JsonObject ?: return null
    val question = obj.stringField("question") ?: return null
    val answer = obj.stringField("answer") ?: return null
    val status = parseBtwStatus(obj.stringField("status")) ?: return null
    val createdAt = obj["createdAt"].epochMs() ?: return null
    val updatedAt = obj["updatedAt"].epochMs() ?: return null
    // Absent is fine; present must be a string (`null` is not, as on the web).
    val error = if (obj.containsKey("error")) {
        (obj["error"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isPlainString)?.content ?: return null
    } else {
        null
    }
    return BtwTurn(question, answer, status, createdAt, updatedAt, error)
}

/** A well-formed record, or null for anything omp could not have sent. */
fun parseBtwRecord(element: JsonElement?): BtwRecord? {
    val obj = element as? JsonObject ?: return null
    val id = obj.stringField("id") ?: return null
    val followUps = if (obj.containsKey("followUps")) {
        val array = obj["followUps"] as? JsonArray ?: return null
        array.map { parseTurn(it) ?: return null }
    } else {
        emptyList()
    }
    val turn = parseTurn(obj) ?: return null
    return BtwRecord(
        id = id,
        leafId = obj.stringField("leafId"),
        question = turn.question,
        answer = turn.answer,
        status = turn.status,
        createdAt = turn.createdAt,
        updatedAt = turn.updatedAt,
        error = turn.error,
        followUps = followUps,
    )
}

/**
 * `incoming` is older than `current`: it misses a turn, reports a finished
 * turn as running, or lacks text that deltas already appended.
 */
private fun isStaleSnapshot(current: BtwRecord, incoming: BtwRecord): Boolean {
    val have = current.followUps.size
    val got = incoming.followUps.size
    if (got != have) return got < have
    val mine = latestBtwTurn(current)
    val theirs = latestBtwTurn(incoming)
    if (theirs.status != BtwStatus.RUNNING) return false
    if (mine.status != BtwStatus.RUNNING) return true
    return mine.answer.length > theirs.answer.length && mine.answer.startsWith(theirs.answer)
}

private fun BtwRecord.updateLatestTurn(patch: (BtwTurn) -> BtwTurn): BtwRecord {
    if (followUps.isEmpty()) {
        val updated = patch(rootTurn)
        return copy(
            question = updated.question,
            answer = updated.answer,
            status = updated.status,
            createdAt = updated.createdAt,
            updatedAt = updated.updatedAt,
            error = updated.error,
        )
    }
    return copy(followUps = followUps.dropLast(1) + patch(followUps.last()))
}

/** omp's history order: newest topic first. */
private val NEWEST_FIRST: Comparator<BtwRecord> = Comparator { a, b ->
    val byDate = b.createdAt.compareTo(a.createdAt)
    if (byDate != 0) byDate else a.id.compareTo(b.id)
}

/** Insert (newest first) or replace a record unless the snapshot is stale. */
fun upsertBtwRecord(records: List<BtwRecord>, incoming: BtwRecord): List<BtwRecord> {
    val index = records.indexOfFirst { it.id == incoming.id }
    if (index == -1) return listOf(incoming) + records
    if (isStaleSnapshot(records[index], incoming)) return records
    return records.toMutableList().also { it[index] = incoming }
}

/** Apply one SSE frame; unrelated or malformed frames leave [records] as is. */
fun applyBtwEvent(records: List<BtwRecord>, event: JsonObject): List<BtwRecord> {
    when (event.btwType()) {
        "btw_record" -> {
            val record = parseBtwRecord(event["record"]) ?: return records
            return upsertBtwRecord(records, record)
        }

        "btw_delta" -> {
            val recordId = event.btwString("recordId") ?: return records
            val delta = event.btwString("delta")?.takeIf { it.isNotEmpty() } ?: return records
            // Streamed text extends the latest turn of a running record only.
            val index = records.indexOfFirst { it.id == recordId }
            if (index == -1) return records
            val latest = latestBtwTurn(records[index])
            if (latest.status != BtwStatus.RUNNING) return records
            val next = records.toMutableList()
            next[index] = records[index].updateLatestTurn { it.copy(answer = it.answer + delta) }
            return next
        }

        else -> return records
    }
}

/**
 * Replace local state with a history snapshot, keeping records the snapshot
 * predates (started after it was taken, or with newer streamed text). A record
 * that was running before the request ([knownBefore]) but is missing from the
 * snapshot cannot still be running: omp lost it (failed checkpoint, replaced
 * child), so it becomes `interrupted` instead of spinning forever.
 */
fun mergeBtwHistory(
    local: List<BtwRecord>,
    snapshot: List<BtwRecord>,
    knownBefore: Set<String>,
): List<BtwRecord> {
    val localById = local.associateBy { it.id }
    val snapshotIds = snapshot.mapTo(HashSet()) { it.id }
    val merged = snapshot.map { record ->
        val mine = localById[record.id]
        if (mine != null && isStaleSnapshot(mine, record)) mine else record
    }.toMutableList()
    for (record in local) {
        if (record.id in snapshotIds) continue
        val lost = record.id in knownBefore && latestBtwTurn(record).status == BtwStatus.RUNNING
        merged += if (lost) record.updateLatestTurn { it.copy(status = BtwStatus.INTERRUPTED) } else record
    }
    return merged.sortedWith(NEWEST_FIRST)
}
