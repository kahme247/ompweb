package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of `lib/notification-history.ts`'s hidden rules: which entries the list
 * accepts, how a delivered event merges without a refetch, and when a load's
 * answer may replace local state. The web module is a singleton store; these
 * functions are its pure core so the rules can be pinned in JVM tests.
 */
class NotificationHistoryTest {

    private fun event(
        type: String = NotificationHistoryType.COMPLETED,
        sessionId: String = "s1",
        sessionName: String? = "Fix the build",
        detail: String? = null,
    ): JsonObject = buildJsonObject {
        put("type", type)
        put("sessionId", sessionId)
        if (sessionName != null) put("sessionName", sessionName)
        if (detail != null) put("detail", detail)
    }

    private fun entryJson(
        id: String = "s1:completed",
        event: JsonObject = event(),
        at: Long = 1_700_000_000_000L,
        read: Boolean = false,
    ): JsonObject = buildJsonObject {
        put("id", id)
        put("event", event)
        put("at", at)
        put("read", read)
    }

    private fun entry(
        id: String = "s1:completed",
        type: String = NotificationHistoryType.COMPLETED,
        read: Boolean = false,
        at: Long = 1_700_000_000_000L,
    ): NotificationHistoryEntry = NotificationHistoryEntry(
        id = id,
        event = NotificationHistoryEvent(type = type, sessionId = id.substringBefore(':'), sessionName = "S"),
        at = at,
        read = read,
    )

    // --- Parsing -----------------------------------------------------------

    @Test
    fun `a valid entry keeps its wire fields`() {
        val parsed = parseNotificationHistoryEntry(
            entryJson(
                id = "s1:input",
                event = event(
                    type = NotificationHistoryType.INPUT,
                    sessionName = "Release",
                    detail = "Allow tool: bash?",
                ),
                read = true,
            ),
        )!!
        assertEquals("s1:input", parsed.id)
        assertEquals(NotificationHistoryType.INPUT, parsed.event.type)
        assertEquals("s1", parsed.event.sessionId)
        assertEquals("Release", parsed.event.sessionName)
        assertEquals("Allow tool: bash?", parsed.event.detail)
        assertEquals(1_700_000_000_000L, parsed.at)
        assertTrue(parsed.read)
    }

    @Test
    fun `model switch fields survive`() {
        val parsed = parseNotificationHistoryEntry(
            entryJson(
                id = "s1:modelSwitch",
                event = buildJsonObject {
                    put("type", "modelSwitch")
                    put("sessionId", "s1")
                    put("from", "gpt-5")
                    put("to", "claude-sonnet")
                },
            ),
        )!!
        assertEquals("gpt-5", parsed.event.from)
        assertEquals("claude-sonnet", parsed.event.to)
    }

    @Test
    fun `the server's order is preserved and invalid entries are dropped`() {
        val root = buildJsonObject {
            put(
                "entries",
                buildJsonArray {
                    add(entryJson(id = "s1:completed"))
                    add(entryJson(id = "s2:input", event = event(type = "input", sessionId = "s2")))
                    add(buildJsonObject { put("id", "") })
                    add(buildJsonObject { put("id", "s3:error"); put("event", event(type = "error")) })
                    add(buildJsonObject { put("id", "s4:error"); put("event", event(type = "error")); put("at", 1) })
                    add(buildJsonObject { put("id", "s5:error"); put("event", event(type = "error")); put("at", 1); put("read", "yes") })
                },
            )
        }
        assertEquals(listOf("s1:completed", "s2:input"), parseNotificationHistoryEntries(root).map { it.id })
    }

    @Test
    fun `an entry id longer than the route's limit is rejected`() {
        val tooLong = "s1:" + "x".repeat(NOTIFICATION_HISTORY_MAX_ID_LENGTH)
        assertNull(parseNotificationHistoryEntry(entryJson(id = tooLong)))
        assertTrue(isValidNotificationHistoryId("y".repeat(NOTIFICATION_HISTORY_MAX_ID_LENGTH)))
        assertEquals(false, isValidNotificationHistoryId("y".repeat(NOTIFICATION_HISTORY_MAX_ID_LENGTH + 1)))
    }

    @Test
    fun `an event without a type or session id is unusable`() {
        assertNull(parseNotificationHistoryEntry(entryJson(event = buildJsonObject { put("sessionId", "s1") })))
        assertNull(parseNotificationHistoryEntry(entryJson(event = buildJsonObject { put("type", "completed") })))
        assertNull(parseNotificationHistoryEntry(entryJson(event = buildJsonObject { put("type", " "); put("sessionId", "s1") })))
    }

    @Test
    fun `a non-object or absent entries field yields an empty list`() {
        assertEquals(emptyList<NotificationHistoryEntry>(), parseNotificationHistoryEntries(null))
        assertEquals(emptyList<NotificationHistoryEntry>(), parseNotificationHistoryEntries(buildJsonObject { }))
        assertEquals(emptyList<NotificationHistoryEntry>(), parseNotificationHistoryEntries(buildJsonObject { put("entries", "nope") }))
    }

    // --- Delivered merge ---------------------------------------------------

    @Test
    fun `a delivered event becomes the replace-tagged front entry without a refetch`() {
        val delivered = notificationHistoryEntryFromEvent(
            event(type = NotificationHistoryType.INPUT, sessionId = "s2", detail = "Which target?"),
            nowMs = 1_800_000_000_000L,
        )!!
        assertEquals("s2:input", delivered.id)
        assertEquals(1_800_000_000_000L, delivered.at)
        assertEquals(false, delivered.read)

        val older = entry(id = "s1:completed")
        assertEquals(listOf(delivered, older), mergeDeliveredNotification(listOf(older), delivered))
    }

    @Test
    fun `a delivered event replaces the same tag instead of stacking`() {
        val first = entry(id = "s1:completed", read = true, at = 1)
        val other = entry(id = "s2:error", type = "error", at = 2)
        val delivered = entry(id = "s1:completed", at = 9)
        val merged = mergeDeliveredNotification(listOf(first, other), delivered)
        assertEquals(listOf("s1:completed", "s2:error"), merged.map { it.id })
        assertEquals(9L, merged.first().at)
        assertEquals(false, merged.first().read)
    }

    @Test
    fun `the merged list keeps at most the server's history limit`() {
        val hundred = (1..100).map { entry(id = "s$it:completed", at = it.toLong()) }
        val delivered = entry(id = "new:completed")
        val merged = mergeDeliveredNotification(hundred, delivered)
        assertEquals(NOTIFICATION_HISTORY_LIMIT, merged.size)
        assertEquals("new:completed", merged.first().id)
        assertEquals("s99:completed", merged.last().id)
    }

    @Test
    fun `an event that cannot be a history entry returns null`() {
        assertNull(notificationHistoryEntryFromEvent(null, 1))
        assertNull(notificationHistoryEntryFromEvent(buildJsonObject { put("type", "completed") }, 1))
        assertNull(notificationHistoryEntryFromEvent(buildJsonObject { put("sessionId", "s1") }, 1))
    }

    // --- Optimistic list changes ------------------------------------------

    @Test
    fun `only the requested ids become read`() {
        val a = entry(id = "a", read = false)
        val b = entry(id = "b", read = false)
        val c = entry(id = "c", read = true)
        val next = markNotificationHistoryRead(listOf(a, b, c), listOf("a", "c", "missing"))
        assertEquals(listOf(true, false, true), next.map { it.read })
    }

    @Test
    fun `marking read is a no-op without changes`() {
        val entries = listOf(entry(id = "a", read = true))
        assertSame(entries, markNotificationHistoryRead(entries, listOf("a", "a")))
        assertSame(entries, markNotificationHistoryRead(entries, emptyList()))
    }

    @Test
    fun `remove drops exactly one entry`() {
        val entries = listOf(entry(id = "a"), entry(id = "b"))
        assertEquals(listOf("b"), removeNotificationHistoryEntry(entries, "a").map { it.id })
        assertSame(entries, removeNotificationHistoryEntry(entries, "missing"))
    }

    @Test
    fun `unread count ignores read entries`() {
        assertEquals(2, unreadNotificationCount(listOf(entry(id = "a"), entry(id = "b"), entry(id = "c", read = true))))
        assertEquals(0, unreadNotificationCount(emptyList()))
    }

    @Test
    fun `the read ids are unread, unique, valid and capped`() {
        val entries = buildList {
            add(entry(id = "a"))
            add(entry(id = "a"))
            add(entry(id = "b", read = true))
            add(entry(id = ""))
            repeat(NOTIFICATION_HISTORY_MAX_IDS) { add(entry(id = "n$it")) }
        }
        val ids = notificationReadIds(entries)
        assertEquals(NOTIFICATION_HISTORY_MAX_IDS, ids.size)
        assertEquals(listOf("a", "n0"), ids.take(2))
    }

    @Test
    fun `display text is flattened and clipped like the web`() {
        assertEquals("a b c", clipNotificationText("  a \n b\t\tc  "))
        val clipped = clipNotificationText("x".repeat(NOTIFICATION_DETAIL_MAX + 10))
        assertEquals(NOTIFICATION_DETAIL_MAX, clipped.length)
        assertTrue(clipped.endsWith("…"))
    }

    // --- Stale-snapshot bookkeeping ---------------------------------------

    @Test
    fun `an unraced load applies its snapshot`() {
        val sync = NotificationHistorySync()
        val token = sync.beginLoad()
        assertEquals(SnapshotDecision.Apply, sync.decide(token))
        assertTrue(sync.isLatest(token))
    }

    @Test
    fun `a local change during a load forces a reload`() {
        val sync = NotificationHistorySync()
        val token = sync.beginLoad()
        sync.localChange()
        assertEquals(SnapshotDecision.Reload, sync.decide(token))
    }

    @Test
    fun `a local change with a request in flight reloads once that request settles`() {
        val sync = NotificationHistorySync()
        val token = sync.beginLoad()
        sync.beginRequest()
        sync.localChange()
        assertEquals(SnapshotDecision.ReloadWhenSettled, sync.decide(token))
        assertTrue(sync.endRequest())
        // The flag is consumed exactly once.
        assertEquals(false, sync.endRequest())
    }

    @Test
    fun `a request still running when the snapshot answers reloads on settle`() {
        val sync = NotificationHistorySync()
        val token = sync.beginLoad()
        sync.beginRequest()
        assertEquals(SnapshotDecision.ReloadWhenSettled, sync.decide(token))
        assertTrue(sync.endRequest())
    }

    @Test
    fun `overlapping requests reload only after the last one`() {
        val sync = NotificationHistorySync()
        sync.beginRequest()
        sync.beginRequest()
        sync.requestFailed()
        assertEquals(false, sync.endRequest())
        assertTrue(sync.endRequest())
    }

    @Test
    fun `an older load never overwrites a newer one`() {
        val sync = NotificationHistorySync()
        val older = sync.beginLoad()
        val newer = sync.beginLoad()
        assertEquals(SnapshotDecision.Ignore, sync.decide(older))
        assertEquals(false, sync.isLatest(older))
        assertEquals(SnapshotDecision.Apply, sync.decide(newer))
    }

    @Test
    fun `a failed request reloads exactly once`() {
        val sync = NotificationHistorySync()
        sync.beginRequest()
        sync.requestFailed()
        assertTrue(sync.endRequest())
        assertEquals(false, sync.endRequest())
    }

    @Test
    fun `reset drops the loads and requests of the previous origin`() {
        val sync = NotificationHistorySync()
        val token = sync.beginLoad()
        sync.beginRequest()
        sync.reset()

        // The answer of a load started before the reset must not land.
        assertEquals(SnapshotDecision.Ignore, sync.decide(token))
        // A request that belonged to the old origin cannot force a reload either.
        assertEquals(false, sync.endRequest())
        // The new origin starts clean: its own load applies.
        assertEquals(SnapshotDecision.Apply, sync.decide(sync.beginLoad()))
    }
}
