package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.notify.NotificationTestOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B27: the Settings "Send test" button must show what actually happened —
 * an Android notification, an in-app toast, a blocked permission, or the
 * failure reason (`NotificationCenter.sendTest`).
 */
class NotificationSettingsTest {

    private fun message(outcome: NotificationTestOutcome) = notificationTestMessage(
        outcome = outcome,
        sent = "Test notification sent",
        shown = "Shown in the app only",
        blocked = "Notifications are blocked",
        failed = "Test failed",
    )

    @Test
    fun sendTestShowsOutcome() {
        val sent = message(NotificationTestOutcome.Sent)
        assertEquals("Test notification sent", sent.text)
        assertFalse(sent.error)

        val local = message(NotificationTestOutcome.LocalShown)
        assertEquals("Shown in the app only", local.text)
        assertFalse(local.error)

        val blocked = message(NotificationTestOutcome.Blocked)
        assertEquals("Notifications are blocked", blocked.text)
        assertTrue("a blocked permission is an error the user must fix", blocked.error)

        val failed = message(NotificationTestOutcome.Failed("no notifier registered"))
        assertEquals("Test failed: no notifier registered", failed.text)
        assertTrue(failed.error)
    }
}
