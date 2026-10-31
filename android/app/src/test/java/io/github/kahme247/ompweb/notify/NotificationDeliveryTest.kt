package io.github.kahme247.ompweb.notify

import io.github.kahme247.ompweb.domain.InAppNotice
import io.github.kahme247.ompweb.domain.NoticeRoute
import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyType
import io.github.kahme247.ompweb.domain.inAppNotice
import io.github.kahme247.ompweb.domain.noticeRoute
import io.github.kahme247.ompweb.domain.noticeRouteAfterPost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A12: the delivery decision the web makes in `hooks/useNotifications.ts:56-108`
 * — `os` posts a system notification, `toast` stays in the app, and a refused
 * system post falls back to the in-app notice instead of disappearing.
 */
class NotificationDeliveryTest {

    private fun event(
        type: NotifyType = NotifyType.Input,
        sessionId: String = "s1",
        detail: String? = "Approve the patch?",
        requestId: String? = "req-1",
    ) = NotifyEvent(
        type = type,
        sessionId = sessionId,
        sessionName = "Fix build",
        detail = detail,
        requestId = requestId,
    )

    @Test
    fun `kind chooses the delivery route`() {
        assertEquals(NoticeRoute.System, noticeRoute("os"))
        assertEquals(NoticeRoute.InApp, noticeRoute("toast"))
        assertEquals(NoticeRoute.None, noticeRoute(null))
        assertEquals(NoticeRoute.None, noticeRoute("push"))
    }

    @Test
    fun `only a refused system post falls back to the in-app notice`() {
        assertEquals(NoticeRoute.InApp, noticeRouteAfterPost(NoticeRoute.System, posted = false))
        assertEquals(NoticeRoute.System, noticeRouteAfterPost(NoticeRoute.System, posted = true))
        assertEquals(NoticeRoute.InApp, noticeRouteAfterPost(NoticeRoute.InApp, posted = false))
        assertEquals(NoticeRoute.None, noticeRouteAfterPost(NoticeRoute.None, posted = false))
    }

    @Test
    fun `an event becomes a notice with its session, tag and request`() {
        val notice = inAppNotice(event())
        assertEquals("s1:input", notice.id)
        assertEquals("s1", notice.sessionId)
        assertEquals("Fix build", notice.title)
        assertEquals("Waiting for your answer: Approve the patch?", notice.body)
        assertEquals("req-1", notice.requestId)
        assertFalse(notice.error)
        assertTrue(inAppNotice(event(type = NotifyType.Error, detail = "boom")).error)
    }

    @Test
    fun `newer notices replace their tag and the list is capped`() {
        val first = inAppNotice(event(detail = "first"))
        val second = inAppNotice(event(detail = "second"))
        val replaced = second.addTo(listOf(first), limit = 3)
        assertEquals(listOf(second), replaced)

        val others = (1..3).map { inAppNotice(event(sessionId = "s$it")) }
        val capped = others[2].addTo(others.take(2), limit = 3)
        assertEquals(listOf("s3:input", "s1:input", "s2:input"), capped.map { it.id })
        val overflow = inAppNotice(event(sessionId = "s4")).addTo(capped, limit = 3)
        assertEquals(listOf("s4:input", "s3:input", "s1:input"), overflow.map { it.id })
    }

    @Test
    fun `a dismiss frame only matches its own request`() {
        val notice = InAppNotice(
            id = "s1:input",
            sessionId = "s1",
            title = "Fix build",
            body = "Waiting",
            error = false,
            requestId = "req-1",
        )
        assertTrue(notice.matches("s1:input", "req-1"))
        assertFalse(notice.matches("s1:input", "req-2"))
        assertFalse(notice.matches("s2:input", "req-1"))
    }
}
