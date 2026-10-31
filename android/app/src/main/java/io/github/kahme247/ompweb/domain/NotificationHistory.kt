package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The server's notification history and the rules the Notifications tab
 * mirrors from the web (`lib/notification-history.ts`,
 * `components/NotificationList.tsx`, `app/api/notifications/history/route.ts`).
 *
 * The server owns the list. This file only defines what one entry is, how an
 * untrusted entry is validated, and the local rules: a delivered event joins
 * the list without a refetch, marking read is optimistic, and a stale snapshot
 * never overwrites a local change that the server has not seen yet.
 */

/** Server cap (`MAX_HISTORY`, `lib/notification-store.ts`). */
const val NOTIFICATION_HISTORY_LIMIT = 100

/** `MAX_ID_LENGTH` in `app/api/notifications/history/route.ts`. */
const val NOTIFICATION_HISTORY_MAX_ID_LENGTH = 256

/** `MAX_IDS` in `app/api/notifications/history/route.ts`; a PATCH above it is rejected. */
const val NOTIFICATION_HISTORY_MAX_IDS = 100

/** Web clips a session name to 100 characters before showing it as a title. */
const val NOTIFICATION_TITLE_MAX = 100

/** Web clips a question/error/reason detail to 180 characters. */
const val NOTIFICATION_DETAIL_MAX = 180

/** Wire types the server emits today; unknown values still render (leniently). */
object NotificationHistoryType {
    const val COMPLETED = "completed"
    const val INPUT = "input"
    const val ERROR = "error"
    const val MODEL_SWITCH = "modelSwitch"
    const val TEST = "test"
}

/**
 * The event fields the history list needs. The wire event carries more
 * (`dialog`, `requestId`, `aliases`); those belong to the notification
 * renderer and the answer flow, not to this list.
 */
data class NotificationHistoryEvent(
    val type: String,
    val sessionId: String,
    val sessionName: String? = null,
    val detail: String? = null,
    val from: String? = null,
    val to: String? = null,
)

/**
 * One persisted notification. `id` is the server's replace-tag
 * `<sessionId>:<type>`, so a newer event of the same kind replaces the old
 * entry instead of stacking.
 */
data class NotificationHistoryEntry(
    val id: String,
    val event: NotificationHistoryEvent,
    /** Wall-clock milliseconds, as the server recorded them. */
    val at: Long,
    val read: Boolean,
)

/** True when [id] may be sent to the history route. */
fun isValidNotificationHistoryId(id: String): Boolean =
    id.isNotEmpty() && id.length <= NOTIFICATION_HISTORY_MAX_ID_LENGTH

/** Flatten and clip display text the same way the web renders a notification. */
fun clipNotificationText(value: String, max: Int = NOTIFICATION_DETAIL_MAX): String {
    val flat = value.replace(Regex("\\s+"), " ").trim()
    return if (flat.length > max) flat.take(max - 1) + "…" else flat
}

/**
 * Parse one entry from `GET /api/notifications/history` or from a live
 * `notification` frame. Anything that does not carry the documented shape is
 * dropped rather than guessed at (web `isEntry`).
 */
fun parseNotificationHistoryEntry(element: JsonElement?): NotificationHistoryEntry? {
    val root = element as? JsonObject ?: return null
    val id = root.string("id") ?: return null
    if (!isValidNotificationHistoryId(id)) return null
    val event = parseNotificationHistoryEvent(root["event"]) ?: return null
    val at = root["at"]?.strictLong() ?: return null
    val read = root["read"]?.strictBoolean() ?: return null
    return NotificationHistoryEntry(id = id, event = event, at = at, read = read)
}

/**
 * Parse a live notification event (`{"type":"notification","event":{…}}`'s
 * `event`) into a history entry the list can show immediately. The server
 * records the same entry before delivering the frame, so [nowMs] is only used
 * until the next `refresh()` replaces the list with the server's timestamps.
 */
fun notificationHistoryEntryFromEvent(event: JsonElement?, nowMs: Long): NotificationHistoryEntry? {
    val parsed = parseNotificationHistoryEvent(event) ?: return null
    if (parsed.type.isBlank()) return null
    return NotificationHistoryEntry(
        id = historyEntryId(parsed),
        event = parsed,
        at = nowMs,
        read = false,
    )
}

/** The replace-tag of [event], exactly like `renderNotification`'s `tag`. */
fun historyEntryId(event: NotificationHistoryEvent): String = "${event.sessionId}:${event.type}"

/** The server's `{entries:[…]}` answer; invalid entries are skipped, order kept. */
fun parseNotificationHistoryEntries(root: JsonElement?): List<NotificationHistoryEntry> {
    val entries = (root as? JsonObject)?.get("entries") as? JsonArray ?: return emptyList()
    return entries.mapNotNull(::parseNotificationHistoryEntry)
}

/**
 * A live event joins the already loaded list without a refetch: it replaces
 * the entry with the same tag and goes to the front, keeping at most
 * [NOTIFICATION_HISTORY_LIMIT] entries (web `notificationHistory.add`).
 */
fun mergeDeliveredNotification(
    entries: List<NotificationHistoryEntry>,
    delivered: NotificationHistoryEntry,
): List<NotificationHistoryEntry> {
    val merged = ArrayList<NotificationHistoryEntry>(entries.size + 1)
    merged += delivered
    entries.forEach { entry -> if (entry.id != delivered.id) merged += entry }
    return if (merged.size > NOTIFICATION_HISTORY_LIMIT) merged.subList(0, NOTIFICATION_HISTORY_LIMIT) else merged
}

/** Mark exactly [ids] read; unknown and already read ids are left alone. */
fun markNotificationHistoryRead(
    entries: List<NotificationHistoryEntry>,
    ids: Collection<String>,
): List<NotificationHistoryEntry> {
    if (ids.isEmpty()) return entries
    val wanted = ids.toSet()
    var changed = false
    val next = entries.map { entry ->
        if (entry.read || entry.id !in wanted) {
            entry
        } else {
            changed = true
            entry.copy(read = true)
        }
    }
    return if (changed) next else entries
}

/** Remove one entry; the id is the server's key, so at most one row matches. */
fun removeNotificationHistoryEntry(
    entries: List<NotificationHistoryEntry>,
    id: String,
): List<NotificationHistoryEntry> {
    if (entries.none { it.id == id }) return entries
    return entries.filterNot { it.id == id }
}

/** Unread entries; the bell badge and the mark-all-read enablement read this. */
fun unreadNotificationCount(entries: List<NotificationHistoryEntry>): Int = entries.count { !it.read }

/**
 * The ids a PATCH may carry: unread, unique, valid and capped to the
 * server's [NOTIFICATION_HISTORY_MAX_IDS]. The web sends the ids the tab shows.
 */
fun notificationReadIds(entries: List<NotificationHistoryEntry>): List<String> =
    entries.asSequence()
        .filter { !it.read }
        .map { it.id }
        .filter(::isValidNotificationHistoryId)
        .distinct()
        .take(NOTIFICATION_HISTORY_MAX_IDS)
        .toList()

private fun parseNotificationHistoryEvent(element: JsonElement?): NotificationHistoryEvent? {
    val root = element as? JsonObject ?: return null
    val type = root.string("type")?.takeIf { it.isNotBlank() } ?: return null
    val sessionId = root.string("sessionId") ?: return null
    return NotificationHistoryEvent(
        type = type,
        sessionId = sessionId,
        sessionName = root.string("sessionName"),
        detail = root.string("detail"),
        from = root.string("from"),
        to = root.string("to"),
    )
}

private fun JsonObject.string(key: String): String? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    val value = primitive.content
    return value.takeIf { it.isNotEmpty() }
}

/** JSON numbers only; a stringified number is not what the route documents. */
private fun JsonElement.strictLong(): Long? =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

/** JSON booleans only (`typeof value === "boolean"` in the web's `isEntry`). */
private fun JsonElement.strictBoolean(): Boolean? =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/**
 * Stale-snapshot bookkeeping from the web store. A load's answer is applied
 * only when no local change and no change request happened since it started;
 * otherwise the answer is dropped and the list is fetched again once the
 * pending requests settle. That is what keeps a dismissed entry from coming
 * back or a mark-read from flickering off.
 */
class NotificationHistorySync {
    private var changes = 0
    private var requestsInFlight = 0
    private var loads = 0
    private var reloadWhenSettled = false

    /** A local change (delivered, read, removed, cleared) happened. */
    fun localChange() {
        changes++
    }

    /** Snapshot a new load; the newest token answers, older answers are ignored. */
    fun beginLoad(): LoadToken {
        loads++
        return LoadToken(sequence = loads, changesAtStart = changes)
    }

    fun beginRequest() {
        requestsInFlight++
    }

    /** A change request failed: the server's list is the truth, so reload once idle. */
    fun requestFailed() {
        reloadWhenSettled = true
    }

    /** A request settled; true means the caller must reload now. */
    fun endRequest(): Boolean {
        if (requestsInFlight > 0) requestsInFlight--
        if (requestsInFlight > 0 || !reloadWhenSettled) return false
        reloadWhenSettled = false
        return true
    }

    /** True while [token] is still the newest load (an older failure keeps the newer error). */
    fun isLatest(token: LoadToken): Boolean = token.sequence == loads

    /** What to do with one load's answer. */
    fun decide(token: LoadToken): SnapshotDecision {
        if (token.sequence != loads) return SnapshotDecision.Ignore
        if (changes != token.changesAtStart) {
            if (requestsInFlight > 0) {
                reloadWhenSettled = true
                return SnapshotDecision.ReloadWhenSettled
            }
            return SnapshotDecision.Reload
        }
        if (requestsInFlight > 0) {
            reloadWhenSettled = true
            return SnapshotDecision.ReloadWhenSettled
        }
        return SnapshotDecision.Apply
    }

    /**
     * The list belongs to another server now (sign-out, server switch): forget
     * every in-flight load and request, so their answers are dropped instead
     * of landing in the new installation's list.
     */
    fun reset() {
        changes++
        loads++
        requestsInFlight = 0
        reloadWhenSettled = false
    }

    data class LoadToken(val sequence: Int, val changesAtStart: Int)
}

/** What a refresh does with its answer (web `notificationHistory.load`). */
sealed interface SnapshotDecision {
    /** Replace the shown list with the server's. */
    data object Apply : SnapshotDecision

    /** A local change raced the load; fetch again instead of applying. */
    data object Reload : SnapshotDecision

    /** A change request is still in flight; reload when it settles. */
    data object ReloadWhenSettled : SnapshotDecision

    /** A newer load answers for this one. */
    data object Ignore : SnapshotDecision
}
