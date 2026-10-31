package io.github.kahme247.ompweb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Notice-bar lifecycle: duplicate frames of one message collapse while it is
 * visible, but once the bar dismissed it (user or its 5 s/30 s timer) the same
 * message must be able to appear again — a repeated clipboard/host notice was
 * otherwise swallowed for the rest of the session.
 */
class ChatEngineNoticeTest {

    private var clock = 1_000L

    private fun engine(): ChatEngine = ChatEngine(now = { clock })

    @Test
    fun repeatedNoticeIsDedupedWhileVisible() {
        val engine = engine()
        engine.notice(NoticeKind.Info, "An extension read your clipboard")
        clock = 1_400L
        engine.notice(NoticeKind.Info, "An extension read your clipboard")

        val notices = engine.state.value.notices
        assertEquals(1, notices.size)
        assertEquals(1_000L, notices.single().createdAt)
    }

    @Test
    fun dismissedNoticeCanShowAgain() {
        val engine = engine()
        engine.notice(NoticeKind.Info, "An extension read your clipboard")
        val first = engine.state.value.notices.single()

        engine.dismissNotice(first)
        assertEquals(emptyList<ChatNotice>(), engine.state.value.notices)

        clock = 7_000L
        engine.notice(NoticeKind.Info, "An extension read your clipboard")

        val again = engine.state.value.notices.single()
        assertEquals(7_000L, again.createdAt)
        assertNotEquals(first.createdAt, again.createdAt)
    }

    @Test
    fun noticesStayBounded() {
        val engine = engine()
        repeat(8) { index ->
            engine.notice(NoticeKind.Info, "Notice $index")
        }

        val messages = engine.state.value.notices.map { it.message }

        assertEquals(5, messages.size)
        assertEquals(
            listOf("Notice 3", "Notice 4", "Notice 5", "Notice 6", "Notice 7"),
            messages,
        )
    }
}
