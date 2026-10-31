package io.github.kahme247.ompweb.notify

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.data.SettingsStore
import io.github.kahme247.ompweb.domain.NotifyAnswer
import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyPrefs
import io.github.kahme247.ompweb.domain.NotifyProject
import io.github.kahme247.ompweb.domain.NotifyType
import io.github.kahme247.ompweb.domain.PresenceReport
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.events.SseFrame
import io.github.kahme247.ompweb.net.AnswerOutcome
import io.github.kahme247.ompweb.net.NotificationsApi
import io.github.kahme247.ompweb.net.TestPushResult
import io.github.kahme247.ompweb.net.ServerAddress
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A12 at the center: a refused system post and a `toast` frame both land in
 * `notices` (the shell's in-app notice), a successful `os` post does not, and a
 * dismiss frame retracts only the request it names.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class NotificationCenterTest {

    private class FakeNotifier : Notifier {
        var postResult = true
        val posted = mutableListOf<NotifyEvent>()
        val postedProjects = mutableListOf<NotifyProject?>()
        val cancelled = mutableListOf<Pair<String, String>>()
        val cancelledSessions = mutableListOf<String>()
        var summaryRefreshes = 0

        override fun ensureChannels() = Unit

        override fun post(event: NotifyEvent, project: NotifyProject?): Boolean {
            posted += event
            postedProjects += project
            return postResult
        }

        override fun postTest(): Boolean = postResult

        override fun postResult(
            tag: String,
            title: String,
            channelId: String,
            text: String,
            sessionId: String,
        ): Boolean = postResult

        override fun cancelAll() = Unit

        override fun cancelSession(sessionId: String) {
            cancelledSessions += sessionId
        }

        override fun cancelIfMatches(tag: String, requestId: String) {
            cancelled += tag to requestId
        }

        override fun onGroupChildDismissed(groupKey: String, tag: String) = Unit

        override fun refreshGroupSummaries() {
            summaryRefreshes++
        }
    }

    private class FakeApi : NotificationsApi {
        val projects = mutableMapOf<String, NotifyProject>()

        override suspend fun putDevice(deviceId: String, prefs: NotifyPrefs, origin: ServerAddress?) = Unit

        override suspend fun isSubscribed(deviceId: String): Boolean = false

        override suspend fun sessionProjects(): Map<String, NotifyProject> = projects

        override suspend fun reportPresence(report: PresenceReport) = Unit

        override suspend fun sendTest(deviceId: String): TestPushResult = TestPushResult.Sent

        override suspend fun answer(sessionId: String, requestId: String, answer: NotifyAnswer): AnswerOutcome =
            AnswerOutcome.Answered

        override suspend fun followUp(sessionId: String, message: String) = Unit
    }

    private class FakeTransport : EventTransport {
        override suspend fun open(): EventStream = object : EventStream {
            override val frames: Flow<SseFrame> = emptyFlow()

            override fun close() = Unit
        }

        override suspend fun subscribe(
            connectionId: String,
            id: String,
            channel: EventChannel,
        ): EventPostResult = EventPostResult.Ok

        override suspend fun unsubscribe(connectionId: String, id: String) = Unit
    }

    private class FakeHaptics : InAppHaptics {
        val pulses = mutableListOf<NotifyType?>()

        override fun pulse(type: NotifyType?) {
            pulses += type
        }
    }

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val notifier = FakeNotifier()
    private val api = FakeApi()
    private val haptics = FakeHaptics()
    private val settings = SettingsStore(context, scope)
    private val center = NotificationCenter(
        context = context,
        settings = settings,
        api = api,
        mux = EventMux(FakeTransport(), scope),
        scope = scope,
        isSignedIn = { false },
        notifier = notifier,
        haptics = haptics,
    )

    /** [NotificationCenter.deliverFrame] suspends on the project lookup. */
    private fun deliver(frame: JsonObject) = runBlocking { center.deliverFrame(frame) }

    private fun notificationFrame(kind: String, type: String = "completed", requestId: String? = null): JsonObject =
        buildJsonObject {
            put("type", "notification")
            put("kind", kind)
            putJsonObject("event") {
                put("type", type)
                put("sessionId", "s1")
                put("sessionName", "Fix build")
                put("detail", "Approve the patch?")
                if (requestId != null) put("requestId", requestId)
            }
        }

    private fun dismissFrame(requestId: String): JsonObject = buildJsonObject {
        put("type", "notification-dismiss")
        put("tag", "s1:input")
        put("sessionId", "s1")
        put("requestId", requestId)
    }

    @Test
    fun `a refused system post becomes an in-app notice`() {
        notifier.postResult = false
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf("s1:completed"), center.notices.value.map { it.id })
        assertEquals(1, notifier.posted.size)
    }

    @Test
    fun `a toast frame becomes a notice without posting`() {
        deliver(notificationFrame(kind = "toast"))
        assertEquals(listOf("s1:completed"), center.notices.value.map { it.id })
        assertTrue(notifier.posted.isEmpty())
    }

    @Test
    fun `a successful system post shows no in-app notice`() {
        deliver(notificationFrame(kind = "os"))
        assertTrue(center.notices.value.isEmpty())
        assertEquals(1, notifier.posted.size)
    }

    @Test
    fun `dismiss retracts only the notice of its own request`() {
        deliver(notificationFrame(kind = "toast", type = "input", requestId = "req-1"))
        deliver(dismissFrame(requestId = "req-2"))
        assertEquals(1, center.notices.value.size)
        assertEquals("req-1", center.notices.value.single().requestId)
        deliver(dismissFrame(requestId = "req-1"))
        assertTrue(center.notices.value.isEmpty())
        // The system notification is closed for every dismiss frame; only the
        // notice list filters by request id.
        assertEquals(listOf("s1:input" to "req-2", "s1:input" to "req-1"), notifier.cancelled)
    }

    @Test
    fun `closing a notice keeps a newer notice of the same tag`() {
        deliver(notificationFrame(kind = "toast", type = "input", requestId = "req-1"))
        val first = center.notices.value.single()
        deliver(notificationFrame(kind = "toast", type = "input", requestId = "req-2"))
        val second = center.notices.value.single()
        center.dismissNotice(first)
        assertEquals(second, center.notices.value.single())
        center.dismissNotice(second)
        assertTrue(center.notices.value.isEmpty())
    }

    @Test
    fun `a system post carries the session's project for grouping`() {
        api.projects["s1"] = NotifyProject(key = "c:/work/ompwebandroid", label = "ompwebandroid")
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf<NotifyProject?>(NotifyProject("c:/work/ompwebandroid", "ompwebandroid")), notifier.postedProjects)
    }

    @Test
    fun `an unknown session stays ungrouped`() {
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf<NotifyProject?>(null), notifier.postedProjects)
    }

    @Test
    fun `a run for the chat on screen posts nothing`() {
        center.setAppForeground(true)
        center.setVisibleSession("s1")
        deliver(notificationFrame(kind = "os"))
        assertTrue(notifier.posted.isEmpty())
        assertTrue(center.notices.value.isEmpty())
        assertTrue(haptics.pulses.isEmpty())
    }

    @Test
    fun `a toast for the chat on screen stays out of the app too`() {
        center.setAppForeground(true)
        center.setVisibleSession("s1")
        deliver(notificationFrame(kind = "toast", type = "input"))
        assertTrue(center.notices.value.isEmpty())
    }

    @Test
    fun `a run for another chat still notifies while the app is foreground`() {
        center.setAppForeground(true)
        center.setVisibleSession("s-other")
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf("s1:completed"), notifier.posted.map { it.tag })
    }

    @Test
    fun `a chat on screen in the background still notifies`() {
        center.setAppForeground(false)
        center.setVisibleSession("s1")
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf("s1:completed"), notifier.posted.map { it.tag })
    }

    @Test
    fun `leaving the chat lets its notifications through again`() {
        center.setAppForeground(true)
        center.setVisibleSession("s1")
        center.setVisibleSession(null)
        deliver(notificationFrame(kind = "os"))
        assertEquals(listOf("s1:completed"), notifier.posted.map { it.tag })
    }

    @Test
    fun `opening the chat closes its posted notification and notice`() {
        center.setAppForeground(false)
        deliver(notificationFrame(kind = "os"))
        deliver(notificationFrame(kind = "toast", type = "input", requestId = "req-1"))
        assertEquals(1, notifier.posted.size)
        assertEquals(1, center.notices.value.size)
        center.setAppForeground(true)
        center.setVisibleSession("s1")
        assertEquals(listOf("s1"), notifier.cancelledSessions)
        assertTrue(center.notices.value.isEmpty())
    }

    @Test
    fun `returning to a chat that stayed visible closes its notification`() {
        center.setAppForeground(false)
        center.setVisibleSession("s1")
        deliver(notificationFrame(kind = "os"))
        assertEquals(1, notifier.posted.size)
        center.setAppForeground(true)
        assertEquals(listOf("s1"), notifier.cancelledSessions)
    }

    @Test
    fun `presence names the shown chat only while the app shows it`() = runBlocking {
        settings.ensureNotifyIdentity()
        center.setAppForeground(true)
        center.setVisibleSession("s1")
        val shown = requireNotNull(center.presenceReport())
        assertTrue(shown.visible)
        assertEquals("s1", shown.sessionId)
        assertTrue(shown.clientId.isNotBlank())
        assertTrue(shown.deviceId.isNotBlank())
        center.setVisibleSession(null)
        val hidden = requireNotNull(center.presenceReport())
        assertFalse(hidden.visible)
        assertNull(hidden.sessionId)
        assertTrue("seq grows so an overtaken report cannot win", hidden.seq > shown.seq)
    }

    @Test
    fun `a foreground in-app notice pulses the event waveform`() {
        center.setAppForeground(true)
        deliver(notificationFrame(kind = "toast", type = "input"))
        assertEquals(listOf<NotifyType?>(NotifyType.Input), haptics.pulses)
    }

    @Test
    fun `an in-app notice in the background does not vibrate`() {
        deliver(notificationFrame(kind = "toast", type = "error"))
        assertTrue(haptics.pulses.isEmpty())
    }

    @Test
    fun `coming back to the foreground refreshes the group summaries`() {
        // A tapped notification is auto-cancelled without a dismiss callback,
        // so the next foreground visit has to repair count and title.
        center.setAppForeground(false)
        assertEquals("backgrounding leaves the shade alone", 0, notifier.summaryRefreshes)
        center.setAppForeground(true)
        assertEquals(1, notifier.summaryRefreshes)
    }
}
