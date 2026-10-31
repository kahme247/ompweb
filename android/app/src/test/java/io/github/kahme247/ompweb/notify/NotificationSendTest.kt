package io.github.kahme247.ompweb.notify

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.data.SettingsStore
import io.github.kahme247.ompweb.domain.NotifyAnswer
import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyPrefs
import io.github.kahme247.ompweb.domain.NotifyProject
import io.github.kahme247.ompweb.domain.PresenceReport
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.events.SseFrame
import io.github.kahme247.ompweb.net.AnswerOutcome
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.net.NotificationsApi
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.TestPushResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * T8-8: the Settings "Send test notification" button, end to end. The center
 * checks the device's subscription first — native installs have no Web Push
 * subscription, so the web's re-subscribe path is the local notification
 * fallback — and answers with the outcome the screen renders.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class NotificationSendTest {

    private class FakeNotifier : Notifier {
        var postTestResult = true
        var testPosts = 0

        override fun ensureChannels() = Unit

        override fun post(event: NotifyEvent, project: NotifyProject?): Boolean = true

        override fun postTest(): Boolean {
            testPosts += 1
            return postTestResult
        }

        override fun postResult(
            tag: String,
            title: String,
            channelId: String,
            text: String,
            sessionId: String,
        ): Boolean = true

        override fun cancelAll() = Unit

        override fun cancelSession(sessionId: String) = Unit

        override fun cancelIfMatches(tag: String, requestId: String) = Unit

        override fun onGroupChildDismissed(groupKey: String, tag: String) = Unit

        override fun refreshGroupSummaries() = Unit
    }

    private class FakeApi : NotificationsApi {
        var subscribed = false
        var testResult: TestPushResult = TestPushResult.Sent
        var pushAttempts = 0

        override suspend fun putDevice(deviceId: String, prefs: NotifyPrefs, origin: ServerAddress?) = Unit

        override suspend fun isSubscribed(deviceId: String): Boolean = subscribed

        override suspend fun sessionProjects(): Map<String, NotifyProject> = emptyMap()

        override suspend fun reportPresence(report: PresenceReport) = Unit

        override suspend fun sendTest(deviceId: String): TestPushResult {
            pushAttempts += 1
            return testResult
        }

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

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val notifier = FakeNotifier()
    private val api = FakeApi()

    @After
    fun tearDown() {
        scope.cancel()
    }

    /** A center whose settings carry the origin of a signed-in install. */
    private suspend fun signedInCenter(signedIn: Boolean = true): NotificationCenter {
        val settings = SettingsStore(context, scope)
        settings.setOrigin("http://127.0.0.1:30177")
        return NotificationCenter(
            context = context,
            settings = settings,
            api = api,
            mux = EventMux(FakeTransport(), scope),
            scope = scope,
            isSignedIn = { signedIn },
            notifier = notifier,
        )
    }

    @Test
    fun anInstallWithoutASubscriptionShowsTheTestNotificationLocally() = runBlocking {
        val center = signedInCenter()

        assertEquals(NotificationTestOutcome.LocalShown, center.sendTest())
        assertEquals("the local fallback posts one test notification", 1, notifier.testPosts)
        assertEquals("no server push without a subscription", 0, api.pushAttempts)
    }

    @Test
    fun aBlockedPermissionReportsBlockedInsteadOfSent() = runBlocking {
        notifier.postTestResult = false
        val center = signedInCenter()

        assertEquals(NotificationTestOutcome.Blocked, center.sendTest())
        assertEquals(1, notifier.testPosts)
    }

    @Test
    fun aSubscribedInstallGoesThroughTheServerTestPush() = runBlocking {
        api.subscribed = true
        api.testResult = TestPushResult.Sent
        val center = signedInCenter()

        assertEquals(NotificationTestOutcome.Sent, center.sendTest())
        assertEquals(1, api.pushAttempts)
        assertTrue("the local fallback does not run when subscribed", notifier.testPosts == 0)
    }

    @Test
    fun theServersPushFailureIsShownWithItsReason() = runBlocking {
        api.subscribed = true
        api.testResult = TestPushResult.Failed("push service rejected the token")
        val center = signedInCenter()

        assertEquals(
            NotificationTestOutcome.Failed("push service rejected the token"),
            center.sendTest(),
        )
    }

    @Test
    fun aSignedOutInstallCannotSendATest() = runBlocking {
        val center = signedInCenter(signedIn = false)

        assertEquals(NotificationTestOutcome.Failed("Not signed in"), center.sendTest())
    }
}
